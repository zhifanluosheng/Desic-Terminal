// dsh-desic-terminal host 侧逻辑测试（node:test，零依赖）。
//
// 覆盖三条铁律级行为：
//   1. 插件加载（createHandlers/apply）绝不 spawn —— 只有 /launch 请求到达时才 spawn；
//   2. /launch 在探测已就绪时不 spawn；连续重复请求不重复 spawn（去抖窗口）；
//   3. spawn 目标不存在时返回可读错误，不抛异常。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  apply,
  createHandlers,
  spawnEmbedded,
  LAUNCH_DEBOUNCE_MS,
  BRIDGE_PORT,
} from '../src/index.js'

function fakeProbe(sequence) {
  const calls = { count: 0 }
  const probe = async () => {
    const step = sequence[Math.min(calls.count, sequence.length - 1)]
    calls.count += 1
    return step
  }
  return { probe, calls }
}

test('createHandlers 创建时绝不 spawn', () => {
  let spawnCalls = 0
  createHandlers({
    probe: async () => ({ ok: false, reason: 'down' }),
    launch: () => { spawnCalls += 1; return { ok: true, pid: 1 } },
  })
  assert.equal(spawnCalls, 0)
})

test('apply 注册且仅注册两条路由，且加载时不 spawn', () => {
  const routes = []
  const ctx = {
    effect: (fn) => fn(),
    webServer: { register: (route) => { routes.push(route); return () => {} } },
  }
  let spawnCalls = 0
  apply(ctx, {
    handlers: createHandlers({
      probe: async () => ({ ok: false, reason: 'down' }),
      launch: () => { spawnCalls += 1; return { ok: true, pid: 1 } },
    }),
  })
  assert.deepEqual(
    routes.map((route) => route.path).sort(),
    ['/api/desic-terminal/launch', '/api/desic-terminal/status'],
  )
  for (const route of routes) assert.equal(route.kind, 'exact')
  assert.equal(spawnCalls, 0)
})

test('status：桥就绪时报 ready，未就绪时报原因', async () => {
  const up = createHandlers({ probe: async () => ({ ok: true, info: { ok: true, port: BRIDGE_PORT, commands: 303 } }) })
  assert.deepEqual(await up.status(), {
    ready: true,
    port: BRIDGE_PORT,
    info: { ok: true, port: BRIDGE_PORT, commands: 303 },
    reason: null,
  })

  const down = createHandlers({ probe: async () => ({ ok: false, reason: '探测超时' }) })
  const payload = await down.status()
  assert.equal(payload.ready, false)
  assert.equal(payload.reason, '探测超时')
})

test('launch：已就绪时不 spawn', async () => {
  let spawnCalls = 0
  const handlers = createHandlers({
    probe: async () => ({ ok: true, info: {} }),
    launch: () => { spawnCalls += 1; return { ok: true, pid: 1 } },
  })
  assert.deepEqual(await handlers.launchRequest(), { ready: true, launched: false })
  assert.equal(spawnCalls, 0)
})

test('launch：未就绪时 spawn 一次，去抖窗口内不重复 spawn', async () => {
  let spawnCalls = 0
  let clock = 1_000_000
  const { probe } = fakeProbe([{ ok: false, reason: 'down' }])
  const handlers = createHandlers({
    probe,
    now: () => clock,
    launch: () => { spawnCalls += 1; return { ok: true, pid: 4242, logPath: 'X:/logs/desic-launch.log' } },
  })

  const first = await handlers.launchRequest()
  assert.equal(first.launched, true)
  assert.equal(first.pid, 4242)
  assert.equal(spawnCalls, 1)

  clock += LAUNCH_DEBOUNCE_MS - 1
  const second = await handlers.launchRequest()
  assert.deepEqual(second, { ready: false, launched: false, pending: true })
  assert.equal(spawnCalls, 1)

  // 去抖窗口之后仍可再次触发（进程可能启动失败）。
  clock += 2
  const third = await handlers.launchRequest()
  assert.equal(third.launched, true)
  assert.equal(spawnCalls, 2)
})

test('launch：spawn 失败时返回错误原因而不是抛异常', async () => {
  const handlers = createHandlers({
    probe: async () => ({ ok: false, reason: 'down' }),
    launch: () => ({ ok: false, error: '未找到可执行文件：X:/nope.exe' }),
  })
  const payload = await handlers.launchRequest()
  assert.equal(payload.launched, false)
  assert.match(payload.error, /未找到可执行文件/)
})

test('spawnEmbedded：可执行文件不存在时返回错误，不抛异常', () => {
  const result = spawnEmbedded({ exePath: 'X:/definitely/missing/desic-terminal.exe', logDir: 'X:/tmp' })
  assert.equal(result.ok, false)
  assert.match(result.error, /未找到可执行文件/)
})
