// Decart client-token minting. The permanent dct_ key is passed in by the host
// composition (server.ts) and never leaves this process. We mint a short-lived
// ek_ token per job, capped at the job's paid duration via
// constraints.realtime.maxSessionDuration — Decart's server then kills the
// session even if the local machine hangs (the hardest cost backstop).

import { log, err } from "./log.js";

const MODEL = "lucy-2.5";

/**
 * Mint an ek_ client token scoped to lucy-2.5, with a 45s validity window and a
 * server-side session cap of durationSec + 15s. Returns "MOCK" when no real
 * key is set so the router can run a camera-passthrough demo without cost.
 */
export async function mintClientToken(
  apiKey: string,
  durationSec: number,
  origin: string,
): Promise<string> {
  if (!apiKey.startsWith("dct_")) return "MOCK";

  // Lazy import: keeps the host bootable without the SDK resolving any
  // browser-only globals at module load, and isolates the one uncertain dep.
  const { createDecartClient } = await import("@decartai/sdk");
  const client = createDecartClient({ apiKey });

  try {
    // allowedOrigins is intentionally omitted: on localhost, setting it made
    // Decart reject the realtime WebSocket (`wasConnected:false` / no remote
    // track). With origin-locking off, the compensating control is a short
    // token lifetime — 45s easily covers mint→connect (seconds) while sharply
    // limiting how long a leaked ek_ token could open a session from any page.
    // TODO(phase1): re-enable allowedOrigins once we serve from a real HTTPS
    // origin and can confirm Decart's matching against it (tracked in
    // docs/PHASE0.md live-verification).
    void origin;
    const res = await client.tokens.create({
      expiresIn: 45,
      allowedModels: [MODEL],
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
