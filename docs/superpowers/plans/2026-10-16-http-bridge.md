# HTTP Bridge（无头后端 + build.rs codegen + SSE 增强）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Desic-Terminal 后端在无 Tauri 窗口的 `--embedded` 模式下，经 `127.0.0.1:17899` 以 HTTP 提供完整 command 调用与 SSE 事件流。

**Architecture:** 在 Tauri `Builder` 之上新增一个 `HttpBridge` 模块：`POST /api/<command>` 由 `build.rs` 生成的 `http_bridge_dispatch.rs` 分发到真实 `#[tauri::command]` 函数；`GET /api/events` 经 `app.listen_any` 捕获所有 `app.emit` 后按 `{seq, event, payload}` 广播；`GET /<path>` 托管前端 dist。`--embedded` 分支跳过 splash/main 窗口创建，只初始化 `.manage(...)` 状态与桥。

**Tech Stack:** Rust (tokio TcpListener 手写 HTTP，不引 axum/hyper)、`build.rs` 代码生成、tauri 2 `listen_any`、SSE。

**Spec:** `docs/superpowers/specs/2026-10-16-iframe-embedding-design.md`

## Global Constraints

- 桥监听 `127.0.0.1:17899`，仅本机回环。
- `--embedded` 启动时不创建 splash/main 窗口；独立桌面运行（无此 flag）照常建窗。
- 命令分发零逻辑重复：每个 branch 复用真实 `#[tauri::command]` 函数，不重写业务逻辑。
- `Result<T, String>` 解包成 `{ok: true, value}` / `{ok: false, error}`；`async fn` 自动 `.await`；入参按 camelCase 反序列化。
- 事件 SSE 帧形如 `event: <name>\ndata: {"seq":N,"payload":...}\n\n`；支持 `?since=<seq>` 回放；每 15s 心跳注释帧。
- 读 TCP 流必须按 `Content-Length` 循环读满 body。
- 前端构建命令 `CODEBUDDY_SAFE_DELETE_ENABLED=0 npm run build`；Rust 构建 `CARGO_TARGET_DIR=C:/Users/Administrator/desic-target cargo check --manifest-path src-tauri/Cargo.toml --workspace`。

## Review Focus

1. **命令 body 跨多次 TCP read 分包** → `POST /api/<command>` 必须按 Content-Length 读满再解析，不能单次 read。测试：Task 2 的 payload 回环测试。
2. **SSE 断线重连丢事件** → `?since=<seq>` 回放必须返回 `>seq` 的全部事件。测试：Task 4 的回放测试。
3. **embedded 下 app.emit 仍可用** → 无窗口时 `app.emit` 不得 panic/静默失败，事件仍进广播通道。测试：Task 4 的 embedded 事件测试。
4. **camelCase 参数对齐** → 前端 `request` 字段名与 Rust 参数反序列化必须一致，不能因命名风格而 400。测试：Task 2 的 camelCase 命令测试。
5. **`--embedded` 不影响桌面模式** → 无 flag 时行为与现在完全一致（建窗、无桥或桥并存）。测试：Task 5 的双模式测试。

---

### Task 1: 事件常量集中清单（build.rs codegen 的事实源）

**Files:**
- Create: `src-tauri/src/event_registry.rs`

**Interfaces:**
- Produces: `pub const EVENT_REGISTRY: &[(&str, &str)]` —— `(事件名, 来源模块名)` 的静态数组，覆盖本仓库全部 `app.emit` / `window.emit` 事件（`market:event`、`kline:sync`、`ai:event`、`ai:chart-action`、`chart:alert-triggered`、`trade:audit`、`trade:instrument-operation`、`intelligence:event`、`systematic:event`、`voice:local-progress`、`voice:partial`、`ai:ui-action`、`ai:automation-event`、`app:update-state`、`app:update-download`、`data-root-migration`、`market-radar:history-status`、`market-radar:directory-updated`、`chart-window:update`、`chart-window:state-changed`、`app:enter-main`、`ai:config-updated`、`ui:locale-changed`、`strategy_signal`、`systematic:strategy-ai-editor-tool` 等，以 `grep "\.emit("` 全量核对为准）。

**Approach:** 从本仓库所有 `*.rs` 里 `app.emit(...)` / `window.emit(...)` / `.emit(...)` 的字符串字面量提取事件名，去重后手工写死为常量数组；codegen 与 SSE 广播都读它。

- [ ] **Step 1: 用 grep 全量提取事件名并核对**

Run: `Select-String -Path "src-tauri/src/*.rs" -Pattern "\.emit\("`
Expected: 得到完整事件名清单（约 20-30 个），与上述列表交叉核对，无遗漏。

- [ ] **Step 2: 写 `event_registry.rs`**

内容：`pub const EVENT_REGISTRY: &[(&str, &str)] = &[("market:event", "lib.rs"), ...];`，每项为真实事件名与来源文件。

- [ ] **Step 3: 编译验证**

Run: `CARGO_TARGET_DIR=C:/Users/Administrator/desic-target cargo check --manifest-path src-tauri/Cargo.toml --workspace`
Expected: 无 error（该模块此刻尚未被引用，不产生 dead_code 告警即可）。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/event_registry.rs
git commit -m "feat(bridge): add event registry constant list"
```

---

### Task 2: HttpBridge 核心（Content-Length 读满 + command 分发骨架）

**Files:**
- Create: `src-tauri/src/http_bridge.rs`

**Interfaces:**
- Consumes: `event_registry::EVENT_REGISTRY`（Task 1）
- Produces:
  - `pub const HTTP_BRIDGE_PORT: u16`（= 17899）
  - `pub struct EventBus { tx: broadcast::Sender<String> }`；`EventBus::new()`、`subscribe() -> broadcast::Receiver<String>`、`publish(event: &str, payload: &str)`
  - `pub struct HttpBridge { app: tauri::AppHandle, dist_dir: Arc<PathBuf>, events: EventBus }`；`HttpBridge::new(app, dist_dir) -> Self`
  - `pub async fn serve(bridge: HttpBridge) -> io::Result<()>`：绑定 `127.0.0.1:17899`，对每个连接：读 header → 解析 `Content-Length` → 循环读满 body → 按路径分发。
  - 路由：`GET /api/status` 返回 `{"ok":true,"commands":N}`；`POST /api/<command>` 调 `crate::http_bridge_dispatch::dispatch(app, command, body) -> Result<Value, String>`；`GET /api/events` 转 SSE；`GET /<path>` 从 `dist_dir` serve（`/` → `index.html`，Spa fallback）。

**Approach:** tokio `TcpListener` 手写 HTTP/1.1 解析；不引 axum/hyper。`handle_conn` 内先读第一段拿 header，用大小写不敏感的 `Content-Length` 头解析 body 长度，然后循环 `read` 直到读满；禁止单次 read 假设读全。

- [ ] **Step 1: 写失败测试（大 payload 回环）**

在 `src-tauri/tests/http_bridge.rs`（新建集成测试目录）写：构造含 2MB 字符串 body 的 `POST /api/echo_test`，断言响应 body 完整等于输入。此测试需临时在 `dispatch` 里挂一个 `echo_test` 桩（本任务实现，供 Task 3 前验证读满逻辑）。

- [ ] **Step 2: 运行测试确认失败（Content-Length 未实现时读不完整）**

Run: `CARGO_TARGET_DIR=C:/Users/Administrator/desic-target cargo test --manifest-path src-tauri/Cargo.toml --test http_bridge`
Expected: FAIL（读不完整导致断言失败）。

- [ ] **Step 3: 实现 `http_bridge.rs` 读满 body + 路由骨架**

按上面 Interfaces 实现；`find_header_end` / `parse_content_length` 大小写不敏感；`dispatch` 先返回 `Ok(serde_json::json!(null))` 桩，`echo_test` 分支原样返回 body。

- [ ] **Step 4: 运行测试确认通过**

Run: 同上
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/http_bridge.rs src-tauri/tests/http_bridge.rs
git commit -m "feat(bridge): http bridge with content-length-safe body read"
```

---

### Task 3: build.rs codegen（生成 http_bridge_dispatch.rs）

**Files:**
- Modify: `src-tauri/build.rs`
- Create: `src-tauri/src/http_bridge_dispatch.rs`（由 build.rs 生成）

**Interfaces:**
- Consumes: `http_bridge::HttpBridge`（Task 2 的 `dispatch` 调用点）
- Produces: `pub fn dispatch(app: tauri::AppHandle, command: &str, body: &[u8]) -> Result<serde_json::Value, String>` —— 一个 match 覆盖 `generate_handler!` 里的全部 command（约 305 个）。
  - 每 arm：从 `body` 按 camelCase 反序列化参数（含 `tauri::State<'_, X>` 经 `app.state::<X>()` 取、`tauri::AppHandle` 直接传 clone）；调用真实函数；`Ok(v)` → `{"ok":true,"value":v}`；`Err(e)` → `{"ok":false,"error":e}`。

**Approach:** `build.rs` 里新增 codegen：读 `src/` 下所有 `#[tauri::command]` 前的 `pub async fn name(...)` / `fn name(...)` 签名（跳过 `//` 与 `/* */` 注释），结合 `generate_handler!` 的名单，emit Rust match。输出写入 `src/http_bridge_dispatch.rs`；`http_bridge.rs` 用 `include!` 引入。emit 前判断文件内容是否变化，未变化不重写（避免触发无谓重编译）。

- [ ] **Step 1: 写 codegen 的解析函数 + 单测**

在 `build.rs` 内实现 `fn parse_command_signatures(src: &str) -> Vec<CommandSig>`（`CommandSig { name, is_async, params: Vec<(param_name, ty)> }`），并写一个 `#[cfg(test)]` 测试对含注释/block 注释的样本断言解析结果正确。

- [ ] **Step 2: 跑 build 生成 dispatch**

Run: `CARGO_TARGET_DIR=C:/Users/Administrator/desic-target cargo build --manifest-path src-tauri/Cargo.toml`
Expected: 生成 `src-tauri/src/http_bridge_dispatch.rs`，`grep -c "=> dispatch"` 数等于 `generate_handler!` 命令数（约 305）。

- [ ] **Step 3: 冒烟一个真实 command**

Run: `POST /api/market_snapshot`（无参）
Expected: 返回 `{"ok":true,"value":{...}}`，`value` 含 `ticker` 字段。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/build.rs src-tauri/src/http_bridge_dispatch.rs
git commit -m "feat(bridge): build.rs codegen dispatch for 305 commands"
```

---

### Task 4: SSE 心跳 + 事件序号回放

**Files:**
- Modify: `src-tauri/src/http_bridge.rs`

**Interfaces:**
- Consumes: `EventBus`（Task 2）、`EVENT_REGISTRY`（Task 1）
- Produces: `GET /api/events?since=<seq>` 的 SSE 流；`EventBus` 新增 `seq: AtomicU64` 与 `history: RwLock<VecDeque<(u64, String)>>`（容量 8192，满则丢最旧）。

**Approach:** `app.listen_any` 回调里 `publish` 时附带自增 `seq` 并写入 history；`/api/events` 先回放 `>since` 的历史帧，再转实时；每 15s 发 `: ping` 注释帧保持连接。

- [ ] **Step 1: 写失败测试（重连回放）**

在 `http_bridge.rs` 的集成测试写：发 3 个事件 → 用 `?since=1` 订阅 → 断言收到 seq 2、3 两帧且不含 seq 1。

- [ ] **Step 2: 运行确认失败（当前无 seq/history）**

Run: `cargo test --test http_bridge`
Expected: FAIL。

- [ ] **Step 3: 实现 seq + history + since 回放 + 心跳**

按 Interfaces 实现。

- [ ] **Step 4: 运行确认通过**

Run: `cargo test --test http_bridge`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/http_bridge.rs
git commit -m "feat(bridge): SSE heartbeat and since-replay"
```

---

### Task 5: `--embedded` 无头模式接入

**Files:**
- Modify: `src-tauri/src/lib.rs:26333`（`run()`）
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/src/http_bridge.rs`

**Interfaces:**
- Consumes: `HttpBridge::new` / `serve`（Task 2）、dispatch（Task 3）、SSE（Task 4）
- Produces: `run()` 接受 `--embedded`（读 `std::env::args`）；embedded 分支：`.manage(...)` 全部状态初始化 + 建 `HttpBridge` 并 `spawn(serve)`，**跳过** splash/main 窗口创建；桌面分支行为不变。

**Approach:** 在 `run()` 顶部 `let embedded = std::env::args().any(|a| a == "--embedded");`；把「状态初始化 + invoke_handler」抽成与窗口创建解耦的步骤，embedded 时只跑前者并在 setup 里起桥。`dist_dir` 从 `CARGO_MANIFEST_DIR/../dist` 解析（dev）或 exe 旁 dist（release）。

- [ ] **Step 1: 写失败测试（embedded 无窗口也能 serve）**

集成测试：以 `--embedded` 参数启动 `desic-terminal` 二进制（或直接调 `run()` 的 embedded 分支），轮询 `http://127.0.0.1:17899/api/status` 直到返回 200（条件轮询，禁止 sleep 固定毫秒）。

- [ ] **Step 2: 运行确认失败（尚未实现 embedded 分支）**

Run: `cargo test --test http_bridge`
Expected: FAIL（端口无监听）。

- [ ] **Step 3: 实现 embedded 分支**

按 Interfaces 实现。

- [ ] **Step 4: 运行确认通过**

Run: 同上
Expected: PASS。

- [ ] **Step 5: 桌面模式回归**

Run: `CARGO_TARGET_DIR=C:/Users/Administrator/desic-target cargo check --manifest-path src-tauri/Cargo.toml --workspace`
Expected: 无 error；确认 `run()` 无 flag 时仍走原窗口创建路径。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/main.rs src-tauri/src/http_bridge.rs
git commit -m "feat(bridge): --embedded headless mode serves http bridge"
```
