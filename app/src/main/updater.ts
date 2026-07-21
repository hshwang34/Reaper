// Auto-update (electron-updater, GitHub Releases). Two guards that matter:
//   1. Only in packaged builds — dev runs must never self-update.
//   2. Never relaunch while a hijack is LIVE. We check the local engine's
//      snapshot before quitInstall; if live, we defer to the next idle.
//
// electron-updater is CommonJS; imported lazily so dev (unpackaged) never
// loads it. Failures are logged and swallowed — an update-check outage must
// never take the app down.

import { app } from "electron";
import { log, warn, type Engine } from "@rh/core";

export async function startAutoUpdate(getEngine: () => Engine | null): Promise<void> {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = await import("electron-updater");
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("update-downloaded", (info) => {
      log("updater", `update ${info.version} ready`);
      tryInstall(autoUpdater, getEngine);
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
  getEngine: () => Engine | null,
): void {
  const snap = getEngine()?.snapshot();
  if (snap && (snap.routerState === "LIVE" || snap.activeJob)) {
    warn("updater", "hijack live — deferring install, retry in 30s");
    setTimeout(() => tryInstall(autoUpdater, getEngine), 30_000);
    return;
  }
  log("updater", "installing update + relaunching");
  autoUpdater.quitAndInstall(true, true);
}
