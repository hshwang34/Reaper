// Opt-in debug logging for the realtime pipeline (WebRTC loopback, Decart
// session, viewer frame-gate). Off by default so a demo/production run is quiet
// in the console; enable per-page with `?debug=1` in the URL or by setting
// `localStorage.rhDebug = "1"`. The viewer page runs inside an OBS Browser
// Source, so append `?debug=1` to that source's URL to surface its trace.

const enabled: boolean = (() => {
  try {
    if (new URLSearchParams(location.search).get("debug") === "1") return true;
    return localStorage.getItem("rhDebug") === "1";
  } catch {
    return false; // SSR / storage-blocked contexts
  }
})();

/** Namespaced console logger. Silent unless debug is enabled for this page. */
export function debugLog(scope: string, ...args: unknown[]): void {
  if (enabled) console.warn(`[${scope}]`, ...args);
}

export const debugEnabled = enabled;
