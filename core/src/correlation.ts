// Pending-submission store + tip↔submission matching.
//
// Viewers submit (prompt + image) BEFORE tipping, because the Streamlabs tip
// form has no image field. We hand back a short claim code the viewer puts in
// their tip message. On a tip, match in priority order:
//   1. code found in the tip message
//   2. tipperName the viewer declared == tip username
//   3. exactly one unexpired pending submission (single-viewer demo path)
//   4. no match → caller fires the streamer's default preset
// Matched submissions are consumed immediately; unmatched ones expire on a TTL.

import { randomBytes } from "node:crypto";
import type { HijackJob, Submission, TipEvent } from "@rh/shared";
import { log } from "./log.js";

// Unambiguous alphabet: no O/0, I/1.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface MatchResult {
  submission: Submission | null;
  matchedBy: HijackJob["matchedBy"];
}

export class CorrelationStore {
  private pending = new Map<string, Submission>();
  private sweepTimer: NodeJS.Timeout;

  /** Called when a submission expires without a tip (to notify its portal). */
  onExpire: (code: string) => void = () => {};

  constructor(private ttlMs = 10 * 60 * 1000) {
    this.sweepTimer = setInterval(() => this.sweep(), 15_000);
    // Do not keep the process alive solely for the sweep.
    this.sweepTimer.unref?.();
  }

  private genCode(): string {
    let code = "";
    do {
      const bytes = randomBytes(4);
      code = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
    } while (this.pending.has(code));
    return code;
  }

  add(input: {
    prompt: string;
    presetId: string | null;
    tipperName: string | null;
    imageUrl: string | null;
  }): Submission {
    const now = Date.now();
    const sub: Submission = {
      code: this.genCode(),
      prompt: input.prompt,
      presetId: input.presetId,
      tipperName: input.tipperName,
      imageUrl: input.imageUrl,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.pending.set(sub.code, sub);
    log("correlation", `+submission ${sub.code} (${this.pending.size} pending)`);
    return sub;
  }

  /** Match a tip to a submission, consuming it if found. */
  match(tip: TipEvent): MatchResult {
    // 1. code in message
    const upper = tip.message.toUpperCase();
    for (const sub of this.pending.values()) {
      if (upper.includes(sub.code)) {
        this.pending.delete(sub.code);
        return { submission: sub, matchedBy: "code" };
      }
    }
    // 2. declared tipper name
    const name = tip.username.trim().toLowerCase();
    if (name) {
      for (const sub of this.pending.values()) {
        if (sub.tipperName && sub.tipperName.trim().toLowerCase() === name) {
          this.pending.delete(sub.code);
          return { submission: sub, matchedBy: "username" };
        }
      }
    }
    // 3. sole pending submission
    if (this.pending.size === 1) {
      const sub = [...this.pending.values()][0];
      this.pending.delete(sub.code);
      return { submission: sub, matchedBy: "sole-pending" };
    }
    // 4. no match
    return { submission: null, matchedBy: "default-preset" };
  }

  get(code: string): Submission | undefined {
    return this.pending.get(code);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [code, sub] of this.pending) {
      if (sub.expiresAt <= now) {
        this.pending.delete(code);
        log("correlation", `-submission ${code} expired`);
        this.onExpire(code);
      }
    }
  }
}
