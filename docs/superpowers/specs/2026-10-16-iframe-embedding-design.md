# Desic-Terminal 嵌入 DSH Desktop（Beta）—— 技术设计（重写版）

- 日期：2026-10-16
- 状态：待批准（HARD-GATE，未批准前不构建任何东西）
- 权威仓库：`D:\Github\Vibe Coding\dsh-desktop\源码\Desic-Terminal`（本设计所有文件路径均相对此仓库根）

## 0. 决策记录（用户已拍板）

| # | 决策点 | 用户选择 |
|---|---|---|
| 方案 | D1~D6 全部选 **(b)** | 无头模式 / build.rs codegen / SSE 心跳回放 / 布局驱动状态机 / 插件一致化 / transport 收敛 |
| Q1 | 插件 `/launch` 是否 spawn | **(ii)**：用户点击侧边栏入口时 spawn（非 START_ON_LOAD 自动拉起），然后软探测 → iframe |
| Q2 | embedded 无头模式数据目录 bootstrap | **(i)**：用默认数据目录自动 bootstrap，不弹选择 |
| Q3 | `open_chart_window` 等窗口类 command 行为 | **允许弹独立 Tauri 窗口**（用户主动触发；保留按需创建窗口能力，面板内分栏留待待办 8） |
| Q4 | 验证顺序 | 先交付 **CDP 复现台全自动证据 + 截图**，用户再一次性真人复核 |

## 1. Intent / Why

把 Desic-Terminal（Tauri 2 + React 19 加密永续合约交易终端）以**固定面板**无缝嵌入 DSH Desktop Beta（Electron 宿主，`2.0.17-beta.2`）。用户在宿主左侧栏点入口即出面板，视觉/交互与宿主一致；同时**根治图表首帧不自适应**这一历史顽疾。

本设计是「重写」而非「移植」：旧版 `D:\Github\Trading\Desic-Terminal-main` 已存在一套嵌入实现，但存在多处真实缺陷（见 §3），**本设计不照搬其代码**，只沿用 AGENTS.md 已定且经验证正确的架构结论。

## 2. 不可变约束（AGENTS.md 铁律，优先级最高，不重新设计）

1. 承载方式只允许同文档 `<iframe>`；`SetParent` / 无边框顶层窗口叠放 overlay / 屏幕镜像投屏 / `<webview>` 全部永久禁止。
2. renderer 内禁止直连 OKX（Electron renderer 里 OKX 被墙且无代理）；一切行情经 Rust HTTP 桥，Rust 持 `127.0.0.1:7890` 代理。
3. 下单/账户/风控/AI/语音/私账历史 100% 依赖 Rust 后端；禁止只搬前端空壳；私有数据经 Rust 签名。
4. DSH 插件：client `dsh.client.inject` 必须为 `[]`（带 `immediately:true`）；所需服务在 client.js 内 `exports.inject=[...]` 声明；host 用某服务必须在 `inject` 数组声明；`ctx.tools.register` 的 `output` 必须含 `{ schema, render }`；webServer 路由契约 `{ kind:'exact'|'prefix', path, handler }`。
5. 绝不在 host 侧插件 spawn 长驻子进程；禁止 `START_ON_LOAD` 自动拉起进程；进程由用户触发启动（本设计 Q1 定为「点入口时 spawn」）。
6. 禁止自行关闭/重启 DSH；改 profile 前备份 package.json + pnpm-lock.yaml。
7. 面板外框复用宿主 `--dsw-alias-*`，禁止新增 `--ds-*`、禁止硬编码颜色；面板内部保留 Terminal 样式体系；交易语义色不被宿主改写。
8. 动效 150–400ms、只动 transform/opacity/filter，必须有 `prefers-reduced-motion` 关闭分支。
9. 公共入口（市场/工作台切换/设置）由宿主保留，不遮挡不复制；不覆盖左侧会话栏；不另建聊天界面。

> 注：Q3 的「弹独立 Tauri 窗口」指 `open_chart_window` 等**用户主动触发**的正常 Tauri 窗口（带系统边框、由应用管理），**不是**第 2 条铁律禁止的「无边框顶层窗口叠放 overlay 承载方式」。二者不冲突：承载仍是 iframe，chart 窗口是独立功能。

## 3. 旧版缺陷（本设计要根治的 6 处）

| # | 缺陷 | 影响 |
|---|---|---|
| 1 | 后端运行形态 = 完整 Tauri 窗口，splash→main，嵌入时窗口仍在 | 引入「main 窗口 standby vis=0 卡死」类 bug |
| 2 | `gen_bridge.py` Python 正则解析 Rust 源码生成 dispatch | Python 脚本与 Rust 源码两处维护、正则脆弱、易漂移 |
| 3 | SSE 无心跳、无事件回放 | 断线重连丢事件；未验证 DSH 里 SSE 是否受 CSP/代理限制 |
| 4 | 图表 autoFit latch 绑定在「数据 ≥80 根」上 | 数据早于容器尺寸就绪时 latch 已 false，ResizeObserver 补 fit 被挡死 |
| 5 | 插件 README（SetParent）/ client.js（iframe）/ host index.js（SetParent 死代码）三处矛盾 | 维护混乱、残留危险死代码 |
| 6 | 约 55 处散落 `isTauriRuntime` 拦截 | 临时、易漏、无单一真相 |

## 4. 已定技术方案

### D1 — 后端运行形态：`--embedded` 无头模式（b）

- Rust 进程支持 `--embedded` 启动（或 `DESIC_EMBEDDED=1`）：**启动时不自动创建 splash/main 窗口**，只初始化运行时（行情流/SQLite/签名/AI）+ 启动 HTTP 桥 + 托管 dist。
- 独立桌面运行时无此 flag，照常走 splash→main 窗口流程。
- **数据目录**（Q2 决策）：embedded 模式用默认数据目录（`%APPDATA%/Roaming/com.desic.terminal`）自动 bootstrap，若从未初始化则用默认值自动完成，不弹选择。
- **窗口能力**（Q3 决策）：embedded 模式**保留按需创建窗口的能力**——`open_chart_window` 等用户主动触发的 command 仍可创建正常 Tauri 窗口；只是启动时不自动建窗。
- 实现要点：在 `src-tauri/src/lib.rs` 的 `run()` 顶部读 flag，embedded 分支复用现有 `.manage(...)` 状态初始化 + invoke 逻辑，跳过自动建窗；HTTP 桥作为独立模块挂接。

### D2 — command 暴露：`build.rs` 代码生成（b）

- 用 Rust `build.rs` 取代 `gen_bridge.py`：解析 `src/` 中 `#[tauri::command]` 函数签名 + `generate_handler!` 命令名单，在**每次 cargo build 时**生成 `http_bridge_dispatch.rs`。
- 单一事实源 = command 定义本身；不再存在「忘了跑 Python 脚本就漂移」。
- dispatch 语义保留（旧版正确之处，沿用）：每个 match 分支复用真实 `#[tauri::command]` 函数，零逻辑重复；`Result` 解包；`async` 自动 `.await`；camelCase 对齐 tauri。
- 前端仍走 `POST /api/<command>`。

### D3 — 传输协议：HTTP fetch + SSE 增强（b1）

- 保持 `POST /api/<command>`（request/response 天然匹配）+ `GET /api/events`(SSE) + `GET /api/status` + `GET /<path>`(dist)。
- SSE 增加：**心跳帧**（防中间层断连）+ **事件序号 `seq` + `?since=<seq>` 回放**（重连不丢事件）。
- 事件总线：`app.listen_any` 捕获所有 `app.emit` → 广播 → SSE。
- 验证项：SSE 在 DSH Electron renderer 里是否受 CSP/代理限制（待办 2，实测为准）。

### D4 — 图表首帧根治：布局驱动状态机（b）

- 把 autoFit 的 latch 从「数据根数 ≥80」改为「容器首次拿到非 0 尺寸 + 完成一次有效 fitContent」。
- 状态机：
  - `layoutReady`：容器 `getBoundingClientRect()` 宽高均非 0（ResizeObserver 触发）。
  - `fittedOnce`：完成首次有效 `fitContent()`。
  - `manualViewport`：用户滚轮/pointerdown/guide drag/Reset 才置位；置位后 RO 不再抢视口。
- `shouldRefit = (!fittedOnce && layoutReady) || (!manualViewport && sizeChanged)`。
- 保留诊断钩子 `window.__desicChartDebug()` / `__desicChartDebugHistory`（供 CDP 直读）。
- 面板切换用可见性/卸载 cleanup 处理 hide；每次尺寸变化让容器经历一次有效测量。

### D5 — 插件外壳：单一 iframe 实现，三处一致（b）

- host `lib/index.js`：只留 `/launch`（Q1 决策：用户点入口时 spawn 无头后端，**非** START_ON_LOAD 自动拉起）+ `/status` 软探测；**不残留任何 SetParent/overlay/心跳**；`inject=['tools','webServer']`；spawn 时清空 HTTP_PROXY/HTTPS_PROXY。
- client `lib/client.js`：`sidebar.panellist`（kind:list，需 `{id, order, label}`）+ `main`（kind:keyed）+ `settings.section` 三入口；iframe 打开 `http://127.0.0.1:17899`，软探测就绪前显示占位。
- README 重写为 iframe 版。
- package.json：`dsh.client = { platform:"web", immediately:true, inject:[] }` + `dsh.bundle.patch` + `exports["./client"]` + peer `@deepseek-ai/cordis >=4.0.1`。

### D6 — 前端桥接收敛：单一 transport 模块（b）

- `src/lib/tauri.ts` 收敛为唯一桥边界，暴露 `transportMode`（`tauri` | `iframe` | `none`）与能力谓词（`supportsNativeWindow` / `supportsVoiceCapture` 等）。
- `invokeOptional` / `invokeDesktop`：`tauri` 走 `invoke`，`iframe` 走 `fetch POST /api/<command>`，`none` 返回 null。
- `listenOptional`：`tauri` 走 `listen`，`iframe` 走共享 EventSource（带 `since` 回放）。
- 约 55 处散落 `isTauriRuntime` 改为查能力谓词（本阶段只建框架，逐项解锁属待办 5）。

## 5. 已核实的宿主契约（Beta 实测，写设计时的证据）

- 目标 DSH：`D:\Program Files\DSH Desktop Beta\`，版本 `2.0.17-beta.2`，home 目录 `C:\Users\Administrator\.dsh-beta`，profile `profiles/desktop`。
- slot 注册表真实可用：`sidebar.panellist`（`dsh-client-ui-sidebar/lib/client.js:504`，kind:"list"）、`main`（`dsh-client-ui-layout/lib/client.js:631`，kind:"keyed"）、`settings.section`、`shell.overlay` 等。
- `sidebar.panellist` 项契约（`sidebar/client.js:455-462`）：`{ id, order, label }`，label 可为 thunk。
- `main` 项契约：`ctx.slots.register({name:'main', key:PANEL_ID}, Component)`。
- client 模块模型：静态单文件 `window.__ModuleLoader__.load({id, factory})`（`dsh-client-modules/lib/index.js`）；`require()` 只能拿共享基线 + 已加载插件 + `dsh.client.external`。
- 当前权威仓库事实：`src-tauri/src/lib.rs` 118KB+，`generate_handler!` 在 L26373；已有 `build.rs`（仅 `tauri_build::build()`）；`src-tauri/Cargo.toml` 已是 workspace（12 crate）；`main.rs` 调 `desic_terminal_lib::run()`。
- 图表现状：`KlineChart.tsx` L445 `AUTO_FIT_READY_CANDLE_COUNT=80`、L1665 `if (canonicalCandles.length >= 80) setAutoFit(false)`；`chartAdapter.ts` L183-184 硬编码 `#000000`/`#9a9aa5`（需改主题变量）。
- `isTauriRuntime` 定义在 `tauri.ts:80` 与 `logger.ts:19`，全仓 17 文件 98 次匹配。
- `open_chart_window` 前端调用在 `okx.ts:516`，走 `invokeDesktop<ChartWindowSummary>("open_chart_window", ...)`。

## 6. Goals / Non-goals / Anti-goals

### Goals
1. 侧边栏入口即出面板，iframe 内 Desic 前端完整可用（行情/下单/账户/AI/语音）。
2. 图表首帧直接自适应（无需滚轮），价格轴与 K 线匹配、副图铺满。
3. 表格渲染与独立端一致，无闪烁无错位。
4. 核心无头脚本全绿（test:kline-merge / market-radar / orderflow / trade-review / risk-preview / i18n）。
5. 面板外框用 `--dsw-alias-*`，动效合规。

### Non-goals（本阶段不做）
- 多窗口归位为面板内分栏——本阶段允许 `open_chart_window` 弹独立 Tauri 窗口（Q3 决策），分栏留待待办 8。
- dsh-purge 浮动按钮去留——交用户决定，不在 Desic 侧硬改。
- 约 55 处 `isTauriRuntime` 全量逐个解锁——D6 只建框架，逐项解锁后续进行。

### Anti-goals（做成这些就算失败）
- 触发 DSH 崩溃 / RendererStartupFailure。
- 直连 OKX（renderer 内）。
- 残留任何 SetParent/overlay 死代码。
- 出现「seems to work / 应该可以了」式无证据结论。

## 7. 约束（工程环境）

- 构建：`CODEBUDDY_SAFE_DELETE_ENABLED=0 npm run build`；`CARGO_TARGET_DIR=C:/Users/Administrator/desic-target`。
- 改 Rust command 后 codegen 由 build.rs 自动跑（无需手动 Python）。
- 前端纯改动无需重建 exe（运行中 exe 从磁盘 serve dist，iframe 硬刷新即生效）。
- 插件 spawn 外部进程须清空 HTTP_PROXY/HTTPS_PROXY；Desic 用 `127.0.0.1:7890`，配置在 `%APPDATA%/Roaming/com.desic.terminal/proxy.local.json`。
- 端口：桥 `127.0.0.1:17899`，前端 dev `127.0.0.1:1420`。

## 8. 验证策略（与 verification-before-completion 一致）

- **图表首帧（待办 1，Q4 决策顺序）**：先交付 **CDP 复现台全自动证据 + 截图**（`tools/cdp-driver.mjs` + `tools/iframe-repro.html` 重写，本机 Chrome/Edge `--remote-debugging-port` + 原生 WebSocket CDP；iframe 是 OOPIF 需 `Target.getTargets`+`attachToTarget`；读 `__desicChartDebug`/`__desicChartDebugHistory`），再由用户一次性真人复核「开启即自适应」。
- **桥接**：305 command 桥用 `POST /api/<command>` 冒烟；SSE 用事件序号回放验证不丢事件；`/api/status` 健康检查。
- **回归**：Rust `cargo check`；前端 `npm run build`；核心无头脚本全绿；任何失败（即使非本次引入）点名报告。

## 9. 留给 builder 的决定

- 具体文件拆分与命名（如 http_bridge 模块内部结构、build.rs codegen 的解析实现细节）。
- 诊断钩子的具体字段形状（只要满足「CDP 可读 + 记录尺寸时间线」）。
- 复现台场景控制的具体实现。
