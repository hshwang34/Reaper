// Content moderation — the classifier chain every untrusted byte passes
// before a claim code can exist (docs/CONTENT-SAFETY.md S1/S2).
//
// Shape of the chain:
//   text:  blocklist (sync, streamer-extensible) → every TextClassifier, concurrently
//   image: the minors-covering classifiers FIRST, one at a time (a gate: a
//          possible minor stops before any other vendor sees the bytes),
//          then the rest concurrently
// Any reject rejects, and every failure point is collected as a finding so
// the viewer sees all of them; a "review" verdict parks the job for
// streamer approval. Each check reports its state as it resolves — the
// portal's live checklist (POST /submissions streaming, apiRouter.ts).
//
// Fail closed: a classifier that errors or times out makes the chain
// "unavailable" (→ 503 "pick a preset") unless something else already
// rejected — the untrusted tier goes dark, presets keep working. "Dev mode"
// (no real model behind the host — MOCK Decart) is the one place the chain
// may run with no vendor classifiers, because nothing the viewer sends can
// reach a model there.
//
// Providers are injected by the host (core/src/moderationProviders.ts builds
// the real ones from env); tests inject fakes.

import {
  categoryLabel,
  type CheckState,
  type SafetyCheck,
  type SafetyFinding,
  type Settings,
} from "@rh/shared";

// ── Layer 1: the blocklist ───────────────────────────────────────────────

// Kept deliberately small and unambiguous — the classifiers carry the
// semantic load; this exists so the obvious cases cost nothing and still
// apply when a vendor is down in dev mode.
const BUILTIN_BLOCKLIST = [
  "nude",
  "naked",
  "nudity",
  "topless",
  "nsfw",
  "porn",
  "sex",
  "sexy",
  "lingerie",
  "gore",
  "slur",
  "underage",
  "loli",
];

export interface ModerationResult {
  ok: boolean;
  reason?: string;
  /** EVERY blocked term found (lower-cased) — the portal lists them all. */
  matches: string[];
}

export function checkPrompt(
  prompt: string,
  extra: string[] = [],
): ModerationResult {
  // `_` is a regex word character, so "\bnaked\b" would miss "naked_lol";
  // treat underscores and hyphens as the separators a reader sees them as.
  const text = prompt.normalize("NFKC").toLowerCase().replace(/[_-]+/g, " ");
  const list = new Set([...BUILTIN_BLOCKLIST, ...extra.map((w) => w.trim().toLowerCase())]);
  const matches: string[] = [];
  for (const word of list) {
    if (!word) continue;
    // Word-boundary match to avoid flagging substrings (e.g. "essex").
    const re = new RegExp(`\\b${escapeRegExp(word)}\\b`, "i");
    if (re.test(text)) matches.push(word);
  }
  return matches.length
    ? { ok: false, reason: `blocked ${matches.length === 1 ? "word" : "words"}: ${matches.join(", ")}`, matches }
    : { ok: true, matches };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** What the "hijacked by …" chip says when a name can't be shown as-is. */
export const ANONYMOUS_TIPPER = "a viewer";
const MAX_DISPLAY_NAME = 25; // Twitch's own login limit

/**
 * The tipper name as it may appear ON STREAM (CONTENT-SAFETY S6). A tip's
 * display name is free text the tipper typed (Streamlabs doesn't verify it),
 * so it gets the same suspicion as a prompt — without a network call, because
 * the engine decides synchronously on the tip:
 *   · normalize (NFKC folds look-alike/full-width tricks), keep only letters,
 *     digits, space, `_` and `-` — no URLs, no markup, no emoji spam
 *   · anything blocklisted, link-like, or empty after cleaning → "a viewer"
 * Returns null when there's no name at all.
 */
export function displayName(raw: string | null | undefined, blocklistExtra: string[] = []): string | null {
  if (!raw) return null;
  const folded = raw.normalize("NFKC");
  const cleaned = folded
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DISPLAY_NAME)
    .trim();
  if (!cleaned) return ANONYMOUS_TIPPER;
  if (/https?|www|\.(com|net|org|gg|tv|io)\b/i.test(folded)) return ANONYMOUS_TIPPER;
  // Check both the raw and cleaned forms: "n.a.k.e.d" cleans to "naked".
  if (!checkPrompt(cleaned, blocklistExtra).ok || !checkPrompt(folded, blocklistExtra).ok) {
    return ANONYMOUS_TIPPER;
  }
  return cleaned;
}

// ── Classifier contracts ─────────────────────────────────────────────────

/** The slice of Settings a classifier scores against. */
export type ContentPolicy = Pick<
  Settings,
  | "customPrompts"
  | "maxIntensity"
  | "allowedCategories"
  | "referenceImages"
  | "moderationStrictness"
>;

export interface ClassifierVerdict {
  verdict: "allow" | "reject" | "review";
  /** Short machine-ish labels ("sexual", "minor", "public-figure", …). */
  categories: string[];
  /** One line, safe to show the viewer on a reject. */
  reason: string;
  /** Exact phrases from the viewer's text that caused a reject/review —
   *  only from classifiers that can point at them (the policy LLM). */
  matches?: string[];
}

export interface TextClassifier {
  readonly name: string;
  /** Viewer-facing check name; defaults by role ("Content scan" / "Stream rules"). */
  readonly label?: string;
  /** "floor": a fixed-category moderation model that doesn't follow
   *  instructions (OpenAI moderation) — immune to prompt injection.
   *  "policy": an instruction-following LLM scoring against the streamer's
   *  policy — smarter, but the viewer's text is in its context, so it can be
   *  argued with. Custom text needs at least one floor classifier. */
  readonly role: "floor" | "policy";
  classifyText(text: string, policy: ContentPolicy): Promise<ClassifierVerdict>;
}

export interface ImageVerdict extends ClassifierVerdict {
  /** Faces this classifier could see (null = it doesn't detect faces). */
  faces: number | null;
  /** Any face that may belong to a minor. */
  minorPossible: boolean;
  /** Sexual content detected (with minorPossible → suspected CSAM). */
  sexual: boolean;
}

export interface ImageClassifier {
  readonly name: string;
  /** Viewer-facing check name; defaults by coversMinors. */
  readonly label?: string;
  /** True when this classifier detects possible minors — a host may only
   *  accept face images when at least one such classifier is configured,
   *  because general-purpose moderation (OpenAI images, an LLM) doesn't. */
  readonly coversMinors: boolean;
  /** `jpeg` is the re-encoded, metadata-free copy (≤1024px). */
  classifyImage(jpeg: Buffer, policy: ContentPolicy): Promise<ImageVerdict>;
}

/** Everything a host plugs in. */
export interface ModerationSuite {
  text: TextClassifier[];
  image: ImageClassifier[];
  /** No real model behind this host (MOCK mode): blocklist + structural
   *  checks alone are acceptable because nothing reaches a model. */
  devMode: boolean;
}

export const emptySuite = (devMode: boolean): ModerationSuite => ({
  text: [],
  image: [],
  devMode,
});

/** Can this host accept custom text at all? An LLM classifier alone isn't
 *  enough: viewer text can try to talk it into "allow". A non-instructable
 *  floor classifier must also pass the text. */
export function textReady(m: ModerationSuite): boolean {
  return m.devMode || m.text.some((c) => c.role === "floor");
}

/** Can this host accept reference images at all? Requires a minors check. */
export function imagesReady(m: ModerationSuite): boolean {
  return m.devMode || m.image.some((c) => c.coversMinors);
}

/** Every classifier gets the same budget; a slow vendor fails closed. */
export const CLASSIFIER_TIMEOUT_MS = 8_000;

export class ModerationUnavailable extends Error {
  constructor(
    public readonly source: string,
    cause: string,
  ) {
    super(`moderation unavailable (${source}): ${cause}`);
  }
}

async function withTimeout<T>(source: string, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ModerationUnavailable(source, "timeout")),
      CLASSIFIER_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } catch (e) {
    if (e instanceof ModerationUnavailable) throw e;
    throw new ModerationUnavailable(source, (e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

// ── Chain runners ────────────────────────────────────────────────────────

// Every chain collects ALL failure points rather than stopping at the first
// reject: the viewer is shown each check that caught something and what it
// caught (shared/src/safetyChecks.ts). The decision is unchanged — every
// classifier must allow — so running them all costs money on rejects, never
// safety. The one place a chain still stops early is the image minors gate:
// bytes that may show a child go to no further vendor.

/** One step's outcome, for the ledger. */
export interface ChainStep {
  source: string;
  verdict: ClassifierVerdict["verdict"] | "error";
  categories: string[];
  reason: string;
}

/** "unavailable" = nothing rejected, but a check couldn't run: fail closed. */
export type ChainVerdict = ClassifierVerdict["verdict"] | "unavailable";

/** Progress sink: one call per check state change. */
export type CheckReporter = (id: string, state: CheckState) => void;
const noReport: CheckReporter = () => {};

export const BLOCKLIST_CHECK = "prompt:blocklist";
export const PHOTO_FILE_CHECK = "photo:file";

const textCheckId = (c: TextClassifier) => `prompt:${c.name}`;
const photoCheckId = (c: ImageClassifier) => `photo:${c.name}`;

/** Text classifiers, floor first — the order the portal lists them in. */
function textOrder(suite: ModerationSuite): TextClassifier[] {
  return [...suite.text].sort((a, b) => Number(b.role === "floor") - Number(a.role === "floor"));
}

/** Image classifiers, minors-covering first — the gate order. */
function imageOrder(suite: ModerationSuite): ImageClassifier[] {
  return [...suite.image].sort((a, b) => Number(b.coversMinors) - Number(a.coversMinors));
}

/** The prompt checks this host will run, in display order. */
export function textChecks(suite: ModerationSuite): SafetyCheck[] {
  return [
    { id: BLOCKLIST_CHECK, subject: "prompt", label: "Blocked words" },
    ...textOrder(suite).map((c): SafetyCheck => ({
      id: textCheckId(c),
      subject: "prompt",
      label: c.label ?? (c.role === "floor" ? "Content scan" : "Stream rules"),
    })),
  ];
}

/** The photo checks this host will run, in display order. */
export function photoChecks(suite: ModerationSuite): SafetyCheck[] {
  return [
    { id: PHOTO_FILE_CHECK, subject: "photo", label: "Photo file" },
    ...imageOrder(suite).map((c): SafetyCheck => ({
      id: photoCheckId(c),
      subject: "photo",
      label: c.label ?? (c.coversMinors ? "Photo safety & age" : "Photo content scan"),
    })),
  ];
}

/** One finding per reported category; a bare reject still gets one. */
function findingsFrom(
  check: string,
  subject: SafetyFinding["subject"],
  v: ClassifierVerdict,
  text?: string,
): SafetyFinding[] {
  if (v.verdict !== "reject") return [];
  const categories = v.categories.length ? [...new Set(v.categories)] : ["classifier-refusal"];
  const detail = v.reason && v.reason !== "not allowed on stream" && v.reason !== "clean" ? v.reason : undefined;
  const matches = text ? presentIn(text, v.matches) : [];
  // The classifier's sentence describes its whole verdict: attach it once.
  return categories.map((category, i) => ({
    check,
    subject,
    category,
    label: categoryLabel(category),
    ...(detail && i === 0 ? { detail } : {}),
    ...(matches.length ? { matches } : {}),
  }));
}

/** Keep only phrases that really occur in the viewer's text — a classifier
 *  quoting something the viewer never wrote would be worse than no quote. */
function presentIn(text: string, phrases: string[] | undefined): string[] {
  if (!phrases?.length) return [];
  const hay = text.toLowerCase();
  return [...new Set(phrases.map((p) => p.trim()).filter((p) => p && hay.includes(p.toLowerCase())))];
}

export interface TextChainResult {
  verdict: ChainVerdict;
  reason: string;
  steps: ChainStep[];
  /** Every failure point, in check order. */
  findings: SafetyFinding[];
}

/**
 * Run custom text through the blocklist and every text classifier. The
 * classifiers run concurrently (the verdict is the AND of all of them, so
 * order can't change it) and all of them run even after a reject, so the
 * viewer sees every failure point. Throws ModerationUnavailable only when
 * the host has no floor classifier and isn't in dev mode.
 */
export async function moderateText(
  text: string,
  policy: ContentPolicy,
  blocklistExtra: string[],
  suite: ModerationSuite,
  report: CheckReporter = noReport,
): Promise<TextChainResult> {
  if (!textReady(suite)) {
    throw new ModerationUnavailable("text", "no floor text classifier configured");
  }
  const steps: ChainStep[] = [];
  const findings: SafetyFinding[] = [];

  const bl = checkPrompt(text, blocklistExtra);
  steps.push({
    source: "blocklist",
    verdict: bl.ok ? "allow" : "reject",
    categories: bl.ok ? [] : ["blocklist"],
    reason: bl.reason ?? "clean",
  });
  report(BLOCKLIST_CHECK, bl.ok ? "pass" : "fail");
  for (const word of bl.matches) {
    findings.push({ check: BLOCKLIST_CHECK, subject: "prompt", category: "blocklist", label: categoryLabel("blocklist"), matches: [word] });
  }

  const ordered = textOrder(suite);
  for (const c of ordered) report(textCheckId(c), "running");
  const settled = await Promise.all(
    ordered.map(async (c) => {
      try {
        const v = await withTimeout(c.name, c.classifyText(text, policy));
        report(textCheckId(c), v.verdict === "reject" ? "fail" : v.verdict === "review" ? "review" : "pass");
        return { c, v };
      } catch (e) {
        report(textCheckId(c), "unavailable");
        return { c, error: (e as Error).message };
      }
    }),
  );

  let review: ChainStep | null = null;
  let unavailable: ChainStep | null = null;
  for (const s of settled) {
    if (!s.v) {
      steps.push({ source: s.c.name, verdict: "error", categories: [], reason: s.error });
      unavailable ??= steps[steps.length - 1];
      continue;
    }
    steps.push({ source: s.c.name, verdict: s.v.verdict, categories: s.v.categories, reason: s.v.reason });
    findings.push(...findingsFrom(textCheckId(s.c), "prompt", s.v, text));
    if (s.v.verdict === "review") review ??= steps[steps.length - 1];
  }

  if (findings.length) return { verdict: "reject", reason: summarize(findings), steps, findings };
  if (unavailable) return { verdict: "unavailable", reason: unavailable.reason, steps, findings };
  if (review) return { verdict: "review", reason: review.reason, steps, findings };
  return { verdict: "allow", reason: "clean", steps, findings };
}

export interface ImageChainResult {
  verdict: ChainVerdict;
  reason: string;
  /** Max faces any classifier reported (0 when none can count faces). */
  faces: number;
  /** Sexual + possible minor: the CSAM runbook, not a normal reject. */
  csamSuspected: boolean;
  steps: ChainStep[];
  findings: SafetyFinding[];
}

/**
 * Run a re-encoded image through every image classifier. Minors-covering
 * classifiers run first, one at a time, as a GATE: if one flags a possible
 * minor (or can't run), no further vendor sees the bytes. Past the gate the
 * rest run concurrently. Applies the streamer's image tier on top of the
 * classifiers' own verdicts: any face under "scenes" is a finding; any face
 * that may be a minor is a reject under every tier.
 */
export async function moderateImage(
  jpeg: Buffer,
  policy: ContentPolicy,
  suite: ModerationSuite,
  report: CheckReporter = noReport,
): Promise<ImageChainResult> {
  if (!imagesReady(suite)) {
    throw new ModerationUnavailable("image", "no minors-covering image classifier configured");
  }
  const steps: ChainStep[] = [];
  const findings: SafetyFinding[] = [];
  const ordered = imageOrder(suite);
  const gates = ordered.filter((c) => c.coversMinors);
  const rest = ordered.filter((c) => !c.coversMinors);
  let faces = 0;
  let facesFrom: string | null = null;
  let review: ChainStep | null = null;
  let unavailable: ChainStep | null = null;

  const run = async (c: ImageClassifier): Promise<ImageVerdict | null> => {
    report(photoCheckId(c), "running");
    try {
      return await withTimeout(c.name, c.classifyImage(jpeg, policy));
    } catch (e) {
      report(photoCheckId(c), "unavailable");
      steps.push({ source: c.name, verdict: "error", categories: [], reason: (e as Error).message });
      unavailable ??= steps[steps.length - 1];
      return null;
    }
  };
  const record = (c: ImageClassifier, v: ImageVerdict) => {
    steps.push({ source: c.name, verdict: v.verdict, categories: v.categories, reason: v.reason });
    if (v.faces !== null && v.faces > faces) {
      faces = v.faces;
      facesFrom = photoCheckId(c);
    }
    const own = findingsFrom(photoCheckId(c), "photo", {
      ...v,
      // A possible minor is a reject under every tier, whatever the vendor said.
      verdict: v.minorPossible ? "reject" : v.verdict,
      categories: v.minorPossible && !v.categories.includes("minor") ? [...v.categories, "minor"] : v.categories,
    });
    findings.push(...own);
    if (v.verdict === "review" && !own.length) review ??= steps[steps.length - 1];
    report(photoCheckId(c), own.length ? "fail" : v.verdict === "review" ? "review" : "pass");
  };
  const skipFrom = (list: ImageClassifier[]) => list.forEach((c) => report(photoCheckId(c), "skipped"));

  for (let i = 0; i < gates.length; i++) {
    const c = gates[i];
    const v = await run(c);
    if (!v) {
      // An unanswered minors check means nobody has cleared the bytes.
      skipFrom([...gates.slice(i + 1), ...rest]);
      return done();
    }
    if (v.minorPossible) {
      skipFrom([...gates.slice(i + 1), ...rest]);
      if (v.sexual) {
        // Suspected CSAM: the viewer gets one generic line — nothing that
        // describes what was detected.
        steps.push({ source: c.name, verdict: "reject", categories: v.categories, reason: v.reason });
        report(photoCheckId(c), "fail");
        return {
          verdict: "reject",
          reason: "image rejected",
          faces: Math.max(faces, v.faces ?? 0),
          csamSuspected: true,
          steps,
          findings: [{ check: photoCheckId(c), subject: "photo", category: "rejected", label: categoryLabel("rejected") }],
        };
      }
      record(c, v);
      return done();
    }
    record(c, v);
  }

  const results = await Promise.all(rest.map(async (c) => ({ c, v: await run(c) })));
  for (const { c, v } of results) if (v) record(c, v);
  return done();

  function done(): ImageChainResult {
    if (faces > 0 && policy.referenceImages !== "likeness" && facesFrom) {
      findings.push({ check: facesFrom, subject: "photo", category: "face-not-allowed", label: categoryLabel("face-not-allowed") });
      report(facesFrom, "fail");
    }
    const base = { faces, csamSuspected: false, steps, findings };
    if (findings.length) return { ...base, verdict: "reject", reason: summarize(findings) };
    if (unavailable) return { ...base, verdict: "unavailable", reason: unavailable.reason };
    if (review) return { ...base, verdict: "review", reason: review.reason };
    return { ...base, verdict: "allow", reason: "clean" };
  }
}

/** One line for a client that ignores `findings`, and for the ledger. */
export function summarize(findings: SafetyFinding[]): string {
  if (findings.length === 1) {
    const f = findings[0];
    return f.matches?.length ? `${f.label}: ${f.matches.join(", ")}` : (f.detail ?? f.label);
  }
  return `${findings.length} problems found: ${[...new Set(findings.map((f) => f.label))].join(", ")}`;
}
