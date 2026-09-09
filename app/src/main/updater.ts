// Auto-update (electron-updater, GitHub Releases). Two guards that matter:
//   1. Only in packaged builds — dev runs must never self-update.
//   2. Never relaunch while a hijack is LIVE. We check the money authority's
//      status (local engine, or the cloud engine's mirrored status in cloud
//      mode) before quitInstall; if live, we defer to the next idle.
//
// electron-updater is CommonJS; imported lazily so dev (unpackaged) never
// loads it. Failures are logged and swallowed — an update-check outage must
// never take the app down.

import { app } from "electron";
import type { StatusSnapshot } from "@rh/shared";
import { log, warn } from "@rh/core";

export async function startAutoUpdate(
  getStatus: () => StatusSnapshot | null,
): Promise<void> {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = await import("electron-updater");
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("update-downloaded", (info) => {
      log("updater", `update ${info.version} ready`);
      tryInstall(autoUpdater, getStatus);
    });
    autoUpdater.on("error", (e) =>
      warn("updater", `update error: ${e.message}`),
    );

    await autoUpdater.checkForUpdates();
    // Re-check hourly.
    setInterval(() => void autoUpdater.checkForUpdates().catch(() => {}), 3600_000);
  } catch (e) {
    warn("updater", `disabled: ${(e as Error).message}`);
  }
}

function tryInstall(
  autoUpdater: { quitAndInstall(silent?: boolean, forceRun?: boolean): void },
  getStatus: () => StatusSnapshot | null,
): void {
  const snap = getStatus();
  if (snap && (snap.routerState === "LIVE" || snap.activeJob)) {
    warn("updater", "hijack live — deferring install, retry in 30s");
    setTimeout(() => tryInstall(autoUpdater, getStatus), 30_000);
    return;
  }
  log("updater", "installing update + relaunching");
  autoUpdater.quitAndInstall(true, true);
}
