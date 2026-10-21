// What a streamer reads about a hijack's fate and about a blocked/parked
// request — pure mappers, so the studio's Earnings tab, the hosted dashboard
// and the Rules panels all say the same thing (docs/product/BRAND.md §3:
// Played / Didn't play / Refunded / In progress) and NO raw engine, ledger or
// classifier text reaches a streamer-facing list. Anything we don't recognise
// maps to nothing (the row simply omits the detail) rather than leaking.

import { PRESETS, categoryLabel, type ModerationEvent } from "@rh/shared";

export interface HijackResult {
  label: "Played" | "Didn't play" | "Refunded" | "In progress";
  /** Tailwind text colour; always paired with the word, never colour alone. */
  tone: string;
}

/** The ledger stores the prompt; show the effect's name when it's a preset. */
export function effectName(prompt: string): string {
  return PRESETS.find((p) => p.prompt === prompt)?.label ?? "Custom effect";
}

/**
 * A ledger row's end state. The ledger has `completed | failed | dispatched`
 * (server/src/channels.ts); a failed row whose reason says it was refunded —
 * or a row already marked refunded — reads "Refunded" so "Didn't play" never
 * leaves a streamer guessing whether chat got their money back.
 */
export function hijackResult(row: { outcome: string; reason?: string | null }): HijackResult {
  const o = row.outcome.toLowerCase();
  const refunded = o === "refunded" || (o === "failed" && /refund/i.test(row.reason ?? ""));
  if (refunded) return { label: "Refunded", tone: "text-amber-200" };
  if (o === "completed") return { label: "Played", tone: "text-emerald-300" };
  if (o === "failed") return { label: "Didn't play", tone: "text-red-300" };
  return { label: "In progress", tone: "text-amber-200" };
}

/** A streamer-safe reason for a row, or null. Never the raw string. */
export function hijackReason(row: { outcome: string; reason?: string | null }): string | null {
  const r = (row.reason ?? "").trim().toLowerCase();
  if (!r) return null;
  if (r.startsWith("safety:")) return "Stopped by your rules";
  if (/declined/.test(r)) return "Declined by you";
  if (/didn't approve|did not approve|expired/.test(r)) return "You didn't approve it in time";
  if (/refund/.test(r)) return "Refunded";
  return null;
}

/** Why a paid request is waiting on the streamer (ReviewItem.why is raw engine text). */
export function reviewWhy(why: string): string {
  const w = why.toLowerCase();
  if (/likeness|face/.test(w)) return "Face swap";
  if (/approval/.test(w)) return "Custom effect";
  return "Needs your OK";
}

/** The "what happened" label for a Recently blocked row. */
export const BLOCKED_WHAT: Record<ModerationEvent["stage"], string> = {
  text: "Custom effect blocked",
  image: "Photo blocked",
  review: "Declined",
  output: "Stopped mid-effect",
  report: "Report from chat",
  takedown: "Photo removal request",
  ban: "Banned",
};

/** Categories whose detail must NEVER be shown to a streamer: a suspected-CSAM
 *  quarantine (docs/runbooks/csam.md) and the takedown-list match. */
const HIDDEN_CATEGORIES = new Set(["csam-suspected", "blocked-hash"]);

/**
 * The one-line "why" under a blocked row — a friendly category name, derived
 * from the machine categories (never `event.reason`, which holds raw strings
 * such as "blocked word: foo" or "suspected CSAM — runbook"). Only text and
 * photo checks carry a category worth showing; every other stage shows none.
 */
export function blockedDetail(e: Pick<ModerationEvent, "stage" | "categories" | "source">): string | null {
  if (e.stage !== "text" && e.stage !== "image") return null;
  if (e.source === "takedown-list" || e.categories.some((c) => HIDDEN_CATEGORIES.has(c))) return null;
  const labels = [...new Set(e.categories.map(categoryLabel))];
  return labels.length ? labels.join(", ") : null;
}
