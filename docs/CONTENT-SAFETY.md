# Content safety — the guardrail architecture

**Status (2026-10-19): Phase A and Phase B are built.** All stages S0–S6 are
implemented and covered by `npm run check` and `npm run e2e`. Phase C (CSAM
hash-matching, NCMEC registration, legal review) needs accounts, not code.
§10 lists where the build differs from the design below and what's still open.
The design sections stay as written because they're the reasoning.

This is the FEASIBILITY-grade "why" for the safety system, plus the data model,
stage contracts, protocol additions and implementation order. It supersedes the
one-paragraph "LLM moderation upgrade" bullets in `COMMERCIALIZATION.md` §3 and
`COMMERCIAL-BUILD.md`.

Read this the way you read `FEASIBILITY.md` §3 for cost: the money path has
three independent caps because one hung session bills forever; the safety path
needs independent layers for the same reason — one bad frame on a Twitch
stream is an indefinite suspension on the first offense, and it is the
*streamer's* channel that eats it, not ours.

---

## 1. Why this is the product, not a feature

Primary-source constraints (researched 2026-10-19; `[U]` = not verified from
a primary source):

| Constraint | Source | What it forces |
|---|---|---|
| Moderation is **our contractual duty**. "Developer is responsible for implementing appropriate content moderation measures, safety controls, and filtering mechanisms." Failing it is a "material violation" → immediate termination. Decart "has no obligation" to pre-screen input or output. | Decart API Terms §3.5, §3.1, §6.2 (2026-04-12) | There is **no server-side safety net**. Every realtime session is unfiltered. We build the whole thing. |
| Likeness consent: developer must have "obtained any and all required permissions or consent necessary to submit such person's likeness." No impersonating real people. Deepfakes need "clear, conspicuous disclosure and verifiable consent." | Decart API Terms §4.3, §4.1; Decart AUP (2026-06-01) | **Become the Photo** needs a recorded consent attestation per job, celebrity/minor rejection, and an on-stream AI disclosure. |
| Twitch bans sexual content "in text, photos, illustrations, audio, animation or video", including "simulated, fictional or implied." Synthetic NCII → indefinite suspension, first offense, even if shown briefly. | Twitch Sexual Content policy; 2023 synthetic-NCEI rule | The output of the model is judged as the streamer's own content. Benign prompt + bad output = the streamer's ban. **Output monitoring is not optional at scale.** |
| Twitch Extension Guidelines §7 (user-submitted content): broadcaster must be able to review/approve, submitter's username must be shown, broadcaster can remove. | dev.twitch.tv guidelines §7.2–7.4 | We are not an Extension yet, but this is the pattern Twitch expects: **approval queue, attribution, kill switch.** Phase 3 (Bits) will require it literally. |
| YouTube: realistic altered content must be disclosed; making "a real person appear to say or do something they didn't do" is the named case. Kick guideline 7: realistic AI content "must be clearly disclosed… through the stream title or an on-screen overlay"; AI may not "simulate… the presence of another person without their express permission." | YouTube altered-content policy; Kick Community Guidelines (AI rules added 2026-03 `[S]`) | We ship the **on-screen "AI-altered" overlay** as a product feature, and surface the title/label obligation in onboarding. |
| Stripe prohibits "pornography and other mature audience content" and "any artificial-intelligence generated content that meets the above criteria." | Stripe Restricted Businesses | Once we are the merchant (Phase 2 rail), one adult-output incident is a **payment-account** risk, not just a platform one. |
| TAKE IT DOWN Act: platform duty FTC-enforced since 2026-05-19 — notice-and-removal process, remove "and known identical copies, within 48 hours of a valid request." Whether a claim-code portal is a "covered platform" is unclear. | FTC press release 2026-05 | Conservative design: treat retained uploads as covered. **Hash every upload, keep a takedown endpoint + 48h SLA, delete by default.** |
| CSAM: no duty to scan (18 U.S.C. §2258A(f)), but on "actual knowledge" a duty to report to NCMEC "as soon as reasonably possible" and preserve for 1 year (REPORT Act 2024). Willful failure: up to $600k first offense. | 18 U.S.C. §2258A | If any classifier flags apparent CSAM we have *knowledge*. **The runbook must exist before the first public upload**, and suspected CSAM must never be forwarded to a third-party LLM. |
| Users must be 18+ (Decart terms). | Decart API Terms | Viewer-facing attestation; streamer-facing ToS. |

The portfolio framing from `FEASIBILITY.md` §5 still holds and gets sharper:
*the safest guardrail is a data model where untrusted bytes never reach the
model.* Presets are that. Everything below is the price of letting any
untrusted bytes (free text, images) through at all — and the honest product
answer is that **new streamers get presets-only by default**, and every
further tier is an opt-in with its own cost.

---

## 2. Threat model — every byte a viewer controls

| Surface | Reaches | Today | Gap |
|---|---|---|---|
| Preset id | prompt string, server-resolved | **exists** (`core/src/submissions.ts`) | none — keep |
| Custom prompt (≤500 chars) | Decart `initialState.prompt.text` | 7-word blocklist + `blocklistExtra`, gated by `allowCustomPrompts` | no semantic check; trivially evaded ("unclothed") |
| `enhance` flag | Decart rewrites the prompt server-side | passed through (default on) | the text we moderated is not the text the model runs |
| Reference image (≤5MB jpeg/png/webp) | Decart `initialState.image` | declared-mimetype check only | no magic-byte sniff, no EXIF strip, **no content check, no minor/celebrity/consent check**, **never deleted after a job completes or expires** |
| Model output | OBS → the stream | nothing | the only backstop is the human panic button |
| Tipper name / username | `StatusSnapshot`, portal | truncated to 64 chars | not displayed on stream (so no §7 attribution), not moderated if it ever is |
| Active prompt text | `StatusSnapshot.activeJob.prompt` → every portal viewer | public | a passed-but-edgy custom prompt is broadcast to the portal |
| Viewer identity | correlation by claim code / declared username | no account | no way to ban a repeat offender beyond `blocklistExtra` |

Adversaries, in order of likelihood: the troll who wants the streamer banned
(sexual/gore output, slur in a name), the "prank" face-swap of a real person
without consent (friend, ex, celebrity, a minor), and — rarely but with the
highest cost — someone using the upload path to move CSAM.

---

## 3. Principles (mirrors the money path)

1. **Defense in depth, independent layers.** Input classification, image
   pipeline, approval queue, output guard, human panic. Any one can fail
   without the others failing.
2. **Fail closed on the untrusted tiers, never on presets.** A classifier
   outage rejects custom prompts and uploads with "try a preset"; the preset
   path (Layer 0) keeps working. A policy may *require* the output guard, in
   which case guard-unavailable → presets-only.
3. **The model never sees unmoderated bytes.** Classification happens at
   submission/upload time, *before* a claim code exists — off the hot path, so
   a 1s LLM round-trip costs nothing on stream.
4. **Hide before anything else.** A safety stop is a `teardown()` with
   reason `"safety"`: same idempotent path, same hide-then-disconnect order.
5. **Every decision is a record.** What was checked, by which provider, the
   scores, the verdict, the policy it was scored against. This is the appeal
   trail for the streamer, the evidence for a platform dispute, and the
   NCMEC/TAKE IT DOWN paper trail.
6. **The streamer sets policy *above* a floor we own.** Floor = platform +
   Decart + law (nudity, minors, NCII, CSAM, impersonation). Streamer knobs =
   intensity ceiling, categories, tiers, strictness, bans.
7. **Suspected CSAM short-circuits everything**: no third-party LLM call, no
   storage beyond the preservation copy, no job, immediate runbook.
8. **Liability follows the key.** Local mode (streamer's own Decart key):
   the streamer is the "developer" under Decart's terms, and the app says so.
   Hosted mode (our key, our uploads dir): we are. The hosted defaults are
   therefore stricter.

---

## 4. Architecture — the stages

```
viewer ──▶ [S1 text] ──▶ [S2 image] ──▶ pending submission ──▶ tip ──▶ [S3 approval?] ──▶ job
                                                                                           │
          /router: [S4 output guard] ◀── Decart output ◀── mint ◀── queue ◀────────────────┘
                        │ positive
                        ▼
                  teardown("safety") ──▶ [S5 ledger · strike · report]
```

### S0 · Policy model (`shared/`)

`Settings.allowCustomPrompts` + `blocklistExtra` become one `contentPolicy`:

```ts
export interface ContentPolicy {
  /** Tier for viewer-authored text. Hosted default "off"; local default "classified". */
  customPrompts: "off" | "classified" | "classified+approval";
  /** Preset catalog ceiling (presets already carry category + intensity). */
  maxIntensity: 1 | 2 | 3;
  allowedCategories: PresetCategory[];
  /** Reference images: none / scene & style refs only / likeness with consent. */
  images: "off" | "scenes" | "likeness-with-consent";
  /** Classifier thresholds. "strict" is the hosted default. */
  strictness: "strict" | "standard";
  /** Output-frame guard on the streamer's machine. "required" → guard
   *  unavailable means presets-only until it is. */
  outputGuard: "off" | "monitor" | "required";
  /** Decart prompt enhancement on CUSTOM text (presets keep their own flag).
   *  Default false: the classifier must score the text the model runs. */
  enhanceCustomPrompts: boolean;
  /** On-stream: submitter attribution (§7.3) and the "AI-altered" label. */
  showAttribution: boolean;
  showAiLabel: boolean;
  /** Streamer-maintained; also fed by S5 strikes. */
  blocklistExtra: string[];
  bannedViewers: string[];
}
```

`DEFAULT_SETTINGS` ships the hosted-safe values; `sanitizeSettingsPatch`
clamps them. The dashboard's guardrails editor replaces the boolean + textarea
with this.

### S1 · Text (core, host-injected provider)

`core/src/moderation.ts` becomes a chain returning a `ModerationDecision`:

1. **Blocklist** (exists) — cheap, synchronous, streamer-extensible. Keep.
2. **Floor classifier** — OpenAI `omni-moderation-latest` (free; covers
   `sexual`, `sexual/minors`, `hate`, `harassment`, `violence`, `self-harm`).
   Any floor category over threshold → reject, regardless of policy.
3. **Policy classifier** — a Claude Haiku-class call with a fixed system
   prompt that scores the text against *this streamer's* `ContentPolicy`
   (intensity, categories, strictness) and returns JSON
   `{ verdict, categories[], intensity, reason }`. ~1–2k tokens ≈ $0.0002–0.002.
   Only runs on custom prompts; presets never hit it.
4. **Enhance handling** — when `enhanceCustomPrompts` is on, the policy
   classifier is asked to score "the plausible enhanced rendering" of the
   text; when off (default), the job is dispatched with `enhance: false` no
   matter what the viewer ticked.

Contract hosts inject (same pattern as the mint ledger):

```ts
export interface TextModerationProvider {
  classify(text: string, policy: ContentPolicy): Promise<ClassifierResult>;
}
```

Provider error → `{ ok: false, status: 503, error: "moderation unavailable — pick a preset" }`.

### S2 · Image pipeline (core policy, host storage)

Order matters; each step can reject and nothing later runs.

1. **Sniff** magic bytes (`file-type`); declared mimetype is ignored.
2. **Re-encode** through `sharp` to a fresh JPEG/WebP at ≤1024px: strips
   EXIF/GPS, defuses polyglot files, normalises for the classifiers. The
   original bytes are discarded.
3. **Hash** — SHA-256 of the re-encoded bytes (exact "identical copies" for
   takedowns + dedupe) and a perceptual hash (near-duplicate takedowns).
4. **CSAM hash match** — Phase C (see §8). Until then: the nudity+minor
   classifiers below give "actual knowledge" when they co-fire, which triggers
   the runbook, not a job.
5. **Floor classifier** — OpenAI omni-moderation on the image (`sexual`,
   `violence/graphic`); it does **not** cover minors in images, hence step 6.
6. **Face checks** — AWS Rekognition `DetectFaces` (`AgeRange`) and
   `RecognizeCelebrities` (or Sightengine face-age). Rules: any face with
   `AgeRange.Low < 18` → reject; celebrity match → reject; faces present but
   `policy.images !== "likeness-with-consent"` → reject with "this streamer
   only allows scene/style references".
7. **Policy classifier** — Claude vision scores the image against the policy
   (same JSON contract as text). Skipped if step 5/6 already rejected.
8. **Consent attestation** — for any preset with `needsImage` and any image
   with faces: the portal requires a checkbox ("this is me, or I have this
   person's consent to use their likeness on stream") and the attestation
   text + timestamp + IP hash is stored on the submission.
9. **Retention** — the stored file carries a TTL. It is deleted on: rejection
   (exists), submission expiry (new), job done/failed (new), and takedown.
   Hosted: 24h hard cap regardless. The hash + decision record outlive the
   bytes.

```ts
export interface ImageModerationProvider {
  classify(image: Buffer, policy: ContentPolicy): Promise<ClassifierResult & {
    faces: { count: number; minorPossible: boolean; celebrity?: string };
  }>;
}
```

Suspected CSAM (nudity + `minorPossible`) never reaches step 7 or any LLM.

### S1/S2 · What the viewer is told (implemented 2026-10-20)

The portal shows **every failure point**: which check caught it, what it
caught, and for text the exact words, highlighted in the viewer's own prompt.
It says what failed, never how to get around it. Types:
`shared/src/safetyChecks.ts`. UI: `web/src/portal/SafetyChecks.tsx`.

- **All checks run; the decision doesn't change.** "First reject wins" is
  gone. Text classifiers run concurrently and all of them run even after a
  blocklist hit, so a prompt with two blocked words, a floor category and an
  impersonation shows all four. The verdict is still the AND of every check,
  so this costs money on rejects (the policy LLM is paid for prompts the
  blocklist already refused) and leaves safety unchanged. A rejected
  submission is still one strike (CSAM: three); a file that simply isn't an
  image is no strike.
- **The photo minors gate still stops.** The minors-covering classifiers run
  first, one at a time. A possible minor, or a gate that couldn't run, marks
  every later photo check `skipped`, so those bytes reach no further vendor.
  The S2 "nothing later runs" ordering above holds only at this gate. Past
  it, the remaining photo checks run concurrently and all report.
- **Suspected CSAM tells the viewer nothing descriptive**: one finding,
  "Image rejected", with no categories.
- **Live progress.** With `Accept: application/x-ndjson`, `POST /submissions`
  answers 200 and streams `plan` (the exact checks this host will run, which
  depends on the configured vendors), then a `check` line per state change,
  then one `result` carrying the real status, `findings[]` and final
  `checks[]`. Without that header it returns one JSON body with the same
  fields and the real HTTP status. A request refused by a cheap gate (strikes,
  ban, tier, consent) sends only the result.
- **Outage vs reject.** A check that errors or times out is `unavailable`. If
  anything else rejected, the response is a 422 with findings. Otherwise it
  fails closed with a 503 "pick a preset", as before.
- **The policy LLM quotes, the server verifies.** Claude returns
  `flagged_text` (verbatim phrases) and categories from a fixed enum. Any quote
  that doesn't occur in the viewer's text is dropped before it can be shown.

### S3 · Streamer approval queue (optional per policy)

For `customPrompts: "classified+approval"` (and always for likeness swaps
on hosted): a matched tip does **not** enqueue the job; it parks it as
`SubmissionStatus.state = "review"` with a 2-minute window. New protocol
messages (control plane, in `shared/src/protocol.ts`):

- `review:pending` (server → router/dashboard): `{ code, prompt, presetId, imageUrl, tipperName, amount, decision }`
- `review:decide` (router/dashboard → server, role-gated): `{ code, approve: boolean, reason? }`

Approve → normal enqueue. Reject/timeout → `failed`, the tip is logged as
unfulfilled (refund policy is a Phase-2 rail question). The router page gets
a one-tap card; the hosted dashboard gets the same.

### S4 · Output guard (web/router, in the hot path)

A `FrameGuard` samples the Decart output `<video>` into a canvas at ~2 fps
and runs an in-browser NSFW classifier (`nsfwjs` MobileNetV2, ~3.5MB, TF.js
WebGL; alternative: Falconsai ViT via ONNX — **accuracy on stylized video
is unverified; see §9**).

Hooks into the state machine without changing its shape:

- **BUFFERING**: the first sampled frame must pass before the router lets
  `viewer:frames-ok` unhide OBS. A positive aborts the job *before LIVE* —
  OBS is never unhidden, exactly like a mint failure.
- **LIVE**: `K = 2` consecutive positives → `teardown("safety")`. Hide
  first, then disconnect, then report.
- **Degrade**: model fails to load → `outputGuard: "monitor"` logs and
  continues; `"required"` flips the engine to presets-only and tells the
  streamer why.

Cost: $0. Latency: one inference per 500ms sample, off the render path.
The panic button stays — the guard is a reflex, the human is the judgment.

### S5 · Accountability

- **`ModerationDecision` ledger** (core interface; SQLite in `server/`,
  JSONL next to `settings.json` in local mode):
  `{ id, ts, channel, code, stage: "text"|"image"|"review"|"output", provider, input_hash, scores, verdict, policy_snapshot, reason }`.
- **Strikes**: a rejected submission or a safety teardown records a strike
  against the tipper identity we have (declared name / Streamlabs username /
  future Stripe customer). N strikes → `bannedViewers`.
- **Viewer report** — `POST /api/report { code | jobId, reason }` from the
  portal and the `/viewer` overlay's QR/link; lands in the ledger and pings
  the streamer.
- **Takedown** — public page + `POST /api/takedown { contact, description, hashes? }`;
  the handler deletes the upload and all hash-identical copies, bans the
  submitter, and records the request with a 48h SLA clock. Runbook in
  `docs/runbooks/takedown.md`.
- **CSAM runbook** — `docs/runbooks/csam.md`: preserve (1 year), report to
  NCMEC CyberTipline, do not forward bytes to any vendor, notify Decart
  (`dsa@decart.ai`). NCMEC registration is a Phase C prerequisite.

### S6 · On-stream and onboarding

- `/viewer` renders an optional attribution chip ("hijacked by *name*" — §7.3)
  and an "AI-altered" label (Kick's overlay requirement; YouTube disclosure
  support). Both are `ContentPolicy` toggles, on by default.
- `/setup` and the hosted dashboard carry a one-screen **platform checklist**
  the streamer acknowledges: Twitch labels, YouTube altered-content
  disclosure, Kick title/overlay, and the 18+ / consent terms.
- The app's local-mode ToS states that with their own Decart key the
  streamer is the "developer" under Decart's terms.

---

## 5. Hosted vs local — who holds what

| | Local mode (streamer's key) | Hosted (our key) |
|---|---|---|
| Classifier keys | streamer-supplied (optional) → without them, `customPrompts: "off"`, `images: "off"` | ours; always on |
| Defaults | `classified`, `scenes`, `standard`, guard `monitor` | `off`, `off`, `strict`, guard `required` for likeness |
| Uploads dir | userData, TTL 24h | server, TTL 24h, behind the takedown endpoint |
| Ledger | JSONL | SQLite, exportable per channel |
| Approval queue | router page | dashboard + router |
| Liability notice | "you are the developer" | our ToS |

---

## 6. Cost and latency budget

| Stage | Where | Cost per event | Latency | On the hot path? |
|---|---|---|---|---|
| S1 blocklist | core | 0 | <1ms | no (submission time) |
| S1 floor (OpenAI moderation) | core | $0 | ~200–500ms `[U]` | no |
| S1 policy (Claude Haiku) | core | ~$0.0002–0.002 | ~500–1500ms `[U]` | no |
| S2 sniff/re-encode/hash | core | 0 | ~50ms | no (upload time) |
| S2 floor + faces | core | $0 + ~$0.002 (Rekognition ×2) | ~500ms–1s | no |
| S2 policy (Claude vision) | core | ~$0.001–0.003 | ~1s | no |
| S4 output guard | router | $0 | ~20–60ms/sample `[U]` | yes — but async to render |

A fully-loaded custom-prompt-with-likeness submission costs under a cent and
~3s of wall time **before the viewer tips** — invisible next to the tip flow.
Per-second GPU billing is untouched.

---

## 7. Protocol, API and type changes (summary)

- `shared/src/types.ts`: `ContentPolicy`; `Settings` gains `contentPolicy`
  (and drops `allowCustomPrompts` / `blocklistExtra` after a migration shim in
  `loadSettings`). `SubmissionStatus.state` gains `"review"` and `"rejected"`.
  `HijackJob` gains `attribution?: string`, `aiLabel: boolean`, `consent?: {...}`.
- `shared/src/protocol.ts`: `review:pending`, `review:decide`,
  `safety:violation` (router → server: `{ jobId, stage: "output", frames, score }`),
  `guard:status` (router → server: `{ available: boolean }`).
- `core/`: `moderation.ts` → chain + providers; new `images.ts` (S2),
  `review.ts` (S3), `ledger.ts` interface; `submissions.ts` calls the chain
  and attaches decisions; `engine.ts` honours `review` parking and
  `bannedViewers`.
- `core/http/apiRouter.ts`: `/api/report`, `/api/takedown`,
  `/api/review/:code` (role-gated), decision records on `/api/submissions`
  responses (viewer-safe subset: verdict + reason).
- `web/`: portal consent checkbox + rejection copy; router `FrameGuard` +
  review card; viewer attribution/AI-label chips; dashboard policy editor +
  incident log; setup checklist.
- `server/`: `moderation_decisions`, `strikes`, `takedowns` tables; provider
  wiring from env (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AWS_*`).
- `sidecar/` + `app/`: same providers from the streamer's pasted keys; TTL
  sweeper for uploads.

---

## 8. Implementation order and gates

**Phase A — before any viewer outside the alpha cohort touches the portal.**
1. S2 steps 1–3, 9: sniff, re-encode, hash, TTL deletion (closes the
   retention gap today, no vendors needed). Tests: polyglot rejected, EXIF
   gone, file deleted on expire/done/reject.
2. S0 policy model + migration shim + dashboard editor. Tests: sanitize
   clamps; old settings.json loads.
3. S1 chain with provider interface; blocklist-only provider for tests;
   OpenAI floor + Claude policy providers in `core/providers/`. Tests:
   fail-closed on provider error; presets bypass; enhance forced off.
4. S2 steps 5–8 behind the `ImageModerationProvider`; consent attestation in
   the portal. Tests: minor → reject; faces under `scenes` → reject;
   attestation stored.
5. S5 ledger + strikes + bans; `/api/report`; `/api/takedown` + runbooks.
6. S6 attribution + AI label + setup checklist.
Gate: `npm run check` + an e2e that submits a blocked prompt, a flagged
image, and a clean preset, and asserts the ledger.

**Phase B — alpha, with real traffic.**
7. S3 approval queue (protocol + router card + dashboard).
8. S4 output guard **pilot**: benchmark `nsfwjs` and the ViT on the six
   recorded preset clips (`site/CLIPS.md`) plus a deliberately adversarial
   set; pick thresholds; ship as `monitor`, promote to `required` for
   likeness on hosted once false-positive rate is known.
Gate: one week of alpha with zero unreviewed likeness jobs; guard FP/FN
numbers in `VERIFICATION.md`.

**Phase C — before Phase 2 (our rail, public uploads).**
9. CSAM hash matching: front hosted uploads with Cloudflare (free scanning
   tool) and/or apply for PhotoDNA; NCMEC registration; legal review of
   "covered platform" status and state likeness laws.
10. Per-viewer rate limits, strike decay, appeal flow.

---

## 9. Open questions (carry into the alpha)

- Output-guard accuracy on *stylized* output — no published numbers; the
  clips we record for the site are the first benchmark set.
- Whether the claim-code portal is a TAKE IT DOWN "covered platform" — we
  design as if yes.
- Streamlabs ToS text on what tips may trigger (not retrievable; read before
  launch). fal.ai AUP for the second-source model host.
- PhotoDNA / Safer eligibility for a company this size.
- Twitch's current CCL guidance for AI-altered video, and whether an
  on-stream AI label satisfies anything on Twitch (it does on Kick).
- Refund semantics when the streamer rejects a paid submission (S3) — a
  Phase-2 rail decision.

---

## 10. As built (2026-10-19)

### Where it lives

| Stage | Code | Tests |
|---|---|---|
| S0 policy | `shared/src/types.ts` (`Settings` content-policy fields, `JobSafety`, `ModerationEvent`, `ReviewItem`), `shared/src/settings.ts` (`DEFAULT_SETTINGS`, `HOSTED_SETTINGS`, legacy migration, sanitizer), `shared/src/presets.ts` (`presetAllowed`) | `core/test/safety.test.ts` (settings) |
| S1 text | `core/src/moderation.ts` (blocklist, chain runner, fail-closed), `core/src/moderationProviders.ts` (OpenAI, Claude, `moderationFromEnv`) | `core/test/submissions.test.ts`, `safety.test.ts` |
| S2 image | `core/src/images.ts` (sniff, re-encode, sha256 + dHash), `core/src/submissions.ts` (the ordered pipeline + consent), Sightengine provider, `core/src/uploadRegistry.ts` (TTL, takedown, block list) | same + e2e uploads |
| S3 review | `core/src/engine.ts` (`park` / `decideReview` / `pendingReviews`, 2-min TTL), `GET/POST /review` in `core/src/http/apiRouter.ts`, `web/src/features/SafetyPanels.tsx` (`ReviewPanel`) | `safety.test.ts` (review) |
| S4 guard | `web/src/router/frameGuard.ts` (nsfwjs MobileNetV2), `GuardPort` in `ports.ts`, `guardGate` + LIVE `watch` in `stateMachine.ts` | `web/test/stateMachine.test.ts` (6 guard tests); e2e loads the real model in Chrome |
| S5 ledger | `core/src/safetyLedger.ts` (memory/JSONL ledger, `ipHash`, `StrikeTracker`, `RateLimiter`), `moderation_events` table + `dbSafetyLedger` (server), `/moderation`, `/report`, `/takedown`, `docs/runbooks/` | e2e (ledger, report, takedown) |
| S6 on-stream | chips on `RtcOfferMsg.overlay` → `ViewerPage.tsx`; setup wizard "Stream safety" step; `ModerationPanel` | e2e (chips visible) |

### Deviations from the design, and why

- **Flat `Settings` fields, not a nested `contentPolicy` object.** Every host
  applies patches as a shallow merge (`{...settings, ...patch}`), and a nested
  object would have needed a deep-merge in three places. `ContentPolicy` is a
  `Pick<Settings, …>` type for the classifiers. The intensity ceiling is 1–5,
  matching the preset catalog (the design said 1–3).
- **Guard modes are `off | on | required`.** "monitor" (log but don't stop)
  became `on`, which stops and logs every score, because a guard that watches a
  bad frame go out isn't a guard. The false-positive data the alpha needs still
  comes from the logs.
- **Sightengine instead of AWS Rekognition** for nudity + minors. It's one REST
  call with no SDK and has a free tier. The public-figure check is the Claude
  policy classifier's `public_figure` flag (best effort; Decart §4.1).
  Sightengine's response field names were taken from its docs and **should be
  confirmed on the first live call**: the parser fails closed on an unexpected
  shape.
- **No new WS messages.** Safety stops ride `job:done` with a reason starting
  `safety:` (`SAFETY_REASON_PREFIX`). Every relay path, including the Electron
  cloud link, carries that unchanged. Review uses HTTP polling (`/review`)
  driven by the public `reviewPending` count in the status snapshot. In cloud
  mode the approval queue is on the hosted dashboard, because the local bridge's
  engine never holds the job.
- **Takedown acts automatically only on the image URL.** Claim codes are 4
  characters and guessable, so a code-only request is ticketed for an operator.
- **Dev mode is precise.** The chain may run with no vendor classifiers only
  when no real model is reachable from that host (no `dct_` key and no cloud
  mint proxy). In MOCK mode nothing a viewer sends can reach a model.
- **The public "now playing" label** shows the preset name or "a custom
  effect", so custom prompt text is no longer broadcast to every portal.
- Uploads have a **1-hour hard TTL** on every host (the design said 24h hosted),
  plus a boot sweep and, hosted, a 15-minute sweep.

### Operating it

- Classifier keys: `.env.example` (rig and dev server) or the Electron app's App
  credentials panel (local mode). Without keys on a live host, custom prompts and
  photos switch off and presets keep working. The router page's Safety panel shows
  which tiers are protected.
- Default classifier model: `claude-haiku-5-5`, overridable with
  `RH_CLASSIFIER_MODEL`.
- The Electron bundle keeps `sharp` external and stages its prebuilt binaries
  (`app/scripts/stage-resources.mjs`). Build the DMG on the target arch.

### Hardening pass (security review of PR #6)

An automated review of the merged build found five issues, all fixed on
`worktree-safety-hardening`:

| Finding | Fix |
|---|---|
| Strikes and public rate limits keyed on `req.ip`. Behind Fly's proxy that is the proxy, so one troll could lock out every viewer. | Hosted sets Express `trust proxy` (`RH_TRUST_PROXY`, default 1 on Fly) and warns when a public deployment leaves it unset. Keys are `clientKey(channelId, ip)`, using the **resolved** channel id rather than the URL segment, so `/c/Alice`, `/c/alice` and `/c/<id>` share one budget. A strike block now pauses only custom text and photos, so even a mis-keyed proxy degrades to "presets only", never "nobody". |
| The "hijacked by &lt;name&gt;" chip showed the tipper's unmoderated free-text name on stream. | `displayName()`: NFKC fold, a character whitelist, a link check and the blocklist (including the streamer's own words), falling back to "a viewer". Banned tippers get no chip. |
| An anonymous takedown fanned out to dHash near-duplicates and blocked them permanently, so one request could wipe and block everyone's similar photos. A sha-only takedown also blocked a placeholder all-zero dHash, which matches flat images. | Anonymous requests remove and block **exact** sha256 copies only. Near-duplicate fan-out is the streamer's `POST /moderation/takedown`. Blocks carry a source. Anonymous blocks have a budget of 2,000, and when it's full new anonymous blocks are **refused** (the files are still deleted), never made room for by eviction, so flooding can't un-block an earlier takedown. Each requester (`clientKey`) gets at most 20 of those. A refused block is never reported as done: the ledger entry becomes `review` / `block-refused` so the streamer can re-file it as an unbudgeted streamer takedown. Streamer and CSAM blocks are never evicted. Upload filenames are now 128 random bits, because "you have the URL, so you saw the picture" only holds if the URL can't be guessed. |
| The takedown requester's contact was written into the streamer-visible ledger. | `SafetyLedger.recordContact()` writes to an operator-only store (`takedown_contacts` table / `moderation.contacts.jsonl`) that no route reads. |
| Viewer text sat between plain tags in the Claude prompt, so it could close the tag and inject instructions. | The text is JSON-encoded with `<`/`>` escaped (`jsonForPrompt`). Classifiers declare a `role`: custom text now requires a non-instructable **floor** classifier (OpenAI moderation), floors always run first, and Claude alone no longer enables the tier. |

The review's tests also caught a bypass in the blocklist itself: `\b` treats
`_` as a word character, so `naked_lol` slipped through. `checkPrompt` now
NFKC-folds and treats `_` and `-` as separators.

### Still open

- Phase C: known-CSAM hash matching (Cloudflare / PhotoDNA), NCMEC ESP
  registration, legal review of "covered platform" status and state likeness laws.
- Persist the takedown block list and strike state across restarts (both are
  in memory per runtime today).
- Benchmark the output guard on the recorded preset clips (`site/CLIPS.md`)
  and an adversarial set, then tune `EXPLICIT_THRESHOLD` and `SUGGESTIVE_THRESHOLD`.
- An operator console for code-only takedowns.
- Refund semantics for declined approvals (Phase-2 rail).
