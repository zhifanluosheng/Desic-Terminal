# DSH 插件外壳（iframe 一致化）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 产出单一 iframe 实现的 `dsh-desic-terminal` 插件：host 只留 `/launch`（点入口时 spawn 无头后端）+ `/status` 软探测，无任何 SetParent/overlay 死代码；client 注册 `sidebar.panellist`+`main`+`settings.section` 三入口，iframe 打开 `127.0.0.1:17899`。

**Architecture:** 全新手写插件包（不照搬旧版）。host `lib/index.js` 用 `inject=['tools','webServer']`，`/launch` 在请求到达时 spawn `desic-terminal.exe --embedded`（清空代理），`/status` 探测桥健康；client `lib/client.js` 走 `window.__ModuleLoader__.load`，`exports.inject=['slots']`，panel 组件软探测后挂 iframe。

**Tech Stack:** Node ESM（host）、React（client 经 `require('react')` 共享宿主实例）、Cordis、`window.__ModuleLoader__`。

**Spec:** `docs/superpowers/specs/2026-10-16-iframe-embedding-design.md`

## Global Constraints

- `package.json` 的 `dsh.client.inject` **必须为 `[]`**（带 `immediately:true`）；所需服务在 client.js 内 `exports.inject=[...]` 声明。
- host 用服务必须在 `inject` 数组声明：`inject=['tools','webServer']`。
- `ctx.tools.register` 的 `output` 必须含 `{ schema, render }`，`render` 返回 `[{type:'text',text}]`；直接用 `ctx.tools.register(spec)`，勿用 `ctx.effect` 包裹。
- webServer 路由契约 `{ kind:'exact'|'prefix', path, handler(req,res) }`，无 method 字段。
- spawn 外部进程须清空 `HTTP_PROXY`/`HTTPS_PROXY`。
- 不 spawn 长驻进程；`/launch` 仅在用户点入口的请求到达时 spawn。
- 外框复用 `--dsw-alias-*`，禁硬编码颜色（`THEME_BG #050508` 这类硬编码也需改为读主题变量）。
- 安装/改 profile 需重启 DSH（用户手动）；改前备份 package.json + pnpm-lock.yaml。

## Review Focus

1. **`dsh.client.inject` 误填服务名 → RendererStartupFailure** → 必须保持 `[]`。测试：Task 1 的 package.json 断言。
2. **host 残留 SetParent/overlay/心跳** → 必须无 `SetParent`/`overlay`/`HWND_TOPMOST`/`心跳`。测试：Task 3 的 grep 断言。
3. **`/launch` 在插件加载时误触发** → 必须只在请求到达时 spawn，无 START_ON_LOAD。测试：Task 2 的加载不 spawn 断言。
4. **iframe 未就绪时报错闪屏** → 软探测未就绪显示占位。测试：Task 4 的占位测试。
5. **侧边栏入口注册失败（slot 契约）** → `sidebar.panellist` 项须 `{id, order, label}`；`main` 项须 `{name:'main', key}`。测试：Task 4 的注册断言。

---

### Task 1: 插件包骨架 + package.json 契约

**Files:**
- Create: `dsh-plugins/dsh-desic-terminal/package.json`
- Create: `dsh-plugins/dsh-desic-terminal/cordis.patch.yml`
- Create: `dsh-plugins/dsh-desic-terminal/README.md`

**Interfaces:**
- Produces: `package.json` 含 `main: "lib/index.js"`、`exports["./client"]="./lib/client.js"`、`dsh.bundle.patch="./cordis.patch.yml"`、`dsh.client={platform:"web", immediately:true, inject:[]}`、`peerDependencies {"@deepseek-ai/cordis": ">=4.0.1"}`；`cordis.patch.yml` 为 `- insert: [{ id: desic-terminal, name: dsh-desic-terminal }]`。

**Approach:** 全新手写，README 明确为 iframe 版（与实现一致）。

- [ ] **Step 1: 写 package.json + cordis.patch.yml + README**

- [ ] **Step 2: 契约断言**

Run: `node -e "const p=require('./dsh-plugins/dsh-desic-terminal/package.json'); console.assert(Array.isArray(p.dsh.client.inject)&&p.dsh.client.inject.length===0,'inject must be []'); console.assert(p.dsh.client.immediately===true,'immediately'); console.log('ok')"`
Expected: `ok`。

- [ ] **Step 3: Commit**

```bash
git add dsh-plugins/dsh-desic-terminal/package.json dsh-plugins/dsh-desic-terminal/cordis.patch.yml dsh-plugins/dsh-desic-terminal/README.md
git commit -m "feat(plugin): scaffold dsh-desic-terminal iframe plugin"
```

---

### Task 2: host `/launch` + `/status`（点入口时 spawn，非加载时）

**Files:**
- Create: `dsh-plugins/dsh-desic-terminal/lib/index.js`

**Interfaces:**
- Produces:
  - `export const name = 'dsh-desic-terminal'`
  - `export const inject = ['tools','webServer']`
  - `export function apply(ctx)`
  - `POST /api/desic-terminal/launch`：spawn `desic-terminal.exe --embedded`（清空代理，`stdio:'ignore'`，日志写 `logs/desic-launch-*.log`）；重复 spawn 前先查 `/api/status`，已就绪则跳过。
  - `GET /api/desic-terminal/status`：`fetch('http://127.0.0.1:17899/api/status')` 透传健康状态。

**Approach:** 不注册 `desic_terminal_launch` 工具（本设计只走 webServer 路由 + client 点击）；若保留工具则必须满足 `output={schema,render}` 契约——本计划不保留工具，避免踩坑。

- [ ] **Step 1: 写失败测试（加载不 spawn）**

断言：`apply(ctx)` 被调用时**不**产生 `child_process.spawn` 调用（mock 记录）；仅当 `/launch` handler 被调用时才 spawn。

- [ ] **Step 2: 运行确认失败 → 实现 → 通过**

- [ ] **Step 3: Commit**

```bash
git add dsh-plugins/dsh-desic-terminal/lib/index.js
git commit -m "feat(plugin): host launch-on-demand and status probe"
```

---

### Task 3: 无 SetParent/overlay 死代码验证

**Files:**
- Modify: `dsh-plugins/dsh-desic-terminal/lib/index.js`（确认无残留）

**Interfaces:**
- Consumes: Task 2 产物
- Produces: host 侧无任何 `SetParent`/`overlay`/`HWND_TOPMOST`/`findWindow`/`心跳` 代码。

**Approach:** 全新文件本身无这些；本任务用 grep 断言锁定。

- [ ] **Step 1: grep 断言**

Run: `Select-String -Path "dsh-plugins/dsh-desic-terminal/lib/*.js" -Pattern "SetParent|HWND_TOPMOST|findWindow|overlay|heartbeat|心跳|enumWindows"`
Expected: 无命中。

- [ ] **Step 2: Commit（如无改动则跳过）**

---

### Task 4: client 三入口 + iframe 面板

**Files:**
- Create: `dsh-plugins/dsh-desic-terminal/lib/client.js`

**Interfaces:**
- Produces: `window.__ModuleLoader__.load({id:'dsh-desic-terminal', factory})`；`module.exports = { apply, inject:['slots'], name:'dsh-desic-terminal' }`。
  - `slots.inject('main', ...)` → `slots.register({name:'main', key:'desic-terminal'}, DesicTerminalPanel)`
  - `slots.inject('sidebar.panellist', ...)` → `slots.register({name:'sidebar.panellist', id:'desic-terminal', order:45, label: () => 'Desic Terminal'}, Icon)`
  - `slots.inject('settings.section', ...)` → 备用入口
  - `DesicTerminalPanel`：软探测 `127.0.0.1:17899/api/status`，未就绪显示占位，就绪后挂 `<iframe src="http://127.0.0.1:17899/">`。

**Approach:** 外框颜色读 `--dsw-alias-*`（不用硬编码 `#050508`）；动效 ≤400ms + `prefers-reduced-motion`。

- [ ] **Step 1: 写 client.js 三入口 + 面板**

- [ ] **Step 2: 注册契约断言**

grep 断言：`sidebar.panellist` 项含 `id`/`order`/`label`；`main` 项含 `key`。

- [ ] **Step 3: Commit**

```bash
git add dsh-plugins/dsh-desic-terminal/lib/client.js
git commit -m "feat(plugin): client sidebar/main/settings iframe entries"
```

---

### Task 5: 安装进 profile（需用户配合，不擅自重启）

**Files:**
- Modify: `C:/Users/Administrator/.dsh-beta/profiles/desktop/package.json`（备份后改）
- Modify: `C:/Users/Administrator/.dsh-beta/profiles/desktop/pnpm-lock.yaml`（随 pnpm install 生成）

**Interfaces:**
- Consumes: 插件包（Task 1-4）
- Produces: profile 依赖加 `"dsh-desic-terminal": "link:<插件绝对路径>"`，`dsh.profile.bundles` 追加 `"dsh-desic-terminal"`。

**Approach:** 此任务涉及改 profile，按铁律：① 先备份 `package.json.bak-<原因>-<时间戳>` + `pnpm-lock.yaml.bak-...`；② 改后**不重启**，明确标注「需用户手动重启 DSH」；③ 用 `node_modules` symlink 或 `dsh plugin` 命令（若无全局 dsh CLI 则手工 link）。

- [ ] **Step 1: 备份 profile 文件**

```powershell
Copy-Item "C:\Users\Administrator\.dsh-beta\profiles\desktop\package.json" "C:\Users\Administrator\.dsh-beta\profiles\desktop\package.json.bak-install-desic-$(Get-Date -Format yyyyMMdd-HHmmss)"
Copy-Item "C:\Users\Administrator\.dsh-beta\profiles\desktop\pnpm-lock.yaml" "C:\Users\Administrator\.dsh-beta\profiles\desktop\pnpm-lock.yaml.bak-install-desic-$(Get-Date -Format yyyyMMdd-HHmmss)"
```

- [ ] **Step 2: 写入依赖 + bundles**

- [ ] **Step 3: 提示用户手动重启 DSH（不代做）**

在报告里标注「已改 profile，需你手动完整退出并重新打开 DSH Desktop Beta 生效」，等待用户确认后再验证。

- [ ] **Step 4: Commit（仅提交插件源文件，不提交 profile）**
