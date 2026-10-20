// Control-plane environment. Everything is env-var driven (Fly secrets in
// production, repo .env in dev).
//
// Two modes, chosen by RH_ENV:
//   · dev (default) — missing Twitch credentials flip the server into DEV AUTH
//     (fake local accounts), so the whole plane is testable with zero external
//     registrations. Missing secrets fall back to throwaway values.
//   · production — every credential the public internet depends on is
//     REQUIRED and the process refuses to boot without it. Dev fallbacks are
//     dangerous in public: with no Twitch app, /auth/dev lets anyone mint a
//     channel, and the dev routes spend our Decart key without a payment.

import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { warn } from "@rh/core";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const serverRoot = resolve(__dirname, "..");
export const repoRoot = resolve(serverRoot, "..");
loadDotenv({ path: resolve(repoRoot, ".env"), quiet: true });

export const isProduction = process.env.RH_ENV?.trim() === "production";

const str = (name: string) => process.env[name]?.trim() || "";

/** Production boot gate: every missing/invalid setting, listed at once, so a
 *  deploy fails with one actionable message instead of one per restart. */
export function productionProblems(e: NodeJS.ProcessEnv): string[] {
  const get = (n: string) => e[n]?.trim() || "";
  const problems: string[] = [];
  for (const n of [
    "RH_PUBLIC_URL",
    "DECART_API_KEY",
    "TWITCH_CLIENT_ID",
    "TWITCH_CLIENT_SECRET",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
  ]) {
    if (!get(n)) problems.push(`${n} is required`);
  }
  if (get("RH_JWT_SECRET").length < 32) problems.push("RH_JWT_SECRET must be at least 32 characters");
  const url = get("RH_PUBLIC_URL");
  if (url && !url.startsWith("https://")) problems.push("RH_PUBLIC_URL must be https:// in production");
  return problems;
}

if (isProduction) {
  const problems = productionProblems(process.env);
  if (problems.length) {
    // Thrown at import: nothing below (DB, routes, listeners) ever starts.
    throw new Error(`refusing to start in production:\n  - ${problems.join("\n  - ")}`);
  }
}

function jwtSecret(): string {
  const s = str("RH_JWT_SECRET");
  if (s.length >= 32) return s;
  warn("env", "RH_JWT_SECRET unset/short — using an ephemeral secret (sessions die on restart)");
  return randomBytes(32).toString("hex");
}

const port = Number(process.env.RH_SERVER_PORT ?? 8790);

export const env = {
  port,
  /** Public origin for OAuth callbacks + portal links, e.g. https://app.example.com */
  publicUrl: str("RH_PUBLIC_URL") || `http://127.0.0.1:${port}`,
  jwtSecret: jwtSecret(),
  /** OUR metered Decart account. Every second it spends is funded by a viewer
   *  payment (Stripe) — or the one free daily test hijack per channel. */
  decartApiKey: str("DECART_API_KEY"),
  twitchClientId: str("TWITCH_CLIENT_ID"),
  twitchClientSecret: str("TWITCH_CLIENT_SECRET"),
  databasePath: str("RH_DATABASE_PATH") || resolve(serverRoot, "data.sqlite"),
  uploadsDir: str("RH_UPLOADS_DIR") || resolve(serverRoot, "uploads"),
  /** Suspected-CSAM quarantine (docs/runbooks/csam.md). Outside uploadsDir
   *  so it is never served; on Fly, a volume path. */
  quarantineDir: str("RH_QUARANTINE_DIR") || resolve(serverRoot, "safety", "quarantine"),
  /** Nightly SQLite snapshots (kept 7 days). On Fly, a volume path. */
  backupDir: str("RH_BACKUP_DIR") || resolve(serverRoot, "backups"),
  /** Per-channel monthly GPU ceiling in seconds. With viewer-funded
   *  hijacks this is no longer a budget we eat — it's a fraud/runaway
   *  backstop (a stolen card farm can't run one channel unbounded). */
  monthlyGpuSecondsCap: Number(process.env.RH_MONTHLY_GPU_SECONDS_CAP ?? 3600),
  /** Stripe (Connect platform account). Empty in dev → payments disabled and
   *  the portal falls back to claim codes. Required in production. */
  stripeSecretKey: str("STRIPE_SECRET_KEY"),
  stripeWebhookSecret: str("STRIPE_WEBHOOK_SECRET"),
  /** Our cut and our cost basis (server/src/fees.ts). Server config, not
   *  streamer Settings: a streamer can't change what we take. */
  platformFeePct: Number(process.env.RH_PLATFORM_FEE_PCT ?? 5),
  gpuCostPerSec: Number(process.env.RH_GPU_COST_PER_SEC ?? 0.02),
  /** Smallest payment we accept: Stripe's fixed 30¢ makes tiny charges
   *  mostly fee. A channel's own minTipUSD can raise it, never lower it. */
  minPaymentUsd: Number(process.env.RH_MIN_PAYMENT_USD ?? 3),
};

/** No Twitch app registered (dev only) → dev auth, loudly. Never in prod:
 *  the boot gate above already refused to start without Twitch. */
export const devAuthEnabled = !isProduction && !env.twitchClientId;
if (devAuthEnabled) {
  warn("env", "TWITCH_CLIENT_ID unset — DEV AUTH enabled (/auth/dev). Never run production like this.");
}

/** The streamer console triggers (/dev/hijack, /dev/fake-tip) run a job with
 *  no payment behind it. Fine on a dev box; in production they'd be an
 *  unmetered tap on our Decart key, so they don't exist there. */
export const devRoutesEnabled = !isProduction;
