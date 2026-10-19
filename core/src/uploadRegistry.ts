// Reference-image lifecycle (CONTENT-SAFETY S2 step 9 + S5 takedowns).
//
// Uploads used to live forever — deleted only when their own submission was
// rejected. Now every stored image is registered here and deleted on the
// first of: its submission expires untipped, its job finishes (ok or not), a
// takedown names it, or the hard TTL passes. The hashes outlive the bytes so
// a takedown also removes — and blocks re-upload of — identical copies
// (sha256) and near-duplicates (dHash), which is what the TAKE IT DOWN Act's
// "known identical copies" duty asks for.
//
// In-memory per runtime by design (same as the correlation store): a restart
// loses the index, so hosts also run `sweepUploadDir` on boot to delete any
// file older than the TTL.

import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { hamming } from "./images.js";
import { log } from "./log.js";

export interface UploadEntry {
  url: string;
  path: string;
  sha256: string;
  dhash: string;
  code: string | null;
  expiresAt: number;
}

/** dHash distance at or below which two images count as the same picture. */
const NEAR_DUPLICATE = 6;

/** Hard cap on how long any upload may exist (the job itself needs minutes). */
export const UPLOAD_TTL_MS = 60 * 60 * 1000;

export class UploadRegistry {
  private byUrl = new Map<string, UploadEntry>();
  private blocked: Array<{ sha256: string; dhash: string }> = [];
  private sweepTimer: ReturnType<typeof setInterval> | null;

  constructor(
    private deleteFile: (path: string) => void,
    private ttlMs = UPLOAD_TTL_MS,
  ) {
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweepTimer.unref?.();
  }

  register(e: Omit<UploadEntry, "expiresAt" | "code">): void {
    this.byUrl.set(e.url, { ...e, code: null, expiresAt: Date.now() + this.ttlMs });
  }

  bindCode(url: string, code: string): void {
    const e = this.byUrl.get(url);
    if (e) e.code = code;
  }

  /** True when a takedown (or a CSAM hit) blocked this picture. */
  isBlocked(sha256: string, dhash: string): boolean {
    return this.blocked.some(
      (b) => b.sha256 === sha256 || hamming(b.dhash, dhash) <= NEAR_DUPLICATE,
    );
  }

  block(sha256: string, dhash: string): void {
    this.blocked.push({ sha256, dhash });
  }

  release(url: string | null | undefined, why: string): void {
    if (!url) return;
    const e = this.byUrl.get(url);
    if (!e) return;
    this.byUrl.delete(url);
    this.remove(e, why);
  }

  releaseCode(code: string, why: string): void {
    for (const e of this.byUrl.values()) {
      if (e.code === code) this.release(e.url, why);
    }
  }

  /**
   * Takedown: delete the named upload(s) plus every identical / near-identical
   * copy we still hold, and block the picture from being uploaded again.
   * Returns how many files were removed.
   */
  takedown(target: { url?: string; code?: string; sha256?: string }): number {
    const seeds = [...this.byUrl.values()].filter(
      (e) =>
        (target.url && e.url === target.url) ||
        (target.code && e.code === target.code) ||
        (target.sha256 && e.sha256 === target.sha256),
    );
    for (const s of seeds) this.block(s.sha256, s.dhash);
    if (target.sha256 && !seeds.length) this.blocked.push({ sha256: target.sha256, dhash: "0".repeat(16) });
    let n = 0;
    for (const e of [...this.byUrl.values()]) {
      if (this.isBlocked(e.sha256, e.dhash)) {
        this.release(e.url, "takedown");
        n++;
      }
    }
    return n;
  }

  get size(): number {
    return this.byUrl.size;
  }

  sweep(): void {
    const now = Date.now();
    for (const e of [...this.byUrl.values()]) {
      if (e.expiresAt <= now) this.release(e.url, "ttl");
    }
  }

  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const e of [...this.byUrl.values()]) this.release(e.url, "runtime disposed");
  }

  private remove(e: UploadEntry, why: string): void {
    try {
      this.deleteFile(e.path);
      log("uploads", `-${e.url.split("/").pop()} (${why})`);
    } catch {
      /* best effort — the boot sweep catches stragglers */
    }
  }
}

/** Boot-time sweep: delete files older than `maxAgeMs` (one level of
 *  subdirectories, which is how the hosted plane lays out per-channel dirs).
 *  Never touches the quarantine directory. */
export function sweepUploadDir(dir: string, maxAgeMs = UPLOAD_TTL_MS): number {
  const cutoff = Date.now() - maxAgeMs;
  let n = 0;
  const visit = (d: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === "quarantine" || name.startsWith(".")) continue;
      const p = join(d, name);
      try {
        const st = statSync(p);
        if (st.isDirectory()) {
          if (depth < 1) visit(p, depth + 1);
        } else if (st.mtimeMs < cutoff) {
          rmSync(p, { force: true });
          n++;
        }
      } catch {
        /* raced with another delete */
      }
    }
  };
  visit(dir, 0);
  if (n) log("uploads", `boot sweep removed ${n} expired upload(s)`);
  return n;
}
