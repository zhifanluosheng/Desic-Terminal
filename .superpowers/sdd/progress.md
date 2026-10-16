# SDD Progress — iframe embedding

Plan file: D:\Github\Vibe Coding\dsh-desktop\源码\Desic-Terminal\docs\superpowers\plans\2026-10-16-http-bridge.md

执行方式: Native/inline (multi_agent_v1 不可用)

## Rulings I made
- Ruling: 用 Native/inline 而非 SDD — 子代理工具不可用 — 代价: 无逐任务独立审查，靠最终整分支审查补
- Ruling: 文档先提交到 main — 文档是交付物非实现代码 — 代价: main 多一次 commit
- Ruling: worktree 放 .worktrees/iframe-embedding — 用户已同意 — 代价: 无
- Ruling: 命令数是 303 而非 305 — lib.rs 有 2 个注释掉的 command（strip_comments 正确排除）— 代价: 若前端调用这 2 个会 unknown command（但这 2 个本就不可用）
- Ruling: 参数类型需模块/外部crate全限定 — dispatch 里 use super::* 只能见 lib.rs 作用域 — 代价: build.rs 复杂化，但零重复逻辑正确
- Ruling: 用 Node 脚本做 CRLF/LF 混合文本替换 — PowerShell 行号操作易错 — 代价: 多次往返，但最终收敛

## Task 状态（计划 1: HTTP 桥）
- [x] Task 1: 事件常量清单 (event_registry.rs, 26 事件)
- [x] Task 2: HttpBridge 核心 (Content-Length 读满 + EventBus)
- [x] Task 3: build.rs codegen (303 command dispatch + 类型限定)
- [x] Task 4: SSE 心跳 + seq 回放 + install_listeners (3 单测绿)
- [x] Task 5: --embedded 无头模式 (curl 冒烟: /api/status 200 + market_snapshot 真实返回)

## 验证证据（计划 1）
- cargo build/check: 0 error（Task 3/5 均通过）
- cargo test --lib http_bridge::tests: 6 测试全绿（3 纯函数 + 3 EventBus）
- 冒烟: GET /api/status → {"commands":303,"ok":true,"port":17899}
- 冒烟: POST /api/market_snapshot → 完整 MarketSnapshot JSON
- 日志: embedded mode headless → bridge started → bootstrap complete（默认目录）
