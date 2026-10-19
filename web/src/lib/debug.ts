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

let sink: ((line: string) => void) | null = null;

/** Mirror every debug line to the local sidecar terminal (via `page:log`),
 *  regardless of `?debug=1` — the console stays quiet, the terminal doesn't.
 *  The viewer runs inside OBS where nobody can open DevTools. */
export function setDebugSink(fn: ((line: string) => void) | null): void {
  sink = fn;
}

/** Namespaced console logger. Silent unless debug is enabled for this page. */
export function debugLog(scope: string, ...args: unknown[]): void {
  if (enabled) console.warn(`[${scope}]`, ...args);
  sink?.(`[${scope}] ${args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" ")}`);
}

function safeJson(v: unknown): string {
  if (v instanceof Error) return v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const debugEnabled = enabled;
