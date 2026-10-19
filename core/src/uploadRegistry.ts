// Reference-image lifecycle (CONTENT-SAFETY S2 step 9 + S5 takedowns).
//
// Uploads used to live forever — deleted only when their own submission was
// rejected. Now every stored image is registered here and deleted on the
// first of: its submission expires untipped, its job finishes (ok or not), a
// takedown names it, or the hard TTL passes. The hashes outlive the bytes, so
// a takedown also removes — and blocks re-upload of — identical copies
// (sha256), which is what the TAKE IT DOWN Act's "known identical copies"
// duty asks for.
//
// Two strengths of takedown, because the public endpoint is anonymous:
//   · exact (anonymous requests): sha256 matches only. Possessing the image
//     URL proves you saw that upload; it proves nothing about other uploads
//     that merely LOOK alike, so a stranger can't use one request to wipe —
//     and permanently block — everyone's similar photos.
//   · near-duplicate (streamer/operator, or our own CSAM block): also dHash
//     neighbours (re-compressed / resized copies).
// The block list is capped so an attacker can't grow it without bound.
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

/** Most block entries kept; the oldest non-pinned entry is evicted first. */
export const MAX_BLOCKED = 5000;

interface BlockEntry {
  sha256: string;
  /** Present only for near-duplicate blocks. */
  dhash: string | null;
  /** Never evicted by the cap (suspected CSAM). */
  pinned: boolean;
}

export interface TakedownOptions {
  /** Also remove/block dHash near-duplicates. Authenticated callers only. */
  nearDuplicates?: boolean;
}

export class UploadRegistry {
  private byUrl = new Map<string, UploadEntry>();
  private blocked: BlockEntry[] = [];
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
      (b) => b.sha256 === sha256 || (b.dhash !== null && hamming(b.dhash, dhash) <= NEAR_DUPLICATE),
    );
  }

  /**
   * Block a picture from being uploaded again. `dhash` widens the block to
   * near-duplicates; pass null for an exact-only block. `pinned` entries
   * (suspected CSAM) survive the cap.
   */
  block(sha256: string, dhash: string | null, pinned = false): void {
    if (this.blocked.some((b) => b.sha256 === sha256 && b.dhash === dhash)) return;
    this.blocked.push({ sha256, dhash, pinned });
    if (this.blocked.length > MAX_BLOCKED) {
      const i = this.blocked.findIndex((b) => !b.pinned);
      if (i >= 0) this.blocked.splice(i, 1);
    }
  }

  get blockedCount(): number {
    return this.blocked.length;
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
   * Takedown: delete the named upload(s) plus every copy we still hold —
   * exact (sha256) copies by default, and dHash near-duplicates too when
   * `nearDuplicates` is set (authenticated callers only) — and block the
   * picture from being uploaded again. Returns how many files were removed.
   */
  takedown(
    target: { url?: string; code?: string; sha256?: string },
    opts: TakedownOptions = {},
  ): number {
    const near = opts.nearDuplicates === true;
    const seeds = [...this.byUrl.values()].filter(
      (e) =>
        (target.url && e.url === target.url) ||
        (target.code && e.code === target.code) ||
        (target.sha256 && e.sha256 === target.sha256),
    );
    const shas = new Set(seeds.map((s) => s.sha256));
    if (target.sha256) shas.add(target.sha256);
    const dhashes = near ? seeds.map((s) => s.dhash) : [];
    for (const s of seeds) this.block(s.sha256, near ? s.dhash : null);
    // A hash-only request (nothing stored right now) still blocks re-upload —
    // exactly, never by a placeholder dHash that would match flat images.
    if (target.sha256 && !seeds.length) this.block(target.sha256, null);

    let n = 0;
    for (const e of [...this.byUrl.values()]) {
      const hit =
        shas.has(e.sha256) || dhashes.some((d) => hamming(d, e.dhash) <= NEAR_DUPLICATE);
      if (hit) {
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
