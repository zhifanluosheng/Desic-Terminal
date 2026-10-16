//! event_registry.rs — 后端事件的集中静态清单。
//!
//! HTTP 桥的 SSE 广播需要监听后端 emit 的每个全局事件。tauri 的
//! `listen_any` 不是通配符，而是「监听指定事件名的 Any target」，因此必须
//! 逐事件名注册。本清单是 SSE 订阅注册与事件名校验的单一事实源。
//!
//! 维护约定：新增/删除后端事件（`app.emit` / `window.emit` 的字符串字面量或
//! 事件常量值）时，必须同步更新此清单。`http_bridge` 据此注册监听。

/// (事件名, 来源模块) —— 覆盖全仓库 `app.emit` / `window.emit` / `.emit`。
pub const EVENT_REGISTRY: &[(&str, &str)] = &[
    // lib.rs 与市场行情
    ("market:event", "lib.rs"),
    ("kline:sync", "lib.rs"),
    ("trade:audit", "lib.rs"),
    ("ai:event", "lib.rs"),
    ("ai:chart-action", "lib.rs"),
    ("chart:alert-triggered", "lib.rs"),
    ("app:enter-main", "lib.rs"),
    ("chart-window:update", "lib.rs"),
    ("chart-window:state-changed", "lib.rs"),
    ("ai:session-title-updated", "lib.rs"),
    ("ai:automation-event", "lib.rs"), // ACCOUNT_POSITION_MODE_SWITCH_FAILED_EVENT
    // ai_automation
    ("strategy_signal", "ai_automation.rs"),
    // ai_ui_control
    ("ai:ui-action", "ai_ui_control.rs"),
    // app_updater
    ("app:update-state", "app_updater.rs"),
    ("app:update-download", "app_updater.rs"),
    // data_root_migration
    ("data-root-migration", "data_root_migration.rs"),
    // instrument_operations
    ("trade:instrument-operation", "instrument_operations.rs"),
    // intelligence
    ("intelligence:event", "intelligence.rs"),
    // market_radar
    ("market-radar:history-status", "market_radar.rs"),
    ("market-radar:directory-updated", "market_radar.rs"),
    // storage_config
    ("ai:config-updated", "storage_config.rs"),
    ("ui:locale-changed", "storage_config.rs"),
    // systematic
    ("systematic:event", "systematic.rs"),
    ("systematic:strategy-ai-editor-tool", "systematic.rs"),
    // voice
    ("voice:local-progress", "voice_local.rs"),
    ("voice:partial", "voice_stream.rs"),
];

/// 事件名是否存在（供 SSE 订阅与校验使用）。
pub fn event_name_known(name: &str) -> bool {
    EVENT_REGISTRY.iter().any(|(n, _)| *n == name)
}
