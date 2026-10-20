// What a viewer is told about the safety checks their submission runs
// through (docs/CONTENT-SAFETY.md S1/S2) — shared so the server's verdicts
// and the portal's checklist speak one vocabulary.
//
// Two ideas:
//   · a CHECK is one step of the chain (the blocklist, one classifier, the
//     photo-file pipeline). The server announces the exact list it will run
//     (`plan`), then streams each check's state as it resolves — the portal
//     never shows a step that isn't really happening.
//   · a FINDING is one failure point. A single prompt can fail several ways
//     (two blocked words AND a classifier category), and the viewer sees
//     every one: which check caught it, what it caught, and — for text — the
//     exact words in their prompt that tripped it.
// Findings say WHAT failed, never how to get around it.

/** What a check looked at. */
export type SafetySubject = "prompt" | "photo";

export type CheckState =
  | "pending" // announced, not started
  | "running"
  | "pass"
  | "review" // passed, but the streamer must approve before it runs
  | "fail"
  | "unavailable" // the check couldn't run (vendor down / timed out) — fails closed
  | "skipped"; // not run: an earlier safety stop meant no further vendor sees the bytes

export interface SafetyCheck {
  /** Stable within one submission: "prompt:blocklist", "photo:file", "photo:<classifier>". */
  id: string;
  subject: SafetySubject;
  /** Viewer-facing name ("Blocked words", "Stream rules") — never a vendor name. */
  label: string;
}

export interface SafetyFinding {
  /** The check that raised it. */
  check: string;
  subject: SafetySubject;
  /** Machine category ("blocklist", "sexual", "public-figure", …). */
  category: string;
  /** Viewer-facing category name ("Blocked word", "Sexual content"). */
  label: string;
  /** One neutral sentence from the classifier, when it gave one. */
  detail?: string;
  /** Exact text from the viewer's prompt that tripped it (for highlighting). */
  matches?: string[];
}

export interface CheckResult extends SafetyCheck {
  state: CheckState;
}

/**
 * Streamed by POST /submissions when the client sends
 * `Accept: application/x-ndjson` — one JSON object per line. `plan` comes
 * first (once the cheap gates pass), then `check` updates, then exactly one
 * `result`. A request that fails a cheap gate (banned, preset disabled, …)
 * sends only the `result`.
 */
export type SubmitProgress =
  | { t: "plan"; checks: SafetyCheck[] }
  | { t: "check"; id: string; state: CheckState };

export type SubmitResult =
  | {
      t: "result";
      ok: true;
      code: string;
      expiresAt: number;
      needsReview: boolean;
      checks: CheckResult[];
    }
  | {
      t: "result";
      ok: false;
      /** The HTTP status the JSON path answers with (the stream is always 200). */
      status: number;
      /** One-line summary — what a client that ignores `findings` shows. */
      error: string;
      /** Every failure point, in check order. Empty for non-check failures. */
      findings: SafetyFinding[];
      checks: CheckResult[];
    };

export type SubmitEvent = SubmitProgress | SubmitResult;

export const NDJSON = "application/x-ndjson";

/**
 * Viewer-facing names for the categories classifiers report. Unknown
 * categories fall back to a neutral label rather than leaking a raw slug.
 */
const CATEGORY_LABELS: Record<string, string> = {
  blocklist: "Blocked word",
  sexual: "Sexual content",
  "sexual/minors": "Sexual content involving minors",
  minors: "Involves a minor",
  minor: "Possible minor in the photo",
  hate: "Hate",
  "hate/threatening": "Hateful threats",
  "harassment/threatening": "Threats",
  harassment: "Harassment",
  "violence/graphic": "Graphic violence",
  gore: "Gore",
  "self-harm": "Self-harm",
  "self-harm/intent": "Self-harm",
  "self-harm/instructions": "Self-harm",
  "illicit/violent": "Illegal violence",
  illegal: "Illegal activity",
  impersonation: "Real person / impersonation",
  "public-figure": "Public figure",
  "prompt-injection": "Tries to override the rules",
  intensity: "Too intense for this stream",
  "category-not-allowed": "Effect type not allowed on this stream",
  "offensive-symbol": "Offensive symbol",
  "face-not-allowed": "Faces aren't allowed on this stream",
  "blocked-hash": "Previously removed image",
  structure: "Not a usable image",
  "classifier-refusal": "Not allowed on stream",
  rejected: "Image rejected",
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? "Not allowed on stream";
}
