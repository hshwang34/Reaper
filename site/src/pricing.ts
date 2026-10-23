// The pricing section: drag the amount, see where every cent goes.
//
// Mirrors server/src/fees.ts (splitPayment + DEFAULT_FEES). The site is a standalone build
// that never imports the monorepo, so the numbers are copied here; change both together.
//   our fee         = AI video time (2¢ a second, rounded up) + 5% platform fee
//   Stripe's fee    = 2.9% + 30¢ (standard US card rate; the real one is Stripe's)
//   streamer gets   = the rest

const FEES = { platformFeePct: 5, gpuCostPerSec: 0.02, stripePct: 2.9, stripeFixedCents: 30 };

export interface Split {
  amount: number;
  stripe: number;
  ai: number;
  platform: number;
  streamer: number;
}

/** $1 buys one second, so the duration is the amount in dollars. */
export function split(dollars: number): Split {
  const cents = Math.round(dollars * 100);
  const stripe = Math.round((cents * FEES.stripePct) / 100) + FEES.stripeFixedCents;
  const ai = Math.ceil(dollars * FEES.gpuCostPerSec * 100);
  const platform = Math.round((cents * FEES.platformFeePct) / 100);
  const ours = Math.min(cents, ai + platform);
  return { amount: cents, stripe, ai, platform: ours - ai, streamer: Math.max(0, cents - stripe - ours) };
}

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export function initPricing(): void {
  const root = document.getElementById("pricing");
  const range = root?.querySelector<HTMLInputElement>("#priceRange");
  if (!root || !range) return;
  const set = (sel: string, text: string) => {
    for (const el of root.querySelectorAll<HTMLElement>(sel)) el.textContent = text;
  };
  const render = () => {
    const dollars = Number(range.value);
    const s = split(dollars);
    set("[data-p=amount]", `$${dollars}`);
    set("[data-p=secs]", `${dollars} second${dollars === 1 ? "" : "s"}`);
    set("[data-p=streamer]", money(s.streamer));
    set("[data-p=stripe]", money(s.stripe));
    set("[data-p=ai]", money(s.ai));
    set("[data-p=platform]", money(s.platform));
    set("[data-p=pct]", `${Math.round((s.streamer / s.amount) * 100)}%`);
    for (const k of ["streamer", "stripe", "ai", "platform"] as const) {
      root.querySelector<HTMLElement>(`.split-bar [data-k=${k}]`)?.style.setProperty("--w", `${(s[k] / s.amount) * 100}%`);
    }
    range.setAttribute("aria-valuetext", `$${dollars}, ${dollars} seconds; the streamer gets ${money(s.streamer)}`);
  };
  range.addEventListener("input", render);
  render();
}
