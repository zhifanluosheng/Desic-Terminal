// diag-shot.mjs — 诊断用：headless Chrome 打开 iframe 复现台 → 进终端 → 截整页图 + 读图表/布局诊断。
// 与 cdp-driver.mjs 的差异：截图走顶层 target（子帧 OOPIF 不能 Page.captureScreenshot）、
// 支持 --window-size、额外 dump 画布/容器几何与 __desicChartDebugHistory 尾部。
// 用法：node tools/diag-shot.mjs [timeoutMs] [debugPort] [width] [height]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const timeoutMs = Number(process.argv[2] || 150000);
const debugPort = Number(process.argv[3] || 9225);
const width = Number(process.argv[4] || 1600);
const height = Number(process.argv[5] || 1000);
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const pageUrl = new URL(`file:///${process.cwd().replace(/\\/g, "/")}/tools/iframe-repro.html`).href;

let msgId = 0;
const pending = new Map();
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(e);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      }
    };
  });
}
function cdp(ws, method, params = {}, sessionId) {
  const id = ++msgId;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, timeout) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) { last = e.message; }
    await sleep(300);
  }
  throw new Error(`timeout waiting for ${what} (last: ${JSON.stringify(last)})`);
}

async function main() {
  const profile = join(process.cwd(), ".tmp-chrome-diag-shot");
  mkdirSync(profile, { recursive: true });
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${debugPort}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    "--disable-gpu",
    "--hide-scrollbars",
    pageUrl
  ], { stdio: "ignore" });

  try {
    let topWs;
    await waitFor(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${debugPort}/json`);
        const list = await r.json();
        const page = list.find((t) => t.type === "page");
        if (page) { topWs = await connect(page.webSocketDebuggerUrl); return true; }
        return false;
      } catch { return false; }
    }, "CDP top page", timeoutMs);
    console.log("[diag] top page connected");

    const iframeTarget = await waitFor(async () => {
      const { targetInfos } = await cdp(topWs, "Target.getTargets");
      return targetInfos.find((t) => t.url.includes("127.0.0.1:17899"));
    }, "iframe target", timeoutMs);
    const { sessionId } = await cdp(topWs, "Target.attachToTarget", { targetId: iframeTarget.targetId, flatten: true });
    console.log("[diag] iframe attached:", sessionId);

    const evalIn = async (expression) => {
      const r = await cdp(topWs, "Runtime.evaluate", { expression, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "eval failed");
      return r.result?.value;
    };

    const viewport = await evalIn(`({ w: window.innerWidth, h: window.innerHeight, dpr: devicePixelRatio })`);
    console.log("[diag] iframe viewport:", JSON.stringify(viewport));

    // 等 app 进入主界面（工作台导航出现）
    await waitFor(async () => evalIn(`!!document.querySelector('[data-workspace="terminal"]')`), "workspace nav", timeoutMs);
    await evalIn(`(() => { const el = document.querySelector('[data-workspace="terminal"]'); if (el) el.click(); return true; })()`);
    console.log("[diag] clicked terminal workspace");

    // 等图表 canvas 且 fittedOnce
    await waitFor(async () => evalIn(`!!document.querySelector('canvas')`), "chart canvas", timeoutMs);
    await waitFor(async () => {
      const d = await evalIn(`window.__desicChartDebug ? window.__desicChartDebug() : null`);
      return d && d.layoutReady && d.fittedOnce;
    }, "chart fittedOnce", timeoutMs);
    console.log("[diag] chart fitted once");

    // 稳定一拍再采样
    await sleep(1500);

    const debug = await evalIn(`window.__desicChartDebug ? window.__desicChartDebug() : null`);
    console.log("[diag] __desicChartDebug:", JSON.stringify(debug, null, 2));

    const history = await evalIn(`(window.__desicChartDebugHistory || []).slice(-25)`);
    console.log("[diag] history tail:", JSON.stringify(history));

    const geometry = await evalIn(`(() => {
      const out = { canvases: [], chartPane: null, terminalRoot: null };
      for (const c of document.querySelectorAll('canvas')) {
        const r = c.getBoundingClientRect();
        out.canvases.push({ w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), cls: c.className || c.parentElement?.className || '' });
      }
      const pane = document.querySelector('[class*="chart-pane"], .chart-shell, [data-chart-root]');
      if (pane) { const r = pane.getBoundingClientRect(); out.chartPane = { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), cls: pane.className }; }
      const root = document.querySelector('#root, .app, .terminal');
      if (root) { const r = root.getBoundingClientRect(); out.terminalRoot = { w: Math.round(r.width), h: Math.round(r.height), cls: root.className }; }
      out.bodyScroll = { w: document.body.scrollWidth, h: document.body.scrollHeight };
      out.symbol = document.body.innerText.slice(0, 400);
      return out;
    })()`);
    console.log("[diag] geometry:", JSON.stringify(geometry, null, 2));

    // 顶层截图（含 iframe 内容）
    const shot = await cdp(topWs, "Page.captureScreenshot", { format: "png" });
    const shotDir = join(process.cwd(), "tools", "repro-shots");
    mkdirSync(shotDir, { recursive: true });
    const shotPath = join(shotDir, `diag-${Date.now()}.png`);
    writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
    console.log("[diag] screenshot saved:", shotPath);
    process.exitCode = 0;
  } finally {
    chrome.kill();
  }
}

main().catch((e) => {
  console.error("[diag] error:", e.message);
  process.exit(2);
});
