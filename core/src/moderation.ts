// Content moderation — the classifier chain every untrusted byte passes
// before a claim code can exist (docs/CONTENT-SAFETY.md S1/S2).
//
// Shape of the chain:
//   text:  blocklist (sync, streamer-extensible) → each TextClassifier in order
//   image: each ImageClassifier in order — the minors-covering one FIRST, so a
//          suspected-CSAM image stops before it is sent to any other vendor
// First reject wins; a "review" verdict parks the job for streamer approval.
//
// Fail closed: a classifier that errors or times out rejects the submission
// with 503 "pick a preset" — the untrusted tier goes dark, presets keep
// working. "Dev mode" (no real model behind the host — MOCK Decart) is the one
// place the chain may run with no vendor classifiers, because nothing the
// viewer sends can reach a model there.
//
// Providers are injected by the host (core/src/moderationProviders.ts builds
// the real ones from env); tests inject fakes.

import type { Settings } from "@rh/shared";

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
}

export function checkPrompt(
  prompt: string,
  extra: string[] = [],
): ModerationResult {
  const text = prompt.toLowerCase();
  const list = [...BUILTIN_BLOCKLIST, ...extra.map((w) => w.toLowerCase())];
  for (const word of list) {
    if (!word) continue;
    // Word-boundary match to avoid flagging substrings (e.g. "essex").
    const re = new RegExp(`\\b${escapeRegExp(word)}\\b`, "i");
    if (re.test(text)) {
      return { ok: false, reason: `blocked term: "${word}"` };
    }
  }
  return { ok: true };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
}

export interface TextClassifier {
  readonly name: string;
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

/** Can this host accept custom text at all? */
export function textReady(m: ModerationSuite): boolean {
  return m.devMode || m.text.length > 0;
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

/** One step's outcome, for the ledger. */
export interface ChainStep {
  source: string;
  verdict: ClassifierVerdict["verdict"];
  categories: string[];
  reason: string;
}

export interface TextChainResult {
  verdict: ClassifierVerdict["verdict"];
  reason: string;
  steps: ChainStep[];
}

/**
 * Run custom text through the blocklist and every text classifier.
 * Throws ModerationUnavailable when a classifier fails (→ 503) or when the
 * host has none and isn't in dev mode.
 */
export async function moderateText(
  text: string,
  policy: ContentPolicy,
  blocklistExtra: string[],
  suite: ModerationSuite,
): Promise<TextChainResult> {
  const steps: ChainStep[] = [];
  const bl = checkPrompt(text, blocklistExtra);
  steps.push({
    source: "blocklist",
    verdict: bl.ok ? "allow" : "reject",
    categories: bl.ok ? [] : ["blocklist"],
    reason: bl.reason ?? "clean",
  });
  if (!bl.ok) return { verdict: "reject", reason: bl.reason!, steps };

  if (!textReady(suite)) {
    throw new ModerationUnavailable("text", "no text classifier configured");
  }

  let review: ChainStep | null = null;
  for (const c of suite.text) {
    const v = await withTimeout(c.name, c.classifyText(text, policy));
    steps.push({ source: c.name, ...v });
    if (v.verdict === "reject") return { verdict: "reject", reason: v.reason, steps };
    if (v.verdict === "review" && !review) review = steps[steps.length - 1];
  }
  if (review) return { verdict: "review", reason: review.reason, steps };
  return { verdict: "allow", reason: "clean", steps };
}

export interface ImageChainResult {
  verdict: ClassifierVerdict["verdict"];
  reason: string;
  /** Max faces any classifier reported (0 when none can count faces). */
  faces: number;
  /** Sexual + possible minor: the CSAM runbook, not a normal reject. */
  csamSuspected: boolean;
  steps: ChainStep[];
}

/**
 * Run a re-encoded image through every image classifier, minors-covering
 * ones first. Applies the streamer's image tier on top of the classifiers'
 * own verdicts: any face under "scenes" is a reject; any face that may be a
 * minor is a reject under every tier.
 */
export async function moderateImage(
  jpeg: Buffer,
  policy: ContentPolicy,
  suite: ModerationSuite,
): Promise<ImageChainResult> {
  const steps: ChainStep[] = [];
  if (!imagesReady(suite)) {
    throw new ModerationUnavailable("image", "no minors-covering image classifier configured");
  }
  const ordered = [...suite.image].sort(
    (a, b) => Number(b.coversMinors) - Number(a.coversMinors),
  );
  let faces = 0;
  let review: ChainStep | null = null;
  for (const c of ordered) {
    const v = await withTimeout(c.name, c.classifyImage(jpeg, policy));
    steps.push({ source: c.name, verdict: v.verdict, categories: v.categories, reason: v.reason });
    if (v.faces !== null) faces = Math.max(faces, v.faces);

    // Stop BEFORE the next vendor sees the bytes.
    if (v.sexual && v.minorPossible) {
      return {
        verdict: "reject",
        reason: "image rejected",
        faces,
        csamSuspected: true,
        steps,
      };
    }
    if (v.minorPossible) {
      return { verdict: "reject", reason: "photos of minors are not allowed", faces, csamSuspected: false, steps };
    }
    if (v.verdict === "reject") {
      return { verdict: "reject", reason: v.reason, faces, csamSuspected: false, steps };
    }
    if (faces > 0 && policy.referenceImages !== "likeness") {
      return {
        verdict: "reject",
        reason: "this streamer only allows scene/style reference images (no faces)",
        faces,
        csamSuspected: false,
        steps,
      };
    }
    if (v.verdict === "review" && !review) review = steps[steps.length - 1];
  }
  if (review) return { verdict: "review", reason: review.reason, faces, csamSuspected: false, steps };
  return { verdict: "allow", reason: "clean", faces, csamSuspected: false, steps };
}
