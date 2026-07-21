// Electron main — the "one download" for streamers.
//
// The main process is the app's local presence: it embeds the SAME local
// server composition the sidecar CLI runs (createLocalServer from
// @rh/sidecar — engine, hub, minting, OBS control, static web serving) and
// wraps it in desktop affordances: a renderer window pinned to /router (the
// capture + state-machine page, running in bundled Chromium where
// getUserMedia is known-good), a tray with status + panic, a global panic
// hotkey, OBS Browser Source auto-provisioning, and single-instance safety.
//
// Design decisions this file encodes (see the plan in the repo docs):
//  · D1: rtc signaling + frames-ok stay on this machine — the embedded Hub
//    relays them between the /router window and OBS's /viewer page.
//  · D2: the OBS Browser Source URL is local + fixed-port + self-repairing
//    (ensureBrowserSource repairs a drifted URL at every boot).
//  · backgroundThrottling:false — a minimized/occluded window must keep its
//    countdown honest; this kills the tab-throttling failure mode that a
//    Chrome-tab router suffers.

import {
  app,
  BrowserWindow,
  globalShortcut,
  Menu,
  nativeImage,
  powerSaveBlocker,
  session,
  systemPreferences,
  Tray,
} from "electron";
import { createLocalServer, type LocalServer } from "@rh/sidecar";
import { log, warn } from "@rh/core";
import {
  getSettings,
  loadKeys,
  updateSettings,
  uploadsDir,
  webDistDir,
} from "./config.js";

// Fixed local port (D2). Fallbacks keep the app alive on collision; the OBS
// source URL is repaired to whatever port actually bound.
const PORTS = [17712, 17713, 17714];

let local: LocalServer | null = null;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;

// ── Single instance ────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(boot);
}

async function boot(): Promise<void> {
  // Camera consent (macOS TCC). Fired non-blocking: the OS prompt needs a
  // human, and NOTHING else (bridge, window, tray) should wait on it — the
  // router's Arm button is the actual moment capture is needed, and a denial
  // surfaces there with a proper error.
  if (process.platform === "darwin") {
    void systemPreferences.askForMediaAccess("camera").then((ok) => {
      if (!ok) warn("app", "camera access denied — router cannot arm");
    });
  }

  // Renderer permission handler: this app's only origin is our loopback
  // bridge; grant it media (getUserMedia) and nothing else.
  session.defaultSession.setPermissionRequestHandler(
    (_wc, permission, callback) => {
      callback(permission === "media");
    },
  );

  // ── Local bridge: the embedded sidecar composition ─────────────────────
  const keys = loadKeys();
  local = createLocalServer({
    ...keys,
    getSettings,
    updateSettings,
    uploadsDir,
    webDist: webDistDir(),
  });

  const port = await listenOnFirstFreePort(local, PORTS);
  log("app", `local bridge on 127.0.0.1:${port}`);

  // ── OBS auto-provisioning (best-effort; retried via tray or next boot) ──
  const viewerUrl = `http://127.0.0.1:${port}/viewer`;
  void provisionObs(viewerUrl);

  // ── Router window ──────────────────────────────────────────────────────
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    title: "Reality Hijack",
    webPreferences: {
      // The countdown + teardown timers must run while minimized/occluded.
      backgroundThrottling: false,
    },
  });
  // Closing the window quits the app (the router IS the product for now);
  // tray-only residency arrives with the M4 wizard polish.
  void win.loadURL(`http://127.0.0.1:${port}/router`);
  win.on("closed", () => {
    win = null;
  });

  // Keep timers honest even when the machine tries to sleep the app.
  powerSaveBlocker.start("prevent-app-suspension");

  // ── Tray + panic hotkey ────────────────────────────────────────────────
  setupTray(port);
  const registered = globalShortcut.register(
    "CommandOrControl+Shift+H",
    () => {
      if (!local) return;
      const paused = local.engine.togglePause();
      warn("app", paused ? "PANIC — paused via hotkey" : "resumed via hotkey");
      refreshTray();
    },
  );
  if (!registered) warn("app", "panic hotkey unavailable (already taken?)");
}

/** Try the fixed port, then fallbacks (D2 — OBS URL is repaired afterwards). */
function listenOnFirstFreePort(
  srv: LocalServer,
  ports: number[],
): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const tryAt = (i: number) => {
      if (i >= ports.length) {
        reject(new Error("no free local port"));
        return;
      }
      const onError = (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE") {
          warn("app", `port ${ports[i]} busy — trying ${ports[i + 1]}`);
          srv.server.removeListener("error", onError);
          tryAt(i + 1);
        } else {
          reject(e);
        }
      };
      srv.server.once("error", onError);
      srv.server.once("listening", () => {
        srv.server.removeListener("error", onError);
        resolvePort(ports[i]);
      });
      srv.start(ports[i]);
    };
    tryAt(0);
  });
}

/** Create/repair the hidden AI-overlay Browser Source. Never blocks boot. */
async function provisionObs(viewerUrl: string): Promise<void> {
  if (!local) return;
  const s = getSettings();
  try {
    const result = await local.obs.ensureBrowserSource(
      s.obsScene,
      s.obsSource,
      viewerUrl,
    );
    log("app", `OBS source "${s.obsSource}": ${result}`);
  } catch (e) {
    warn(
      "app",
      `OBS provisioning skipped (${(e as Error).message}) — retry from tray`,
    );
  }
  refreshTray();
}

// ── Tray ──────────────────────────────────────────────────────────────────

function setupTray(port: number): void {
  // Text-only tray (macOS): an empty image + a title glyph. A real template
  // icon lands with M5 packaging.
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip("Reality Hijack");
  trayPort = port;
  refreshTray();
  // Cheap status poll — the tray is a glanceable, not a dashboard.
  setInterval(refreshTray, 3000);
}

let trayPort = 0;

function refreshTray(): void {
  if (!tray || !local) return;
  const snap = local.engine.snapshot();
  const stateGlyph = snap.paused
    ? "⏸"
    : snap.routerState === "LIVE"
      ? "🔴"
      : snap.routerState === "OFFLINE"
        ? "○"
        : "●";
  tray.setTitle(` ${stateGlyph} RH`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: `Router: ${snap.routerState}${snap.paused ? " (PAUSED)" : ""} · queue ${snap.queueLength}`,
        enabled: false,
      },
      {
        label: `OBS: ${local.obs.isConnected() ? "connected" : "not connected"}`,
        enabled: false,
      },
      { type: "separator" },
      {
        label: snap.paused ? "Resume hijacks" : "Panic (pause + kill live)",
        accelerator: "CommandOrControl+Shift+H",
        click: () => {
          local?.engine.togglePause();
          refreshTray();
        },
      },
      {
        label: "Re-provision OBS source",
        click: () => void provisionObs(`http://127.0.0.1:${trayPort}/viewer`),
      },
      { type: "separator" },
      {
        label: "Open router window",
        click: () => {
          if (win) {
            win.show();
            win.focus();
          }
        },
      },
      { type: "separator" },
      { label: "Quit Reality Hijack", role: "quit" },
    ]),
  );
}

// ── Shutdown ──────────────────────────────────────────────────────────────
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  // Best-effort: closing the window already ran the router page's unload
  // teardown (hide OBS → drop Decart); this just stops triggers + HTTP.
  void local?.stop();
});

// macOS convention would keep apps alive with no windows; for a streaming
// tool that owns a camera + OBS source, dying windows = quit is safer.
app.on("window-all-closed", () => {
  app.quit();
});
