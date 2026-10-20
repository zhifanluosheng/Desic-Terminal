// dsh-desic-terminal —— client 侧：向 Desktop 注册工作台业务面板（整页 iframe）。
//
// 契约（工作台开发规范 §3.5，2026-10-12 版，随当前 Desktop 内置）：
//   - 单文件模块经 window.__ModuleLoader__.load({ id }) 载入，id 必须等于 npm 包名；
//   - register() 提供 title、业务组件与规范的 GitHub repository URL；
//   - Cordis 服务在 factory 返回对象的 inject 上声明（desktopWorkbenches）。
//
// 面板结构：customFrame 整页 iframe → http://127.0.0.1:17899/（Desic Rust HTTP 桥）。
// 未就绪时显示占位卡片：探测走宿主路由 /api/desic-terminal/status，
// 「启动终端」按钮 POST /api/desic-terminal/launch（host 侧 spawn，20s 去抖）。
window.__ModuleLoader__.load({
  id: 'dsh-desic-terminal',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const BRIDGE_URL = 'http://127.0.0.1:17899/'
    const STATUS_ROUTE = '/api/desic-terminal/status'
    const LAUNCH_ROUTE = '/api/desic-terminal/launch'
    const POLL_READY_MS = 5000
    const POLL_OFFLINE_MS = 3000
    const POLL_HIDDEN_MS = 15000
    const LAUNCH_STALL_MS = 120000

    // 宿主主题令牌：iframe 是独立文档，CSS 变量不会继承进去，必须主动推送。
    const THEME_TOKENS = [
      '--dsw-alias-bg-base',
      '--dsw-alias-bg-layer-1',
      '--dsw-alias-bg-layer-2',
      '--dsw-alias-bg-module-platform',
      '--dsw-alias-label-primary',
      '--dsw-alias-label-secondary',
      '--dsw-alias-label-caption',
      '--dsw-alias-border-l1',
      '--dsw-alias-border-l2'
    ]

    function readThemeTokens() {
      const style = getComputedStyle(document.documentElement)
      const tokens = {}
      for (const name of THEME_TOKENS) {
        const value = style.getPropertyValue(name).trim()
        if (value) tokens[name] = value
      }
      return tokens
    }

    /**
     * 工作台面板外框的圆角半径：宿主用 overflow + border-radius 裁切 iframe，
     * 应用内画的接缝亮边如果不带同样的圆角，左上角那一段会被裁掉（缺一块）。
     * 这里把实测半径传给应用，让它自己画出完整的圆角描边。
     */
    function readClipRadius(element) {
      let node = element && element.parentElement
      while (node && node !== document.body) {
        const style = getComputedStyle(node)
        const clips = /hidden|clip/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`)
        if (clips) {
          const radius = parseFloat(style.borderTopLeftRadius) || 0
          if (radius > 0) return radius
        }
        node = node.parentElement
      }
      return 0
    }

    const CSS = `
.dst-shell{position:relative;display:flex;flex-direction:column;flex:1;height:100%;min-height:0;min-width:0;box-sizing:border-box;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2023);font-family:inherit;font-size:13px;line-height:20px}
.dst-frame{flex:1;width:100%;height:100%;min-height:0;border:0;display:block;background:var(--dsw-alias-bg-base,#fff)}
.dst-center{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;min-height:0}
.dst-card{display:flex;flex-direction:column;align-items:center;gap:10px;max-width:560px;padding:28px 32px;border:1px solid var(--dsw-alias-border-l2,#dfe1e4);border-radius:12px;background:var(--dsw-alias-bg-module-platform,#f5f6f7);text-align:center;transition:opacity .2s ease-out}
.dst-card h2{margin:0;font-size:16px;line-height:24px;font-weight:600}
.dst-muted{margin:0;color:var(--dsw-alias-label-secondary,#5d6065);font-size:13px;line-height:20px}
.dst-note{margin:0;color:var(--dsw-alias-label-tertiary,#878a90);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dst-actions{display:flex;gap:8px;margin-top:6px;flex-wrap:wrap;justify-content:center}
.dst-actions button,.dst-overlay button{border:1px solid var(--dsw-alias-border-l2,#dfe1e4);background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;border-radius:6px;padding:6px 14px;font:inherit;font-size:13px;line-height:18px;cursor:pointer}
.dst-actions button:hover:not(:disabled),.dst-overlay button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,#eceef0)}
.dst-actions button:focus-visible,.dst-overlay button:focus-visible{outline:2px solid var(--dsw-alias-label-primary,#1f2023);outline-offset:2px}
.dst-actions button:disabled{cursor:default;color:var(--dsw-alias-label-secondary,#5d6065)}
.dst-actions .dst-primary{background:var(--dsw-alias-button-primary-fill,#3a67f7);color:var(--dsw-alias-label-primary-foreground,#fff);border-color:transparent}
.dst-actions .dst-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-button-primary-fill,#3a67f7))}
.dst-hint{margin:0;color:var(--dsw-alias-label-tertiary,#878a90);font-size:12px;line-height:18px;max-width:560px;text-align:center}
.dst-overlay{position:absolute;top:12px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2,#dfe1e4);border-radius:10px;background:var(--dsw-alias-bg-module-platform,#f5f6f7);box-shadow:0 8px 24px rgba(0,0,0,.14);font-size:12px;line-height:18px;white-space:nowrap;transition:opacity .2s ease-out}
@media (prefers-reduced-motion: reduce){.dst-card,.dst-overlay{transition:none}}
`

    function shortReason(value) {
      return typeof value === 'string' && value.length > 200 ? `${value.slice(0, 200)}…` : value
    }

    function DesicTerminalPanel({ active = true }) {
      const [phase, setPhase] = React.useState('probing') // probing | offline | launching | ready
      const [note, setNote] = React.useState('')
      const [mounted, setMounted] = React.useState(false)
      const [frameKey, setFrameKey] = React.useState(0)
      const stateRef = React.useRef({ phase: 'probing', mounted: false, launchAt: 0 })
      const activeRef = React.useRef(active)
      activeRef.current = active
      const frameRef = React.useRef(null)

      const pushTheme = React.useCallback(() => {
        const frame = frameRef.current
        const target = frame && frame.contentWindow
        if (!target) return
        try {
          target.postMessage({
            type: 'dsh-desic-theme',
            tokens: readThemeTokens(),
            radiusPx: readClipRadius(frame)
          }, '*')
        } catch {
          // iframe 尚未可访问时忽略，onLoad 时会再推一次
        }
      }, [])

      React.useEffect(() => {
        if (!mounted) return
        pushTheme()
        const observer = new MutationObserver(() => pushTheme())
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-theme', 'data-dsw-theme', 'data-color-scheme']
        })
        const media = window.matchMedia('(prefers-color-scheme: dark)')
        const onMedia = () => pushTheme()
        media.addEventListener?.('change', onMedia)
        const onMessage = (event) => {
          if (event.data && event.data.type === 'dsh-desic-theme-request') pushTheme()
        }
        window.addEventListener('message', onMessage)
        return () => {
          observer.disconnect()
          media.removeEventListener?.('change', onMedia)
          window.removeEventListener('message', onMessage)
        }
      }, [mounted, pushTheme])

      const probe = React.useCallback(async () => {
        try {
          const response = await fetch(STATUS_ROUTE, { cache: 'no-store', credentials: 'same-origin' })
          const data = await response.json()
          if (data?.ready) {
            const wasReady = stateRef.current.phase === 'ready'
            const wasMounted = stateRef.current.mounted
            stateRef.current.phase = 'ready'
            stateRef.current.mounted = true
            setMounted(true)
            setPhase('ready')
            setNote('')
            // 断开后重新就绪：换 key 重挂 iframe，避免停留在死掉的旧页面。
            if (wasMounted && !wasReady) setFrameKey((key) => key + 1)
            return
          }
          if (stateRef.current.phase === 'launching') {
            setNote('终端正在启动，等待就绪…')
            return
          }
          stateRef.current.phase = 'offline'
          setPhase('offline')
          setNote(data?.reason ? `后端未就绪（${shortReason(data.reason)}）` : '后端未就绪')
        } catch (error) {
          if (stateRef.current.phase === 'launching') {
            setNote('终端正在启动，等待就绪…')
            return
          }
          stateRef.current.phase = 'offline'
          setPhase('offline')
          setNote(`无法访问本机探针接口：${shortReason(String(error?.message ?? error))}`)
        }
      }, [])

      const launch = React.useCallback(async () => {
        stateRef.current.phase = 'launching'
        stateRef.current.launchAt = Date.now()
        setPhase('launching')
        setNote('正在启动 Desic Terminal…')
        try {
          const response = await fetch(LAUNCH_ROUTE, { method: 'POST', cache: 'no-store', credentials: 'same-origin' })
          const data = await response.json()
          if (data?.error) {
            stateRef.current.phase = 'offline'
            setPhase('offline')
            setNote(`启动失败：${shortReason(String(data.error))}`)
            return
          }
          if (data?.ready) {
            const wasMounted = stateRef.current.mounted
            stateRef.current.phase = 'ready'
            stateRef.current.mounted = true
            setMounted(true)
            setPhase('ready')
            setNote('')
            if (wasMounted) setFrameKey((key) => key + 1)
            return
          }
          if (data?.pending) { setNote('终端已在启动中，请稍候…'); return }
          if (data?.launched) { setNote(`已拉起终端进程（PID ${data.pid ?? '?'}），等待就绪…`); return }
          setNote('启动请求已发送，等待就绪…')
        } catch (error) {
          stateRef.current.phase = 'offline'
          setPhase('offline')
          setNote(`启动请求失败：${shortReason(String(error?.message ?? error))}`)
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        let timer = null
        const tick = async () => {
          if (!alive) return
          await probe()
          if (!alive) return
          const current = stateRef.current
          let delay = activeRef.current ? POLL_OFFLINE_MS : POLL_HIDDEN_MS
          if (current.phase === 'ready') delay = activeRef.current ? POLL_READY_MS : POLL_HIDDEN_MS
          if (current.phase === 'launching') {
            delay = 2000
            if (Date.now() - current.launchAt > LAUNCH_STALL_MS) {
              current.phase = 'offline'
              setPhase('offline')
              setNote('启动超时（2 分钟未就绪）。可在启动日志中排查后重试。')
            }
          }
          timer = setTimeout(tick, delay)
        }
        tick()
        return () => { alive = false; if (timer) clearTimeout(timer) }
      }, [probe])

      const launching = phase === 'launching'
      return h('div', { className: 'dst-shell' },
        mounted ? h('iframe', { key: frameKey, ref: frameRef, onLoad: pushTheme, className: 'dst-frame', src: BRIDGE_URL, title: 'Desic Terminal', allow: 'microphone; autoplay; fullscreen; clipboard-read; clipboard-write', allowFullScreen: true }) : null,
        !mounted ? h('div', { className: 'dst-center' },
          h('div', { className: 'dst-card' },
            h('h2', null, 'Desic Terminal'),
            h('p', { className: 'dst-muted' }, launching
              ? '交易终端正在启动，通常需要十几秒。'
              : '交易终端后端尚未运行。'),
            note ? h('p', { className: 'dst-note' }, note) : null,
            h('div', { className: 'dst-actions' },
              h('button', { type: 'button', className: 'dst-primary', disabled: launching, onClick: launch }, launching ? '正在启动…' : '启动终端'),
              h('button', { type: 'button', onClick: () => { void probe() } }, '重新检测'))),
          h('p', { className: 'dst-hint' }, 'Desic 前端经本机 127.0.0.1:17899 HTTP 桥与 Rust 后端通信；行情与交易数据不经过 DSH。')) : null,
        mounted && phase !== 'ready' ? h('div', { className: 'dst-overlay', role: 'status' },
          h('span', null, launching ? '等待终端就绪…' : '与终端的连接已断开'),
          !launching ? h('button', { type: 'button', onClick: launch }, '启动终端') : null,
          !launching ? h('button', { type: 'button', onClick: () => setFrameKey((key) => key + 1) }, '重新加载面板') : null,
          h('button', { type: 'button', onClick: () => { void probe() } }, '重新检测')) : null)
    }

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-dsh-plugin', 'dsh-desic-terminal')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'desic-terminal: panel styles')

      ctx.effect(() => ctx.desktopWorkbenches.register({
        title: 'Nuomi Terminal',
        panelTitle: 'Nuomi Terminal',
        repository: 'https://github.com/xiazhi88/Desic-Terminal',
        description: '加密永续合约交易终端：K 线、订单流、账户与 AI 自动化，整页嵌入 DSH；前端经本机 127.0.0.1:17899 HTTP 桥与 Rust 后端通信。',
        customFrame: true,
      }, DesicTerminalPanel), 'desic-terminal: register workbench')
    }

    return { apply, inject: ['desktopWorkbenches'] }
  },
})
