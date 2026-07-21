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
});
