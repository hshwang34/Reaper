// Pure helpers for the hijack page, kept apart from React so node:test can
// exercise them (web/test/portalMoney.test.ts).

import type { SubmissionStatus } from "@rh/shared";

/** Clamp an amount into [min, max], to whole cents. */
export function clampToBounds(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n * 100) / 100));
}

/** "$10" for whole dollars, "$7.50" otherwise, never "$7.5". */
export function formatUsd(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/** The pay button's label; always the amount that will be charged. */
export function payLabel(amount: number, seconds: number, effect: string): string {
  return `Pay ${formatUsd(amount)} · ${seconds}s of ${effect}`;
}

/** The receipt line belongs only to a claim that is paid and still alive or
 *  finished well. On failed/expired claims it would contradict the refund
 *  line, and the stored amount can come from an abandoned checkout. */
export function showReceipt(state: SubmissionStatus["state"] | undefined): boolean {
  return state === "pending" || state === "review" || state === "matched" || state === "queued" || state === "live" || state === "done";
}
