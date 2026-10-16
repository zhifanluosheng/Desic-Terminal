#!/usr/bin/env node
// cdp-driver.mjs — 用本机 Chrome + 原生 WebSocket CDP 驱动 iframe 复现台（不装 playwright）。
// 流程：起 Chrome headless → 打开 iframe-repro.html → 等 iframe(OOPIF) target → attach
//       → 点 data-workspace="terminal" 导航 → 等 chart canvas → 读 __desicChartDebug → 截图。
// 用法：node tools/cdp-driver.mjs <场景名: control|delay> [timeoutMs] [debugPort]

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const scenario = process.argv[2] || "control";
const timeoutMs = Number(process.argv[3] || 30000);
const debugPort = Number(process.argv[4] || 9223);
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BRIDGE = "http://127.0.0.1:17899";
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
  while (Date.now() - start < timeout) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function main() {
  const profile = join(process.cwd(), ".tmp-chrome-profile");
  mkdirSync(profile, { recursive: true });

  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${debugPort}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    "--disable-gpu",
    "--hide-scrollbars",
    pageUrl
  ], { stdio: "ignore" });

  try {
    // 等 CDP 端口就绪
    let browserWs;
    await waitFor(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${debugPort}/json`);
        const list = await r.json();
        const page = list.find((t) => t.type === "page");
        if (page) {
          browserWs = await connect(page.webSocketDebuggerUrl);
          return true;
        }
        return false;
      } catch { return false; }
    }, "CDP page target", timeoutMs);

    console.log("[cdp] browser connected");

    // 等 iframe target（OOPIF，URL 127.0.0.1:17899）
    const iframeTarget = await waitFor(async () => {
      const { targetInfos } = await cdp(browserWs, "Target.getTargets");
      return targetInfos.find((t) => t.url.includes("127.0.0.1:17899"));
    }, "iframe (OOPIF) target", timeoutMs);

    console.log("[cdp] iframe target found:", iframeTarget.targetId);

    const { sessionId } = await cdp(browserWs, "Target.attachToTarget", {
      targetId: iframeTarget.targetId,
      flatten: true
    });
    console.log("[cdp] attached to iframe, session:", sessionId);

    // 在 iframe 里点 data-workspace="terminal"
    await waitFor(async () => {
      try {
        const r = await cdp(browserWs, "Runtime.evaluate", {
          expression: `(() => {
            const el = document.querySelector('[data-workspace="terminal"]');
            if (el) { el.click(); return true; }
            return false;
          })()`,
          returnByValue: true
        }, sessionId);
        return r.result && r.result.value === true;
      } catch { return false; }
    }, "terminal workspace nav", timeoutMs);

    console.log("[cdp] clicked terminal workspace nav");

    // 等 chart canvas
    await waitFor(async () => {
      const r = await cdp(browserWs, "Runtime.evaluate", {
        expression: `!!document.querySelector('canvas')`,
        returnByValue: true
      }, sessionId);
      return r.result && r.result.value === true;
    }, "chart canvas", timeoutMs);

    console.log("[cdp] chart canvas present");

    // 读诊断钩子
    const debug = await cdp(browserWs, "Runtime.evaluate", {
      expression: `window.__desicChartDebug ? window.__desicChartDebug() : null`,
      returnByValue: true
    }, sessionId);
    console.log("[cdp] __desicChartDebug:", JSON.stringify(debug.result?.value ?? null, null, 2));

    // 截图
    const shot = await cdp(browserWs, "Page.captureScreenshot", { format: "png" }, sessionId);
    const shotDir = join(process.cwd(), "tools", "repro-shots");
    mkdirSync(shotDir, { recursive: true });
    const shotPath = join(shotDir, `${scenario}-${Date.now()}.png`);
    writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
    console.log("[cdp] screenshot saved:", shotPath);

    // 判定：layoutReady && fittedOnce 即视为首帧自适应成功
    const v = debug.result?.value;
    const pass = v && v.layoutReady === true && v.fittedOnce === true;
    console.log(pass ? "[cdp] PASS: first-frame fit ok" : "[cdp] FAIL: first-frame fit not achieved");
    process.exitCode = pass ? 0 : 1;
  } finally {
    chrome.kill();
  }
}

main().catch((e) => {
  console.error("[cdp] error:", e.message);
  process.exit(2);
});
