#!/usr/bin/env node
// Live smoke test — the whole money path on PRODUCTION, as a real viewer:
//
//   npm run smoke:live
//
// A headless browser opens the hosted portal, picks a preset, pays on the
// REAL Stripe Checkout page with Stripe's test card (4242…, test mode only),
// comes back, and watches the hijack go LIVE and complete. Real webhook, real
// Decart session, real OBS on the streamer's machine.
//
// Preconditions (the script checks and says what's missing):
//   · Stripe is in TEST mode on the server (this refuses to run otherwise —
//     a 4242 card on a live-mode Checkout would just be declined, but we
//     never want this script anywhere near real cards)
//   · the streamer's app is open and armed (portal reports live)
//
// Cost: the minimum payment ($3 → 3s) is fake test-mode money, but the 3s of
// Decart GPU is real: ~$0.06 per run. On demand only — never scheduled.
//
// Optional: STRIPE_SECRET_KEY (the platform's sk_test_) adds a ledger check —
// the charge exists on the streamer's connected account with our fee.
//
//   RH_SMOKE_URL / RH_SMOKE_CHANNEL   default prod + realfakemeat
//   CHROME_PATH                       default macOS Google Chrome
//   SMOKE_HEADED=1                    watch it happen

import { chromium } from "playwright-core";

const BASE = (process.env.RH_SMOKE_URL ?? "https://reality-hijack.fly.dev").replace(/\/+$/, "");
const CHANNEL = process.env.RH_SMOKE_CHANNEL ?? "realfakemeat";
const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeoutMs, stepMs = 250) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await pred().catch(() => false)) return true;
    await sleep(stepMs);
  }
  return false;
}

/** Fill a Stripe Checkout field if it's on the page (layouts vary by
 *  country, Link, and A/B tests — every field is best-effort except card). */
async function fillIfPresent(page, selector, value) {
  const el = page.locator(selector).first();
  if (await el.isVisible().catch(() => false)) await el.fill(value);
}

let browser;
async function main() {
  console.log(`live smoke: ${BASE}/c/${CHANNEL}\n`);
  const pay = await (await fetch(`${BASE}/api/c/${CHANNEL}/payments`)).json();
  if (!check("channel takes payments", pay.enabled === true, JSON.stringify(pay))) return;
  if (!check("streamer app is live (open + armed)", pay.live === true, pay.live ? "" : "open Stream Hijack and arm the camera, then rerun")) return;
  const amount = pay.minUsd;

  browser = await chromium.launch({ executablePath: CHROME, headless: !process.env.SMOKE_HEADED });
  const page = await (await browser.newContext({ locale: "en-US" })).newPage();
  await page.goto(`${BASE}/c/${CHANNEL}`);
  await page.getByRole("button", { name: /80s Anime/i }).first().click();
  await page.getByPlaceholder("optional").first().fill("smoke test");
  await page.locator('input[type="number"]').fill(String(amount));
  const t0 = Date.now();
  await page.getByRole("button", { name: new RegExp(`^Pay \\$${amount}`) }).click();

  // ── Stripe Checkout (hosted by Stripe) ──
  const onStripe = await waitFor(async () => new URL(page.url()).host === "checkout.stripe.com", 20_000);
  if (!check("redirected to Stripe Checkout", onStripe, new URL(page.url()).host)) return;
  const testMode = await waitFor(async () => /test mode/i.test(await page.locator("body").innerText()), 15_000);
  if (!check("Checkout is in TEST mode (refusing otherwise)", testMode)) return;
  await page.locator("#cardNumber").waitFor({ timeout: 20_000 });
  await fillIfPresent(page, "#email", "smoke@example.com");
  await page.locator("#cardNumber").fill("4242 4242 4242 4242");
  await page.locator("#cardExpiry").fill("12 / 34");
  await page.locator("#cardCvc").fill("123");
  await fillIfPresent(page, "#billingName", "Smoke Test");
  await fillIfPresent(page, "#billingPostalCode", "10001");
  // Stripe Link may offer to save the card — opt out if the box is there.
  const link = page.locator("#enableStripePass");
  if (await link.isChecked().catch(() => false)) await link.uncheck();
  await page.locator('[data-testid="hosted-payment-submit-button"], button[type="submit"]').first().click();

  // ── back on the portal ──
  const back = await waitFor(async () => new URL(page.url()).host === new URL(BASE).host, 60_000);
  check("payment succeeds and returns to the portal", back, `${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const body = () => page.locator("body").innerText();
  check("portal shows the paid status", await waitFor(async () => /Payment received|in the queue|LIVE|Hijack complete/.test(await body()), 20_000));
  const live = await waitFor(async () => /LIVE/.test(await body()), 60_000);
  check("hijack goes LIVE on stream", live, live ? `${((Date.now() - t0) / 1000).toFixed(1)}s after Pay` : (await body()).match(/It didn't play[^\n]*/)?.[0] ?? "");
  const done = await waitFor(async () => /Hijack complete/.test(await body()), amount * 1000 + 30_000);
  check("hijack completes", done, done ? "" : (await body()).match(/It didn't play[^\n]*/)?.[0] ?? "");

  // ── optional ledger check, straight from Stripe ──
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (!key.startsWith("sk_test_")) {
    console.log("  · STRIPE_SECRET_KEY (sk_test_) not set — skipping the Stripe ledger check");
    return;
  }
  const Stripe = (await import("stripe")).default;
  const stripe = new Stripe(key);
  const accounts = await stripe.accounts.list({ limit: 100 });
  const acct = accounts.data.find((a) => a.metadata?.login === CHANNEL) ?? null;
  if (!check("streamer's connected account found", Boolean(acct), acct?.id)) return;
  const sessions = await stripe.checkout.sessions.list({ limit: 1 }, { stripeAccount: acct.id });
  const s = sessions.data[0];
  check("latest Checkout session is ours, paid", s?.payment_status === "paid" && s?.amount_total === amount * 100, s?.id);
  const pi = s?.payment_intent
    ? await stripe.paymentIntents.retrieve(String(s.payment_intent), {}, { stripeAccount: acct.id })
    : null;
  check("platform fee taken", (pi?.application_fee_amount ?? 0) > 0, `${pi?.application_fee_amount}¢`);
  const refunds = pi ? await stripe.refunds.list({ payment_intent: pi.id }, { stripeAccount: acct.id }) : null;
  check("not refunded (it played)", (refunds?.data.length ?? 0) === 0);
}

try {
  await main();
} catch (e) {
  check("smoke ran without throwing", false, e?.message ?? String(e));
} finally {
  await browser?.close().catch(() => {});
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
