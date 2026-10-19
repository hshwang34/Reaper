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
// discovery, then the ws://127.0.0.1:4455 default. We only ever READ here;
// flipping server_enabled for the streamer is a consent-gated wizard action
// (M4), never something a boot path does silently.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { shell } from "electron";
import { log, warn } from "@rh/core";

export interface ObsDiscovery {
  status: "found" | "disabled" | "not-installed" | "unreadable";
  url?: string;
  password?: string;
}

function configPath(): string {
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

export function discoverObsWebsocket(): ObsDiscovery {
  const path = configPath();
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
      warn("obs-discovery", "obs-websocket server is disabled in OBS");
      return { status: "disabled" };
    }
    const port = cfg.server_port ?? 4455;
    const password = cfg.auth_required ? (cfg.server_password ?? "") : "";
    log("obs-discovery", `found obs-websocket on port ${port} (auth: ${cfg.auth_required ? "yes" : "no"})`);
    return {
      status: "found",
      url: `ws://127.0.0.1:${port}`,
      password,
    };
  } catch {
    warn("obs-discovery", "obs-websocket config unreadable");
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
  const err = await shell.openPath(target);
  if (err) throw new Error(err);
}
