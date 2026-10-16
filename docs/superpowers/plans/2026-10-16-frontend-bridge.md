# 前端桥接收敛（transport 模块）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让前端在 Tauri 与 iframe 两种环境下经同一桥边界调用后端，消除 `isTauriRuntime` 散落与直连 OKX。

**Architecture:** `src/lib/tauri.ts` 收敛为唯一 transport 模块，暴露 `transportMode`（tauri/iframe/none）与能力谓词；`invokeDesktop`/`invokeOptional` 在 iframe 走 `fetch POST /api/<command>`，`listenOptional` 走共享 EventSource（带 since 回放）。行情（`okx.ts`）桥优先。

**Tech Stack:** TypeScript、`@tauri-apps/api`、fetch、EventSource。

**Spec:** `docs/superpowers/specs/2026-10-16-iframe-embedding-design.md`

## Global Constraints

- `transportMode`: `'tauri'`（`__TAURI_INTERNALS__` 存在）、`'iframe'`（无 Tauri 且能连 `127.0.0.1:17899`）、`'none'`。
- `invokeDesktop` iframe 分支：`fetch('http://127.0.0.1:17899/api/<command>', {method:'POST', body: JSON.stringify(args)})`，解包 `{ok, value, error}`。
- `listenOptional` iframe 分支：共享 EventSource，重连带 `?since=<seq>`。
- renderer 内**禁止**直连 OKX；行情一律桥优先。
- 前端构建 `CODEBUDDY_SAFE_DELETE_ENABLED=0 npm run build`。

## Review Focus

1. **无 Tauri 时 `invokeDesktop` 静默返回 null 导致功能半残** → iframe 分支必须真正走 HTTP 桥。测试：Task 1 的 transport 模式测试。
2. **SSE 重连丢事件** → EventSource 需带 since 回放。测试：Task 3 的 since 测试。
3. **行情直连 OKX 残留** → `okx.ts` 必须全部桥优先。测试：Task 4 的桥优先断言。
4. **`isTauriRuntime` 仍是硬判断** → 应改为能力谓词。测试：Task 2 的谓词测试。
5. **前端日志循环依赖** → `logger.ts` 不 import `tauri.ts`。测试：Task 5 的构建。

---

### Task 1: transport 模式判定

**Files:**
- Modify: `src/lib/tauri.ts:80`（`isTauriRuntime` 处）

**Interfaces:**
- Produces:
  - `export type TransportMode = 'tauri' | 'iframe' | 'none'`
  - `export function detectTransportMode(): TransportMode` —— 有 `__TAURI_INTERNALS__` → `'tauri'`；否则探测 `fetch('http://127.0.0.1:17899/api/status')` 可达 → `'iframe'`；否则 `'none'`。
  - `export const transportMode: TransportMode`（模块加载时惰性检测）。

**Approach:** 惰性单次检测并缓存；`none` 时为纯预览兜底。

- [ ] **Step 1: 写失败测试（iframe 被误判为 none）**

在 `src/lib/tauri.test.ts`（若有测试框架；否则用脚本）断言：mock `__TAURI_INTERNALS__` 不存在且 `/api/status` 返回 200 时，`detectTransportMode()` 为 `'iframe'`。

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- <测试>`
Expected: FAIL（当前只有 isTauriRuntime 布尔）。

- [ ] **Step 3: 实现 detectTransportMode**

按 Interfaces 实现。

- [ ] **Step 4: 运行确认通过 + 构建**

Run: 测试 PASS；`CODEBUDDY_SAFE_DELETE_ENABLED=0 npm run build`
Expected: 无 error。

- [ ] **Step 5: Commit**

```bash
git add src/lib/tauri.ts
git commit -m "feat(bridge): transport mode detection"
```

---

### Task 2: 能力谓词

**Files:**
- Modify: `src/lib/tauri.ts`

**Interfaces:**
- Produces:
  - `export function supportsNativeWindow(): boolean`（= transportMode === 'tauri'）
  - `export function supportsVoiceCapture(): boolean`（iframe 下仍可用麦克风，返回 true；由语音降级路径决定）
  - `export function hasBackend(): boolean`（transportMode !== 'none'）

**Approach:** 谓词基于 `transportMode`，不重复检测。

- [ ] **Step 1: 写失败测试（谓词缺失）**

断言 `supportsNativeWindow()` 在 tauri 为 true、iframe 为 false；`hasBackend()` 在 iframe 为 true。

- [ ] **Step 2: 运行确认失败 → 实现 → 通过 → Commit**

```bash
git add src/lib/tauri.ts
git commit -m "feat(bridge): capability predicates"
```

---

### Task 3: invokeDesktop/invokeOptional/listenOptional 双路实现

**Files:**
- Modify: `src/lib/tauri.ts:120`（invokeOptional）、`:240`（invokeDesktop）、`:251`（listenOptional）

**Interfaces:**
- Produces: 三个函数按 `transportMode` 分流：tauri 走现有 invoke/listen；iframe 走 fetch/EventSource；none 返回 null。
- `invokeDesktop<T>(command, args?, options?): Promise<T | null>`；`invokeOptional<T>` 同；`listenOptional<T>(event, handler): Promise<(() => void) | null>`。

**Approach:** iframe 的 EventSource 用模块级单例，重连携带最后 `seq`；`{ok:false,error}` 时按 `options.quiet` 决定 warn/throw。

- [ ] **Step 1: 写失败测试（iframe 下走 fetch）**

mock `transportMode='iframe'` + mock fetch，断言 `invokeDesktop('x')` 请求 `/api/x` 且解析 `{ok,value}`。

- [ ] **Step 2: 运行确认失败 → 实现 → 通过 → 构建 → Commit**

```bash
git add src/lib/tauri.ts
git commit -m "feat(bridge): dual-path invoke and listen"
```

---

### Task 4: 行情桥优先（禁直连 OKX）

**Files:**
- Modify: `src/lib/okx.ts`（8 个行情函数：fetchCandles/fetchTicker/fetchMarketTickers/fetchFundingRate/syncOkxTime/probeOkxStartupNetwork/2 个 WS 探测）

**Interfaces:**
- Consumes: `invokeDesktop`（Task 3）
- Produces: 8 个函数全部改 `invokeDesktop(..., { quiet: true })` 桥优先，浏览器直连仅作纯预览兜底；`connectMarketStream` 删除 `isTauriRuntime` 门，Tauri/iframe 共用后端行情流。

**Approach:** 每个函数先试桥，失败且 `transportMode==='none'` 才回退直连（纯预览）。

- [ ] **Step 1: 写失败测试（仍存在直连路径优先级）**

grep `okx.ts` 断言 `invokeDesktop` 调用先于 `fetch` 直连 OKX。

- [ ] **Step 2: 运行确认失败 → 实现 → 通过 → 构建 → Commit**

```bash
git add src/lib/okx.ts
git commit -m "fix(bridge): OKX market data bridge-first"
```

---

### Task 5: 前端日志走桥（避免循环依赖）

**Files:**
- Modify: `src/lib/logger.ts:19`（`isTauriRuntime` 处）

**Interfaces:**
- Produces: `writeFrontendLogOverHttp(level, msg, meta)` —— 直接 `fetch POST /api/frontend_log`（**不** import `tauri.ts`，避开循环依赖）；Tauri 环境仍走原生 invoke。

**Approach:** logger 内自实现 HTTP 写入，不依赖 transport 模块。

- [ ] **Step 1: 写失败测试（logger 无循环依赖 + 走桥）**

断言 `logger.ts` 不 `import` tauri.ts，且非 Tauri 时 `POST /api/frontend_log`。

- [ ] **Step 2: 运行确认失败 → 实现 → 通过 → 构建 → Commit**

```bash
git add src/lib/logger.ts
git commit -m "feat(bridge): frontend logs over http"
```
