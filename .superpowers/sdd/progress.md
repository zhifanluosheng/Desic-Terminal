# SDD Progress — iframe embedding

Plan file: D:\Github\Vibe Coding\dsh-desktop\源码\Desic-Terminal\docs\superpowers\plans\2026-10-16-http-bridge.md

执行方式: Native/inline (multi_agent_v1 不可用)

## Rulings I made
- Ruling: 用 Native/inline 而非 SDD — 子代理工具不可用 — 代价: 无逐任务独立审查，靠最终整分支审查补
- Ruling: 文档先提交到 main — 文档是交付物非实现代码 — 代价: main 多一次 commit
- Ruling: worktree 放 .worktrees/iframe-embedding — 用户已同意 worktree — 代价: 无

## Task 状态
- [ ] Task 1: 事件常量清单
- [ ] Task 2: HttpBridge 核心
- [ ] Task 3: build.rs codegen
- [ ] Task 4: SSE 心跳回放
- [ ] Task 5: --embedded 无头模式
