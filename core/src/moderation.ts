// Layer-1 guardrail: a cheap word blocklist enforced at submission time.
// This is the MVP filter; an LLM classifier scored against the streamer's
// intensity settings is the documented Phase-6 upgrade. Keep the built-in list
// conservative — it exists to demonstrate the guardrail seam, not to be
// exhaustive. The streamer adds their own terms via settings.blocklistExtra.

const BUILTIN_BLOCKLIST = [
  "nude",
  "naked",
  "nsfw",
  "porn",
  "sex",
  "gore",
  "slur",
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
