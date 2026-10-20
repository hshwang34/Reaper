// App-side host configuration: where the packaged app keeps what the sidecar
// CLI keeps in the repo (.env + settings.json + uploads/).
//
// Layout under app.getPath("userData") (e.g. ~/Library/Application Support/
// Stream Hijack/):
//   settings.json — the same Settings shape as the demo rig
//   keys.json     — Decart/Streamlabs/OBS credentials (M2 "paste keys" mode;
//                   moves to safeStorage with the settings UI, and mostly
//                   disappears in M3 when the hosted control plane holds keys)
//   uploads/      — viewer reference images
//   app-state.json — app-level flags (has setup finished?). Separate from
//                   settings.json because loadSettings() validates against
//                   the Settings shape and drops anything it doesn't know.
//
// DEV FALLBACK: when the app runs unpackaged from the repo (`npm run dev
// --workspace app`) and keys.json doesn't exist yet, credentials are read from
// the repo's .env so the dev loop needs zero extra setup.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, safeStorage } from "electron";
import { config as loadDotenv } from "dotenv";
import { DEFAULT_SETTINGS, loadSettings, type Settings } from "@rh/shared";
import { log, warn } from "@rh/core";
import { discoverObsWebsocket } from "./obsDiscovery.js";

const userData = app.getPath("userData");
const settingsPath = resolve(userData, "settings.json");
const keysPath = resolve(userData, "keys.json");
const authTokenPath = resolve(userData, "auth-token");
const appStatePath = resolve(userData, "app-state.json");

export const uploadsDir = resolve(userData, "uploads");
/** Moderation ledger + suspected-CSAM quarantine. Never served. */
export const safetyDir = resolve(userData, "safety");

/** Repo root when running unpackaged from source (dev), else null. */
function devRepoRoot(): string | null {
  if (app.isPackaged) return null;
  // dist/main.mjs → app/ → repo root
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "..", "..");
  return existsSync(resolve(root, "package.json")) ? root : null;
}

/** Credentials + machine wiring for the local bridge. Stored in keys.json
 *  (keychain-encrypted). Distinct from Settings, which is streamer policy. */
export interface Keys {
  decartApiKey: string;
  streamlabsToken: string;
  obsWsUrl: string;
  obsWsPassword: string;
  /** OBS scene + Browser Source that hosts the hijack overlay. */
  obsScene: string;
  obsSource: string;
  /** Content-safety classifiers (local mode only — in cloud mode the control
   *  plane moderates). Without them, custom text / photo uploads stay off. */
  openaiApiKey: string;
  anthropicApiKey: string;
  sightengineApiUser: string;
  sightengineApiSecret: string;
}

/** Map stored keys to the env names core's moderationFromEnv reads. */
export function moderationEnvFrom(k: Keys) {
  return {
    OPENAI_API_KEY: k.openaiApiKey,
    ANTHROPIC_API_KEY: k.anthropicApiKey,
    SIGHTENGINE_API_USER: k.sightengineApiUser,
    SIGHTENGINE_API_SECRET: k.sightengineApiSecret,
    RH_CLASSIFIER_MODEL: process.env.RH_CLASSIFIER_MODEL,
  };
}

/** The per-install privilege token: gates the local bridge's privileged HTTP
 *  endpoints and hub roles. Per-install (not per-boot) so the provisioned OBS
 *  Browser Source URL — which embeds it as ?auth= — stays stable across
 *  launches instead of rewriting OBS config every boot. Random 256-bit;
 *  regenerating it is just deleting the file (OBS URL self-repairs). */
export function getAuthToken(): string {
  try {
    if (existsSync(authTokenPath)) {
      const t = readFileSync(authTokenPath, "utf8").trim();
      if (t.length >= 32) return t;
    }
  } catch {
    /* regenerate below */
  }
  const t = randomBytes(32).toString("hex");
  writeFileSync(authTokenPath, t, { mode: 0o600 });
  log("app-config", "generated new local auth token");
  return t;
}

/** keys.json on-disk shape: encrypted with the OS keychain via safeStorage
 *  when available, plaintext fallback otherwise (flagged in the file). */
interface KeysFile {
  enc: boolean;
  blob?: string; // base64(safeStorage.encryptString(JSON(Keys)))
  plain?: Partial<Keys>;
}

function readKeysFile(): Partial<Keys> {
  if (!existsSync(keysPath)) return {};
  try {
    const f = JSON.parse(readFileSync(keysPath, "utf8")) as KeysFile;
    if (f.enc && f.blob) {
      return JSON.parse(
        safeStorage.decryptString(Buffer.from(f.blob, "base64")),
      ) as Partial<Keys>;
    }
    return f.plain ?? {};
  } catch {
    warn("app-config", "keys.json unreadable — falling back");
    return {};
  }
}

export function loadKeys(): Keys {
  // OBS credential precedence: keys.json explicit → auto-discovery from
  // obs-websocket's own config file (the "nothing to paste" path — and ground
  // truth, since it's the file OBS actually reads) → .env (dev) → default.
  const saved: Partial<Keys> = readKeysFile();

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
    obsScene: String(saved.obsScene ?? "") || process.env.OBS_SCENE?.trim() || "Scene",
    obsSource:
      String(saved.obsSource ?? "") || process.env.OBS_SOURCE?.trim() || "AI Hijack",
    openaiApiKey: String(saved.openaiApiKey ?? "") || process.env.OPENAI_API_KEY?.trim() || "",
    anthropicApiKey:
      String(saved.anthropicApiKey ?? "") || process.env.ANTHROPIC_API_KEY?.trim() || "",
    sightengineApiUser:
      String(saved.sightengineApiUser ?? "") || process.env.SIGHTENGINE_API_USER?.trim() || "",
    sightengineApiSecret:
      String(saved.sightengineApiSecret ?? "") || process.env.SIGHTENGINE_API_SECRET?.trim() || "",
  };
}

export function saveKeys(keys: Partial<Keys>): void {
  // Merge over whatever is stored so a partial save (e.g. only the Decart
  // key) doesn't wipe the rest.
  const merged = { ...readKeysFile(), ...keys };
  let file: KeysFile;
  if (safeStorage.isEncryptionAvailable()) {
    file = {
      enc: true,
      blob: safeStorage
        .encryptString(JSON.stringify(merged))
        .toString("base64"),
    };
  } else {
    warn("app-config", "OS keychain unavailable — storing keys unencrypted");
    file = { enc: false, plain: merged };
  }
  writeFileSync(keysPath, JSON.stringify(file), { mode: 0o600 });
  log("app-config", "keys saved");
}

/** Redacted view for the settings UI (never ship secrets to the renderer —
 *  it only needs to know what's set). */
export function keysStatus(): Record<keyof Keys, boolean> {
  const k = loadKeys();
  return {
    decartApiKey: Boolean(k.decartApiKey),
    streamlabsToken: Boolean(k.streamlabsToken),
    obsWsUrl: Boolean(k.obsWsUrl),
    obsWsPassword: Boolean(k.obsWsPassword),
    obsScene: Boolean(k.obsScene),
    obsSource: Boolean(k.obsSource),
    openaiApiKey: Boolean(k.openaiApiKey),
    anthropicApiKey: Boolean(k.anthropicApiKey),
    sightengineApiUser: Boolean(k.sightengineApiUser),
    sightengineApiSecret: Boolean(k.sightengineApiSecret),
  };
}

let settings: Settings = loadSettingsFile();

function loadSettingsFile(): Settings {
  if (existsSync(settingsPath)) {
    try {
      // Validated on load (shared/settings.ts): stale keys from older
      // versions are dropped rather than carried along forever.
      return loadSettings(JSON.parse(readFileSync(settingsPath, "utf8")));
    } catch {
      warn("app-config", "settings.json unreadable — using defaults");
    }
  }
  return { ...DEFAULT_SETTINGS };
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

/** App-level flags, not streamer policy. Missing file = fresh install. */
export interface AppState {
  /** The setup wizard reached "Done" at least once. Until then every launch
   *  opens /setup instead of /router. */
  setupDone: boolean;
}

export function getAppState(): AppState {
  try {
    if (existsSync(appStatePath)) {
      const raw = JSON.parse(readFileSync(appStatePath, "utf8")) as Partial<AppState>;
      return { setupDone: raw.setupDone === true };
    }
  } catch {
    warn("app-config", "app-state.json unreadable — treating as fresh install");
  }
  return { setupDone: false };
}

export function updateAppState(patch: Partial<AppState>): AppState {
  const next = { ...getAppState(), ...patch };
  try {
    writeFileSync(appStatePath, JSON.stringify(next, null, 2));
  } catch {
    warn("app-config", "could not persist app-state.json");
  }
  return next;
}

/** The built web bundle: repo web/dist in dev, packaged resources in prod. */
export function webDistDir(): string {
  const root = devRepoRoot();
  if (root) return resolve(root, "web", "dist");
  return resolve(process.resourcesPath, "web-dist");
}
