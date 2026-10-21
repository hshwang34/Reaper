#!/usr/bin/env node
// End-to-end test of the FIRST-RUN WIZARD (/setup), without Electron:
//
//   npm run e2e:wizard                 # headless; screenshots with E2E_SHOTS=<dir>
//
// Boots the mock sidecar + a fake obs-websocket exactly like scripts/e2e.mjs,
// then opens /setup in headless Chrome with a STUBBED desktop bridge
// (window.rhDesktop — the shape in shared/src/desktopBridge.ts: local-mode
// build, no control plane, OBS connected, Virtual Camera on) and walks all
// seven steps. The point of the run: the test step is itself a router, so
// the free test hijack goes LIVE inside the wizard and the OBS overlay is
// shown — the bug brief 001 was written for. The Electron-side wiring of the
// same wizard is covered by scripts/e2e-hosted.mjs.
//
// Needs Google Chrome (CHROME_PATH to override).

import { spawn, execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { encode, decode } from "@msgpack/msgpack";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.env.E2E_SHOTS ?? null;
const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeoutMs, stepMs = 100) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(stepMs);
  }
  return false;
}
function freePort() {
  return new Promise((done, fail) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
    s.on("error", fail);
  });
}
const obsCalls = [];
function startFakeObs(port) {
  const wss = new WebSocketServer({
    port, host: "127.0.0.1",
    handleProtocols: (p) => (p.has("obswebsocket.msgpack") ? "obswebsocket.msgpack" : "obswebsocket.json"),
  });
  wss.on("connection", (ws) => {
    const msgpack = ws.protocol === "obswebsocket.msgpack";
    const send = (m) => ws.send(msgpack ? encode(m) : JSON.stringify(m));
    send({ op: 0, d: { obsWebSocketVersion: "5.5.0", rpcVersion: 1 } });
    ws.on("message", (raw, isBinary) => {
      const m = isBinary ? decode(raw) : JSON.parse(String(raw));
      if (m.op === 1) return send({ op: 2, d: { negotiatedRpcVersion: 1 } });
      if (m.op !== 6) return;
      const { requestType, requestId, requestData = {} } = m.d;
      let responseData = {};
      if (requestType === "GetSceneItemId") responseData = { sceneItemId: 7 };
      if (requestType === "GetVirtualCamStatus") responseData = { outputActive: true };
      if (requestType === "SetSceneItemEnabled") obsCalls.push({ visible: requestData.sceneItemEnabled, at: Date.now() });
      send({ op: 7, d: { requestType, requestId, requestStatus: { result: true, code: 100 }, responseData } });
    });
  });
  return wss;
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

let sidecar, browser, obs, dir;
try {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} (set CHROME_PATH)`);
  console.log("building web …");
  execSync("npm run build", { cwd: root, stdio: "ignore" });
  const [port, obsPort] = [await freePort(), await freePort()];
  obs = startFakeObs(obsPort);
  const base = `http://127.0.0.1:${port}`;
  dir = mkdtempSync(join(tmpdir(), "rh-wiz-"));
  sidecar = spawn("npm", ["run", "start", "--workspace", "sidecar"], {
    cwd: root,
    env: {
      ...process.env, SIDECAR_PORT: String(port), DECART_API_KEY: "", STREAMLABS_SOCKET_TOKEN: "",
      OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", SIGHTENGINE_API_USER: "", SIGHTENGINE_API_SECRET: "",
      SIDECAR_SETTINGS_PATH: join(dir, "settings.json"),
      OBS_WS_URL: `ws://127.0.0.1:${obsPort}`, OBS_WS_PASSWORD: "", OBS_SCENE: "Scene", OBS_SOURCE: "AI Hijack",
    },
    stdio: "ignore",
  });
  const up = await waitFor(async () => (await fetch(base + "/api/health").catch(() => ({}))).status === 200, 30_000, 300);
  check("sidecar boots", up);

  browser = await chromium.launch({
    executablePath: CHROME, headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  const ctx = await browser.newContext({ permissions: ["camera", "microphone"], viewport: { width: 900, height: 900 } });
  // The stubbed Electron bridge: a local-mode build with no control plane,
  // OBS connected, Virtual Camera on. testHijack goes to the sidecar's
  // streamer-console route, which is what the app's local engine does.
  await ctx.addInitScript(({ base }) => {
    window.rhAuth = "";
    window.rhDesktop = {
      keysStatus: async () => ({}),
      saveKeys: async () => {},
      relaunch: async () => {},
      setupState: async () => ({
        cloudMode: false, login: null, cloudUrl: null, localModeAllowed: true,
        obs: { discovery: "found", connected: true, running: true, virtualCamActive: true },
        decartEnabled: false,
        keys: { decartApiKey: false }, port: 17712,
        viewerUrl: base + "/viewer", portalUrl: null, autoLaunch: false,
      }),
      signIn: async () => ({ ok: false }),
      signOut: async () => {},
      provisionObs: async () => ({ ok: true, detail: 'source "AI Hijack" ready in scene "Scene"' }),
      launchObs: async () => {},
      enableObsWebsocket: async () => "already-enabled",
      startVirtualCamera: async () => "already-on",
      payouts: async () => null,
      startPayouts: async () => {},
      setupComplete: async () => {},
      testHijack: async (prompt, durationSec) => {
        const r = await fetch(base + "/api/dev/hijack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt, durationSec }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "HTTP " + r.status);
        return j.outcome;
      },
      setAutoLaunch: async () => {},
      openExternal: async () => {},
    };
  }, { base });

  const viewer = await ctx.newPage();
  await viewer.goto(`${base}/viewer`);
  const page = await ctx.newPage();
  await page.goto(`${base}/setup`);
  const body = () => page.locator("body").innerText();
  const shot = (n) => (out ? page.screenshot({ path: join(out, `wizard-${n}.png`), fullPage: true }) : Promise.resolve());

  await waitFor(async () => /Step 1 of 7/.test(await body()), 5000);
  const stepLineOneRow = await page.evaluate(() => {
    const ol = document.querySelector('ol[aria-label="Progress"]');
    const r = ol.getBoundingClientRect();
    return r.height < 20;
  });
  check("stepper is a single row", stepLineOneRow);
  await shot("1-signin");
  await page.getByRole("button", { name: "Continue" }).click();

  await waitFor(async () => /Step 2 of 7/.test(await body()), 3000);
  await page.getByRole("button", { name: /add the ai hijack source/i }).click();
  await waitFor(async () => /ready in scene/.test(await body()), 3000);
  await shot("2-obs");
  await page.getByRole("button", { name: "Continue" }).click();

  await waitFor(async () => /Step 3 of 7/.test(await body()), 3000);
  await page.getByRole("button", { name: /use the obs virtual camera/i }).click();
  await waitFor(async () => /continue/i.test(await body()) && /Capturing/.test(await body()), 5000);
  await shot("3-camera");
  await page.getByRole("button", { name: /continue/i }).click();

  await waitFor(async () => /Step 4 of 7/.test(await body()), 3000);
  check("get paid step has no Streamlabs copy", !/Streamlabs/.test(await body()));
  await shot("4-paid");
  await page.getByRole("button", { name: "Continue" }).click();

  await waitFor(async () => /Step 5 of 7/.test(await body()), 3000);
  check("safety step says prompts + photos always", /always write their own prompt/.test(await body()));
  for (const cb of await page.locator('input[type="checkbox"]').all()) await cb.check();
  await shot("5-safety");
  await page.getByRole("button", { name: /i understand/i }).click();

  await waitFor(async () => /Step 6 of 7/.test(await body()), 3000);
  const runBtn = page.getByRole("button", { name: /run the 10-second test/i });
  const armed = await waitFor(async () => await runBtn.isEnabled(), 10_000);
  check("test step arms the camera (wizard is a router)", armed);
  await shot("6-test-before");
  obsCalls.length = 0;
  const t0 = Date.now();
  await runBtn.click();
  const live = await waitFor(async () => /LIVE/.test(await body()), 20_000);
  check("test hijack reaches LIVE inside the wizard", live, live ? `${Date.now() - t0} ms` : "");
  const shown = await waitFor(() => obsCalls.some((c) => c.visible === true), 5000);
  check("OBS overlay shown during the test", shown);
  await sleep(600);
  await shot("6-test-live");
  const asked = await waitFor(async () => /Did the|Did your/.test(await body()), 25_000);
  check("asks 'did you see it?' after the run", asked);
  await shot("6-test-after");
  await page.getByRole("button", { name: /no, i saw nothing/i }).click();
  await waitFor(async () => /find out why/i.test(await body()), 3000);
  check("'no' path explains the model went live here, so OBS is the suspect", /did go live here/.test(await body()));
  await shot("6-test-no");
  await page.getByRole("button", { name: /continue anyway/i }).click();
  await waitFor(async () => /Step 7 of 7/.test(await body()), 3000);
  check("done step explains panic with the key", /Panic: press/.test(await body()));
  await shot("7-done");

  const studio = await ctx.newPage();
  await studio.goto(`${base}/router`);
  await waitFor(async () => /Creator studio/.test(await studio.locator("body").innerText()), 5000);
  if (out) await studio.screenshot({ path: join(out, "studio.png"), fullPage: true });
  check("studio page renders", true);
} catch (e) {
  check("run completed", false, String(e?.stack ?? e));
} finally {
  await browser?.close();
  sidecar?.kill();
  obs?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  console.log(`${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
