import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { logger } from "./logger";

const activeListeners = new Map<string, number>();
const duplicateListenerWarningAt = new Map<string, number>();
const DUPLICATE_LISTENER_WARNING_INTERVAL_MS = 10_000;
const SUSPICIOUS_LISTENER_COUNT = 8;

type TauriEventPluginInternals = {
  unregisterListener: (event: string, eventId: number) => void;
};

const patchedEventInternals = new WeakSet<TauriEventPluginInternals>();

function missingTauriListenerError(error: unknown) {
  return /listeners\[eventId\]\.handlerId|undefined is not an object.*handlerId|cannot read properties of undefined.*handlerId/i
    .test(error instanceof Error ? error.message : String(error));
}

function installIdempotentEventUnregister() {
  const internals = (window as Window & {
    __TAURI_EVENT_PLUGIN_INTERNALS__?: TauriEventPluginInternals;
  }).__TAURI_EVENT_PLUGIN_INTERNALS__;
  if (!internals || patchedEventInternals.has(internals)) return;
  try {
    const unregister = internals.unregisterListener.bind(internals);
    internals.unregisterListener = (event, eventId) => {
      try {
        unregister(event, eventId);
      } catch (error) {
        // HMR can clear the WebView listener table before React cleanup runs.
        // Keep removal idempotent so Tauri can still unregister its backend listener.
        if (!missingTauriListenerError(error)) throw error;
      }
    };
    patchedEventInternals.add(internals);
  } catch (error) {
    logger.warn("tauri listener cleanup patch unavailable", { error: String(error) });
  }
}

function cleanupTauriListener(event: string, unlisten: () => void) {
  try {
    const pending = (unlisten as unknown as () => unknown)();
    if (pending && typeof (pending as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(pending).catch((error) => {
        if (!missingTauriListenerError(error)) {
          logger.warn("tauri listener cleanup failed", { event, error: String(error) });
        }
      });
    }
  } catch (error) {
    if (!missingTauriListenerError(error)) {
      logger.warn("tauri listener cleanup failed", { event, error: String(error) });
    }
  }
}

installIdempotentEventUnregister();

function updateListenerCount(event: string, delta: number) {
  const next = Math.max(0, (activeListeners.get(event) ?? 0) + delta);
  if (next === 0) activeListeners.delete(event);
  else activeListeners.set(event, next);
  if (import.meta.env.DEV && next > SUSPICIOUS_LISTENER_COUNT) {
    const now = Date.now();
    const lastWarningAt = duplicateListenerWarningAt.get(event) ?? 0;
    if (now - lastWarningAt >= DUPLICATE_LISTENER_WARNING_INTERVAL_MS) {
      duplicateListenerWarningAt.set(event, now);
      logger.warn("duplicate tauri listeners detected", { event, count: next });
    }
  }
}

export function getActiveTauriListenerCounts() {
  return Object.fromEntries(activeListeners);
}

export function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

// ===== D6 transport 收敛：单一桥边界 =====
export type TransportMode = "tauri" | "iframe" | "none";

const HTTP_BRIDGE_ORIGIN = "http://127.0.0.1:17899";

let cachedTransportMode: TransportMode | null = null;
let transportProbePromise: Promise<TransportMode> | null = null;

/** 惰性检测传输模式：tauri → iframe（HTTP 桥可达）→ none（纯预览）。 */
export function detectTransportMode(): Promise<TransportMode> {
  if (cachedTransportMode !== null) return Promise.resolve(cachedTransportMode);
  if (transportProbePromise) return transportProbePromise;
  transportProbePromise = (async () => {
    if (isTauriRuntime()) {
      cachedTransportMode = "tauri";
      return cachedTransportMode;
    }
    try {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 1500);
      const res = await fetch(`${HTTP_BRIDGE_ORIGIN}/api/status`, { mode: "cors", signal: controller.signal });
      window.clearTimeout(timer);
      if (res.ok) {
        cachedTransportMode = "iframe";
      } else {
        cachedTransportMode = "none";
      }
    } catch {
      cachedTransportMode = "none";
    }
    return cachedTransportMode;
  })();
  return transportProbePromise;
}

/** 是否有后端可调（tauri 或 iframe 桥）。 */
export function hasBackend(): boolean {
  return isTauriRuntime() || cachedTransportMode === "iframe";
}

/** 异步版 hasBackend：探测完成后判定。 */
export async function hasBackendAsync(): Promise<boolean> {
  await detectTransportMode();
  return hasBackend();
}

/** 是否支持原生窗口（仅 tauri）。 */
export function supportsNativeWindow(): boolean {
  return isTauriRuntime();
}

/** 是否支持语音采集（iframe 下仍可用麦克风，由语音降级路径决定）。 */
export function supportsVoiceCapture(): boolean {
  return true;
}

/** 桥 fetch：POST /api/<command>，解析 {ok,value}/{ok,error}。 */
async function bridgeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${HTTP_BRIDGE_ORIGIN}/api/${command}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args ?? {})
  });
  if (!res.ok) {
    throw new Error(`bridge HTTP ${res.status} for ${command}`);
  }
  const envelope = await res.json() as { ok: boolean; value?: T; error?: string };
  if (!envelope.ok) {
    throw new Error(envelope.error ?? `bridge command failed: ${command}`);
  }
  return envelope.value as T;
}

/** 共享 EventSource（iframe 下的事件流），带 since 回放。 */
let sharedEventSource: EventSource | null = null;
let sharedEventSourceSeq = 0;
let sharedEventSourceRefs = 0;
const sharedEventHandlers = new Map<string, Set<(payload: unknown) => void>>();

function ensureSharedEventSource(): EventSource {
  if (sharedEventSource) return sharedEventSource;
  const es = new EventSource(`${HTTP_BRIDGE_ORIGIN}/api/events`);
  es.onmessage = (ev) => {
    try {
      const frame = JSON.parse(ev.data) as { seq: number; event: string; payload: unknown };
      if (frame.seq > sharedEventSourceSeq) sharedEventSourceSeq = frame.seq;
      const handlers = sharedEventHandlers.get(frame.event);
      if (handlers) {
        for (const h of handlers) h(frame.payload);
      }
    } catch {
      // 非 JSON 帧（如心跳）忽略。
    }
  };
  es.onerror = () => {
    // 断线后重连（浏览器自动重连；seq 用于回放，桥侧支持 ?since）。
    sharedEventSource = null;
  };
  sharedEventSource = es;
  return es;
}

export async function loadUiPreferences() {
  return invokeOptional<import("../types").UiPreferencesSummary>("ui_preferences_summary", {
    request: { systemLocale: navigator.languages?.[0] || navigator.language || "en-US" }
  });
}

export async function saveUiPreferences(language: import("../types").LanguagePreference) {
  return invokeDesktop<import("../types").UiPreferencesSummary>("save_ui_preferences", {
    request: { language, systemLocale: navigator.languages?.[0] || navigator.language || "en-US" }
  });
}

export async function loadAppUpdateStatus() {
  return invokeOptional<import("../types").AppUpdateState>("app_update_status");
}

export async function checkAppUpdate() {
  return invokeDesktop<import("../types").AppUpdateState>("app_update_check");
}

export async function prepareAppUpdate() {
  return invokeDesktop<import("../types").AppUpdateBackup>("app_update_prepare");
}

export async function installAppUpdate() {
  return invokeDesktop<void>("app_update_install");
}

export async function applySourceAppUpdate() {
  return invokeDesktop<import("../types").AppUpdateState>("app_update_apply_source");
}

export async function restartAfterSourceAppUpdate() {
  return invokeDesktop<void>("app_update_restart_source");
}

export async function invokeOptional<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  await detectTransportMode();
  if (cachedTransportMode === "iframe") {
    try {
      return await bridgeInvoke<T>(command, args);
    } catch (error) {
      logger.warn(`bridge command failed (optional): ${command}`, { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }
  if (!isTauriRuntime()) return null;
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    logger.error(`tauri command failed, falling back when possible: ${command}`, error);
    return null;
  }
}

// ===== 数据根引导（splash 阶段）=====
export type DataRootBootstrapState = {
  needsChoice: boolean;
  customRoot: string | null;
  dataDir: string;
  databaseExists: boolean;
  // 后端已登记待迁移：需要先完成迁移再初始化运行目录
  migrationPending: boolean;
  migrationTarget: string | null;
  /** 当前平台是否支持自定义数据目录（仅 Windows） */
  supported: boolean;
};

export type DataRootBootstrapOutcome = {
  dataDir: string;
  customRoot: string | null;
  databaseReady: boolean;
};

export async function dataRootBootstrapState() {
  return invokeDesktop<DataRootBootstrapState>("data_root_bootstrap_state");
}

export async function pickDataRootDirectory(current?: string | null) {
  return invokeDesktop<string | null>("pick_data_root_directory", { current: current ?? null });
}

export async function finalizeDataRootBootstrap(dataRoot?: string | null) {
  return invokeDesktop<DataRootBootstrapOutcome>("finalize_data_root_bootstrap", {
    dataRoot: dataRoot ?? null
  });
}

// ===== 数据目录迁移与用量（splash 迁移向导 / 设置页）=====
export type DataRootDirUsage = {
  label: string;
  path: string;
  bytes: number;
  files: number;
};

export type DataRootOverview = {
  /** 当前生效的数据目录（展示用） */
  dataRoot: string;
  /** 自定义数据根；null 表示默认位置 */
  customRoot: string | null;
  isCustomRoot: boolean;
  /** 当前平台是否支持自定义数据目录（仅 Windows） */
  supported: boolean;
  dirs: DataRootDirUsage[];
  totalBytes: number;
  totalFiles: number;
  /** 非 null = 有待迁移的目标路径 */
  pendingMigration: string | null;
  /** 迁移完成后旧数据所在位置（null = 无遗留） */
  oldDataRoot: string | null;
  oldDataBytes: number;
};

export type DataRootMigrationPhase = "idle" | "preparing" | "copying" | "verifying" | "switching" | "done" | "failed" | "cancelled";

export type DataRootMigrationProgress = {
  phase: DataRootMigrationPhase;
  copiedFiles: number;
  totalFiles: number;
  copiedBytes: number;
  totalBytes: number;
  currentPath: string;
  targetRoot: string | null;
  error: string | null;
  /** cache 通道内因被占用而跳过的文件数（可重建，不影响迁移结果） */
  skippedFiles: number;
};

/** 迁移过程中后端推送 MigrationProgress 的事件名 */
export const DATA_ROOT_MIGRATION_EVENT = "data-root-migration";

export async function dataRootOverview() {
  return invokeDesktop<DataRootOverview>("data_root_overview");
}

export async function requestDataRootMigration(targetRoot: string) {
  return invokeDesktop<void>("request_data_root_migration", { targetRoot });
}

export async function cancelDataRootMigration() {
  return invokeDesktop<void>("cancel_data_root_migration");
}

export async function restartApp() {
  return invokeDesktop<void>("restart_app");
}

export async function dataRootMigrationStatus() {
  return invokeDesktop<DataRootMigrationProgress>("data_root_migration_status");
}

export async function runDataRootMigration() {
  return invokeDesktop<DataRootMigrationProgress>("run_data_root_migration");
}

export async function cancelRunningDataRootMigration() {
  return invokeDesktop<void>("cancel_running_data_root_migration");
}

export async function cleanupOldDataRoot() {
  return invokeDesktop<void>("cleanup_old_data_root");
}

/** quiet：调用方自己处理失败（例如有回退路径）时只记 warn，不弹“前端代码异常”通知。 */
export async function invokeDesktop<T>(command: string, args?: Record<string, unknown>, options?: { quiet?: boolean }): Promise<T | null> {
  await detectTransportMode();
  if (cachedTransportMode === "iframe") {
    try {
      return await bridgeInvoke<T>(command, args);
    } catch (error) {
      if (options?.quiet) logger.warn(`bridge command failed (handled by caller): ${command}`, { error: error instanceof Error ? error.message : String(error) });
      else logger.error(`bridge command failed: ${command}`, error);
      throw error;
    }
  }
  if (!isTauriRuntime()) return null;
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    if (options?.quiet) logger.warn(`tauri command failed (handled by caller): ${command}`, { error: error instanceof Error ? error.message : String(error) });
    else logger.error(`tauri command failed: ${command}`, error);
    throw error;
  }
}

export async function listenOptional<T>(event: string, handler: (payload: T) => void): Promise<(() => void) | null> {
  await detectTransportMode();
  if (cachedTransportMode === "iframe") {
    const es = ensureSharedEventSource();
    let set = sharedEventHandlers.get(event);
    if (!set) {
      set = new Set();
      sharedEventHandlers.set(event, set);
    }
    const wrapped = (payload: unknown) => handler(payload as T);
    set.add(wrapped);
    sharedEventSourceRefs += 1;
    return () => {
      set.delete(wrapped);
      sharedEventSourceRefs -= 1;
    };
  }
  if (!isTauriRuntime()) return null;
  try {
    installIdempotentEventUnregister();
    const unlisten = await listen<T>(event, (message) => handler(message.payload));
    let active = true;
    updateListenerCount(event, 1);
    return () => {
      if (!active) return;
      active = false;
      updateListenerCount(event, -1);
      cleanupTauriListener(event, unlisten);
    };
  } catch (error) {
    logger.error(`tauri listen failed: ${event}`, error);
    return null;
  }
}
