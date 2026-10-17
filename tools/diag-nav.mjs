import { spawn } from "node:child_process";
import { join } from "node:path";
const debugPort = 9224;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const pageUrl = new URL(`file:///${process.cwd().replace(/\\/g, "/")}/tools/iframe-repro.html`).href;
let msgId = 0; const pending = new Map();
function connect(u){return new Promise((res,rej)=>{const w=new WebSocket(u);w.onopen=()=>res(w);w.onerror=rej;w.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}};});}
function cdp(w,m,p={},s){const id=++msgId;const pl={id,method:m,params:p};if(s)pl.sessionId=s;w.send(JSON.stringify(pl));return new Promise((resolve,reject)=>pending.set(id,{resolve,reject}));}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn,t){const s=Date.now();while(Date.now()-s<t){const v=await fn();if(v)return v;await sleep(300);}throw new Error('timeout');}
const chrome=spawn(CHROME,[`--remote-debugging-port=${debugPort}`,"--headless=new","--no-first-run","--no-default-browser-check",`--user-data-dir=${join(process.cwd(),'.tmp-chrome-diag')}`,"--disable-gpu",pageUrl],{stdio:"ignore"});
try{
  let ws;
  await wait(async()=>{try{const r=await fetch(`http://127.0.0.1:${debugPort}/json`);const l=await r.json();const p=l.find(t=>t.type==='page');if(p){ws=await connect(p.webSocketDebuggerUrl);return true;}return false;}catch{return false;}},20000);
  const t=await wait(async()=>{const r=await cdp(ws,'Target.getTargets');return r.targetInfos.find(x=>x.url.includes('127.0.0.1:17899'));},20000);
  const {sessionId}=await cdp(ws,'Target.attachToTarget',{targetId:t.targetId,flatten:true});
  const r=await cdp(ws,'Runtime.evaluate',{expression:`(()=>{const els=[...document.querySelectorAll('[data-workspace]')].map(e=>e.getAttribute('data-workspace'));return {count:els.length, workspaces:els, bodyText:document.body.innerText.slice(0,300)};})()`,returnByValue:true},sessionId);
  console.log(JSON.stringify(r.result.value,null,2));
}catch(e){console.error('ERR',e.message);}finally{chrome.kill();}
