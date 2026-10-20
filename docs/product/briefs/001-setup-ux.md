# 001 — Setup wizard and studio: make the first run work and read clearly

**Status:** in review · **Owner:** PM · **PR:** — · **Updated:** 2026-10-20

## Problem
The PM ran the packaged app's first-run wizard and hit, in order: a step strip that wraps to
two lines and reflows every time a step completes; a camera step that silently grabs "OBS
Virtual Camera" without checking OBS is even running or saying what the preview is; a
"Connect tips" step that still talks about Streamlabs (viewers pay by card now); a safety step
that says new channels are presets-only, which is no longer the product; a 10-second test
hijack that did nothing, with no way to say "I saw nothing"; and a panic key that is mentioned
but never explained. After setup the app opens on a page titled "Stream controls" that is a
developer console, not a streamer's home.

Root cause of the dead test: the wizard page is not a router. The job is queued and
dispatched to the "router" role, and no router is connected until the app relaunches into
`/router` after setup, so the hub logs `no router connected for job:start` and the test is
lost.

## Who it's for
The streamer, in the ten minutes between opening the DMG and going live. Secondarily us: the
test step is the one place we learn whether their OBS is wired right before a viewer pays.

## What success looks like
- The step strip is one line at every step and never reflows.
- OBS comes before the camera. The camera step knows whether OBS is connected and whether its
  Virtual Camera is running, can start it, and says in one sentence what the preview is.
- "Get paid" replaces "Connect tips": start Stripe payouts from the wizard, see the status.
- The safety step states the actual policy: viewers always write their own prompt and may add
  a photo; both are screened; presets are examples. Hosted defaults match that.
- The test step shows the effect inside the wizard, says beforehand exactly what the streamer
  should see for 10 seconds, counts down, and then asks "did you see it?" with a real "No, I
  saw nothing" path that diagnoses the common causes.
- Panic is explained once, in plain words, with the key drawn as a keycap, wherever it is
  mentioned.
- After setup the app opens on a studio home: status, panic, share link, "try an effect";
  developer panels are collapsed under Advanced.

## Acceptance criteria
- [ ] Stepper renders as a single row at 7 steps on a 640 px wide card; completing a step
      changes colours only.
- [ ] Step order: Sign in → Connect OBS → Camera → Get paid → Stream safety → Test hijack → Done.
- [ ] Camera step: with OBS connected and Virtual Camera off, a "Start the Virtual Camera"
      button starts it over obs-websocket; with OBS not connected, the step says so and links
      back. The preview is labelled with the device actually captured; a non-OBS device is
      flagged in amber with a picker.
- [ ] Get paid (hosted): shows Stripe status from the control plane, opens Stripe onboarding in
      the browser, and flips to "ready" on its own when Stripe verifies. Local mode: one
      sentence, no Streamlabs instructions.
- [ ] `HOSTED_SETTINGS` has `customPrompts: "classified"` and `referenceImages: "likeness"`;
      the safety step and docs no longer say presets-only. Degraded modes (classifier down,
      strike block) still fall back to presets-only.
- [ ] Test step hosts a router: arming the camera, firing, and the AI preview all happen in
      the wizard. The job reaches LIVE in mock mode under the e2e rig.
- [ ] Test step shows "what you'll see" before firing, a live phase indicator during, and
      "Yes, it worked" / "No, I saw nothing" after; the "no" path lists checks derived from
      real state (OBS connected, overlay source, device, model mode, abort reason).
- [ ] Panic explained in the safety checkbox, the done step and the studio header, with the
      hotkey as a keycap and what happens (effect hidden now, new hijacks paused, press again
      to resume).
- [ ] `/router` is titled as the studio; developer panels (credentials, event log) are under a
      collapsed Advanced section. `npm run check` and `npm run e2e` pass.

## Out of scope
- The viewer portal's presets-as-ideas rework (presets fill the prompt box as editable
  starting points). Follow-up brief 002.
- Windows-specific camera permission UX; signing.
- Any change to pricing, fees, or the one-free-test-per-day allowance (#8).

## Open product questions
1. **Should new channels start with photos on at the "likeness" tier (face swaps allowed) or
   "scenes" only?** — Options: A likeness (photos always, as the PM stated), B scenes.
   **Recommendation:** A, matching "custom prompts and photos always"; the classifier chain
   (Sightengine minors check) is the floor either way, and the streamer can tighten from the
   dashboard. → *Answer:* A, taken from the PM's statement of 2026-10-20 (logged as #12).
2. **Studio home scope.** — Options: A light restructure of `/router` now (status, panic,
   share link, try-an-effect; dev panels collapsed), B a full redesign as its own brief.
   **Recommendation:** A now, B as brief 003 once the PM has used A for a stream.
   → *Answer:* A assumed; PM can bump to B.

## Engineering decisions
- The router's hub/machine/camera wiring moves from `RouterPage` into a `useRouterEngine`
  hook so the wizard's test step can be a real router without duplicating the state machine.
- Virtual Camera control uses obs-websocket v5 `GetVirtualCamStatus` / `StartVirtualCam`
  through the existing `ObsController`; the bridge exposes `startVirtualCamera()`.
- Payouts in the wizard go through the main process's cloud link (it holds the JWT); the
  renderer only sees status booleans and asks main to open the Stripe URL.
- `rh:setup-state` becomes async so it can ask OBS for the Virtual Camera state.

## Risks / what could go wrong for users
- The free test is one per channel per UTC day (#8): a streamer who retries after "I saw
  nothing" gets the allowance error; the "no" path says so and offers the diagnostics instead.
- Starting the Virtual Camera from the app only works on OBS 28+ with obs-websocket 5; older
  OBS falls back to manual instructions.
- Opening custom prompts and photos by default raises classifier spend per channel; the server
  needs `OPENAI_API_KEY` and Sightengine keys set or those tiers stay off (fail closed).
