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
//   · cheap gates (strikes, bans, tiers, consent) run before any vendor; past
//     them, every safety check runs and EVERY failure point comes back as a
//     finding — the portal lists them all, live, as each check resolves
//   · the image minors gate still stops the chain: bytes that may show a
//     child go to no further vendor
// Hosts own the transport (multer, response codes, file disposal, ledger
// storage); the decision and its audit records come from here.

import {
  categoryLabel,
  CONSENT_STATEMENT,
  getPreset,
  presetAllowed,
  type CheckResult,
  type CheckState,
  type ConsentRecord,
  type SafetyCheck,
  type SafetyFinding,
  type Settings,
  type SubmitProgress,
} from "@rh/shared";
import type { CorrelationStore } from "./correlation.js";
import { ImageRejected, prepareUpload, sha256Hex, type PreparedImage } from "./images.js";
import {
  imagesReady,
  moderateImage,
  moderateText,
  ModerationUnavailable,
  PHOTO_FILE_CHECK,
  photoChecks,
  summarize,
  textChecks,
  textReady,
  type ChainStep,
  type ChainVerdict,
  type CheckReporter,
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
      /** Every check that ran, with its final state. */
      checks: CheckResult[];
    }
  | {
      ok: false;
      /** HTTP status the host should answer with. */
      status: 400 | 403 | 422 | 429 | 503;
      /** One-line summary of the failure. */
      error: string;
      /** Every failure point, in check order. Absent when the request failed
       *  a cheap gate before any safety check ran. */
      findings?: SafetyFinding[];
      checks?: CheckResult[];
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
    steps.find((st) => st.verdict === "reject") ??
    steps.find((st) => st.verdict !== "allow") ??
    steps[steps.length - 1] ?? { source: "dev-mode", verdict: "allow", categories: [], reason: "no classifiers (MOCK model)" }
  );
}

/**
 * `progress` receives the check plan and every check state change as they
 * happen — the host streams them to the portal's live checklist.
 */
export async function createSubmission(
  deps: IntakeDeps,
  input: SubmissionInput,
  progress?: (ev: SubmitProgress) => void,
): Promise<SubmissionOutcome> {
  const { store, settings: s, moderation, strikes } = deps;
  const presetId = str(input.presetId, 64) || null;
  const customPrompt = str(input.prompt, MAX_PROMPT_CHARS);
  const tipperName = str(input.tipperName, MAX_NAME_CHARS) || null;
  const ipHash = input.ipHash;

  // ── Cheap gates first ──────────────────────────────────────────────────
  // Strikes pause only the UNTRUSTED tiers for this submitter. A preset with
  // no photo carries no viewer bytes, so it stays open — which also bounds
  // the damage if many viewers ever share one key (e.g. a misconfigured
  // proxy): the worst case is "presets only", never "nobody can hijack".
  if (strikes.blocked(ipHash) && (!presetId || input.image)) {
    return {
      ok: false,
      status: 429,
      error: "too many rejected requests — custom prompts and photos are paused for you; presets still work",
    };
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
  const approvalOn = approvalEnabled(s);
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

  // ── The safety checks ──────────────────────────────────────────────────
  // Announce exactly the checks this host will run, then run the prompt and
  // photo chains concurrently, streaming each check's state as it resolves.
  // Every failure point is collected — the viewer sees all of them at once.
  const plan: SafetyCheck[] = [
    ...(finalPresetId ? [] : textChecks(moderation)),
    ...(input.image ? photoChecks(moderation) : []),
  ];
  const states = new Map<string, CheckState>(plan.map((c) => [c.id, "pending"]));
  const report: CheckReporter = (id, state) => {
    if (!states.has(id)) return;
    states.set(id, state);
    progress?.({ t: "check", id, state });
  };
  const checks = (): CheckResult[] => plan.map((c) => ({ ...c, state: states.get(c.id)! }));
  if (plan.length) progress?.({ t: "plan", checks: plan });

  const [text, photo] = await Promise.all([
    finalPresetId ? null : runTextChecks(deps, prompt, ipHash, tipperName, report),
    input.image ? runPhotoChecks(deps, input.image.path, ipHash, tipperName, report) : null,
  ]);

  const findings = [...(text?.findings ?? []), ...(photo?.findings ?? [])];
  if (findings.length) {
    const quarantine = photo?.csamSuspected === true;
    // One strike per rejected submission (CSAM: three). A file that simply
    // isn't an image is a mistake, not abuse — no strike.
    const strikesDue = quarantine ? 3 : findings.some((f) => f.category !== "structure") ? 1 : 0;
    for (let i = 0; i < strikesDue; i++) strikes.strike(ipHash);
    return {
      ok: false,
      status: findings.every((f) => f.category === "structure") ? 400 : 422,
      error: summarize(findings),
      findings,
      checks: checks(),
      ...(quarantine ? { quarantine } : {}),
    };
  }
  if (text?.verdict === "unavailable" || photo?.verdict === "unavailable") {
    return {
      ok: false,
      status: 503,
      error:
        text?.verdict === "unavailable"
          ? "custom prompts are unavailable right now — pick a preset"
          : "photo uploads are unavailable right now",
      findings: [],
      checks: checks(),
    };
  }
  for (const r of [text, photo]) {
    if (r?.verdict === "review") {
      // Approval is opt-in (CONTENT-SAFETY §5). With no approval tier on,
      // nobody is watching the queue, so a borderline result is refused up
      // front — never parked where a paid tip would wait on no one. It's
      // borderline, not abusive: no strike.
      if (!approvalOn) {
        return { ok: false, status: 422, error: r.reason, findings: [], checks: checks() };
      }
      needsReview = true;
      // The classifier's reason is more useful to the reviewer than the
      // generic "approval tier" set earlier, so it wins.
      reviewWhy = `classifier: ${r.reason}`;
    }
  }

  // ── Likeness: a face swap needs a face and a consent attestation ───────
  let consent: ConsentRecord | undefined;
  const prepared = photo?.prepared ?? null;
  if (photo && prepared) {
    // A likeness swap needs a face; in dev mode no classifier counts faces,
    // so the needsImage preset itself is what tells us a person is pictured.
    const likeness = photo.faces > 0 || Boolean(preset?.needsImage);
    if (preset?.needsImage && !moderation.devMode && photo.faces === 0) {
      return { ok: false, status: 400, error: "this effect needs a clear photo of a person", findings: [], checks: checks() };
    }
    if (likeness) {
      if (!ticked(input.consent)) {
        return {
          ok: false,
          status: 400,
          error: "confirm you have consent to use this person's likeness",
          findings: [],
          checks: checks(),
        };
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
  return { ok: true, code: sub.code, expiresAt: sub.expiresAt, presetId: finalPresetId, needsReview, checks: checks() };
}

interface TextChecksOutcome {
  verdict: ChainVerdict;
  reason: string;
  findings: SafetyFinding[];
}

/** The prompt chain + its ledger line. Never throws: a broken chain is
 *  "unavailable", which the caller turns into a fail-closed 503. */
async function runTextChecks(
  deps: IntakeDeps,
  prompt: string,
  ipHash: string,
  tipper: string | null,
  report: CheckReporter,
): Promise<TextChecksOutcome> {
  const { settings: s, moderation, ledger } = deps;
  const inputHash = sha256Hex(prompt);
  try {
    const r = await moderateText(prompt, s, s.blocklistExtra, moderation, report);
    recordChain(ledger, "text", r, inputHash, ipHash, tipper, approvalEnabled(s));
    return r;
  } catch (e) {
    recordUnavailable(ledger, "text", e, inputHash, ipHash);
    return { verdict: "unavailable", reason: (e as Error).message, findings: [] };
  }
}

interface PhotoChecksOutcome extends TextChecksOutcome {
  faces: number;
  csamSuspected: boolean;
  /** Set once the file passed the structural pipeline. */
  prepared: PreparedImage | null;
}

/**
 * The photo pipeline: structure (sniff, re-encode, hash) → the takedown list
 * → the classifier chain. A structural or takedown failure skips the
 * classifiers — there is nothing (or nothing new) to classify.
 */
async function runPhotoChecks(
  deps: IntakeDeps,
  path: string,
  ipHash: string,
  tipper: string | null,
  report: CheckReporter,
): Promise<PhotoChecksOutcome> {
  const { settings: s, moderation, ledger, uploads } = deps;
  const base = { faces: 0, csamSuspected: false, prepared: null };
  const fileFailure = (category: string, reason: string, detail?: string): PhotoChecksOutcome => {
    report(PHOTO_FILE_CHECK, "fail");
    for (const c of photoChecks(moderation)) if (c.id !== PHOTO_FILE_CHECK) report(c.id, "skipped");
    const finding: SafetyFinding = {
      check: PHOTO_FILE_CHECK,
      subject: "photo",
      category,
      label: categoryLabel(category),
      ...(detail ? { detail } : {}),
    };
    return { ...base, verdict: "reject", reason, findings: [finding] };
  };

  report(PHOTO_FILE_CHECK, "running");
  let prepared: PreparedImage;
  try {
    prepared = await prepareUpload(path);
  } catch (e) {
    const msg = e instanceof ImageRejected ? e.message : "image could not be processed";
    ledger.record({ stage: "image", verdict: "reject", source: "structure", reason: msg, categories: ["structure"], ipHash, tipper });
    return fileFailure("structure", msg, msg);
  }
  const inputHash = prepared.sha256;
  if (uploads.isBlocked(prepared.sha256, prepared.dhash)) {
    ledger.record({ stage: "image", verdict: "reject", source: "takedown-list", reason: "previously removed image", categories: ["blocked-hash"], inputHash, ipHash, tipper });
    return fileFailure("blocked-hash", "previously removed image");
  }
  report(PHOTO_FILE_CHECK, "pass");

  try {
    const r = await moderateImage(prepared.classifierJpeg, s, moderation, report);
    if (r.csamSuspected) {
      // CONTENT-SAFETY S5: we now have "actual knowledge" (18 U.S.C. §2258A).
      // Preserve, block, and follow docs/runbooks/csam.md — the bytes have
      // already stopped before any further vendor saw them.
      uploads.block(prepared.sha256, prepared.dhash, "csam"); // near-dup, never evicted
      ledger.record({ stage: "image", verdict: "reject", source: decidingStep(r.steps).source, reason: "suspected CSAM — runbook", categories: ["csam-suspected"], inputHash, ipHash, tipper });
      warn("safety", `SUSPECTED CSAM upload quarantined (sha256 ${inputHash.slice(0, 12)}…) — follow docs/runbooks/csam.md`);
    } else {
      recordChain(ledger, "image", r, inputHash, ipHash, tipper, approvalEnabled(s));
    }
    return { ...r, prepared };
  } catch (e) {
    recordUnavailable(ledger, "image", e, inputHash, ipHash);
    return { ...base, verdict: "unavailable", reason: (e as Error).message, findings: [] };
  }
}

/** Is anyone watching the approval queue? Approval is opt-in
 *  (CONTENT-SAFETY §5): with no tier on, a borderline result is refused
 *  rather than parked. */
function approvalEnabled(s: Settings): boolean {
  return s.customPrompts === "classified+approval" || s.reviewLikeness;
}

/** One ledger line per chain: the deciding step, and every category found.
 *  A "review" verdict is logged as the refusal it becomes when approval is
 *  off, so the streamer's log says what actually happened. */
function recordChain(
  ledger: SafetyLedger,
  stage: "text" | "image",
  r: { verdict: ChainVerdict; reason: string; steps: ChainStep[]; findings: SafetyFinding[] },
  inputHash: string,
  ipHash: string,
  tipper: string | null,
  approvalOn: boolean,
): void {
  const step = decidingStep(r.steps);
  ledger.record({
    stage,
    verdict:
      r.verdict === "unavailable" ? "error" : r.verdict === "review" && !approvalOn ? "reject" : r.verdict,
    source: step.source,
    reason: r.reason,
    categories: r.findings.length ? [...new Set(r.findings.map((f) => f.category))] : step.categories,
    inputHash,
    ipHash,
    tipper,
  });
  if (r.verdict === "unavailable") warn("moderation", `${stage} check unavailable (${step.source}): ${r.reason}`);
}

function recordUnavailable(
  ledger: SafetyLedger,
  stage: "text" | "image",
  e: unknown,
  inputHash: string,
  ipHash: string,
): void {
  const source = e instanceof ModerationUnavailable ? e.source : "unknown";
  ledger.record({ stage, verdict: "error", source, reason: (e as Error).message, categories: [], inputHash, ipHash });
  warn("moderation", (e as Error).message);
}
