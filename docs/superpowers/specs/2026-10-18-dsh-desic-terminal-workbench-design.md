# dsh-desic-terminal 工作台插件设计（新契约重写）

日期: 2026-10-18 · 状态: 已实施（待真实 DSH 验收）· 取代: `2026-10-16-dsh-plugin-shell.md` 中的插件外壳部分（HTTP 桥 / 前端 / 图表三份子计划不变）

## 背景与现状核实（全部实测）

- 宿主已升级为 DSH Desktop 0.12.0（`D:\Program Files\dsh-desktop\DSH Desktop`），DSH_HOME = `%APPDATA%\dsh-desktop\harness`，活动 profile = `web`。
- workbench 正式契约已落地：`dsh-desktop-workbenches` 包 + 工作台市场 + 《工作台开发规范》（2026-10-12，随应用内置）+ 活样例（dsh-content-workbench 等已装工作台）。
- 旧插件（旧 slot API）源码与安装均不存在；旧设计文档记录的目标环境（Beta 2.0.17-beta.2 / `.dsh-beta`）已过期。

## 决策（用户拍板）

- **D1 启动方式**: 面板内一键启动（用户点击时 host spawn，非插件加载自动拉起）。与 AGENTS.md §2.2.1 字面冲突，用户明确裁决；`apply` 加载路径仍保持零 spawn。
- **D2 安装**: 授权手动 profile 安装（备份 → `link:` 依赖 + bundles 追加 → app 自带 pnpm install → 用户手动重启 DSH）。

## 契约（全部来自活证据，非文档推断）

- 包: `name`/`main`/`exports` + `dsh.bundle.patch` + `dsh.client{platform:'web', inject:['dsh-desktop-workbenches']}` + peerDeps(cordis, dsh-host-webserver)。
- host: `inject = ['webServer']`，`ctx.webServer.register({kind:'exact', path, handler})`，路由前缀 `/api/desic-terminal/`。
- client: `window.__ModuleLoader__.load({id:'dsh-desic-terminal'})` → `ctx.desktopWorkbenches.register({title, repository, description, customFrame:true}, Panel)`，`inject:['desktopWorkbenches']`。
- 身份: `repository = https://github.com/xiazhi88/Desic-Terminal`（真实仓库）→ 身份 `xiazhi88/desic-terminal`，本地未上架亦可注册。
- 面板 props: `{service, entry, active, conversation}`；customFrame 容器链 `.dshWbFrame → HeaderHost(.dshWbCustomFrame) → PanelBoundary` 为 flex 列 → 根容器 `flex:1; min-height:0` 撑满。
- 样式: `--dsw-alias-*` token（安全 fallback 写法）；`prefers-reduced-motion` 降级。

## 行为

- 探测: client 轮询 host 路由 `/api/desic-terminal/status`（3s / 就绪 5s / 隐藏 15s）；host 侧 fetch `127.0.0.1:17899/api/status`（1.5s 超时）→ 未就绪显示占位卡片（启动 / 重试）。
- 启动: POST `/api/desic-terminal/launch` → host 先探测（已就绪不 spawn）；20s 去抖；spawn 时清 `HTTP_PROXY/HTTPS_PROXY` 等代理变量，`detached + windowsHide`，stdout/stderr 落 `<DSH_HOME>/logs/desic-launch-*.log`。
- iframe: 就绪即挂载 `http://127.0.0.1:17899/`（保持挂载）；断开显示覆盖条（启动 / 重新加载面板 / 重新检测）；重新就绪自动换 key 重挂。
- exe 路径: `DESIC_EXE_PATH` 覆盖，默认 debug 构建 `C:/Users/Administrator/desic-target/debug/desic-terminal.exe`。

## 非目标（v1）

- 不渲染宿主 conversation 节点（整页业务形态；规范允许按需放置）。
- 不上架市场（本地开发形态；repository 为真实仓库，具备上架条件）。
- 不改 HTTP 桥协议与 Desic 前端（本设计只重写插件外壳）。

## 风险与回滚

- profile 改动已备份: `package.json.bak-desic-20261018-0012` / `pnpm-lock.yaml.bak-desic-20261018-0012`；回滚 = 还原备份 + 删除 `node_modules\dsh-desic-terminal` + 重启。
- 若工作台未出现在切换器: 检查 native bundle 上报与 client 模块加载日志（`.generations` / harness 日志）。

## 验收清单（重启后）

1. 工作台切换器出现 “Desic Terminal”（市场-已安装显示本地工作台）。
2. 打开面板 → 占位卡 → 「启动终端」→ desic-terminal.exe 拉起 → 探针就绪 → iframe 加载 Desic 界面。
3. 图表首帧（SDD 待办 1）在真实 DSH 内验证（K 线容器尺寸变化 → 自适应）。
4. 断开场景: 杀掉 exe → 覆盖条出现 → 「启动终端」恢复。

## 验证证据（本地）

- `node --test`: 7/7 绿（apply 零 spawn / 去抖 / 错误路径 / 缺 exe）。
- `node scripts/verify-package.mjs`: OK；`pnpm pack` tgz 清单与 `files` 白名单一致。
- 隔离目录实测 `link:` 含空格 + 中文路径: junction + import 通过（v10.34.5）。
- profile 安装: “Already up to date”；junction 指向插件目录；import 解析通过；lockfile 记录 link 条目；生成代际投影自动恢复。
