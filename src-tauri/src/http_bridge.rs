//! http_bridge.rs — 本地 HTTP 桥：让 Desic 前端在「非 Tauri WebView」环境
//! （DSH 的 Electron iframe）里也能完整调用后端。
//!
//! 路由：
//!   - POST /api/<command>   → 等价 tauri invoke(command, args)，返回 JSON。
//!       由 `http_bridge_dispatch.rs`（build.rs 自动生成）按 command 名分发到
//!       真实的 `#[tauri::command]` 函数，复用同一份逻辑，零重复。
//!   - GET  /api/events      → SSE 流：把后端 `app.emit` 的事件转发给前端。
//!   - GET  /api/status      → 健康检查。
//!   - GET  /<path>          → 托管前端 dist 静态文件（SPA）。

use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;

/// 桥接端口（DSH 插件与前端降级路径共用此常量约定）。
pub const HTTP_BRIDGE_PORT: u16 = 17899;

/// 事件广播通道容量：行情/私有流等高频事件可能瞬间堆积，给足余量避免 lag 丢帧。
const EVENT_CHANNEL_CAPACITY: usize = 8192;

/// 单个 HTTP 请求 header 的最大字节数（防恶意连接撑爆内存）。
const MAX_HEADER_BYTES: usize = 64 * 1024;

/// 事件总线：`app.emit` 的每个事件被监听后，序列化为 `{event, payload}` 广播。
#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<String>,
}

impl EventBus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        Self { tx }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.tx.subscribe()
    }

    /// 由事件监听回调调用：把事件名 + 负载 JSON 广播出去。
    pub fn publish(&self, event: &str, payload: &str) {
        let frame = serde_json::json!({ "event": event, "payload": payload }).to_string();
        // 无订阅者时 send 返回 Err，静默即可。
        let _ = self.tx.send(frame);
    }
}

/// HTTP 桥：持有 AppHandle（用于 command 分发取 State / 发事件）与 dist 目录。
pub struct HttpBridge {
    pub app: tauri::AppHandle,
    pub dist_dir: Arc<PathBuf>,
    pub events: EventBus,
}

/// 一个解析完成的 HTTP 请求。
#[derive(Debug)]
pub struct ParsedRequest {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// 从 TCP 流读满一个 HTTP 请求：先读 header 段（直到 `\r\n\r\n`），
/// 再按 `Content-Length` 循环读满 body。禁止单次 read 假设读全。
pub async fn read_http_request(stream: &mut TcpStream) -> io::Result<ParsedRequest> {
    let mut buf: Vec<u8> = Vec::new();
    let mut tmp = [0u8; 8192];

    // 1. 读 header 直到遇到 \r\n\r\n。
    let header_end = loop {
        if let Some(pos) = find_subsequence(&buf, b"\r\n\r\n") {
            break pos + 4;
        }
        if buf.len() > MAX_HEADER_BYTES {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "header too large"));
        }
        let n = stream.read(&mut tmp).await?;
        if n == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "connection closed in header"));
        }
        buf.extend_from_slice(&tmp[..n]);
    };

    let header_bytes = buf[..header_end].to_vec();
    let mut rest = buf[header_end..].to_vec();
    buf.clear();

    // 2. 解析请求行 + headers。
    let header_text = String::from_utf8_lossy(&header_bytes);
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("/").to_string();

    let mut headers: Vec<(String, String)> = Vec::new();
    for line in lines {
        if let Some(idx) = line.find(':') {
            let name = line[..idx].trim().to_string();
            let value = line[idx + 1..].trim().to_string();
            headers.push((name, value));
        }
    }

    // 3. 按 Content-Length 读满 body。
    let content_length = parse_content_length(&headers);
    let mut body = rest;
    if body.len() > content_length {
        body.truncate(content_length);
    }
    while body.len() < content_length {
        let n = stream.read(&mut tmp).await?;
        if n == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "connection closed in body"));
        }
        body.extend_from_slice(&tmp[..n]);
    }

    Ok(ParsedRequest {
        method,
        path,
        headers,
        body,
    })
}

/// 大小写不敏感解析 Content-Length；缺省返回 0。
pub fn parse_content_length(headers: &[(String, String)]) -> usize {
    for (name, value) in headers {
        if name.eq_ignore_ascii_case("content-length") {
            return value.trim().parse().unwrap_or(0);
        }
    }
    0
}

/// 查找子序列 `needle` 在 `haystack` 中的起始位置。
fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// 写一个最小 HTTP/1.1 响应。
pub async fn write_http_response(
    stream: &mut TcpStream,
    status: u16,
    status_text: &str,
    content_type: &str,
    body: &[u8],
) -> io::Result<()> {
    let header = format!(
        "HTTP/1.1 {status} {status_text}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.flush().await
}

/// 从请求中提取 header 值（大小写不敏感）。
pub fn header_value<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

impl HttpBridge {
    pub fn new(app: tauri::AppHandle, dist_dir: PathBuf) -> Self {
        Self {
            app,
            dist_dir: Arc::new(dist_dir),
            events: EventBus::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_content_length_is_case_insensitive() {
        let headers = vec![("CONTENT-LENGTH".to_string(), "42".to_string())];
        assert_eq!(parse_content_length(&headers), 42);

        let headers = vec![("content-length".to_string(), "7".to_string())];
        assert_eq!(parse_content_length(&headers), 7);

        let headers: Vec<(String, String)> = vec![];
        assert_eq!(parse_content_length(&headers), 0);
    }

    #[test]
    fn find_subsequence_finds_header_end() {
        let b = b"GET / HTTP/1.1\r\nHost: x\r\n\r\nbody";
        assert_eq!(find_subsequence(b, b"\r\n\r\n"), Some(b.len() - 4 - 4));
    }

    #[test]
    fn header_value_is_case_insensitive() {
        let headers = vec![("Host".to_string(), "127.0.0.1".to_string())];
        assert_eq!(header_value(&headers, "host"), Some("127.0.0.1"));
        assert_eq!(header_value(&headers, "missing"), None);
    }

    // 读满逻辑的集成验证依赖真实 TcpStream，这里用纯函数覆盖 parse 分支，
    // 读满 body 的循环在 Task 2 实现里经 `read_http_request` 的 `body.len() < content_length`
    // 分支验证（见 http_bridge 的 handle_conn 冒烟，Task 3 用 curl 大 payload 验证）。
}
