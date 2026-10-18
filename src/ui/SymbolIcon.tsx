import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { logger } from "../lib/logger";
import { hasBackendAsync, invokeDesktop, isTauriRuntime } from "../lib/tauri";
import type { MarketAssetsSummary } from "../types";

type SymbolIconProps = {
  base: string;
  iconPath?: string | null;
  cached?: boolean;
  cacheDir?: string | null;
};

const iconDataUrls = new Map<string, string>();
const iconDataUrlRequests = new Map<string, Promise<string | null>>();
const iconDownloadFailures = new Map<string, number>();
const ICON_DOWNLOAD_RETRY_MS = 5 * 60_000;

/**
 * 图标是「每个交易对一次桥调用」。启动时一屏几十个图标会同时挤满 HTTP/1.1
 * 的 6 条连接（实测 83 次调用、平均排队 765ms，把行情和页面数据都堵在后面），
 * 所以这里限制并发；拿到的 data URL 也持久化到 localStorage，二次启动直接复用。
 */
const ICON_CACHE_STORAGE_KEY = "desic.market-icons.v1";
const ICON_REQUEST_CONCURRENCY = 2;
const ICON_CACHE_MAX_ENTRIES = 400;
let iconActiveRequests = 0;
let iconPersistTimer: number | null = null;
const iconRequestQueue: Array<() => void> = [];

function acquireIconSlot(): Promise<void> {
  if (iconActiveRequests < ICON_REQUEST_CONCURRENCY) {
    iconActiveRequests += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    iconRequestQueue.push(() => {
      iconActiveRequests += 1;
      resolve();
    });
  });
}

function releaseIconSlot() {
  iconActiveRequests = Math.max(0, iconActiveRequests - 1);
  iconRequestQueue.shift()?.();
}

function rememberIcon(path: string, dataUrl: string) {
  iconDataUrls.set(path, dataUrl);
  if (iconDataUrls.size > ICON_CACHE_MAX_ENTRIES) return;
  if (iconPersistTimer !== null) window.clearTimeout(iconPersistTimer);
  iconPersistTimer = window.setTimeout(() => {
    iconPersistTimer = null;
    try {
      const payload: Record<string, string> = {};
      for (const [key, value] of iconDataUrls) payload[key] = value;
      window.localStorage.setItem(ICON_CACHE_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // localStorage 写满时放弃持久化，内存缓存继续生效
    }
  }, 1200);
}

function restorePersistedIcons() {
  try {
    const raw = window.localStorage.getItem(ICON_CACHE_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, string>;
    for (const [path, dataUrl] of Object.entries(parsed)) {
      if (typeof dataUrl === "string" && dataUrl.startsWith("data:")) iconDataUrls.set(path, dataUrl);
    }
  } catch {
    // 缓存损坏或 localStorage 不可用，忽略
  }
}

restorePersistedIcons();

function fallbackIconPath(base: string, cacheDir?: string | null) {
  if (!base) return "";
  const fileName = `${base.toLowerCase()}.png`;
  if (cacheDir) {
    const separator = cacheDir.includes("\\") ? "\\" : "/";
    return `${cacheDir.replace(/[\\/]$/, "")}${separator}icons${separator}${fileName}`;
  }
  return `/cache/market-assets/icons/${fileName}`;
}

function marketAssetSrc(path?: string | null) {
  if (!path) return "";
  if (!isTauriRuntime()) {
    // iframe 嵌入模式：页面由 HTTP 桥托管，没有 /cache 静态路由（相对路径请求会被 403）。
    // 图标统一走桥的 data URL（见 loadIconDataUrl），这里不再猜相对路径。
    return "";
  }
  try {
    return convertFileSrc(path, "asset");
  } catch (error) {
    logger.error("market asset url conversion failed", error, { path });
    return "";
  }
}

function loadIconDataUrl(path: string, base: string) {
  const cached = iconDataUrls.get(path);
  if (cached) return Promise.resolve(cached);
  const pending = iconDataUrlRequests.get(path);
  if (pending) return pending;
  const normalizedBase = base.trim().toUpperCase();
  const canDownload = /^[A-Z0-9]{1,32}$/.test(normalizedBase);
  const request = (async () => {
    try {
      await acquireIconSlot();
      let local: string | null = "";
      try {
        local = await invokeDesktop<string>("market_icon_data_url", { path }, { quiet: true });
      } finally {
        releaseIconSlot();
      }
      if (local) {
        rememberIcon(path, local);
        iconDownloadFailures.delete(normalizedBase);
        return local;
      }
    } catch (error) {
      logger.warn("market icon cache read failed", {
        error: error instanceof Error ? error.message : String(error),
        base: normalizedBase,
        path
      });
    }
    if (!canDownload) return null;
    const failedAt = iconDownloadFailures.get(normalizedBase) ?? 0;
    if (Date.now() - failedAt < ICON_DOWNLOAD_RETRY_MS) return null;
    try {
      await acquireIconSlot();
      let downloaded: string | null = "";
      try {
        downloaded = await invokeDesktop<string>("ensure_market_icon_data_url", { base: normalizedBase }, { quiet: true });
      } finally {
        releaseIconSlot();
      }
      if (downloaded) {
        rememberIcon(path, downloaded);
        iconDownloadFailures.delete(normalizedBase);
        return downloaded;
      }
    } catch (error) {
      iconDownloadFailures.set(normalizedBase, Date.now());
      logger.warn("market icon download failed", {
        error: error instanceof Error ? error.message : String(error),
        base: normalizedBase
      });
    }
    return null;
  })()
    .finally(() => iconDataUrlRequests.delete(path));
  iconDataUrlRequests.set(path, request);
  return request;
}

export function SymbolIcon({ base, iconPath, cached, cacheDir }: SymbolIconProps) {
  const [failed, setFailed] = useState(false);
  const [dataUrl, setDataUrl] = useState("");
  const resolvedIconPath = iconPath || fallbackIconPath(base, cacheDir);
  const src = dataUrl || marketAssetSrc(resolvedIconPath);
  const canUseImage = Boolean(src && !failed);

  useEffect(() => {
    setFailed(false);
    setDataUrl(iconDataUrls.get(resolvedIconPath) ?? "");
    if (!resolvedIconPath) return;
    let cancelled = false;
    void (async () => {
      // 原生（Tauri）与嵌入（HTTP 桥）都走 data URL；纯浏览器预览无后端时跳过。
      if (!(await hasBackendAsync())) return;
      if (cancelled) return;
      const value = await loadIconDataUrl(resolvedIconPath, base).catch((error) => {
        logger.warn("market icon data url failed", {
          error: error instanceof Error ? error.message : String(error),
          base,
          iconPath: resolvedIconPath,
          cached
        });
        return null;
      });
      if (cancelled) return;
      if (value) {
        setDataUrl(value);
        setFailed(false);
      } else if (cached) {
        logger.warn("market icon cache missing", { base, iconPath: resolvedIconPath });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base, cached, resolvedIconPath]);

  return (
    <span className="symbol-icon" aria-hidden="true">
      {canUseImage ? <img src={src} alt="" draggable={false} onError={() => setFailed(true)} /> : <b>{base.slice(0, 1).toUpperCase()}</b>}
    </span>
  );
}

export function symbolBase(symbol: string) {
  return symbol.trim().toUpperCase().split("-")[0] || "?";
}

export function SymbolLabel({
  symbol,
  marketAssets,
  secondary,
  className,
  onSelect,
  selectLabel
}: {
  symbol: string;
  marketAssets?: MarketAssetsSummary | null;
  secondary?: string | null;
  className?: string;
  onSelect?: (symbol: string) => void;
  selectLabel?: string;
}) {
  const asset = marketAssets?.instruments.find((item) => item.instId === symbol);
  const base = asset?.baseCcy || symbolBase(symbol);
  const content = <>
    <SymbolIcon base={base} iconPath={asset?.iconPath} cached={asset?.iconCached} cacheDir={marketAssets?.cacheDir} />
    <span className="symbol-label-copy">
      <strong>{symbol || "--"}</strong>
      {secondary ? <small>{secondary}</small> : null}
    </span>
  </>;
  const classes = ["symbol-label", className].filter(Boolean).join(" ");
  if (!onSelect || !symbol) return <span className={classes}>{content}</span>;
  return (
    <button
      type="button"
      className={`${classes} symbol-label-selectable`}
      onClick={() => onSelect(symbol)}
      title={selectLabel ?? `Switch to ${symbol}`}
      aria-label={selectLabel ?? `Switch to ${symbol}`}
    >
      {content}
    </button>
  );
}
