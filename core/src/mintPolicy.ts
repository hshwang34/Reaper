// Token-mint policy: the rules that decide whether a router may receive an
// ek_ token right now. Enforced on whichever host holds the Decart key,
// because the router is the streamer's machine and can't be trusted with
// the "$1 = 1s" contract.
//
//   1. job-gated   — only while the engine has an active dispatched job, and
//                    only for that job's remaining time (+ cap headroom)
//   2. one per job — each token can open its own session; N tokens for one
//                    paid job = N parallel sessions billed to us
//   3. budget      — (hosted) the month's capped seconds must stay under the
//                    channel's cap; debited only after Decart issued the token
//
// The demo rig runs (1) and (2); the hosted plane adds (3) via a ledger.

import { SESSION_CAP_EXTRA_SEC } from "./decart.js";
import type { Engine } from "./engine.js";

export interface MintLedger {
  hasMintFor(jobId: string): boolean;
  /** Capped seconds already committed this billing period. */
  usedSec(): number;
  capSec(): number;
  record(entry: { jobId: string; durationSec: number; cappedSec: number }): void;
}

/** Policy refusal — carries the HTTP status a route should answer with. */
export class MintError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 403 = 403,
  ) {
    super(message);
    this.name = "MintError";
  }
}

/** In-memory ledger for hosts without persistence (the demo rig): enforces
 *  one-per-job for the process lifetime with no budget cap. */
export function memoryLedger(): MintLedger {
  const minted = new Set<string>();
  return {
    hasMintFor: (jobId) => minted.has(jobId),
    usedSec: () => 0,
    capSec: () => Number.POSITIVE_INFINITY,
    record: ({ jobId }) => {
      minted.add(jobId);
    },
  };
}

export async function gatedMint(
  engine: Engine,
  durationSec: number,
  mint: (durationSec: number) => Promise<string>,
  ledger: MintLedger = memoryLedger(),
): Promise<string> {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new MintError("durationSec required", 400);
  }
  const active = engine.snapshot().activeJob;
  if (!active) throw new MintError("no active job — token minting is job-gated");
  if (durationSec > active.remainingSec + SESSION_CAP_EXTRA_SEC) {
    throw new MintError("requested duration exceeds the active job");
  }
  if (ledger.hasMintFor(active.jobId)) {
    throw new MintError("a token was already minted for this job");
  }
  const cappedSec = durationSec + SESSION_CAP_EXTRA_SEC;
  if (ledger.usedSec() + cappedSec > ledger.capSec()) {
    throw new MintError("GPU budget exhausted for this period");
  }
  // Debit only once Decart actually issued the token — a failed mint must
  // not eat into the budget.
  const token = await mint(durationSec);
  ledger.record({ jobId: active.jobId, durationSec, cappedSec });
  return token;
}
