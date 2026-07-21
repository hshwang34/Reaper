// Control-plane environment. Everything is env-var driven (Fly secrets in
// production, repo .env in dev). Missing Twitch credentials flip the server
// into DEV AUTH mode (fake local accounts) so the whole plane is testable
// with zero external registrations — the OAuth apps have real lead times.

import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { warn } from "@rh/core";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const serverRoot = resolve(__dirname, "..");
export const repoRoot = resolve(serverRoot, "..");
loadDotenv({ path: resolve(repoRoot, ".env"), quiet: true });

function jwtSecret(): string {
  const s = process.env.RH_JWT_SECRET?.trim();
  if (s && s.length >= 32) return s;
  warn(
    "env",
    "RH_JWT_SECRET unset/short — using an ephemeral secret (sessions die on restart)",
  );
  return randomBytes(32).toString("hex");
}

export const env = {
  port: Number(process.env.RH_SERVER_PORT ?? 8790),
  /** Public origin for OAuth callbacks + portal links, e.g. https://app.example.com */
  publicUrl: process.env.RH_PUBLIC_URL?.trim() || `http://127.0.0.1:${Number(process.env.RH_SERVER_PORT ?? 8790)}`,
  jwtSecret: jwtSecret(),
  /** OUR metered Decart account — the whole point of the hosted plane. */
  decartApiKey: process.env.DECART_API_KEY?.trim() || "",
  twitchClientId: process.env.TWITCH_CLIENT_ID?.trim() || "",
  twitchClientSecret: process.env.TWITCH_CLIENT_SECRET?.trim() || "",
  databasePath:
    process.env.RH_DATABASE_PATH?.trim() || resolve(serverRoot, "data.sqlite"),
  uploadsDir:
    process.env.RH_UPLOADS_DIR?.trim() || resolve(serverRoot, "uploads"),
  /** Per-channel monthly GPU budget in seconds (hard mint stop). Default 1h
   *  ≈ $72 COGS — the alpha "we eat it, bounded" number. */
  monthlyGpuSecondsCap: Number(process.env.RH_MONTHLY_GPU_SECONDS_CAP ?? 3600),
};

/** No Twitch app registered → dev auth (explicitly loud about it). */
export const devAuthEnabled = !env.twitchClientId;
if (devAuthEnabled) {
  warn(
    "env",
    "TWITCH_CLIENT_ID unset — DEV AUTH enabled (/auth/dev). Never run production like this.",
  );
}
