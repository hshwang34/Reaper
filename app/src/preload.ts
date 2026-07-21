// Preload for the router window. Two exposures, both minimal:
//   window.rhAuth    — the per-install privilege token (string). Read by
//                      web/src/lib/auth.ts for API headers + WS hello.
//   window.rhDesktop — the keys/settings IPC surface for the in-app setup
//                      panel. Secrets flow renderer→main only; status flows
//                      back as booleans (the renderer never reads keys).
// contextIsolation is on; everything crosses via contextBridge.

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld(
  "rhAuth",
  process.argv.find((a) => a.startsWith("--rh-auth="))?.slice("--rh-auth=".length) ?? "",
);

contextBridge.exposeInMainWorld("rhDesktop", {
  /** Which credentials are configured (booleans only — no secret values). */
  keysStatus: (): Promise<Record<string, boolean>> =>
    ipcRenderer.invoke("rh:keys-status"),
  /** Save pasted credentials (empty fields are left unchanged). */
  saveKeys: (keys: Record<string, string>): Promise<void> =>
    ipcRenderer.invoke("rh:save-keys", keys),
  /** Relaunch the app so the bridge picks up new credentials. */
  relaunch: (): Promise<void> => ipcRenderer.invoke("rh:relaunch"),

  // ── Setup wizard surface ────────────────────────────────────────────────
  /** Everything the wizard needs to render its checklist. */
  setupState: (): Promise<{
    cloudMode: boolean;
    login: string | null;
    cloudUrl: string;
    obs: { discovery: string; connected: boolean };
    keys: Record<string, boolean>;
    port: number;
    viewerUrl: string;
    portalUrl: string | null;
    autoLaunch: boolean;
  }> => ipcRenderer.invoke("rh:setup-state"),
  /** Loopback OAuth via the system browser; resolves once signed in. */
  signIn: (): Promise<{ ok: boolean; login?: string }> =>
    ipcRenderer.invoke("rh:sign-in"),
  signOut: (): Promise<void> => ipcRenderer.invoke("rh:sign-out"),
  /** Create/repair the hidden OBS Browser Source now. */
  provisionObs: (): Promise<{ ok: boolean; detail: string }> =>
    ipcRenderer.invoke("rh:provision-obs"),
  launchObs: (): Promise<void> => ipcRenderer.invoke("rh:launch-obs"),
  /** Fire a test hijack through whichever engine owns money logic. */
  testHijack: (prompt: string, durationSec: number): Promise<string> =>
    ipcRenderer.invoke("rh:test-hijack", prompt, durationSec),
  setAutoLaunch: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("rh:auto-launch", enabled),
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke("rh:open-external", url),
});
