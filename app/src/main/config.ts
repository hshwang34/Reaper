// App-side host configuration: where the packaged app keeps what the sidecar
// CLI keeps in the repo (.env + settings.json + uploads/).
//
// Layout under app.getPath("userData") (e.g. ~/Library/Application Support/
// Reality Hijack/):
//   settings.json — the same Settings shape as the demo rig
//   keys.json     — Decart/Streamlabs/OBS credentials (M2 "paste keys" mode;
//                   moves to safeStorage with the settings UI, and mostly
//                   disappears in M3 when the hosted control plane holds keys)
//   uploads/      — viewer reference images
//
// DEV FALLBACK: when the app runs unpackaged from the repo (`npm run dev
// --workspace app`) and keys.json doesn't exist yet, credentials are read from
// the repo's .env so the dev loop needs zero extra setup.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import { config as loadDotenv } from "dotenv";
import { DEFAULT_SETTINGS, type Settings } from "@rh/shared";
import { log, warn } from "@rh/core";
import { discoverObsWebsocket } from "./obsDiscovery.js";

const userData = app.getPath("userData");
const settingsPath = resolve(userData, "settings.json");
const keysPath = resolve(userData, "keys.json");

export const uploadsDir = resolve(userData, "uploads");

/** Repo root when running unpackaged from source (dev), else null. */
function devRepoRoot(): string | null {
  if (app.isPackaged) return null;
  // dist/main.mjs → app/ → repo root
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "..", "..");
  return existsSync(resolve(root, "package.json")) ? root : null;
}

export interface Keys {
  decartApiKey: string;
  streamlabsToken: string;
  obsWsUrl: string;
  obsWsPassword: string;
}

export function loadKeys(): Keys {
  // OBS credential precedence: keys.json explicit → auto-discovery from
  // obs-websocket's own config file (the "nothing to paste" path — and ground
  // truth, since it's the file OBS actually reads) → .env (dev) → default.
  let saved: Partial<Keys> = {};
  if (existsSync(keysPath)) {
    try {
      saved = JSON.parse(readFileSync(keysPath, "utf8")) as Partial<Keys>;
    } catch {
      warn("app-config", "keys.json unreadable — falling back");
    }
  }

  // Dev fallback: the repo's .env.
  const root = devRepoRoot();
  if (root) {
    loadDotenv({ path: resolve(root, ".env"), quiet: true });
    log("app-config", "using repo .env credentials (dev fallback)");
  }

  const discovered = discoverObsWebsocket();
  const obsExplicit = saved.obsWsUrl != null || saved.obsWsPassword != null;

  return {
    decartApiKey:
      String(saved.decartApiKey ?? "") ||
      process.env.DECART_API_KEY?.trim() ||
      "",
    streamlabsToken:
      String(saved.streamlabsToken ?? "") ||
      process.env.STREAMLABS_SOCKET_TOKEN?.trim() ||
      "",
    obsWsUrl: obsExplicit
      ? String(saved.obsWsUrl ?? "ws://127.0.0.1:4455")
      : (discovered.url ??
        process.env.OBS_WS_URL?.trim() ??
        "ws://127.0.0.1:4455"),
    obsWsPassword: obsExplicit
      ? String(saved.obsWsPassword ?? "")
      : (discovered.password ?? process.env.OBS_WS_PASSWORD ?? ""),
  };
}

export function saveKeys(keys: Keys): void {
  writeFileSync(keysPath, JSON.stringify(keys, null, 2));
  log("app-config", "keys saved");
}

let settings: Settings = loadSettingsFile();

function loadSettingsFile(): Settings {
  const base: Settings = { ...DEFAULT_SETTINGS };
  if (existsSync(settingsPath)) {
    try {
      return { ...base, ...JSON.parse(readFileSync(settingsPath, "utf8")) };
    } catch {
      warn("app-config", "settings.json unreadable — using defaults");
    }
  }
  return base;
}

export function getSettings(): Settings {
  return settings;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  settings = { ...settings, ...patch };
  try {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    log("app-config", "settings updated");
  } catch {
    warn("app-config", "could not persist settings.json");
  }
  return settings;
}

/** The built web bundle: repo web/dist in dev, packaged resources in prod. */
export function webDistDir(): string {
  const root = devRepoRoot();
  if (root) return resolve(root, "web", "dist");
  return resolve(process.resourcesPath, "web-dist");
}
