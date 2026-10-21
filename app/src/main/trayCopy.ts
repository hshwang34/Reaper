// Plain-words status for the tray (tooltip + the menu's first row). Pure, so
// it's unit-tested without Electron. The raw engine state names (OFFLINE,
// TEARDOWN…) are an implementation detail and never reach the menu bar —
// docs/product/BRAND.md §3: Ready / Live / Paused / Not connected.

import { PRESETS, type StatusSnapshot } from "@rh/shared";

export type TrayState = "ready" | "live" | "paused" | "offline";

type Snap = Pick<StatusSnapshot, "routerState" | "paused" | "queueLength" | "activeJob">;

export function trayState(snap: Snap): TrayState {
  if (snap.paused) return "paused";
  if (snap.routerState === "OFFLINE") return "offline";
  if (snap.routerState === "LIVE" || snap.activeJob) return "live";
  return "ready";
}

/** The effect's name when it is one of ours, else a neutral "custom effect". */
function effectName(prompt: string | undefined): string {
  return PRESETS.find((p) => p.prompt === prompt)?.label ?? "custom effect";
}

/** "Ready" / "Live: 80s Anime" / "Paused" / "Not connected". */
export function trayStatusText(snap: Snap): string {
  switch (trayState(snap)) {
    case "paused":
      return "Paused";
    case "offline":
      return "Not connected";
    case "live":
      return `Live: ${effectName(snap.activeJob?.prompt)}`;
    case "ready":
      return "Ready";
  }
}

/** Menu row: "Status: Ready · 2 in line". */
export function trayMenuLabel(snap: Snap): string {
  return `Status: ${trayStatusText(snap)}${snap.queueLength ? ` · ${snap.queueLength} in line` : ""}`;
}

/** Hover tooltip: "Stream Hijack — Ready · 2 in line". */
export function trayTooltip(snap: Snap): string {
  return `Stream Hijack — ${trayStatusText(snap)}${snap.queueLength ? ` · ${snap.queueLength} in line` : ""}`;
}

/** Is an effect on stream right now? (Gates the "Run setup again" confirm.) */
export function effectIsLive(snap: Snap): boolean {
  return snap.routerState === "LIVE" || snap.activeJob != null;
}
