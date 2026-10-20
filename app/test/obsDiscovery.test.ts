// obs-websocket config discovery + the wizard's "Enable it for me". Pure file
// logic over OBS's own config.json, run against temp files.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverObsWebsocket, enableObsWebsocket } from "../src/main/obsDiscovery.js";

const dir = mkdtempSync(join(tmpdir(), "rh-obs-"));
const cfgFile = (name: string, cfg: Record<string, unknown>) => {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(cfg));
  return p;
};
// The shape OBS 30–32 writes (observed on a real install).
const base = { alerts_enabled: false, auth_required: true, first_load: false, server_password: "pw", server_port: 4455 };

test("discovery: enabled server yields url + password only when auth is required", () => {
  const on = discoverObsWebsocket(cfgFile("on.json", { ...base, server_enabled: true }));
  assert.deepEqual(on, { status: "found", url: "ws://127.0.0.1:4455", password: "pw" });
  const noAuth = discoverObsWebsocket(cfgFile("noauth.json", { ...base, server_enabled: true, auth_required: false }));
  assert.equal(noAuth.password, "");
  assert.equal(discoverObsWebsocket(cfgFile("off.json", { ...base, server_enabled: false })).status, "disabled");
  assert.equal(discoverObsWebsocket(join(dir, "missing.json")).status, "not-installed");
});

test("enable: flips server_enabled and nothing else, only while OBS is closed", () => {
  const p = cfgFile("enable.json", { ...base, server_enabled: false });
  assert.equal(enableObsWebsocket(p, true), "obs-running");
  assert.equal(JSON.parse(readFileSync(p, "utf8")).server_enabled, false, "untouched while OBS runs");

  assert.equal(enableObsWebsocket(p, false), "enabled");
  const after = JSON.parse(readFileSync(p, "utf8"));
  assert.deepEqual(after, { ...base, server_enabled: true }, "port + password preserved");
  assert.equal(discoverObsWebsocket(p).status, "found", "discovery sees it immediately");

  assert.equal(enableObsWebsocket(p, false), "already-enabled");
  assert.equal(enableObsWebsocket(join(dir, "missing.json"), false), "no-config");
});
