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
      status: 400 | 403 | 422;
      error: string;
    };

const MAX_PROMPT_CHARS = 500;
const MAX_NAME_CHARS = 64;

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

  const sub = store.add({
    prompt,
    presetId: finalPresetId,
    tipperName,
    imageUrl: input.imageUrl,
  });
  return { ok: true, code: sub.code, expiresAt: sub.expiresAt, presetId: finalPresetId };
}
