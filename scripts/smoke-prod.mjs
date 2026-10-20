#!/usr/bin/env node
// Production smoke test — read-only, free, safe to run any time:
//
//   npm run smoke:prod                         # https://reality-hijack.fly.dev
//   RH_SMOKE_URL=https://… RH_SMOKE_CHANNEL=… npm run smoke:prod
//
// Asserts the deployed control plane is up AND still locked down: production
// mode, no dev auth, no unmetered dev routes, webhooks rejected unless signed,
// Twitch sign-in wired to the right callback, security headers, HTTPS only.
// Nothing here spends money, creates a payment, or writes data (the one POST
// that would — /auth/dev — must 404).
//
// Runs hourly + after deploys in .github/workflows/smoke.yml; a failure there
// is a page-worthy event, not a flaky test.

const BASE = (process.env.RH_SMOKE_URL ?? "https://reality-hijack.fly.dev").replace(/\/+$/, "");
const CHANNEL = process.env.RH_SMOKE_CHANNEL ?? "realfakemeat";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
async function get(path, init = {}) {
  const t0 = Date.now();
  const r = await fetch(BASE + path, { redirect: "manual", ...init });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, headers: r.headers, text, json, ms: Date.now() - t0 };
}

async function main() {
  console.log(`smoke: ${BASE} (channel ${CHANNEL})\n`);

  // ── up, and in production mode ──
  const h = await get("/healthz");
  check("healthz 200", h.status === 200, `${h.ms} ms`);
  check("production mode", h.json?.mode === "production", JSON.stringify(h.json));
  check("dev auth OFF", h.json?.devAuth === false);
  check("Decart key loaded (LIVE, not MOCK)", h.json?.decart === true);
  check("responds in < 2s", h.ms < 2000, `${h.ms} ms`);

  // ── locked down ──
  const dev = await get("/auth/dev", { method: "POST", headers: { "content-type": "application/json" }, body: '{"login":"smoke"}' });
  check("/auth/dev does not exist (404)", dev.status === 404, String(dev.status));
  const fake = await get(`/api/c/${CHANNEL}/dev/fake-tip`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"amount":1}' });
  check("dev fake-tip route does not exist (404)", fake.status === 404, String(fake.status));
  const hij = await get(`/api/c/${CHANNEL}/dev/hijack`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  check("dev hijack route does not exist (404)", hij.status === 404, String(hij.status));
  const wh = await get("/stripe/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=00" },
    body: '{"id":"evt_smoke","type":"checkout.session.completed"}',
  });
  check("unsigned Stripe webhook rejected (400)", wh.status === 400, String(wh.status));
  const th = await get(`/api/c/${CHANNEL}/test-hijack`, { method: "POST" });
  check("free test hijack needs the streamer's token (401)", th.status === 401, String(th.status));
  const po = await get(`/api/c/${CHANNEL}/payouts`);
  check("payouts need the streamer's token (401)", po.status === 401, String(po.status));

  // ── transport ──
  const plain = await fetch(BASE.replace(/^https:/, "http:") + "/healthz", { redirect: "manual" });
  check("http:// redirects to https://", plain.status === 301 && (plain.headers.get("location") ?? "").startsWith("https://"));
  check("HSTS", /max-age=\d{7,}/.test(h.headers.get("strict-transport-security") ?? ""));
  check("nosniff", h.headers.get("x-content-type-options") === "nosniff");
  check("no framing", h.headers.get("x-frame-options") === "DENY");

  // ── Twitch sign-in wiring (no login performed) ──
  const auth = await get("/auth/app?app_state=smoke");
  const loc = new URL(auth.headers.get("location") ?? "http://invalid/");
  check("app sign-in redirects to Twitch", auth.status === 302 && loc.host === "id.twitch.tv", loc.host);
  check(
    "Twitch callback is this server",
    loc.searchParams.get("redirect_uri") === `${BASE}/auth/twitch/callback`,
    loc.searchParams.get("redirect_uri") ?? "",
  );

  // ── the viewer side ──
  const portal = await get(`/c/${CHANNEL}`);
  check("viewer portal page serves", portal.status === 200 && /<div id="root">/.test(portal.text));
  const pay = await get(`/api/c/${CHANNEL}/payments`);
  check("channel takes payments (Stripe onboarded)", pay.json?.enabled === true, JSON.stringify(pay.json));
  check("minimum payment is sane ($1–$10)", pay.json?.minUsd >= 1 && pay.json?.minUsd <= 10, `$${pay.json?.minUsd}`);
  // live depends on whether the streamer's app is open right now — reported,
  // never failed on.
  console.log(`  · streamer app ${pay.json?.live ? "LIVE" : "offline"} right now`);
  const cfg = await get(`/api/c/${CHANNEL}/config`);
  check("portal config lists presets", Array.isArray(cfg.json?.presets) && cfg.json.presets.length > 0);
}

try {
  await main();
} catch (e) {
  check("smoke ran without throwing", false, e?.message ?? String(e));
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
