#!/usr/bin/env node
// End-to-end smoke test of the demo rig in MOCK mode — zero cost, no OBS.
//
//   npm run e2e
//
// What runs for real: the sidecar (built web app served from :PORT), the
// /router and /viewer pages in headless Chrome (fake camera), the WebRTC
// loopback, the buffering gate, the engine queue. What's faked: OBS (an
// obs-websocket v5 server below that records SetSceneItemEnabled calls), the
// camera (Chrome's fake device), Decart (no key → mock passthrough), and the
// tip (POST /api/dev/fake-tip). Streamlabs is forced off.
//
// The OBS call log is the thing asserted on: it is exactly what a streamer's
// audience would see. Needs Google Chrome installed (CHROME_PATH to override).

import { spawn, execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { encode, decode } from "@msgpack/msgpack";
import { chromium } from "playwright-core";
import sharp from "sharp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// ── tiny harness ────────────────────────────────────────────────────────────
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
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

// ── fake OBS (obs-websocket v5, json + msgpack subprotocols) ────────────────
/** Every SetSceneItemEnabled the rig makes, in order: [{visible, at}]. */
const obsCalls = [];
function startFakeObs(port) {
  const wss = new WebSocketServer({
    port,
    host: "127.0.0.1",
    handleProtocols: (protocols) =>
      protocols.has("obswebsocket.msgpack") ? "obswebsocket.msgpack" : "obswebsocket.json",
  });
  wss.on("connection", (ws) => {
    const msgpack = ws.protocol === "obswebsocket.msgpack";
    const send = (m) => ws.send(msgpack ? encode(m) : JSON.stringify(m));
    send({ op: 0, d: { obsWebSocketVersion: "5.5.0", rpcVersion: 1 } }); // Hello, no auth
    ws.on("message", (raw, isBinary) => {
      const m = isBinary ? decode(raw) : JSON.parse(String(raw));
      if (m.op === 1) return send({ op: 2, d: { negotiatedRpcVersion: 1 } }); // Identified
      if (m.op !== 6) return;
      const { requestType, requestId, requestData = {} } = m.d;
      let responseData = {};
      if (requestType === "GetSceneItemId") responseData = { sceneItemId: 7 };
      if (requestType === "SetSceneItemEnabled") {
        obsCalls.push({ visible: requestData.sceneItemEnabled, at: Date.now() });
      }
      send({
        op: 7,
        d: { requestType, requestId, requestStatus: { result: true, code: 100 }, responseData },
      });
    });
  });
  return wss;
}

// ── run ─────────────────────────────────────────────────────────────────────
let sidecar, browser, obs, settingsDir;
async function main() {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} (set CHROME_PATH)`);

  console.log("building web …");
  execSync("npm run build", { cwd: root, stdio: "ignore" });

  const [port, obsPort] = [await freePort(), await freePort()];
  obs = startFakeObs(obsPort);
  const base = `http://127.0.0.1:${port}`;

  // Explicit empty values win over .env (dotenv never overrides set vars), so
  // a developer's real keys can't leak into the test — MOCK, no Streamlabs.
  // E2E_REAL_DECART=1 opts into the .env Decart key: same checks, real lucy
  // sessions (a few seconds of billed GPU time per run).
  const realDecart = process.env.E2E_REAL_DECART === "1";
  settingsDir = mkdtempSync(join(tmpdir(), "rh-e2e-"));
  const settingsFile = join(settingsDir, "settings.json");
  sidecar = spawn("npm", ["run", "start", "--workspace", "sidecar"], {
    cwd: root,
    env: {
      ...process.env,
      SIDECAR_PORT: String(port),
      ...(realDecart ? {} : { DECART_API_KEY: "" }),
      STREAMLABS_SOCKET_TOKEN: "",
      // Never call paid classifier vendors from the harness: MOCK runs the
      // dev suite (blocklist + structure). With E2E_REAL_DECART the .env
      // classifier keys apply, exactly as on the rig.
      ...(realDecart
        ? {}
        : { OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", SIGHTENGINE_API_USER: "", SIGHTENGINE_API_SECRET: "" }),
      // A fresh settings file: DEFAULT_SETTINGS, never the developer's own.
      SIDECAR_SETTINGS_PATH: settingsFile,
      OBS_WS_URL: `ws://127.0.0.1:${obsPort}`,
      OBS_WS_PASSWORD: "",
      OBS_SCENE: "Scene",
      OBS_SOURCE: "AI Hijack",
    },
    stdio: process.env.E2E_VERBOSE ? "inherit" : "ignore",
  });

  console.log(`sidecar on ${base}, fake OBS on :${obsPort}`);
  const api = async (path, body) => {
    const r = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const up = await waitFor(async () => (await api("/api/health").catch(() => ({}))).status === 200, 30_000, 300);
  check("sidecar boots", up);
  if (!up) return;

  // The output guard is opt-in (CONTENT-SAFETY §5) — off by default. Turn it
  // on explicitly so the run still proves the real nsfwjs guard loads in
  // Chrome and passes the first frame.
  const guard = await api("/api/settings", { outputGuard: "on" });
  check("output guard opted in via settings", guard.json?.outputGuard === "on");

  const cfg = await api("/api/router-config");
  check(realDecart ? "runs in LIVE Decart mode" : "runs in MOCK mode", cfg.json?.decartEnabled === realDecart);

  browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  const ctx = await browser.newContext({ permissions: ["camera", "microphone"] });
  const viewer = await ctx.newPage(); // stands in for the OBS Browser Source
  await viewer.goto(`${base}/viewer`);
  const router = await ctx.newPage();
  await router.goto(`${base}/router`);
  await router.getByRole("button", { name: /arm camera/i }).click();
  check(
    "router arms the camera",
    await waitFor(async () => !(await router.getByRole("button", { name: /arm camera/i }).isVisible()), 10_000),
  );
  check(
    "router OBS tile shows connected",
    await waitFor(async () => /OBS\s*connected/i.test(await router.locator("body").innerText()), 12_000),
  );

  // ── 1. a paid job: hidden until frames, visible ~N s, hidden again ──────
  const sub = await api("/api/submissions", { prompt: "make it look like a watercolor painting" });
  check("submission returns a claim code", sub.status === 200 && typeof sub.json?.code === "string", sub.json?.code);

  const N = 4;
  obsCalls.length = 0;
  const t0 = Date.now();
  const tip = await api("/api/dev/fake-tip", { amount: N, message: `go ${sub.json?.code}`, username: "e2e" });
  check("tip is accepted and queued", tip.status === 200 && tip.json?.ok === true, String(tip.json?.outcome));

  const shown = await waitFor(() => obsCalls.some((c) => c.visible === true), 20_000);
  check("OBS source unhidden after the buffering gate", shown, shown ? `${Date.now() - t0} ms after tip` : "");
  // CONTENT-SAFETY S4/S6: the real nsfwjs guard loaded in Chrome and passed
  // the first frame (opted in above), and the viewer draws the
  // on-stream chips over the effect.
  check(
    "output guard loaded in the router and passed the first frame",
    /output guard ready/i.test(await router.locator("body").innerText()),
  );
  const chips = await waitFor(async () => {
    const t = await viewer.locator("body").innerText();
    return /AI-altered/.test(t) && /hijacked by e2e/.test(t);
  }, 3000);
  check('viewer shows "AI-altered" + "hijacked by e2e" chips', chips);
  if (shown && process.env.E2E_SCREENSHOT) {
    await sleep(1500);
    await viewer.screenshot({ path: process.env.E2E_SCREENSHOT });
    console.log(`    viewer screenshot → ${process.env.E2E_SCREENSHOT}`);
  }
  const hidden = await waitFor(() => obsCalls.at(-1)?.visible === false && obsCalls.some((c) => c.visible), (N + 15) * 1000);
  check("OBS source hidden again when the job ends", hidden);
  const on = obsCalls.find((c) => c.visible === true);
  const off = obsCalls.findLast((c) => c.visible === false);
  if (on && off) {
    const liveSec = (off.at - on.at) / 1000;
    check(`visible for ≈ the paid ${N}s`, liveSec >= N - 0.5 && liveSec <= N + 2, `${liveSec.toFixed(1)}s`);
  }

  // ── 2. panic mid-job: hides immediately ─────────────────────────────────
  await sleep(4000); // cooldown between jobs
  obsCalls.length = 0;
  await api("/api/dev/fake-tip", { amount: 10, message: "panic test", username: "e2e" });
  const shown2 = await waitFor(() => obsCalls.some((c) => c.visible === true), 20_000);
  check("second job goes live", shown2);
  const tPanic = Date.now();
  const p = await api("/api/panic", {});
  check("panic pauses the engine", p.json?.paused === true);
  const hidden2 = await waitFor(() => obsCalls.at(-1)?.visible === false, 3000, 50);
  check("panic hides OBS within 3s", hidden2, hidden2 ? `${Date.now() - tPanic} ms` : "");
  await api("/api/panic", {}); // resume

  // ── 3. guardrails: bad input never reaches the engine ───────────────────
  const tiny = await api("/api/dev/fake-tip", { amount: -1 });
  check("non-positive tip rejected", tiny.status === 400);
  const unknown = await api("/api/submissions", { presetId: "__proto__" });
  check("prototype-key preset id rejected", unknown.status >= 400 && unknown.status < 500);

  // ── 4. content safety: moderation ledger, report, takedown ─────────────
  const nsfw = await api("/api/submissions", { prompt: "make everyone naked" });
  check("blocklisted custom prompt rejected (422)", nsfw.status === 422, nsfw.json?.error);
  const log = await api("/api/moderation?limit=20");
  const hit = log.json?.events?.find((e) => e.stage === "text" && e.verdict === "reject");
  // The reason may name the blocklist term; the viewer's own text never lands.
  check(
    "rejection is in the moderation ledger (hashed, not stored)",
    Boolean(hit?.inputHash) && !JSON.stringify(log.json).includes("make everyone naked"),
  );
  const rep = await api("/api/report", { reason: "e2e: overlay test", code: sub.json?.code });
  check("viewer report accepted", rep.status === 200 && rep.json?.ok === true);
  const td = await api("/api/takedown", { contact: "e2e@example.com", description: "e2e takedown" });
  check("takedown request ticketed", td.status === 200 && typeof td.json?.ticket === "string");
  const cfg2 = await api("/api/config");
  check("portal config carries the consent statement", /18 or older/.test(cfg2.json?.consentStatement ?? ""));

  // Multipart uploads through multer → sniff/re-encode → registry.
  const upload = async (bytes, type, fields) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    form.set("image", new Blob([bytes], { type }), "ref");
    const r = await fetch(`${base}/api/submissions`, { method: "POST", body: form });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const png = await sharp({ create: { width: 200, height: 200, channels: 3, background: "#2a6" } })
    .png()
    .toBuffer();
  const okUp = await upload(png, "image/png", { presetId: "underwater" });
  check("a real photo uploads with a preset", okUp.status === 200, okUp.json?.error ?? okUp.json?.code);
  const fake = await upload(Buffer.from("<html><script>alert(1)</script></html>"), "image/png", { presetId: "underwater" });
  check("HTML declared as image/png is rejected by its bytes", fake.status === 400, fake.json?.error);
  const swap = await upload(png, "image/png", { presetId: "photo-swap" });
  check("face swap without the consent box is refused", swap.status === 400, swap.json?.error);
}

try {
  await main();
} catch (e) {
  check("harness ran without throwing", false, e?.message ?? String(e));
} finally {
  await browser?.close().catch(() => {});
  sidecar?.kill("SIGTERM");
  obs?.close();
  if (settingsDir) rmSync(settingsDir, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
