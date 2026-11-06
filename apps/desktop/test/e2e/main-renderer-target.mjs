/** Select the production app shell, never a widget, plugin page or DevTools. */
export function selectMainRendererTarget(targets) {
  const candidates = targets.filter((entry) => {
    if (entry?.type !== "page" || typeof entry.webSocketDebuggerUrl !== "string"
      || !entry.webSocketDebuggerUrl || typeof entry.url !== "string") return false;
    try {
      const url = new URL(entry.url);
      return url.protocol === "file:" && url.pathname.endsWith("/renderer/index.html")
        && !url.searchParams.has("surface");
    } catch {
      return false;
    }
  });
  if (candidates.length !== 1) {
    throw new Error(`Expected one Electron main renderer target; found ${candidates.length}`);
  }
  return candidates[0];
}
