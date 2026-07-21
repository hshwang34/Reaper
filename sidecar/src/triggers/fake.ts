// Dev trigger: turns a POST /api/dev/fake-tip body into a normalized TipEvent
// so the entire money path is demoable without any real Streamlabs account.

import type { TipEvent } from "@rh/shared";

export function parseFakeTip(body: unknown): TipEvent | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: "amount must be a positive number (USD)" };
  }
  return {
    source: "fake",
    amount,
    message: typeof b.message === "string" ? b.message : "",
    username: typeof b.username === "string" ? b.username : "DevTester",
    isTest: true,
  };
}
