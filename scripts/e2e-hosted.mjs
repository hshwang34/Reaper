#!/usr/bin/env node
// End-to-end test of the COMMERCIAL path — the one a streamer actually runs:
//
//   npm run e2e:hosted
//
// What runs for real:
//   · the hosted control plane (server/, dev mode: DEV AUTH, MOCK Decart)
//   · the desktop app (Electron, driven by Playwright) — its local bridge,
//     cloud link, first-run routing, OBS provisioning, and the /router page
//     in Electron's own Chromium (fake camera)
//   · the viewer portal /c/<channel> in headless Chrome, clicking "Pay"
//   · the /viewer page (stands in for OBS's Browser Source), the WebRTC
//     loopback and the buffering gate
//   · the payment state machine, webhook verification, settle + refund paths
//
// What's faked:
//   · Stripe — a local HTTP server speaking the slice of the API we use
//     (server STRIPE_API_BASE seam). Its /pay page plays Checkout: it sends a
//     correctly SIGNED checkout.session.completed webhook, then redirects to
//     success_url, exactly like the real thing.
//   · OBS — an obs-websocket v5 server recording what the audience would see.
//   · Twitch — DEV AUTH (RH_CLOUD_LOGIN), the app's documented dev shortcut.
//
// The real-money twin of this (real Stripe test mode, real Decart, prod) is
// scripts/smoke-live.mjs. Needs Google Chrome (CHROME_PATH to override).

import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeObs, webcam, layer } from "./lib/fakeObs.mjs";
import { chromium } from "playwright-core";
import Stripe from "stripe";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const LOGIN = "e2ehost";
const WEBHOOK_SECRET = "whsec_e2e_hosted";
const OFFLINE_GRACE_MS = 4000;
const verbose = Boolean(process.env.E2E_VERBOSE);

// ── tiny harness (same shape as scripts/e2e.mjs) ───────────────────────────
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}
const section = (t) => console.log(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeoutMs, stepMs = 150) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await pred().catch(() => false)) return true;
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

// ── fake OBS (stateful: scripts/lib/fakeObs.mjs) ─────────────────────────────
// A real streamer layout: no scene called "Scene", a webcam under a frame and
// alerts. The app must find the webcam scene and slot the overlay directly
// above the webcam without touching anything else.
/** Every overlay show/hide, in order. */
let obsCalls = [];
let fakeObs = null;

// ── fake Stripe ────────────────────────────────────────────────────────────
const stripeState = {
  onboarded: false,
  sessions: new Map(), // id → session
  refunds: [], // { payment_intent, account, idempotencyKey }
  webhooks: [], // { type, status }
};
const ACCOUNT = "acct_e2e";

/** Stripe's form encoding (a[b][0][c]=v) → just the flat keys we read. */
function parseForm(body) {
  return Object.fromEntries(new URLSearchParams(body));
}
function startFakeStripe(port, serverBase) {
  const signer = new Stripe("sk_test_signer");
  let n = 0;
  const srv = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const json = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const redirect = (to) => {
      res.writeHead(302, { location: to });
      res.end();
    };
    const p = url.pathname;

    // ── API (what the server calls) ──
    if (req.method === "POST" && p === "/v2/core/accounts") return json(200, { id: ACCOUNT, object: "v2.core.account" });
    if (req.method === "GET" && p === `/v1/accounts/${ACCOUNT}`) {
      return json(200, { id: ACCOUNT, object: "account", charges_enabled: stripeState.onboarded });
    }
    if (req.method === "POST" && p === "/v1/account_links") {
      const f = parseForm(body);
      return json(200, { object: "account_link", url: `http://127.0.0.1:${port}/onboard?back=${encodeURIComponent(f.return_url)}` });
    }
    if (req.method === "POST" && p === "/v1/checkout/sessions") {
      const f = parseForm(body);
      const id = `cs_e2e_${++n}`;
      stripeState.sessions.set(id, {
        id,
        account: req.headers["stripe-account"],
        amount: Number(f["line_items[0][price_data][unit_amount]"]),
        fee: Number(f["payment_intent_data[application_fee_amount]"]),
        metadata: { paymentId: f["metadata[paymentId]"], channelId: f["metadata[channelId]"], code: f["metadata[code]"] },
        successUrl: f.success_url,
        paymentIntent: `pi_e2e_${n}`,
      });
      return json(200, { id, object: "checkout.session", url: `http://127.0.0.1:${port}/pay/${id}` });
    }
    if (req.method === "POST" && p === "/v1/refunds") {
      const f = parseForm(body);
      stripeState.refunds.push({
        payment_intent: f.payment_intent,
        account: req.headers["stripe-account"],
        idempotencyKey: req.headers["idempotency-key"],
      });
      return json(200, { id: `re_e2e_${stripeState.refunds.length}`, object: "refund" });
    }

    // ── Hosted pages (what a browser visits) ──
    if (req.method === "GET" && p === "/onboard") {
      stripeState.onboarded = true;
      return redirect(url.searchParams.get("back"));
    }
    if (req.method === "GET" && p.startsWith("/pay/")) {
      const s = stripeState.sessions.get(p.slice(5));
      if (!s) return json(404, { error: "no such session" });
      // Real Checkout order: the webhook is in flight while the browser goes
      // back to success_url. Awaiting it first keeps the test deterministic.
      const status = await sendWebhook(signer, serverBase, s);
      stripeState.webhooks.push({ type: "checkout.session.completed", status });
      return redirect(s.successUrl);
    }
    json(404, { error: { message: `fake stripe: unhandled ${req.method} ${p}` } });
  });
  return new Promise((done) => srv.listen(port, "127.0.0.1", () => done(srv)));
}
async function sendWebhook(signer, serverBase, s, override = {}) {
  const event = {
    id: `evt_${s.id}_${Math.random().toString(36).slice(2, 8)}`,
    object: "event",
    type: "checkout.session.completed",
    account: s.account,
    data: {
      object: {
        id: s.id,
        object: "checkout.session",
        payment_status: "paid",
        amount_total: s.amount,
        currency: "usd",
        payment_intent: s.paymentIntent,
        metadata: s.metadata,
        ...override,
      },
    },
  };
  const payload = JSON.stringify(event);
  const header = signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const r = await fetch(`${serverBase}/stripe/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": header },
    body: payload,
  });
  return r.status;
}

// ── run ─────────────────────────────────────────────────────────────────────
let server, browser, appProc, obs, stripeSrv;
const scratch = mkdtempSync(join(tmpdir(), "rh-e2e-hosted-"));

/**
 * Launch the real app (unpackaged, from app/) and attach over CDP.
 *
 * Not Playwright's _electron driver: it hangs connecting to an ESM-main app
 * (our dist/main.mjs). A plain --remote-debugging-port + connectOverCDP has
 * no such coupling — it's the same Chromium protocol, minus the injected
 * loader. Returns { page, close } where page is the app's window.
 */
async function launchApp(userData) {
  const cdpPort = await freePort();
  const proc = spawn(
    require("electron"),
    [
      resolve(root, "app"),
      `--remote-debugging-port=${cdpPort}`,
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      // Linux CI: Electron's setuid sandbox helper isn't installed root-owned
      // in node_modules, so Chromium refuses to start without this.
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    ],
    {
      env: {
        ...process.env,
        RH_USER_DATA: userData,
        RH_CLOUD_URL: serverBase,
        RH_CLOUD_LOGIN: LOGIN,
        // Never let a developer's real keys reach the test app.
        DECART_API_KEY: "",
        STREAMLABS_SOCKET_TOKEN: "",
      },
      stdio: verbose ? "inherit" : "ignore",
    },
  );
  const exited = new Promise((r) => proc.once("exit", r));
  appProc = proc;
  const up = await waitFor(async () => (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).ok, 30_000, 250);
  if (!up) throw new Error("app never opened its debugging port");
  const cdp = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  let page = null;
  await waitFor(async () => {
    page = cdp.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("http://127.0.0.1:")) ?? null;
    return Boolean(page);
  }, 30_000);
  if (!page) throw new Error("app window never loaded");
  return {
    page,
    close: async () => {
      await cdp.close().catch(() => {});
      proc.kill("SIGTERM");
      await Promise.race([exited, sleep(5000)]);
      if (proc.exitCode === null) proc.kill("SIGKILL");
      appProc = null;
    },
  };
}

let serverBase = "";
async function main() {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} (set CHROME_PATH)`);

  console.log("building web + app main …");
  execSync("npm run build", { cwd: root, stdio: "ignore" });
  execSync("npm run build:main --workspace app", { cwd: root, stdio: "ignore" });

  const [port, obsPort, stripePort] = [await freePort(), await freePort(), await freePort()];
  serverBase = `http://127.0.0.1:${port}`;
  fakeObs = obs = startFakeObs(obsPort, {
    scenes: {
      "Starting Soon": [layer("Countdown", "ffmpeg_source")],
      "Just Chatting": [layer("Background"), webcam("Facecam"), layer("Cam frame"), layer("Alerts", "browser_source")],
    },
    program: "Starting Soon",
  });
  obsCalls = obs.visibility;
  stripeSrv = await startFakeStripe(stripePort, serverBase);

  const data = join(scratch, "server");
  mkdirSync(data, { recursive: true });
  server = spawn("npm", ["run", "start", "--workspace", "server"], {
    cwd: root,
    env: {
      ...process.env,
      RH_ENV: "",
      RH_SERVER_PORT: String(port),
      RH_PUBLIC_URL: serverBase,
      RH_DATABASE_PATH: join(data, "db.sqlite"),
      RH_UPLOADS_DIR: join(data, "uploads"),
      RH_QUARANTINE_DIR: join(data, "quarantine"),
      RH_BACKUP_DIR: join(data, "backups"),
      // Explicit empties beat the repo .env (dotenv never overrides): DEV AUTH,
      // MOCK Decart, no paid classifier calls.
      TWITCH_CLIENT_ID: "",
      TWITCH_CLIENT_SECRET: "",
      DECART_API_KEY: "",
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      SIGHTENGINE_API_USER: "",
      SIGHTENGINE_API_SECRET: "",
      STRIPE_SECRET_KEY: "sk_test_e2e",
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_API_BASE: `http://127.0.0.1:${stripePort}`,
      RH_OFFLINE_GRACE_MS: String(OFFLINE_GRACE_MS),
    },
    stdio: verbose ? "inherit" : "ignore",
  });
  console.log(`server ${serverBase} · fake OBS :${obsPort} · fake Stripe :${stripePort}`);

  const api = async (path, { body, token, method } = {}) => {
    const r = await fetch(serverBase + path, {
      method: method ?? (body ? "POST" : "GET"),
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };

  // ── 1. server ──────────────────────────────────────────────────────────
  section("control plane");
  const health = await waitFor(async () => (await api("/healthz")).status === 200, 40_000, 300);
  if (!check("server boots", health)) return;
  const h = await api("/healthz");
  check("dev mode, MOCK Decart", h.json?.mode !== "production" && h.json?.decart === false, JSON.stringify(h.json));

  // ── 2. first run: the app opens the setup wizard, signed in ─────────────
  section("desktop app — first run");
  const firstProfile = join(scratch, "profile-first");
  mkdirSync(firstProfile, { recursive: true });
  writeFileSync(join(firstProfile, "keys.json"), JSON.stringify({ plain: { obsWsUrl: `ws://127.0.0.1:${obsPort}`, obsWsPassword: "" } }));
  let app = await launchApp(firstProfile);
  let win = app.page;
  check("first launch opens /setup (not the router)", await waitFor(async () => new URL(win.url()).pathname === "/setup", 20_000), win.url());
  check(
    "wizard shows the signed-in Twitch login",
    await waitFor(async () => (await win.locator("body").innerText()).toLowerCase().includes(LOGIN), 15_000),
  );
  check("first run does NOT touch OBS before consent", fakeObs.provisionedUrl() === "");
  await app.close();

  // The same dev sign-in the app just did gives us the streamer's API token.
  const session = await api("/auth/dev", { body: { login: LOGIN } });
  const token = session.json?.access;
  const channelId = session.json?.channelId;
  check("streamer session issued", Boolean(token && channelId), channelId);

  // ── 3. getting paid: Stripe onboarding ──────────────────────────────────
  section("streamer onboarding (Stripe Connect)");
  let pay = await api(`/api/c/${LOGIN}/payments`);
  check("payments OFF before onboarding", pay.json?.enabled === false);
  const onboard = await api(`/api/c/${LOGIN}/payouts/onboard`, { body: { country: "US", from: "app" }, token });
  check("onboarding returns a Stripe-hosted link", onboard.status === 200 && /\/onboard\?/.test(onboard.json?.url ?? ""));
  const back = await fetch(onboard.json.url, { redirect: "follow" });
  check("return from Stripe lands on /payouts-done", new URL(back.url).pathname === "/payouts-done", back.url);
  const payouts = await api(`/api/c/${LOGIN}/payouts`, { token });
  check("payouts enabled after onboarding", payouts.json?.enabled === true);
  pay = await api(`/api/c/${LOGIN}/payments`);
  check("portal: payments on, but not live (app offline)", pay.json?.enabled === true && pay.json?.live === false);

  // Checkout must refuse while the app is offline (the "paid but never plays" gap).
  const offSub = await api(`/api/c/${LOGIN}/submissions`, { body: { presetId: "80s-anime" } });
  const offCo = await api(`/api/c/${LOGIN}/checkout`, { body: { code: offSub.json?.code, amountUsd: 5 } });
  check("checkout refused while the app is offline (409)", offCo.status === 409, offCo.json?.error);

  // ── 4. returning launch: router, OBS provisioning, live ─────────────────
  section("desktop app — returning launch");
  writeFileSync(join(firstProfile, "app-state.json"), JSON.stringify({ setupDone: true }));
  app = await launchApp(firstProfile);
  win = app.page;
  check("returning launch opens /router", await waitFor(async () => new URL(win.url()).pathname === "/router", 20_000), win.url());
  check(
    "app provisions the OBS Browser Source with the /viewer URL",
    await waitFor(async () => /\/viewer\?auth=/.test(fakeObs.provisionedUrl()), 15_000),
    fakeObs.provisionedUrl().replace(/auth=[^&]+/, "auth=…"),
  );
  // An ADDITION to the streamer's layout: into the scene with the webcam
  // (there's no "Scene"), directly above the webcam, under their frame and
  // alerts, born hidden, sized to the webcam — and nothing of theirs moved.
  await waitFor(async () => fakeObs.scene("Just Chatting").join() === "Background,Facecam,AI Hijack,Cam frame,Alerts", 10_000);
  check(
    "overlay lands directly above the webcam, under the streamer's frame + alerts",
    fakeObs.scene("Just Chatting").join() === "Background,Facecam,AI Hijack,Cam frame,Alerts",
    fakeObs.scene("Just Chatting").join(" < "),
  );
  check("scenes without a webcam are left alone", fakeObs.scene("Starting Soon").join() === "Countdown");
  const ov = fakeObs.item("Just Chatting", "AI Hijack");
  check(
    "overlay is hidden and covers the webcam's drawn rect (398,181 1104×621)",
    ov?.enabled === false &&
      ov.transform.positionX === 398 && Math.round(ov.transform.positionY) === 181 &&
      ov.transform.boundsWidth === 1104 && Math.round(ov.transform.boundsHeight) === 621,
    JSON.stringify(ov && { enabled: ov.enabled, x: ov.transform.positionX, y: ov.transform.positionY, w: ov.transform.boundsWidth, h: ov.transform.boundsHeight }),
  );

  browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  const viewerPage = await (await browser.newContext()).newPage(); // the OBS Browser Source
  await viewerPage.goto(fakeObs.provisionedUrl());

  // First launch shows the "how it works" tour; a streamer can skip it.
  const skipTour = win.getByRole("button", { name: /^skip$/i });
  if (await skipTour.waitFor({ timeout: 5000 }).then(() => true, () => false)) await skipTour.click();
  await win.getByRole("button", { name: /turn on stream hijack/i }).click();
  check(
    "router arms the (fake) camera",
    await waitFor(async () => !(await win.getByRole("button", { name: /turn on stream hijack/i }).isVisible()), 15_000),
  );
  check(
    "portal goes live once the app is connected",
    await waitFor(async () => (await api(`/api/c/${LOGIN}/payments`)).json?.live === true, 20_000),
  );

  // ── 5. a viewer pays in the portal → the hijack plays in OBS ────────────
  section("viewer pays → hijack plays");
  const portal = await (await browser.newContext()).newPage();
  await portal.goto(`${serverBase}/c/${LOGIN}`);
  await portal.getByRole("button", { name: /80s Anime/i }).first().click();
  await portal.getByPlaceholder("optional").first().fill("e2e viewer");
  await portal.locator('input[type="number"]').fill("4");
  obsCalls.splice(0);
  const t0 = Date.now();
  await portal.getByRole("button", { name: /^Pay \$4/ }).click();
  // The portal consumes ?paid= and cleans the URL, so assert on what the
  // viewer sees: the paid status view (its "Hijack again" button).
  check(
    "Pay → Checkout → back on the portal, showing the paid status",
    await waitFor(async () => portal.getByRole("button", { name: /hijack again/i }).isVisible(), 20_000),
    portal.url().replace(serverBase, ""),
  );
  check("signed webhook accepted (200)", stripeState.webhooks.at(-1)?.status === 200, JSON.stringify(stripeState.webhooks.at(-1)));
  const s1 = [...stripeState.sessions.values()].at(-1);
  check("direct charge on the streamer's account", s1?.account === ACCOUNT);
  check("application fee = GPU + margin (4s → 28¢)", s1?.fee === 28, `${s1?.fee}¢ of ${s1?.amount}¢`);

  const shown = await waitFor(async () => obsCalls.some((c) => c.visible === true), 30_000);
  check("OBS unhidden after the buffering gate", shown, shown ? `${Date.now() - t0} ms after Pay` : "");
  const hidden = await waitFor(async () => obsCalls.at(-1)?.visible === false && obsCalls.some((c) => c.visible), 25_000);
  check("OBS hidden again when the paid time is up", hidden);
  const on = obsCalls.find((c) => c.visible === true);
  const off = obsCalls.findLast((c) => c.visible === false);
  if (on && off) {
    const sec = (off.at - on.at) / 1000;
    check("visible for ≈ the paid 4s", sec >= 3.5 && sec <= 6, `${sec.toFixed(1)}s`);
  }
  const delivered = await waitFor(async () => {
    const e = (await api(`/api/c/${LOGIN}/payouts`, { token })).json?.earnings ?? [];
    return e.some((r) => r.status === "delivered" && r.n === 1);
  }, 10_000);
  check("payment settles as delivered", delivered);
  check("no refund for a delivered hijack", stripeState.refunds.length === 0);

  // ── 6. webhook attacks are rejected ────────────────────────────────────
  section("webhook hardening");
  const signer = new Stripe("sk_test_signer");
  const unsigned = await fetch(`${serverBase}/stripe/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
    body: "{}",
  });
  check("bad signature → 400", unsigned.status === 400);
  const forgedSub = await api(`/api/c/${LOGIN}/submissions`, { body: { presetId: "80s-anime" } });
  const forgedCo = await api(`/api/c/${LOGIN}/checkout`, { body: { code: forgedSub.json?.code, amountUsd: 50 } });
  const forged = [...stripeState.sessions.values()].at(-1);
  obsCalls.splice(0);
  // Signed correctly, but claims 50¢ was paid for a $50 session.
  await sendWebhook(signer, serverBase, forged, { amount_total: 50 });
  await sleep(2500);
  check("underpaid session never starts a hijack", forgedCo.status === 200 && obsCalls.length === 0);
  // The forged one stays pending and simply expires; no refund is owed.

  // ── 7. panic blocks payments ───────────────────────────────────────────
  section("panic");
  const p1 = await api(`/api/c/${LOGIN}/panic`, { body: {}, token });
  check("panic pauses the channel", p1.json?.paused === true);
  pay = await api(`/api/c/${LOGIN}/payments`);
  check("portal not live while paused", pay.json?.live === false);
  const pSub = await api(`/api/c/${LOGIN}/submissions`, { body: { presetId: "80s-anime" } });
  const pCo = await api(`/api/c/${LOGIN}/checkout`, { body: { code: pSub.json?.code, amountUsd: 5 } });
  check("checkout refused while paused (409)", pCo.status === 409, pCo.json?.error);
  const p2 = await api(`/api/c/${LOGIN}/panic`, { body: {}, token });
  check("resume", p2.json?.paused === false);

  // ── 8. the app dies with a paid hijack queued → refunded ────────────────
  section("app quits with paid hijacks waiting → refund");
  const buy = async (usd) => {
    const sub = await api(`/api/c/${LOGIN}/submissions`, { body: { presetId: "80s-anime" } });
    const co = await api(`/api/c/${LOGIN}/checkout`, { body: { code: sub.json?.code, amountUsd: usd } });
    await fetch(co.json.url, { redirect: "manual" }); // "pay" → signed webhook
    return [...stripeState.sessions.values()].at(-1);
  };
  obsCalls.splice(0);
  const playing = await buy(10);
  const queued = await buy(5);
  check("first paid hijack goes live", await waitFor(async () => obsCalls.some((c) => c.visible === true), 30_000));
  await app.close(); // streamer's machine/app goes away mid-hijack
  const refunded = await waitFor(
    async () => stripeState.refunds.some((r) => r.payment_intent === queued.paymentIntent),
    OFFLINE_GRACE_MS + 15_000,
  );
  check(`queued paid hijack refunded after the ${OFFLINE_GRACE_MS / 1000}s offline grace`, refunded);
  const rq = stripeState.refunds.find((r) => r.payment_intent === queued.paymentIntent);
  check("refund issued on the streamer's account, idempotently", rq?.account === ACCOUNT && Boolean(rq?.idempotencyKey));
  const e = (await api(`/api/c/${LOGIN}/payouts`, { token })).json?.earnings ?? [];
  const playingRefunded = stripeState.refunds.some((r) => r.payment_intent === playing.paymentIntent);
  const review = e.find((r) => r.status === "failed_after_start");
  check(
    "the interrupted (already minted) hijack goes to review, not auto-refund",
    !playingRefunded && review?.n === 1,
    JSON.stringify(e.map((r) => `${r.status}:${r.n}`)),
  );
  const again = await api(`/api/c/${LOGIN}/payments`);
  check("portal stops taking payments once the app is gone", again.json?.live === false);
}

// Playwright can crash the process from inside its own dispatcher (e.g.
// "Process failed to launch!") — never leave the spawned server behind.
process.on("exit", () => {
  server?.kill("SIGTERM");
  appProc?.kill("SIGKILL");
});

try {
  await main();
} catch (e) {
  check("harness ran without throwing", false, e?.stack ?? String(e));
} finally {
  appProc?.kill("SIGKILL");
  await browser?.close().catch(() => {});
  server?.kill("SIGTERM");
  obs?.close();
  stripeSrv?.close();
  rmSync(scratch, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
