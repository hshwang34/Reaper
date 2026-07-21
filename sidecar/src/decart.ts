// Decart client-token minting. The permanent dct_ key never leaves this file.
// We mint a short-lived ek_ token per job, capped at the job's paid duration
// via constraints.realtime.maxSessionDuration — Decart's server then kills the
// session even if the local machine hangs (the hardest cost backstop).

import { decartEnabled, env } from "./config.js";
import { log, err } from "./log.js";

const MODEL = "lucy-2.5";

/**
 * Mint an ek_ client token scoped to lucy-2.5, expiring soon, with a server-
 * side session cap of durationSec + 15s. Returns "MOCK" when no key is set so
 * the router can run a camera-passthrough demo without incurring cost.
 */
export async function mintClientToken(
  durationSec: number,
  origin: string,
): Promise<string> {
  if (!decartEnabled) return "MOCK";

  // Lazy import: keeps the sidecar bootable without the SDK resolving any
  // browser-only globals at module load, and isolates the one uncertain dep.
  const { createDecartClient } = await import("@decartai/sdk");
  const client = createDecartClient({ apiKey: env.decartApiKey });

  try {
    const res = await client.tokens.create({
      expiresIn: 120,
      allowedModels: [MODEL],
      // allowedOrigins is browser-enforced defense-in-depth; include the router
      // origin so a leaked token can't be used from an arbitrary page.
      allowedOrigins: origin ? [origin] : undefined,
      constraints: { realtime: { maxSessionDuration: durationSec + 15 } },
    });
    log("decart", `minted ek_ token, session cap ${durationSec + 15}s`);
    return res.apiKey;
  } catch (e) {
    err("decart", "token mint failed:", (e as Error).message);
    throw e;
  }
}

export const decartModel = MODEL;
