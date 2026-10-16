# 图表首帧自适应与表格对齐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让图表在 iframe 内首次可见时直接自适应（无需滚轮），价格轴与 K 线匹配、副图铺满，且表格渲染与独立端一致。

**Architecture:** 把 `KlineChart.tsx` 的 autoFit latch 从「数据根数 ≥80」改为「布局驱动状态机」：容器首次拿到非 0 尺寸 + 完成一次有效 `fitContent()` 才算就绪；用户手动操作视口才 latch 手动模式。保留 `__desicChartDebug` 诊断钩子供 CDP 直读。`chartAdapter.ts` 硬编码颜色改读主题变量。

**Tech Stack:** React 19、lightweight-charts v5、ResizeObserver、rAF。

**Spec:** `docs/superpowers/specs/2026-10-16-iframe-embedding-design.md`

## Global Constraints

- 布局驱动状态机：`layoutReady`（容器宽高均非 0）→ `fittedOnce`（完成首次 fitContent）→ `manualViewport`（用户操作才置位）。
- `shouldRefit = (!fittedOnce && layoutReady) || (!manualViewport && sizeChanged)`。
- 用户滚轮/pointerdown/guide drag/Reset 才 latch 手动视口；之后 ResizeObserver 不再抢视口。
- 保留 `window.__desicChartDebug()`（当前状态）与 `__desicChartDebugHistory`（尺寸时间线）。
- 面板切换用可见性/卸载 cleanup 处理 hide。
- 前端构建 `CODEBUDDY_SAFE_DELETE_ENABLED=0 npm run build`。

## Review Focus

1. **数据先于容器尺寸到达** → 布局状态机必须在数据已存在但容器还没尺寸时，等尺寸就绪后仍补一次 fitContent。测试：Task 2 的「延迟容器尺寸」复现。
2. **用户已手动缩放的视口被 RO 抢回** → `manualViewport` 置位后任何尺寸变化不得触发 fit。测试：Task 3 的 manual latch 测试。
3. **隐藏→切回后空白残留** → 卸载 cleanup 必须处理 hide，切回后重新走 layoutReady→fit。测试：Task 4 的切回测试。
4. **价格轴全范围、K 线压顶一条** → 首帧必须基于真实容器尺寸 fit。测试：Task 2 的首帧断言。
5. **图表颜色硬编码 `#000000`/`#9a9aa5`** → 必须读主题变量，主题切换后重绘。测试：Task 1 的主题变量断言。

---

### Task 1: chartAdapter 颜色主题化

**Files:**
- Modify: `src/ui/chartAdapter.ts:183-184`

**Interfaces:**
- Produces: `function resolveChartColors(): { background: string; textColor: string }` —— 读 `getComputedStyle(document.documentElement).getPropertyValue('--xxx')`（或现有主题 token 机制），替换硬编码 `#000000`/`#9a9aa5`。

**Approach:** 复用仓库已有主题 token 读取机制（若有）；否则读 CSS 变量，缺省回退到原值。

- [ ] **Step 1: 写失败测试（颜色不再硬编码）**

在 `chartAdapter` 相关单测断言：源码中不再出现字面量 `#000000`/`#9a9aa5` 作为图表颜色（用 `Select-String` 验证）。

- [ ] **Step 2: 运行确认失败**

Run: `Select-String -Path "src/ui/chartAdapter.ts" -Pattern "#000000|#9a9aa5"`
Expected: 命中（当前硬编码）。

- [ ] **Step 3: 实现 `resolveChartColors` 并替换**

按 Interfaces 实现。

- [ ] **Step 4: 运行确认通过**

Run: 同上
Expected: 无命中。

- [ ] **Step 5: 构建**

Run: `CODEBUDDY_SAFE_DELETE_ENABLED=0 npm run build`
Expected: 无 error。

- [ ] **Step 6: Commit**

```bash
git add src/ui/chartAdapter.ts
git commit -m "feat(chart): chartAdapter reads theme variables"
```

---

### Task 2: 布局驱动状态机（layoutReady + fittedOnce）

**Files:**
- Modify: `src/ui/KlineChart.tsx:445`（AUTO_FIT_READY_CANDLE_COUNT 处）、`:590`、`:1382-1397`、`:1663-1665`

**Interfaces:**
- Consumes: 现有 `autoFit` state、`ResizeObserver`
- Produces: 新增 refs `layoutReadyRef: boolean`、`fittedOnceRef: boolean`、`manualViewportRef: boolean`；`shouldRefit = (!fittedOnceRef.current && layoutReadyRef.current) || (!manualViewportRef.current && sizeChanged)`。

**Approach:** 移除「`canonicalCandles.length >= 80 → setAutoFit(false)`」的数据驱动 latch；改为 ResizeObserver 里：先判容器宽高是否均非 0（layoutReady），未 fit 过则 fitContent 并置 fittedOnce；之后仅当「非手动视口 且 尺寸变化」才补 fit。

- [ ] **Step 1: 写失败测试（数据先到、容器后到仍 fit）**

用 `tools/iframe-repro.html` + `tools/cdp-driver.mjs` 复现台：注入「容器尺寸晚于 K 线数据就绪」场景，断言首帧价格轴范围与 K 线匹配（非全范围压顶）。此测试先写，当前实现应失败。

- [ ] **Step 2: 运行确认失败（当前数据驱动 latch 挡死补 fit）**

Run: `node tools/cdp-driver.mjs <场景>`
Expected: FAIL（首帧畸形）。

- [ ] **Step 3: 实现布局驱动状态机**

按 Interfaces 实现；保留 rAF + `chart === chartRef.current` 守卫。

- [ ] **Step 4: 运行确认通过**

Run: 同上
Expected: PASS（首帧自适应）。

- [ ] **Step 5: 构建**

Run: `CODEBUDDY_SAFE_DELETE_ENABLED=0 npm run build`
Expected: 无 error。

- [ ] **Step 6: Commit**

```bash
git add src/ui/KlineChart.tsx
git commit -m "fix(chart): layout-driven first-frame fit state machine"
```

---

### Task 3: manualViewport latch（用户操作不被抢）

**Files:**
- Modify: `src/ui/KlineChart.tsx:3441`（onWheel）、pointerdown/guide drag/Reset 处理点

**Interfaces:**
- Produces: 滚轮、pointerdown、guide drag、Reset 任一用户操作置 `manualViewportRef.current = true`；Reset 额外允许恢复（置 false 并触发一次 fitContent）。

**Approach:** 在 4 个交互入口统一调 `latchManualViewport()`；Reset 走 `resetViewport()` 清手动标记后主动 fit。

- [ ] **Step 1: 写失败测试（手动缩放后尺寸变化不抢回）**

复现台：模拟用户滚轮缩放 → 改变容器尺寸 → 断言视口保持用户缩放（未被 fit 抢回）。

- [ ] **Step 2: 运行确认失败（当前无 manual latch）**

Run: `node tools/cdp-driver.mjs <场景>`
Expected: FAIL。

- [ ] **Step 3: 实现 manualViewport latch**

按 Interfaces 实现。

- [ ] **Step 4: 运行确认通过**

Run: 同上
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/ui/KlineChart.tsx
git commit -m "fix(chart): latch manual viewport against RO refit"
```

---

### Task 4: 诊断钩子 + 隐藏切回恢复

**Files:**
- Modify: `src/ui/KlineChart.tsx`

**Interfaces:**
- Produces:
  - `window.__desicChartDebug(): { layoutReady: boolean; fittedOnce: boolean; manualViewport: boolean; containerW: number; containerH: number; lastFitAt: number }`
  - `window.__desicChartDebugHistory: Array<{ t: number; w: number; h: number; event: string }>`
  - 卸载 cleanup 处理 hide（`useEffect` 返回 cleanup 断开 RO 并标记需要重新 layoutReady）。

**Approach:** 诊断钩子只读状态；history 数组 cap 500 条；cleanup 里 `layoutReadyRef.current = false; fittedOnceRef.current = false` 使切回后重新走 fit。

- [ ] **Step 1: 写失败测试（切回后自动恢复）**

复现台：隐藏面板（unmount）→ 重新挂载 → 断言 `__desicChartDebug()` 报告 layoutReady 且图表重新 fit。

- [ ] **Step 2: 运行确认失败**

Run: `node tools/cdp-driver.mjs <场景>`
Expected: FAIL（残留空白）。

- [ ] **Step 3: 实现诊断钩子 + cleanup**

按 Interfaces 实现。

- [ ] **Step 4: 运行确认通过**

Run: 同上
Expected: PASS。

- [ ] **Step 5: 构建 + Commit**

```bash
CODEBUDDY_SAFE_DELETE_ENABLED=0 npm run build
git add src/ui/KlineChart.tsx
git commit -m "feat(chart): debug hooks and hide-restore cleanup"
```

---

### Task 5: 复现台工具重写

**Files:**
- Create: `tools/cdp-driver.mjs`
- Create: `tools/iframe-repro.html`

**Interfaces:**
- Consumes: `http://127.0.0.1:17899/api/status`（软探测）、`__desicChartDebug`（诊断读）
- Produces: `node tools/cdp-driver.mjs <场景名> [timeoutMs] [port]` —— 用本机 Chrome/Edge `--remote-debugging-port` + 原生 WebSocket CDP（不装 playwright）；流程：boot → 等 iframe target（`Target.getTargets` 按 URL `127.0.0.1:17899` `attachToTarget`）→ 点 `data-workspace="terminal"` → 等 chart canvas → 读诊断 → 截图。

**Approach:** 原生 WebSocket CDP，不装 playwright；iframe 是 OOPIF 必须按 URL attach；条件轮询等待，禁止固定 sleep。

- [ ] **Step 1: 写 `iframe-repro.html`**

仿 DSH 插件 placeholder→iframe 流程，带「延迟容器尺寸」场景开关。

- [ ] **Step 2: 写 `cdp-driver.mjs`**

按 Interfaces 实现全流程驱动。

- [ ] **Step 3: 冒烟（控制组）**

Run: 起 `desic-terminal.exe --embedded`（等 `/api/status` 200）→ `node tools/cdp-driver.mjs control`
Expected: 截图显示稳定尺寸下图表正常，诊断钩子可读。

- [ ] **Step 4: Commit**

```bash
git add tools/cdp-driver.mjs tools/iframe-repro.html
git commit -m "test(chart): reproducible iframe chart repro harness"
```
