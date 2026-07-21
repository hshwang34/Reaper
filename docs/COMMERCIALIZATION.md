# Commercialization Plan — from local sidecar to a Streamlabs-class product

*Drafted 2026-07-20 from a three-track research sweep (Streamlabs onboarding
teardown, OBS integration architectures, Twitch payment rails + Crowd Control
teardown). Sources inline. Companion to `FEASIBILITY.md`, which governs the
core pipeline; this doc governs the product around it.*

**North star:** a streamer goes from "heard about it" to "viewers can hijack my
cam" in under 5 minutes, without touching a config file, an API key, or an OBS
setting. That bar is what made Streamlabs 40% of Twitch within nine months of
its relaunch ([Q3'18 report](https://streamlabs.com/content-hub/post/live-streaming-q318-report-40-of-twitch-using-streamlabs-desktop-pubg-popularity-on-the-decline-mixer)).

---

## 1. What we must build (and why "just a backend" isn't enough)

Physics forces three components:

| Component | Why it must exist | What it replaces |
|---|---|---|
| **Hosted control plane** | Accounts, catalog, payments, queue, moderation, token minting — everything in today's sidecar that isn't latency-sensitive | `sidecar/` (fully absorbed) |
| **Thin local presence** | The camera and OBS live on the streamer's machine. OBS 31's CEF still cannot `getUserMedia` (verified current), so capture must happen in a real browser context outside OBS; and routing live video through our cloud would *add* a network hop over the localhost loopback | `/router` tab (Phase 1: hosted page; Phase 2: tray app) |
| **Viewer surface** | Where the card picker + payment lives | `/portal` (Phase 1: hosted; Phase 3: Twitch Extension panel) |

The video path **never** touches our backend: webcam → Decart → localhost
loopback → OBS Browser Source. Our cloud carries control messages only. This
keeps our COGS at ~zero per hijack (Decart bills the streamer-session directly
via minted tokens) and keeps latency identical to the proven MVP.

**Key enabling detail:** a hosted (HTTPS) router page can still drive local OBS,
because browsers exempt loopback (`ws://127.0.0.1`) from mixed-content blocking
— so obs-websocket control works from a cloud-served page. And a companion app
can create the Browser Source programmatically (obs-websocket v5 `CreateInput`
with `inputKind: "browser_source"`), so the streamer never opens OBS's UI.

## 2. Guiding principles (stolen from Streamlabs, adapted)

1. **One OAuth does everything.** "Sign in with Twitch" auto-provisions the
   channel page, trigger wiring, and widget URL. Never ask for a channel name,
   API key, or socket token.
2. **The integration is a URL, not an install.** The viewer-page-in-a-Browser-
   Source is our Alert Box: one copy-paste that works in OBS, Streamlabs
   Desktop, anything CEF-based. An app install *reduces* friction later but is
   never *required* (StreamElements' lesson).
3. **Meet streamers where they are.** Never require switching broadcast
   software; auto-configure theirs.
4. **The monetization surface is pre-built.** The streamer's hijack page
   (`app.example/c/<channel>`) exists the moment they OAuth — like the
   Streamlabs tip page. Zero Stripe/PayPal wiring exposed.
5. **Free core loop; charge where the margin is.** Streamlabs takes 0% of tips
   and sells Ultra. We can't be that pure — every hijack carries real GPU COGS
   (~$0.02/sec) — but the *software* is free and the cut is taken only where we
   add the rail (see §6).
6. **Skill-branching onboarding.** Default path is "make it work"; raw knobs
   (intensity ceilings, per-viewer rate limits, queue depth) live behind an
   Advanced toggle.
7. **Trust & safety is a feature, not a checkbox.** Panic hotkey, catalog
   curation, approval queue — the streamer's face and room are the canvas;
   their confidence is the product.

## 3. Phased plan

### Phase 0 — Prove the picture (1–2 weeks, pre-commercial)
The single biggest unretired risk is aesthetic/latency: does a live hijack
*look good enough to pay for*? No commercial benchmark exists for our exact
round trip (verified: nobody ships local-cam → cloud-AI → browser-source today).
- Live Decart run on the existing MVP; measure glass-to-glass latency; record
  real before/after captures (these also feed the README and the pitch).
- Tauri-vs-Electron spike: verify `getUserMedia` robustness in Tauri's system
  WebView (unverified in research; Electron's bundled Chromium is known-good).
- Manually read the **May 2026 Bits AUP update** primary text (research only
  confirmed it via secondary reporting) — it decides how safe the Phase 3 Bits
  tier is.
- **Exit criteria:** latency number, real capture footage, go/no-go on quality.

### Phase 1 — Hosted alpha: kill the local sidecar (4–8 weeks)
Cloud control plane + today's browser-tab pattern; 5–15 hand-recruited streamers.
- Backend v1 (see §4): Twitch OAuth, per-channel hosted portal + viewer page,
  WS hub, engine/queue/correlation ported from the sidecar, Decart key vault +
  token minting, Streamlabs trigger (their OAuth connect flow, not a pasted
  socket token) **plus** `channel.cheer` via EventSub (`bits:read`, webhook) —
  Bits-native triggering with zero review, viable for any streamer post
  "Monetization for All" (May 2026).
- Streamer onboarding (target ≤5 min): sign in with Twitch → connect Streamlabs
  (OAuth) → open Arm page, grant cam once → copy ONE Browser Source URL (with a
  "connect OBS" option that auto-creates it via obs-websocket QR pairing) →
  fire a test hijack.
- Money: streamer keeps 100% of tips (their Streamlabs); GPU on our metered
  Decart account with hard monthly caps per channel; we eat alpha COGS.
- **Exit criteria:** 10 streamers ran ≥1 real paid hijack; median setup time
  ≤10 min; zero runaway-billing incidents.

### Phase 2 — Companion app + our own payment rail (8–12 weeks)
This is where it becomes a business.
- **Tray app** (Electron or Tauri per spike): wraps the router; auto-launch at
  boot, survives backgrounding (kills the tab-throttling failure mode);
  auto-provisions/repairs the OBS source (`CreateInput`), pairs via OBS's QR;
  global panic hotkey. NVIDIA-Broadcast-class friction: install → sign in →
  allow camera → done.
- **Direct Stripe checkout** on the viewer page (Stripe Connect for splits):
  our first revenue. No Twitch review, no 6.2.8 free-text ban, works on
  YouTube/Kick chats too. Per-hijack split: GPU COGS netted first, then
  platform cut, remainder to streamer — margin-positive by construction.
- **Streamer dashboard:** catalog curation, intensity ceiling, per-viewer rate
  limits, free-text approval queue, earnings, session replays.
- Moderation upgrade: blocklist → LLM classifier scored against streamer
  settings (FEASIBILITY Layer 2); image-upload moderation becomes mandatory
  (CSAM scanning is a legal requirement once we host viewer uploads).
- **Exit criteria:** first $1k month across cohort; support load per streamer
  quantified; chargeback rate known (tips carry chargeback risk; Bits don't).

### Phase 3 — Twitch-native tier (post-PMF; 6–10 weeks + review cycles)
- **Extension panel** (below stream): preset cards + **fixed tip tiers only**
  (menu of duration SKUs — 6.2.8-compliant because our preset-card catalog is
  already "pre-populated options, no free text"; the free-text tier stays on
  the off-platform page). Bits-in-Extensions: 80/20 streamer/dev split — the
  only rail that pays *us* on Twitch natively. EventSub
  `extension.bits_transaction.create` (webhook-only) as source of truth.
- Overlay-extension experiment: interactive hijack buttons over the video.
- Channel Points as the **free teaser rail** (1-second preview hijack) — costs
  viewers nothing, funnels to paid; redemption text arrives via EventSub.
- Budget review cycles (1–3+ business days each, channel live during review).
- **Exit criteria:** approved extension live on ≥50 channels; Bits-attributed
  revenue ≥ tips revenue on those channels.

### Phase 4 — Platform play (ongoing)
- **Brand activations:** sponsored effect packs + per-second scene takeovers
  sold as a B2B ad product (likely the largest line; see README thesis).
- **Multi-platform:** YouTube/Kick/TikTok triggers (Crowd Control's 2.0
  playbook — also our hedge against Twitch policy risk).
- **Native OBS plugin end-state:** eliminates the loopback hop; blocked today
  (Decart has no native C/C++ SDK; realtime is LiveKit-backed) — pursue *with*
  Decart, not by reverse-engineering.
- **BYOK tier:** streamer's own Decart key; our cut becomes pure margin.
- Marketplace: community/creator-made effect packs with rev share.

## 4. Backend requirements (the control plane)

| Service | Scope | Notes |
|---|---|---|
| Auth & accounts | Twitch OAuth (+ YouTube later), multi-tenant channels | One OAuth = full provisioning (principle #1) |
| Channel config | Catalog, guardrails, rate limits — today's `Settings` per tenant | Same shape as `shared/src/types.ts` |
| Realtime hub | WS fan-out per channel (portal/router/viewer roles), RTC signaling relay | Today's `hub.ts`, multi-tenant; sticky per-channel routing |
| Engine | Tip→job matching, duration, FIFO queue, cooldown | Port `engine.ts`/`correlation.ts` nearly as-is |
| Token minting | Decart key vault; per-job `ek_` tokens, `maxSessionDuration` capped | The cost-safety backstop stays server-side |
| Trigger ingestion | Streamlabs OAuth+socket per channel; EventSub webhooks (cheer, channel points, later bits-transactions) | Normalized `TipEvent` stays the seam |
| Payments | Stripe Connect (checkout, splits, payouts, refunds/chargebacks) | Phase 2 |
| Moderation | Text: blocklist → LLM classifier. Images: hash-match + CSAM scan on upload | Legal requirement, not optional |
| Uploads | S3-compatible store, signed URLs, TTL cleanup | Replaces `uploads/` dir |
| Observability | Per-hijack ledger (tip → job → seconds billed → outcome), billing alarms | The "#1 support surface" per FEASIBILITY |
| Admin/support | Session inspector, refund tooling, channel kill-switch | |

## 5. UX targets

**Streamer (Phase 2 steady-state):** install app → Sign in with Twitch → allow
camera → app finds OBS + creates the source (QR pair once) → "Send yourself a
test hijack" → link-in-chat button for the viewer page. *Five clicks, zero OBS
UI, zero keys.*

**Viewer:** open streamer's hijack page (chat command / panel link) → card grid
(emoji-thumbnailed presets, exactly today's portal) → slider: amount ⇄ seconds,
live price preview → optional reference image → pay (Streamlabs tip w/ claim
code today; one-tap Stripe in Phase 2; cheer/Bits in Phase 3) → live status:
queue position → countdown → clip-it CTA.

## 6. Business model (decision, not yet made)

GPU COGS (~$0.02/sec) means Streamlabs' pure zero-cut model doesn't map. Options:

- **A. Rail-scoped cut (recommended start):** free software; on rails we
  operate (Stripe, Bits-extension) we net COGS then take 15–20%; on rails we
  don't (streamer's own Streamlabs tips) we take 0% but GPU runs on their
  metered allowance/BYOK. Aligns cut with value added; mirrors ecosystem norms
  (Crowd Control 80/20, Twitch 80/20).
- **B. SaaS subscription:** flat monthly for hosted GPU minutes + premium packs
  (Ultra-style). Predictable, but taxes small streamers before they earn.
- **C. Pure BYOK + free:** zero revenue until marketplace/brand layers exist.

Decide at Phase 2 entry with alpha data on hijacks/streamer/month.

## 7. Top risks & open questions

1. **Quality/latency unproven live** — Phase 0 exists to retire this first.
2. **May 2026 Bits AUP** primary text unread — could constrain Phase 3; verify
   manually before any Bits build.
3. **Tauri camera capture unverified** — spike before committing the app stack.
4. **T&S burden of image uploads** (CSAM scanning, DMCA on reference images) —
   scope legal review before Phase 2 opens uploads beyond alpha.
5. **Decart platform risk** — single-vendor realtime model; fal.ai hosts
   lucy-2.5 too (second source), and the token-mint seam isolates vendor swap.
6. **Chargebacks on tips** ($15 + amount per dispute) — Bits/Stripe Radar
   mitigate; factor into rail sequencing.
7. **EventSub channel-points `user_input` field** — high confidence but not
   primary-source verified; confirm against a live payload.
