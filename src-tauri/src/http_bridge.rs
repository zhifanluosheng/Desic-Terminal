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

use std::collections::{HashMap, VecDeque};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;
pub const HTTP_BRIDGE_PORT: u16 = 17899;

/// 事件广播通道容量：行情/私有流等高频事件可能瞬间堆积，给足余量避免 lag 丢帧。
const EVENT_CHANNEL_CAPACITY: usize = 8192;

/// 单个 HTTP 请求 header 的最大字节数（防恶意连接撑爆内存）。
const MAX_HEADER_BYTES: usize = 64 * 1024;

/// 事件总线：`app.emit` 的每个事件被监听后，序列化为 `{event, payload}` 广播。
#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<String>,
    seq: Arc<AtomicU64>,
    history: Arc<RwLock<VecDeque<(u64, String)>>>,
}

impl EventBus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        Self {
            tx,
            seq: Arc::new(AtomicU64::new(0)),
            history: Arc::new(RwLock::new(VecDeque::new())),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.tx.subscribe()
    }

    /// 由事件监听回调调用：把事件名 + 负载 JSON 广播出去，并写历史。
    pub fn publish(&self, event: &str, payload: &str) {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let frame = serde_json::json!({ "seq": seq, "event": event, "payload": payload }).to_string();
        // 写历史（容量 8192，满则丢最旧）。
        {
            let mut h = self.history.write().unwrap();
            h.push_back((seq, frame.clone()));
            while h.len() > EVENT_CHANNEL_CAPACITY {
                h.pop_front();
            }
        }
        // 无订阅者时 send 返回 Err，静默即可。
        let _ = self.tx.send(frame);
    }

    /// 返回 seq > since 的历史帧（供 SSE 重连回放）。
    pub fn history_since(&self, since: u64) -> Vec<String> {
        let h = self.history.read().unwrap();
        h.iter()
            .filter(|(seq, _)| *seq > since)
            .map(|(_, frame)| frame.clone())
            .collect()
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
    write_http_response_with_cache(stream, status, status_text, content_type, body, None).await
}

/// Same as [`write_http_response`], plus an optional `Cache-Control` value.
///
/// The bridge serves the built frontend, so a cached `index.html` would keep
/// pointing at chunk files that a newer build already deleted — the page then
/// dies with "Failed to fetch dynamically imported module". Hashed assets are
/// immutable and can be cached for a year.
pub async fn write_http_response_with_cache(
    stream: &mut TcpStream,
    status: u16,
    status_text: &str,
    content_type: &str,
    body: &[u8],
    cache_control: Option<&str>,
) -> io::Result<()> {
    let cache_header = match cache_control {
        Some(value) => format!("Cache-Control: {value}\r\n"),
        None => String::new(),
    };
    let header = format!(
        "HTTP/1.1 {status} {status_text}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n{cache_header}Connection: close\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\n\r\n",
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

    /// 注册事件监听：把后端 app.emit 的每个全局事件转发到 EventBus。
    /// 必须显式逐事件名调用 listen_any（tauri 无通配监听）。
    pub fn install_listeners(&self) {
        use tauri::Listener;
        let app = self.app.clone();
        let events = self.events.clone();
        for (event_name, _source) in crate::event_registry::EVENT_REGISTRY {
            let event_name = *event_name;
            let events = events.clone();
            app.listen_any(event_name, move |e| {
                let payload = e.payload().to_string();
                events.publish(event_name, &payload);
            });
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

    #[test]
    fn event_bus_publish_increments_seq_and_writes_history() {
        let bus = EventBus::new();
        bus.publish("market:event", "{\"a\":1}");
        bus.publish("kline:sync", "{\"b\":2}");
        bus.publish("ai:event", "{\"c\":3}");
        let h = bus.history_since(0);
        assert_eq!(h.len(), 3);
        assert!(h[0].contains("\"seq\":1"));
        assert!(h[1].contains("\"seq\":2"));
        assert!(h[2].contains("\"seq\":3"));
    }

    #[test]
    fn event_bus_history_since_filters_by_seq() {
        let bus = EventBus::new();
        for i in 0..5 {
            bus.publish("market:event", &format!("{{\"i\":{i}}}"));
        }
        let h = bus.history_since(2);
        assert_eq!(h.len(), 3);
        assert!(h[0].contains("\"seq\":3"));
        assert!(h[2].contains("\"seq\":5"));
        // since 大于最大 seq 时为空
        assert!(bus.history_since(100).is_empty());
    }

    #[test]
    fn event_bus_evicts_oldest_beyond_capacity() {
        let bus = EventBus::new();
        // 容量 8192，写满后最旧被淘汰。这里验证 history 长度不超过容量。
        for i in 0..(EVENT_CHANNEL_CAPACITY + 10) {
            bus.publish("market:event", &format!("{{\"i\":{i}}}"));
        }
        let h = bus.history_since(0);
        assert_eq!(h.len(), EVENT_CHANNEL_CAPACITY);
        // 最旧的 10 个 seq 已被淘汰，最早的应是 seq=11
        assert!(h[0].contains("\"seq\":11"));
    }

    // 读满逻辑的集成验证依赖真实 TcpStream，这里用纯函数覆盖 parse 分支，
    // 读满 body 的循环在 Task 2 实现里经 `read_http_request` 的 `body.len() < content_length`
    // 分支验证（见 http_bridge 的 handle_conn 冒烟，Task 3 用 curl 大 payload 验证）。
}


/// 解析前端 dist 目录：优先 exe 同目录的 dist（release），回退 CARGO_MANIFEST_DIR/../dist（dev）。
pub fn http_bridge_dist_dir() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("dist");
            if candidate.join("index.html").exists() {
                return candidate;
            }
        }
    }
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest.join("../dist")
}

// ===== 引入 build.rs 生成的 dispatch 表 =====
include!("http_bridge_dispatch.rs");

/// 启动 HTTP 桥：绑定 127.0.0.1:17899 并循环 accept。
pub async fn serve(bridge: HttpBridge) -> io::Result<()> {
    bridge.install_listeners();
    let listener = TcpListener::bind(("127.0.0.1", HTTP_BRIDGE_PORT)).await?;
    let bridge = Arc::new(bridge);
    loop {
        let (stream, _addr) = listener.accept().await?;
        let bridge = Arc::clone(&bridge);
        tokio::spawn(async move {
            if let Err(e) = handle_conn(stream, bridge).await {
                // 单连接错误不致命，静默。
                let _ = e;
            }
        });
    }
}

/// 处理单个连接：读请求 → 路由 → 写响应。
async fn handle_conn(mut stream: TcpStream, bridge: Arc<HttpBridge>) -> io::Result<()> {
    let req = read_http_request(&mut stream).await?;
    let path = req.path.clone();
    let method = req.method.clone();

    if method == "OPTIONS" {
        write_http_response(&mut stream, 204, "No Content", "text/plain", b"").await
    } else if method == "POST" && path.starts_with("/api/") {
        let command = path.trim_start_matches("/api/");
        handle_command(&mut stream, &bridge, command, &req).await
    } else if method == "GET" && path == "/api/status" {
        let body = serde_json::json!({
            "ok": true,
            "port": HTTP_BRIDGE_PORT,
            "commands": 303,
        });
        write_http_response(&mut stream, 200, "OK", "application/json", body.to_string().as_bytes()).await
    } else if method == "GET" && path.starts_with("/api/events") {
        handle_sse(&mut stream, &bridge, &req).await
    } else if method == "GET" {
        serve_static(&mut stream, &bridge, &path).await
    } else {
        write_http_response(&mut stream, 405, "Method Not Allowed", "text/plain", b"method not allowed").await
    }
}

/// POST /api/<command>：解析 JSON body → dispatch → 返回 {ok, value}/{ok, error}。
async fn handle_command(
    stream: &mut TcpStream,
    bridge: &HttpBridge,
    command: &str,
    req: &ParsedRequest,
) -> io::Result<()> {
    let body_map: serde_json::Map<String, serde_json::Value> = if req.body.is_empty() {
        serde_json::Map::new()
    } else {
        match serde_json::from_slice(&req.body) {
            Ok(serde_json::Value::Object(m)) => m,
            Ok(_) => {
                return write_http_response(
                    stream, 400, "Bad Request", "application/json",
                    serde_json::json!({"ok": false, "error": "body must be a JSON object"}).to_string().as_bytes(),
                ).await;
            }
            Err(e) => {
                return write_http_response(
                    stream, 400, "Bad Request", "application/json",
                    serde_json::json!({"ok": false, "error": format!("invalid JSON: {e}")}).to_string().as_bytes(),
                ).await;
            }
        }
    };

    match dispatch_command(&bridge.app, command, &body_map).await {
        Ok(value) => {
            let resp = serde_json::json!({"ok": true, "value": value});
            write_http_response(stream, 200, "OK", "application/json", resp.to_string().as_bytes()).await
        }
        Err(e) => {
            let resp = serde_json::json!({"ok": false, "error": e});
            write_http_response(stream, 200, "OK", "application/json", resp.to_string().as_bytes()).await
        }
    }
}

/// GET /api/events?since=<seq>：SSE 流，先回放 >since 的历史事件，再实时转发。
async fn handle_sse(
    stream: &mut TcpStream,
    bridge: &HttpBridge,
    req: &ParsedRequest,
) -> io::Result<()> {
    let since = query_param(&req.path, "since").and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);

    // 响应头（SSE 不关闭连接，手动写头）。
    let header = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nAccess-Control-Allow-Origin: *\r\n\r\n";
    stream.write_all(header.as_bytes()).await?;
    stream.flush().await?;

    // 回放历史（EventBus 的 history 由 publish 写入）。
    let history = bridge.events.history_since(since);
    for frame in history {
        stream.write_all(b"data: ").await?;
        stream.write_all(frame.as_bytes()).await?;
        stream.write_all(b"\n\n").await?;
    }
    stream.flush().await?;

    // 实时订阅。
    let mut rx = bridge.events.subscribe();
    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(15));
    loop {
        tokio::select! {
            _ = ticker.tick() => {
                // 心跳注释帧。
                if stream.write_all(b": ping\n\n").await.is_err() {
                    break;
                }
                let _ = stream.flush().await;
            }
            msg = rx.recv() => {
                match msg {
                    Ok(frame) => {
                        if stream.write_all(b"data: ").await.is_err() {
                            break;
                        }
                        if stream.write_all(frame.as_bytes()).await.is_err() {
                            break;
                        }
                        if stream.write_all(b"\n\n").await.is_err() {
                            break;
                        }
                        let _ = stream.flush().await;
                    }
                    Err(_) => break,
                }
            }
        }
    }
    Ok(())
}

/// 从 URL 提取查询参数。
fn query_param<'a>(path: &'a str, key: &str) -> Option<&'a str> {
    let q = path.split('?').nth(1)?;
    for pair in q.split('&') {
        let mut it = pair.splitn(2, '=');
        let k = it.next()?;
        let v = it.next().unwrap_or("");
        if k == key {
            return Some(v);
        }
    }
    None
}

/// GET /<path>：托管 dist 静态文件（SPA fallback 到 index.html）。
async fn serve_static(stream: &mut TcpStream, bridge: &HttpBridge, path: &str) -> io::Result<()> {
    // 忽略查询串/片段：导航到 /?visual=host、/index.html?chartWindowId=… 都应按路径解析，
    // 否则带查询串的地址会被当成不存在的相对路径（甚至触发 403）。
    let path = path.split(['?', '#']).next().unwrap_or("/");
    let rel = path.trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };
    let mut file_path = bridge.dist_dir.join(rel);

    // 防止目录穿越。
    let dist_canonical = bridge.dist_dir.canonicalize().unwrap_or_else(|_| bridge.dist_dir.as_path().to_path_buf());
    let candidate = file_path.canonicalize().unwrap_or_else(|_| file_path.clone());

    if !candidate.starts_with(&dist_canonical) {
        return write_http_response(stream, 403, "Forbidden", "text/plain", b"forbidden").await;
    }

    // SPA fallback：路径是目录或不存在时回退 index.html。
    if file_path.is_dir() || !file_path.exists() {
        file_path = bridge.dist_dir.join("index.html");
    }

    match tokio::fs::read(&file_path).await {
        Ok(data) => {
            let ct = content_type_for(&file_path);
            // index.html 必须每次回源：前端重新构建后 chunk 文件名会变，
            // 缓存下来的旧 index 会去请求已被删除的 chunk（动态 import 失败）。
            let cache_control = if rel == "index.html" || file_path.extension().and_then(|e| e.to_str()) == Some("html") {
                "no-store, no-cache, must-revalidate"
            } else if rel.starts_with("assets/") {
                "public, max-age=31536000, immutable"
            } else {
                "no-store"
            };
            write_http_response_with_cache(stream, 200, "OK", ct, &data, Some(cache_control)).await
        }
        Err(_) => {
            write_http_response(stream, 404, "Not Found", "text/plain", b"not found").await
        }
    }
}

fn content_type_for(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "application/javascript",
        Some("css") => "text/css",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}
