# Product decision log

Append-only. Newest at the bottom. When a decision is reversed, add a new entry and mark the old
one `SUPERSEDED by #n` — don't delete it. Agents read this before raising a product question.

Format: `#n · date · decision` — then *why*, and where it lives in code/docs.

---

**#1 · 2026-07 · Pricing is $1 = 1 second of hijack.**
Simple to explain on stream; maps directly to per-second GPU billing. `shared/src/settings.ts`
(`computeDurationSec`).

**#2 · 2026-07 · No Twitch Bits extension.**
Bits policy bans free-text products and needs review. Triggers are pluggable adapters emitting
one `TipEvent` shape. `FEASIBILITY.md`.

**#3 · 2026-10-20 · Hosted-first.** Streamers download the app, sign in with Twitch, and run on
our control plane, which holds the Decart key. "Paste your own keys" is a developer fallback
only, hidden on packaged builds (`RH_LOCAL_MODE=1`).
*Why:* streamers shouldn't need a Decart account; a local-first plan was rejected.

**#4 · 2026-10-20 · Viewers fund every GPU second — never us.** Payments go through Stripe
Connect *direct charges* with **Managed Risk**: the streamer is seller of record, Stripe absorbs
fraud/chargeback losses. Streamlabs tips can't be cut (paid straight to the streamer), so they're
off in production. `server/src/payments.ts`.

**#5 · 2026-10-20 · Our cut: application fee = GPU cost ($0.02/s, rounded up) + 5% margin.
Minimum payment $3** (Stripe's fixed 30¢ makes smaller charges mostly fee). Server env, never a
streamer setting. $10 for 10s → streamer receives ≈ $8.71. `server/src/fees.ts`.

**#6 · 2026-10-20 · Express onboarding** (short Stripe-hosted flow) rather than the full
dashboard, accepting that Express + Managed Risk is a Stripe preview API.

**#7 · 2026-10-20 · A viewer only pays for a hijack that can happen.** Checkout is refused while
the streamer's app is offline or paused; paid hijacks that never start are refunded
automatically (2 min offline, or 15 min not started). If a hijack started and the streamer says
it failed, it goes to manual review rather than auto-refund.

**#8 · 2026-10-20 · One free 10-second test hijack per channel per day** (fixed preset) for the
setup wizard — the only GPU time we pay for.

**#9 · 2026-10-20 · Streamer approval and the output guard are opt-in, default off.** Input
screening + the panic hotkey are the baseline, like Streamlabs TTS. With approval off, a
borderline classifier result is rejected, never parked. `docs/CONTENT-SAFETY.md`.

**#10 · 2026-10-20 · When a submission fails safety checks, tell the viewer WHAT failed, never
HOW to get around it.** The portal lists every failure point.

**#11 · 2026-10-20 · Ways of working:** the PM approves a brief up front and merges every PR;
the eng lead orchestrates agents; deploys and live-Stripe changes need the PM's explicit go.
`docs/product/README.md`.
