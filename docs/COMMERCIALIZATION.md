# Commercialization Plan — from local sidecar to a Streamlabs-class product

*Drafted 2026-07-20 from a three-track research sweep (Streamlabs onboarding
teardown, OBS integration architectures, Twitch payment rails + Crowd Control
teardown). Sources inline. Companion to `FEASIBILITY.md`, which governs the
core pipeline; this doc governs the product around it.*

> **Status (2026-09-09).** The software in Phases 1–2 is built: the hosted
> control plane, the Electron companion app, the dashboard, and the wizard
> (`COMMERCIAL-BUILD.md` is the map; `ARCHITECTURE-REVIEW.md` is the
> post-build audit). This doc has been trimmed to what is **not** done: the
> live-quality proof (Phase 0), the external accounts, the payment rail, the
> Twitch-native tier, and the business-model decision. Anything marked
> *built* below is described once, in `COMMERCIAL-BUILD.md`, not here.

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

### Phase 0 — Prove the picture (still open)
The single biggest unretired risk is aesthetic/latency: does a live hijack
*look good enough to pay for*? No commercial benchmark exists for our exact
round trip (verified: nobody ships local-cam → cloud-AI → browser-source today).
- Live Decart run on the rig; measure glass-to-glass latency; record real
  before/after captures (these also feed the README and the pitch).
- Manually read the **May 2026 Bits AUP update** primary text (research only
  confirmed it via secondary reporting) — it decides how safe the Phase 3 Bits
  tier is.
- ~~Tauri-vs-Electron spike~~ — *decided:* Electron (bundled Chromium is the
  known-good `getUserMedia` path; the app is built on it).
- **Exit criteria:** latency number, real capture footage, go/no-go on quality.

### Phase 1 — Hosted alpha (software built; alpha not run)
*Built:* the control plane (Twitch OAuth → our JWTs, per-channel engines,
server-side job-gated + budget-capped minting, ledger, hosted portal at
`/c/:channel`, dashboard) and the ≤5-minute onboarding wizard. See
`COMMERCIAL-BUILD.md`.

Still to do — none of it is code:
- External accounts: Twitch OAuth app, Streamlabs OAuth app (the pasted
  socket token works meanwhile), Fly deploy. Listed with exact env names in
  `COMMERCIAL-BUILD.md` §"What's left".
- `channel.cheer` via EventSub (`bits:read`, webhook) — Bits-native
  triggering with zero review, viable for any streamer post "Monetization for
  All" (May 2026). Not built; needs the Twitch app first.
- Recruit 5–15 streamers and run it. Money: streamer keeps 100% of tips
  (their Streamlabs); GPU on our metered Decart account under the per-channel
  monthly cap; we eat alpha COGS.
- **Exit criteria:** 10 streamers ran ≥1 real paid hijack; median setup time
  ≤10 min; zero runaway-billing incidents.

### Phase 2 — Our own payment rail (app built; rail not)
*Built:* the Electron companion app — auto-launch, survives backgrounding,
auto-provisions/repairs the OBS source, global panic hotkey, signed-in cloud
mode with no key on the machine, auto-update. The streamer dashboard exists
with catalog curation and guardrails.

Still to do — this is where it becomes a business:
- **Direct Stripe checkout** on the viewer page (Stripe Connect for splits):
  our first revenue. No Twitch review, no 6.2.8 free-text ban, works on
  YouTube/Kick chats too. Per-hijack split: GPU COGS netted first, then
  platform cut, remainder to streamer — margin-positive by construction.
- Dashboard additions: intensity ceiling, per-viewer rate limits, free-text
  approval queue, earnings, session replays.
- Moderation upgrade: blocklist → LLM classifier scored against streamer
  settings (FEASIBILITY Layer 2); image-upload moderation becomes mandatory
  (CSAM scanning is a legal requirement once we host viewer uploads).
- Signed/notarized macOS build (Apple Developer enrollment; the CI job is
  ready and gated on secrets).
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

The table as originally planned, with what `server/` now has. "Built" means
in the repo and exercised by the test gate; it does not mean deployed.

| Service | Planned scope | State |
|---|---|---|
| Auth & accounts | Twitch OAuth (+ YouTube later), multi-tenant channels | **built** (Twitch; one-time exchange code for the browser session) |
| Channel config | Catalog, guardrails, rate limits — `Settings` per tenant | **built** (per-channel row; no per-viewer rate limits yet) |
| Realtime hub | WS fan-out per channel, RTC relay | **built** (one front door → per-channel adopted hubs; local plane rejected) |
| Engine | Tip→job matching, duration, FIFO queue, cooldown | **built** (`@rh/core`, unchanged across hosts) |
| Token minting | Decart key vault; per-job `ek_`, `maxSessionDuration` capped | **built** (job-gated, one per job, monthly budget) |
| Trigger ingestion | Streamlabs per channel; EventSub webhooks | Streamlabs pasted-token **built**; OAuth connect + EventSub open |
| Payments | Stripe Connect (checkout, splits, payouts, chargebacks) | open — Phase 2 |
| Moderation | Text: blocklist → LLM classifier. Images: hash + CSAM scan | blocklist **built**; the rest open, and legally required before public uploads |
| Uploads | S3-compatible store, signed URLs, TTL cleanup | local disk per channel; S3 open |
| Observability | Per-hijack ledger, billing alarms | ledger **built** (SQLite); alarms open |
| Admin/support | Session inspector, refund tooling, channel kill-switch | `suspended` flag only |

Deployment shape: **one instance**. Channel runtimes, adopted WS sockets, and
sign-in exchange codes are process memory by design for the alpha; see
`COMMERCIAL-BUILD.md` §"Deployment shape" before scaling to two.

## 5. UX targets

**Streamer (built as the `/setup` wizard):** install app → Sign in with Twitch
→ allow camera → app finds OBS + creates the source → "Send yourself a test
hijack" → link-in-chat button for the viewer page. *Five clicks, zero OBS UI,
zero keys.* Not yet measured against the ≤5-minute target with real streamers.

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
   Still the top risk: everything since has been built against MOCK mode.
2. **May 2026 Bits AUP** primary text unread — could constrain Phase 3; verify
   manually before any Bits build.
3. ~~Tauri camera capture unverified~~ — resolved by choosing Electron.
4. **T&S burden of image uploads** (CSAM scanning, DMCA on reference images) —
   scope legal review before Phase 2 opens uploads beyond alpha.
5. **Decart platform risk** — single-vendor realtime model; fal.ai hosts
   lucy-2.5 too (second source), and the token-mint seam isolates vendor swap.
6. **Chargebacks on tips** ($15 + amount per dispute) — Bits/Stripe Radar
   mitigate; factor into rail sequencing.
7. **EventSub channel-points `user_input` field** — high confidence but not
   primary-source verified; confirm against a live payload.
