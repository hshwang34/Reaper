// Typed access to the Electron preload bridge. Null in a plain browser tab
// (the demo rig) — every desktop-only UI checks this once and renders nothing
// otherwise, instead of each page re-declaring the window shape.

import type { DesktopBridge } from "@rh/shared";

export function desktopBridge(): DesktopBridge | null {
  return (window as { rhDesktop?: DesktopBridge }).rhDesktop ?? null;
}
