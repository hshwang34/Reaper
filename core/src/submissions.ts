// Viewer submission intake — the ONE implementation of "turn a portal form
// into a pending submission" that every host's POST /submissions route calls.
//
// Policy enforced here, not in route handlers (docs/CONTENT-SAFETY.md S0–S2):
//   · preset prompts are resolved server-side from the id (a client can never
//     spoof preset text) and must be permitted by the streamer's policy
//     (enabled, under the intensity ceiling, in an allowed category)
//   · custom free text runs the moderation chain: blocklist → classifiers,
//     fail-closed — and Decart's prompt rewriter is off for it unless the
//     streamer opted in, so we classify the text the model actually runs
//   · a reference image is sniffed, re-encoded, hashed, checked against
//     blocked pictures, classified (minors-covering classifier first), and
//     — when it shows a face — accepted only with a consent attestation
//   · checks run cheap → expensive, so a rejected request never pays for (or
//     sends bytes to) a vendor it didn't need
// Hosts own the transport (multer, response codes, file disposal, ledger
// storage); the decision and its audit records come from here.

import {
  CONSENT_STATEMENT,
  getPreset,
  presetAllowed,
  type ConsentRecord,
  type Settings,
} from "@rh/shared";
import type { CorrelationStore } from "./correlation.js";
import { ImageRejected, prepareUpload, sha256Hex, type PreparedImage } from "./images.js";
import {
  imagesReady,
  moderateImage,
  moderateText,
  ModerationUnavailable,
  textReady,
  type ChainStep,
  type ModerationSuite,
} from "./moderation.js";
import type { SafetyLedger, StrikeTracker } from "./safetyLedger.js";
import type { UploadRegistry } from "./uploadRegistry.js";
import { warn } from "./log.js";

export interface StoredImage {
  /** URL the router will fetch (host-relative locally, absolute hosted). */
  url: string;
  /** Where the host stored it — rewritten in place by the image pipeline. */
  path: string;
}

export interface SubmissionInput {
  /** Raw form fields — untrusted; coerced here. */
  presetId?: unknown;
  prompt?: unknown;
  tipperName?: unknown;
  /** Decart "enhance prompt" form field ("1"/"0"); absent = Decart default (on). */
  enhance?: unknown;
  /** Likeness-consent checkbox ("1" when ticked). */
  consent?: unknown;
  /** The stored upload, if any. */
  image: StoredImage | null;
  /** Salted submitter IP hash (strikes, ledger). */
  ipHash: string;
}

export interface IntakeDeps {
  store: CorrelationStore;
  settings: Settings;
  moderation: ModerationSuite;
  uploads: UploadRegistry;
  ledger: SafetyLedger;
  strikes: StrikeTracker;
}

export type SubmissionOutcome =
  | {
      ok: true;
      code: string;
      expiresAt: number;
      presetId: string | null;
      needsReview: boolean;
    }
  | {
      ok: false;
      /** HTTP status the host should answer with. */
      status: 400 | 403 | 422 | 429 | 503;
      error: string;
      /** Keep the stored image for the CSAM runbook instead of deleting it. */
      quarantine?: boolean;
    };

const MAX_PROMPT_CHARS = 500;
const MAX_NAME_CHARS = 64;
/** The endpoint is public and each pending entry lives for the TTL (10 min)
 *  whether or not a tip follows — without a ceiling a script can grow the
 *  store without bound. Far above any real channel's unclaimed backlog. */
export const MAX_PENDING_SUBMISSIONS = 1000;

/**
 * Decart "enhance prompt" flag from a multipart form field.
 *
 * Multipart fields arrive as strings (or are absent). The Decart default is ON,
 * and older portal builds never send the field at all — so absence means true.
 * Only an explicit off value ("0", "false", "off", "no") disables it.
 */
export function parseEnhance(raw: unknown): boolean {
  if (raw == null) return true;
  const v = String(raw).trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function ticked(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "on" || s === "yes";
}

export function isBanned(s: Pick<Settings, "bannedViewers">, name: string | null | undefined): boolean {
  if (!name) return false;
  const n = name.trim().toLowerCase();
  return s.bannedViewers.some((b) => b.trim().toLowerCase() === n);
}

/** Collapse a chain's steps into one ledger line's `source`. An empty chain
 *  is legal only in dev mode (no classifiers behind a MOCK model). */
function decidingStep(steps: ChainStep[]): ChainStep {
  return (
    steps.find((st) => st.verdict !== "allow") ??
    steps[steps.length - 1] ?? { source: "dev-mode", verdict: "allow", categories: [], reason: "no classifiers (MOCK model)" }
  );
}

export async function createSubmission(
  deps: IntakeDeps,
  input: SubmissionInput,
): Promise<SubmissionOutcome> {
  const { store, settings: s, moderation, ledger, strikes } = deps;
  const presetId = str(input.presetId, 64) || null;
  const customPrompt = str(input.prompt, MAX_PROMPT_CHARS);
  const tipperName = str(input.tipperName, MAX_NAME_CHARS) || null;
  const ipHash = input.ipHash;

  // ── Cheap gates first ──────────────────────────────────────────────────
  if (strikes.blocked(ipHash)) {
    return { ok: false, status: 429, error: "too many rejected requests — try again later" };
  }
  if (isBanned(s, tipperName)) {
    return { ok: false, status: 403, error: "you can't submit effects on this stream" };
  }
  if (store.size >= MAX_PENDING_SUBMISSIONS) {
    return { ok: false, status: 429, error: "too many pending submissions — try again shortly" };
  }

  let prompt: string;
  let finalPresetId: string | null;
  let needsReview = false;
  let reviewWhy = "";
  // Approval is opt-in (CONTENT-SAFETY §5). With no approval tier on, nobody
  // is watching the queue, so a borderline classifier result is rejected
  // up front — never parked, where a paid tip would wait on no one.
  const approvalOn = s.customPrompts === "classified+approval" || s.reviewLikeness;
  const preset = presetId ? getPreset(presetId) : undefined;

  if (presetId) {
    if (!preset) return { ok: false, status: 400, error: "unknown preset" };
    if (!presetAllowed(preset, s)) {
      return { ok: false, status: 403, error: "this effect isn't available on this stream" };
    }
    // lucy-2.5 character substitution with no reference image is a paid no-op.
    if (preset.needsImage && !input.image) {
      return { ok: false, status: 400, error: "this effect needs a reference image" };
    }
    prompt = preset.prompt;
    finalPresetId = preset.id;
  } else if (customPrompt) {
    if (s.customPrompts === "off") {
      return { ok: false, status: 403, error: "custom prompts are disabled by the streamer" };
    }
    if (!textReady(moderation)) {
      return { ok: false, status: 503, error: "custom prompts are unavailable right now — pick a preset" };
    }
    prompt = customPrompt;
    finalPresetId = null;
    if (s.customPrompts === "classified+approval") {
      needsReview = true;
      reviewWhy = "approval tier";
    }
  } else {
    return { ok: false, status: 400, error: "provide a preset or a custom prompt" };
  }

  if (input.image) {
    if (s.referenceImages === "off") {
      return { ok: false, status: 403, error: "reference images are disabled by the streamer" };
    }
    if (!imagesReady(moderation)) {
      return { ok: false, status: 503, error: "photo uploads are unavailable right now" };
    }
    // A face swap always needs consent — refuse before paying any vendor.
    if (preset?.needsImage && !ticked(input.consent)) {
      return { ok: false, status: 400, error: "confirm you have consent to use this person's likeness" };
    }
  }

  // ── Text chain (custom prompts only) ───────────────────────────────────
  if (!finalPresetId) {
    const inputHash = sha256Hex(prompt);
    try {
      const r = await moderateText(prompt, s, s.blocklistExtra, moderation);
      const step = decidingStep(r.steps);
      const verdict = r.verdict === "review" && !approvalOn ? "reject" : r.verdict;
      ledger.record({
        stage: "text",
        verdict,
        source: step.source,
        reason: r.reason,
        categories: step.categories,
        inputHash,
        ipHash,
        tipper: tipperName,
      });
      if (r.verdict === "reject") {
        strikes.strike(ipHash);
        return { ok: false, status: 422, error: r.reason };
      }
      // Borderline, not abusive: refused without a strike.
      if (verdict === "reject") return { ok: false, status: 422, error: r.reason };
      if (r.verdict === "review") {
        needsReview = true;
        reviewWhy = `classifier: ${r.reason}`;
      }
    } catch (e) {
      return unavailable(ledger, "text", e, inputHash, ipHash, "custom prompts are unavailable right now — pick a preset");
    }
  }

  // ── Image pipeline ─────────────────────────────────────────────────────
  let consent: ConsentRecord | undefined;
  let prepared: PreparedImage | null = null;
  if (input.image) {
    try {
      prepared = await prepareUpload(input.image.path);
    } catch (e) {
      const msg = e instanceof ImageRejected ? e.message : "image could not be processed";
      ledger.record({ stage: "image", verdict: "reject", source: "structure", reason: msg, categories: ["structure"], ipHash, tipper: tipperName });
      return { ok: false, status: 400, error: msg };
    }
    const inputHash = prepared.sha256;
    if (deps.uploads.isBlocked(prepared.sha256, prepared.dhash)) {
      ledger.record({ stage: "image", verdict: "reject", source: "takedown-list", reason: "previously removed image", categories: ["blocked-hash"], inputHash, ipHash, tipper: tipperName });
      strikes.strike(ipHash);
      return { ok: false, status: 422, error: "this image isn't allowed" };
    }

    let faces = 0;
    try {
      const r = await moderateImage(prepared.classifierJpeg, s, moderation);
      faces = r.faces;
      const step = decidingStep(r.steps);
      if (r.csamSuspected) {
        // CONTENT-SAFETY S5: we now have "actual knowledge" (18 U.S.C. §2258A).
        // Preserve, block, and follow docs/runbooks/csam.md — the bytes have
        // already stopped before any further vendor saw them.
        deps.uploads.block(prepared.sha256, prepared.dhash);
        ledger.record({ stage: "image", verdict: "reject", source: step.source, reason: "suspected CSAM — runbook", categories: ["csam-suspected"], inputHash, ipHash, tipper: tipperName });
        warn("safety", `SUSPECTED CSAM upload quarantined (sha256 ${inputHash.slice(0, 12)}…) — follow docs/runbooks/csam.md`);
        strikes.strike(ipHash);
        strikes.strike(ipHash);
        strikes.strike(ipHash);
        return { ok: false, status: 422, error: "image rejected", quarantine: true };
      }
      const verdict = r.verdict === "review" && !approvalOn ? "reject" : r.verdict;
      ledger.record({
        stage: "image",
        verdict,
        source: step.source,
        reason: r.reason,
        categories: step.categories,
        inputHash,
        ipHash,
        tipper: tipperName,
      });
      if (r.verdict === "reject") {
        strikes.strike(ipHash);
        return { ok: false, status: 422, error: r.reason };
      }
      // Borderline, not abusive: refused without a strike.
      if (verdict === "reject") return { ok: false, status: 422, error: r.reason };
      if (r.verdict === "review") {
        needsReview = true;
        reviewWhy = `classifier: ${r.reason}`;
      }
    } catch (e) {
      return unavailable(ledger, "image", e, inputHash, ipHash, "photo uploads are unavailable right now");
    }

    // A likeness swap needs a face; in dev mode no classifier counts faces,
    // so the needsImage preset itself is what tells us a person is pictured.
    const likeness = faces > 0 || Boolean(preset?.needsImage);
    if (preset?.needsImage && !moderation.devMode && faces === 0) {
      return { ok: false, status: 400, error: "this effect needs a clear photo of a person" };
    }
    if (likeness) {
      if (!ticked(input.consent)) {
        return { ok: false, status: 400, error: "confirm you have consent to use this person's likeness" };
      }
      consent = { statement: CONSENT_STATEMENT, at: Date.now(), ipHash };
      if (s.reviewLikeness) {
        needsReview = true;
        reviewWhy ||= "likeness swap";
      }
    }
  }

  const viewerEnhance = parseEnhance(input.enhance);
  const sub = store.add({
    prompt,
    presetId: finalPresetId,
    tipperName,
    imageUrl: input.image?.url ?? null,
    // Custom text runs literally unless the streamer opted into rewriting —
    // the classifier scored THIS text, not whatever an enhancer makes of it.
    enhance: finalPresetId ? viewerEnhance : s.enhanceCustomPrompts && viewerEnhance,
    needsReview,
    reviewWhy,
    consent,
  });
  if (input.image && prepared) {
    // From here the registry owns the file: deleted when the submission
    // expires, its job finishes, a takedown names it, or the TTL passes.
    deps.uploads.register({
      url: input.image.url,
      path: input.image.path,
      sha256: prepared.sha256,
      dhash: prepared.dhash,
    });
    deps.uploads.bindCode(input.image.url, sub.code);
  }
  return { ok: true, code: sub.code, expiresAt: sub.expiresAt, presetId: finalPresetId, needsReview };
}

function unavailable(
  ledger: SafetyLedger,
  stage: "text" | "image",
  e: unknown,
  inputHash: string,
  ipHash: string,
  error: string,
): SubmissionOutcome {
  const source = e instanceof ModerationUnavailable ? e.source : "unknown";
  ledger.record({ stage, verdict: "error", source, reason: (e as Error).message, categories: [], inputHash, ipHash });
  warn("moderation", (e as Error).message);
  return { ok: false, status: 503, error };
}
