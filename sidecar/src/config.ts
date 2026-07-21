// Environment + persisted settings. Settings live in sidecar/settings.json
// (gitignored) and are merged over DEFAULT_SETTINGS so new fields get defaults.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { DEFAULT_SETTINGS, type Settings } from "@rh/shared";
import { log, warn } from "./log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const rootDir = resolve(__dirname, "..", ".."); // repo root
loadDotenv({ path: resolve(rootDir, ".env") });

export const env = {
  port: Number(process.env.SIDECAR_PORT ?? 7712),
  decartApiKey: process.env.DECART_API_KEY?.trim() || "",
  streamlabsToken: process.env.STREAMLABS_SOCKET_TOKEN?.trim() || "",
  obsWsUrl: process.env.OBS_WS_URL?.trim() || "ws://127.0.0.1:4455",
  obsWsPassword: process.env.OBS_WS_PASSWORD ?? "",
  obsScene: process.env.OBS_SCENE?.trim() || "Scene",
  obsSource: process.env.OBS_SOURCE?.trim() || "AI Hijack",
};

/** True when a real Decart key is configured. Otherwise the router runs in
 *  mock mode (camera passthrough) so the pipeline is demoable without cost. */
export const decartEnabled = env.decartApiKey.startsWith("dct_");

export const uploadsDir = resolve(__dirname, "..", "uploads");
const settingsPath = resolve(__dirname, "..", "settings.json");

let settings: Settings = loadSettings();

function loadSettings(): Settings {
  const base: Settings = {
    ...DEFAULT_SETTINGS,
    obsScene: env.obsScene,
    obsSource: env.obsSource,
  };
  if (existsSync(settingsPath)) {
    try {
      const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
      return { ...base, ...saved };
    } catch {
      warn("config", "settings.json unreadable — using defaults");
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
    log("config", "settings updated");
  } catch {
    warn("config", "could not persist settings.json");
  }
  return settings;
}
