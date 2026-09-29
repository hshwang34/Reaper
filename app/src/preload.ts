// Preload for the router window. Two exposures, both minimal:
//   window.rhAuth    — the per-install privilege token (string). Read by
//                      web/src/lib/auth.ts for API headers + WS hello.
//   window.rhDesktop — the DesktopBridge (shared/src/desktopBridge.ts): the
//                      keys/settings IPC surface + the setup wizard. Secrets
//                      flow renderer→main only; status flows back as booleans
//                      (the renderer never reads keys).
// contextIsolation is on; everything crosses via contextBridge. The shape is
// checked against the shared contract at compile time (`satisfies`) — the
// import is type-only, so esbuild erases it and the bundle stays alias-free.

import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge, DesktopSetupState } from "@rh/shared";

contextBridge.exposeInMainWorld(
  "rhAuth",
  process.argv.find((a) => a.startsWith("--rh-auth="))?.slice("--rh-auth=".length) ?? "",
);

const bridge = {
  keysStatus: (): Promise<Record<string, boolean>> =>
    ipcRenderer.invoke("rh:keys-status"),
  saveKeys: (keys: Record<string, string>): Promise<void> =>
    ipcRenderer.invoke("rh:save-keys", keys),
  relaunch: (): Promise<void> => ipcRenderer.invoke("rh:relaunch"),

  setupState: (): Promise<DesktopSetupState> => ipcRenderer.invoke("rh:setup-state"),
  signIn: (): Promise<{ ok: boolean; login?: string }> =>
    ipcRenderer.invoke("rh:sign-in"),
  signOut: (): Promise<void> => ipcRenderer.invoke("rh:sign-out"),
  provisionObs: (): Promise<{ ok: boolean; detail: string }> =>
    ipcRenderer.invoke("rh:provision-obs"),
  launchObs: (): Promise<void> => ipcRenderer.invoke("rh:launch-obs"),
  testHijack: (prompt: string, durationSec: number): Promise<string> =>
    ipcRenderer.invoke("rh:test-hijack", prompt, durationSec),
  setAutoLaunch: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("rh:auto-launch", enabled),
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke("rh:open-external", url),
} satisfies DesktopBridge;

contextBridge.exposeInMainWorld("rhDesktop", bridge);
