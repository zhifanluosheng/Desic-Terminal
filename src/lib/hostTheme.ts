/**
 * DSH 宿主主题桥。
 *
 * 嵌入 iframe 是独立文档，父页面的 CSS 变量不会继承进来。插件端（DSH 面板）
 * 把宿主的 `--dsw-alias-*` 令牌 postMessage 过来，这里落到 `--dsh-*` 变量，
 * 宿主切浅色/深色/自定义主题时，`data-shell="host"` 的外壳会跟着变，而不是
 * 固定死在 #1b1b1c。
 */

const TOKEN_MAP: Record<string, string> = {
  "--dsw-alias-bg-base": "--dsh-bg-base",
  "--dsw-alias-bg-layer-1": "--dsh-bg-layer-1",
  "--dsw-alias-bg-layer-2": "--dsh-bg-layer-2",
  "--dsw-alias-bg-module-platform": "--dsh-bg-module",
  "--dsw-alias-label-primary": "--dsh-label-primary",
  "--dsw-alias-label-secondary": "--dsh-label-secondary",
  "--dsw-alias-label-caption": "--dsh-label-caption",
  "--dsw-alias-border-l1": "--dsh-border-l1",
  "--dsw-alias-border-l2": "--dsh-border-l2"
};

type ThemeMessage = {
  type?: string;
  tokens?: Record<string, unknown>;
};

function applyTokens(tokens: Record<string, unknown>) {
  const root = document.documentElement;
  for (const [name, cssVar] of Object.entries(TOKEN_MAP)) {
    const value = tokens[name];
    if (typeof value === "string" && value.trim()) {
      root.style.setProperty(cssVar, value.trim());
    }
  }
}

export function installHostThemeBridge() {
  if (typeof window === "undefined" || window.parent === window) return;
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const data = event.data as ThemeMessage | null;
    if (!data || data.type !== "dsh-desic-theme" || !data.tokens) return;
    applyTokens(data.tokens);
  });
  // 监听器装好后主动向宿主索要一次：iframe 首次加载时宿主可能先于监听发送。
  try {
    window.parent.postMessage({ type: "dsh-desic-theme-request" }, "*");
  } catch {
    // 跨域限制时静默失败，宿主会在下一次主题变更时再推
  }
}
