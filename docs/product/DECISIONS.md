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

**#12 · 2026-10-20 · New channels start on "Anything goes":** typed prompts and photos (face
swaps included) on by default, behind strict classifiers that fail closed. Presets are examples
of what works, not the menu. The streamer tightens from the studio's Safety tab
(Family-friendly / Balanced / Anything goes). `HOSTED_SETTINGS`, PR #18 + #20.

**#13 · 2026-10-20 · Payments are Stripe-only — no Streamlabs/tips.** Every hijack is paid on
the streamer's hijack page because each payment must fund its own Decart time; Streamlabs pays
the streamer directly, so it could never carry our cut. No product, site or wizard copy
describes tips as the payment path. PR #18, #20, #21.

**#14 · 2026-10-20 · The effect catalog grows to 17 presets** written to Decart's Lucy 2.5
prompt guide (grouped by its edit types); presets are opt-out so new ones reach every channel.
The 10 new prompts still need one real-model run each before we lean on them. PR #20.

**#15 · 2026-10-20 · First run shows a one-time "How it works" tour** (four cards, ending in
the Effects gallery), re-openable from the studio. PR #20.

**#16 · 2026-10-20 · The marketing site deploys itself:** Vercel is connected to `main` with
root `site/`; any merge touching `site/` ships streamhijack.com, PRs get preview links.

**#17 · 2026-10-20 · Effect previews are generated from the PM's own webcam clip**, recorded
once at the rig and run through the real model for every effect — not CSS art, not stock, not a
generated actor. Static files; nothing user-facing calls the model for previews. Brief 002.

**#18 · 2026-10-20 · Voice: playful and streamer-native, except money and safety**, which stay
plain and calm (refunds, errors, safety screens). `docs/product/BRAND.md`. Brief 002.

**#19 · 2026-10-20 · Vocabulary: a viewer buys an "effect"; what happens on stream is a
"hijack".** "Preset" is code-only; "look" is not used. `docs/product/BRAND.md`. Brief 002.

**#20 · 2026-10-20 · Brief 002 ships as three PRs, viewer portal first** (brand guide + preview
pipeline + portal → studio + wizard → website), because the portal is where money changes hands.
