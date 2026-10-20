// OBS websocket credential auto-discovery — the "nothing to paste" move.
//
// obs-websocket (bundled with OBS 28+) persists its server settings to a
// plain JSON file in OBS's profile dir. Reading it gives us the port and
// password without the streamer ever opening OBS's WebSocket dialog:
//   macOS:   ~/Library/Application Support/obs-studio/plugin_config/obs-websocket/config.json
//   Windows: %APPDATA%/obs-studio/plugin_config/obs-websocket/config.json
// Shape (observed, OBS 30/31): { alerts_enabled, auth_required, first_load,
// server_enabled, server_password, server_port }.
//
// Policy: explicit creds in keys.json always win (loadKeys), then this
// discovery, then the ws://127.0.0.1:4455 default. Boot paths only ever READ;
// flipping server_enabled is `enableObsWebsocket`, a consent-gated wizard
// action behind a button the streamer clicks.

// No Electron import here on purpose: the module stays a plain Node module,
// so app/test/obsDiscovery.test.ts can exercise it under `node --test`.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log, warn } from "@rh/core";

export interface ObsDiscovery {
  status: "found" | "disabled" | "not-installed" | "unreadable";
  url?: string;
  password?: string;
}

export function configPath(): string {
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      "obs-studio",
      "plugin_config",
      "obs-websocket",
      "config.json",
    );
  }
  // darwin (linux uses ~/.config/obs-studio — out of scope)
  return join(
    homedir(),
    "Library",
    "Application Support",
    "obs-studio",
    "plugin_config",
    "obs-websocket",
    "config.json",
  );
}

// The wizard polls discovery every few seconds; log a result only when it
// changes, not on every poll.
let lastLogged = "";
function once(key: string, emit: () => void): void {
  if (key === lastLogged) return;
  lastLogged = key;
  emit();
}

export function discoverObsWebsocket(path = configPath()): ObsDiscovery {
  if (!existsSync(path)) {
    // No obs-websocket config → OBS never ran (or is ancient). The wizard's
    // "not installed" branch handles messaging.
    return { status: "not-installed" };
  }
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8")) as {
      server_enabled?: boolean;
      server_port?: number;
      server_password?: string;
      auth_required?: boolean;
    };
    if (!cfg.server_enabled) {
      once("disabled", () => warn("obs-discovery", "obs-websocket server is disabled in OBS"));
      return { status: "disabled" };
    }
    const port = cfg.server_port ?? 4455;
    const password = cfg.auth_required ? (cfg.server_password ?? "") : "";
    once(`found:${port}:${cfg.auth_required}`, () =>
      log("obs-discovery", `found obs-websocket on port ${port} (auth: ${cfg.auth_required ? "yes" : "no"})`),
    );
    return {
      status: "found",
      url: `ws://127.0.0.1:${port}`,
      password,
    };
  } catch {
    once("unreadable", () => warn("obs-discovery", "obs-websocket config unreadable"));
    return { status: "unreadable" };
  }
}

/** Where OBS's own installer puts it. Steam/portable installs live elsewhere;
 *  those streamers get the "start OBS yourself" message. */
function obsExecutable(): string {
  if (process.platform === "win32") {
    return join(
      process.env.ProgramFiles ?? "C:\\Program Files",
      "obs-studio",
      "bin",
      "64bit",
      "obs64.exe",
    );
  }
  return "/Applications/OBS.app";
}

/** Start OBS for the wizard's "Launch OBS" button. Throws a human-readable
 *  error when OBS isn't at its default install location. */
export async function launchObs(): Promise<void> {
  const target = obsExecutable();
  if (!existsSync(target)) {
    throw new Error("OBS isn't in its default install location — start it yourself and this page connects on its own.");
  }
  if (process.platform === "win32") {
    // OBS must start with its own bin dir as the working directory, or it
    // fails to find its locale files ("Failed to find locale/en-US.ini").
    spawn(target, [], { cwd: dirname(target), detached: true, stdio: "ignore" }).unref();
    return;
  }
  // `open -a` is what Finder does: brings OBS forward if it's already up.
  execFileSync("open", ["-a", target]);
}

/** Is OBS running right now? Process-list check, because the websocket
 *  being unreachable doesn't distinguish "OBS closed" from "server off". */
export function isObsRunning(): boolean {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq obs64.exe", "/NH"], {
        encoding: "utf8",
        windowsHide: true,
      });
      return /obs64\.exe/i.test(out);
    }
    execFileSync("pgrep", ["-x", "OBS"], { stdio: "ignore" });
    return true;
  } catch {
    return false; // pgrep exits 1 when nothing matches
  }
}

export type EnableObsWebsocketResult = "enabled" | "already-enabled" | "obs-running" | "no-config";

/** Flip obs-websocket's server on, for the wizard's "Enable it for me".
 *
 *  OBS reads this file at startup and rewrites it from memory on quit, so a
 *  write while OBS runs is silently undone the next time it closes — hence
 *  the refusal while OBS is up. Port and password are left exactly as the
 *  streamer had them: discovery already reads the password, so an
 *  auth-required server stays auth-required. */
export function enableObsWebsocket(
  path = configPath(),
  running = isObsRunning(),
): EnableObsWebsocketResult {
  if (!existsSync(path)) return "no-config";
  if (running) return "obs-running";
  const cfg = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (cfg.server_enabled === true) return "already-enabled";
  writeFileSync(path, JSON.stringify({ ...cfg, server_enabled: true }, null, 4));
  log("obs-discovery", "enabled obs-websocket server in OBS's config (streamer consent)");
  return "enabled";
}
