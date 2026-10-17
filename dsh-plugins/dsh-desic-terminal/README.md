# dsh-desic-terminal

Desic Terminal 的 DSH Desktop 工作台插件 —— 把本机的加密永续合约交易终端以**整页业务面板**嵌入 DSH Desktop。侧边栏入口、工作台模式切换、会话归属与恢复都由宿主接管，插件本身只负责面板与终端进程的对接。

- 前端不在插件内打包：面板是 `http://127.0.0.1:17899/` 的整页 iframe，由独立进程 `desic-terminal.exe`（`--embedded` 无头模式）serve；
- 桥协议（Desic-Terminal 仓库 `src-tauri/src/http_bridge.rs`）：`POST /api/<command>`（等价 tauri invoke）、`GET /api/events`（SSE）、`GET /api/status`（健康检查）、`GET /<path>`（dist 静态托管）；
- 本插件 host 侧只做两件事：探测桥状态、按需拉起终端 —— **插件加载时绝不 spawn**，`/launch` 20 秒去抖，spawn 时清空代理环境变量并落盘启动日志。

## 契约（工作台开发规范 2026-10-12，随当前 Desktop 内置）

- `package.json`：`dsh.bundle.patch → ./cordis.patch.yml`；`dsh.client.platform = "web"`；`dsh.client.inject` 含 `dsh-desktop-workbenches`；`exports["./client"]` 单文件客户端。
- host 入口 `src/index.js`：`name` / `inject = ['webServer']` / `apply`，路由注册在 `/api/desic-terminal/` 前缀下。
- client 入口 `lib/client.js`：`window.__ModuleLoader__.load({ id: 'dsh-desic-terminal', ... })` → `ctx.desktopWorkbenches.register({ ... }, Panel)`，`inject: ['desktopWorkbenches']`。
- 身份：`repository = https://github.com/xiazhi88/Desic-Terminal`（真实仓库，非占位）。

## 安装（本地开发，手动 profile 安装）

1. 备份 profile：`%APPDATA%\dsh-desktop\harness\profiles\web\{package.json,pnpm-lock.yaml}`；
2. profile 的 `package.json` 增加依赖 `"dsh-desic-terminal": "link:<本目录绝对路径>"`，并在 `dsh.profile.bundles` 追加 `"dsh-desic-terminal"`；
3. 在 profile 目录运行 `pnpm install`（`harness\.desktop-bin\pnpm.cmd` 或系统 pnpm 均可）；
4. 完整退出并重开 DSH Desktop（插件在启动期加载）。

## 配置

- 终端可执行文件路径：环境变量 `DESIC_EXE_PATH`，默认 `C:/Users/Administrator/desic-target/debug/desic-terminal.exe`（debug 构建，`cargo build` 产物）；
- 启动日志：`<DSH_HOME>/logs/desic-launch-*.log`。

## 自检

```powershell
node --check src/index.js
node --check lib/client.js
node --test test/host-handlers.test.mjs
node scripts/verify-package.mjs
pnpm pack
```

## 文件结构

```
src/index.js          host：探针 + 一键启动（webServer 路由，纯逻辑可测）
lib/client.js         client：工作台注册 + 整页 iframe 面板（占位/重连/重载）
cordis.patch.yml      bundle patch（单条 insert）
test/                 host 逻辑测试（node:test）
scripts/              包契约校验
```
