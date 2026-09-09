// Viewer submission intake — the ONE implementation of "turn a portal form
// into a pending submission" that every host's POST /submissions route calls.
//
// Policy enforced here, not in route handlers:
//   · preset prompts are resolved server-side from the id (a client can never
//     spoof preset text) and must be enabled by the streamer
//   · custom free text is allowed only when the streamer permits it, and runs
//     through the moderation guardrail against their extra blocklist
// Hosts own the transport (multer, response codes, upload cleanup, ledger).

import { getPreset, type Settings } from "@rh/shared";
import type { CorrelationStore } from "./correlation.js";
import { checkPrompt } from "./moderation.js";

export interface SubmissionInput {
  /** Raw form fields — untrusted; coerced here. */
  presetId?: unknown;
  prompt?: unknown;
  tipperName?: unknown;
  /** Decart "enhance prompt" form field ("1"/"0"); absent = Decart default (on). */
  enhance?: unknown;
  /** Public URL of the already-stored reference image, if any. */
  imageUrl: string | null;
}

export type SubmissionOutcome =
  | {
      ok: true;
      code: string;
      expiresAt: number;
      presetId: string | null;
    }
  | {
      ok: false;
      /** HTTP status the host should answer with. */
      status: 400 | 403 | 422 | 429;
      error: string;
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

export function createSubmission(
  store: CorrelationStore,
  s: Settings,
  input: SubmissionInput,
): SubmissionOutcome {
  const presetId = str(input.presetId, 64) || null;
  const customPrompt = str(input.prompt, MAX_PROMPT_CHARS);
  const tipperName = str(input.tipperName, MAX_NAME_CHARS) || null;

  let prompt: string;
  let finalPresetId: string | null;

  if (presetId) {
    const preset = getPreset(presetId);
    if (!preset) return { ok: false, status: 400, error: "unknown preset" };
    if (!s.enabledPresetIds.includes(presetId)) {
      return { ok: false, status: 403, error: "preset not enabled by streamer" };
    }
    // lucy-2.5 character substitution with no reference image is a paid no-op.
    if (preset.needsImage && !input.imageUrl) {
      return { ok: false, status: 400, error: "this effect needs a reference image" };
    }
    prompt = preset.prompt;
    finalPresetId = preset.id;
  } else if (customPrompt) {
    if (!s.allowCustomPrompts) {
      return { ok: false, status: 403, error: "custom prompts are disabled by the streamer" };
    }
    const mod = checkPrompt(customPrompt, s.blocklistExtra);
    if (!mod.ok) return { ok: false, status: 422, error: mod.reason ?? "prompt rejected" };
    prompt = customPrompt;
    finalPresetId = null;
  } else {
    return { ok: false, status: 400, error: "provide a preset or a custom prompt" };
  }

  if (store.size >= MAX_PENDING_SUBMISSIONS) {
    return { ok: false, status: 429, error: "too many pending submissions — try again shortly" };
  }
  const sub = store.add({
    prompt,
    presetId: finalPresetId,
    tipperName,
    imageUrl: input.imageUrl,
    enhance: parseEnhance(input.enhance),
  });
  return { ok: true, code: sub.code, expiresAt: sub.expiresAt, presetId: finalPresetId };
}
