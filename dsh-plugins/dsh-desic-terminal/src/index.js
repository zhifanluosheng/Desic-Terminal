// dsh-desic-terminal —— host 侧（Harness 服务端）入口。
//
// 职责（工作台开发规范 §3.4：本机接口注册在自己的 /api/<工作台 id>/ 前缀下）：
//   1. GET  /api/desic-terminal/status → 探测 Desic HTTP 桥（127.0.0.1:17899）是否就绪；
//   2. POST /api/desic-terminal/launch → 用户点击「启动终端」时拉起 desic-terminal.exe --embedded。
//
// 铁律（用户裁决版）：插件加载（apply）绝不 spawn；仅在 /launch 主动请求到达时
// spawn 一次，20 秒去抖窗口内不重复拉起；spawn 时清空宿主代理环境变量并落盘启动日志。
import { spawn as nodeSpawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-desic-terminal'
export const inject = ['webServer']

export const BRIDGE_PORT = 17899
export const LAUNCH_DEBOUNCE_MS = 20_000

const BRIDGE_STATUS_URL = `http://127.0.0.1:${BRIDGE_PORT}/api/status`
const PROBE_TIMEOUT_MS = 1500
const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']
const DEFAULT_EXE_PATH = 'C:/Users/Administrator/desic-target/debug/desic-terminal.exe'

export function resolveExePath(env = process.env) {
  return env.DESIC_EXE_PATH || DEFAULT_EXE_PATH
}

export function resolveLogDir(env = process.env) {
  const home = env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'logs')
}

// 探测桥：1.5 秒超时，任何失败都折叠为 { ok:false, reason }，永不抛。
export async function probeBridge(fetchImpl = fetch) {
  try {
    const response = await fetchImpl(BRIDGE_STATUS_URL, {
      cache: 'no-store',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` }
    const info = await response.json()
    return info?.ok === true ? { ok: true, info } : { ok: false, reason: '桥返回非就绪状态' }
  } catch (error) {
    const message = error?.name === 'TimeoutError' ? '探测超时' : String(error?.message ?? error)
    return { ok: false, reason: message }
  }
}

// spawn 封装：spawn 本身是同步调用；日志写到 <DSH_HOME>/logs/desic-launch-*.log。
export function spawnEmbedded({ exePath, logDir, spawnImpl = nodeSpawn, now = () => new Date() } = {}) {
  if (typeof exePath !== 'string' || exePath === '' || !existsSync(exePath)) {
    return { ok: false, error: `未找到可执行文件：${exePath || '(空路径)'}` }
  }
  try {
    mkdirSync(logDir, { recursive: true })
    const stamp = now().toISOString().replace(/[:.]/g, '-')
    const logPath = join(logDir, `desic-launch-${stamp}.log`)
    const fd = openSync(logPath, 'a')
    const env = { ...process.env }
    for (const key of PROXY_ENV_KEYS) delete env[key]
    try {
      const child = spawnImpl(exePath, ['--embedded'], {
        cwd: dirname(exePath),
        detached: true,
        windowsHide: true,
        stdio: ['ignore', fd, fd],
        env,
      })
      child.unref()
      return { ok: true, pid: child.pid, logPath }
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

function defaultLaunch() {
  return spawnEmbedded({ exePath: resolveExePath(), logDir: resolveLogDir() })
}

// 纯逻辑核心：探测 / 启动的决策都收敛在这里，便于测试（不碰进程、不碰网络）。
export function createHandlers({ probe = probeBridge, launch = defaultLaunch, now = () => Date.now() } = {}) {
  let lastLaunchAt = 0

  async function status() {
    const result = await probe()
    return {
      ready: result.ok === true,
      port: BRIDGE_PORT,
      info: result.ok ? result.info : null,
      reason: result.ok ? null : (result.reason ?? '未就绪'),
    }
  }

  async function launchRequest() {
    const current = await probe()
    if (current.ok) return { ready: true, launched: false }
    if (now() - lastLaunchAt < LAUNCH_DEBOUNCE_MS) return { ready: false, launched: false, pending: true }
    lastLaunchAt = now()
    const spawned = launch()
    if (!spawned?.ok) return { ready: false, launched: false, error: spawned?.error ?? '启动失败' }
    return { ready: false, launched: true, pid: spawned.pid, logPath: spawned.logPath }
  }

  return { status, launchRequest }
}

function sendJson(res, payload, statusCode = 200) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

export function apply(ctx, overrides = {}) {
  const handlers = overrides.handlers ?? createHandlers()

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/desic-terminal/status',
    handler: (req, res) => {
      if (req.method && req.method !== 'GET') return sendJson(res, { error: 'method not allowed' }, 405)
      handlers.status()
        .then((payload) => sendJson(res, payload))
        .catch((error) => sendJson(res, { error: String(error?.message ?? error) }, 500))
    },
  }), 'dsh-desic-terminal: status route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/desic-terminal/launch',
    handler: (req, res) => {
      if (req.method && req.method !== 'POST') return sendJson(res, { error: 'method not allowed' }, 405)
      handlers.launchRequest()
        .then((payload) => sendJson(res, payload))
        .catch((error) => sendJson(res, { error: String(error?.message ?? error) }, 500))
    },
  }), 'dsh-desic-terminal: launch route')
}
