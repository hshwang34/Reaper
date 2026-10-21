# 002 — One brand, real previews, plain-language UX everywhere

**Status:** in review (PR 1 of 3) · PR 2 studio + wizard and PR 3 website not started · **Owner:** PM · **PR:** — · **Updated:** 2026-10-20

## Problem
The product was built surface by surface (wizard, studio, viewer portal, OBS overlay, website)
and it shows: wording, button styles and tone differ from screen to screen, and a lot of copy
still speaks engineer ("Browser Source", "classifier", "token", "preset id"). The biggest gap
is the effect catalog: a viewer about to pay $5–$20 sees a CSS gradient with an emoji, not what
their money buys. Our users are streamers and their chat — not software engineers.

## Who it's for
- **Viewers** at the moment of paying: "what will this actually look like on the stream?"
- **Streamers** during setup and in the studio: "what do I do next, and is it working?"
- **Us**: one brand we can keep consistent as features land.

## What success looks like
- Every effect shows a real before → after preview of the actual model output, from one shared
  base clip, everywhere the catalog appears (portal, studio, wizard test step, website).
- A first-time streamer can finish setup and read every studio screen without meeting a
  technical term they'd have to look up.
- Every screen has one obvious primary action; every error says what to do next.
- One written source of truth for brand voice, vocabulary and UI patterns that future briefs
  are checked against.

## Acceptance criteria
- [ ] `docs/product/BRAND.md` exists: name/wordmark use, voice (with do/don't examples),
      vocabulary (the one word for each concept), button-label rules, error/empty/loading
      patterns, colour + type tokens (from `web/src/BrandShell.tsx`).
- [ ] A preview set for all 17 presets (`web/public/previews/<id>.{jpg,webm}` or similar):
      still + ≤6 s loop, before → after, from one base clip, produced by the real `lucy-2.5`.
      Recording tool and encode script documented; re-runnable when presets change.
- [ ] Portal, studio Effects tab, wizard test step and the website looks grid use the previews
      (hover/tap plays the loop; a still otherwise; CSS art only as a fallback when a file is
      missing).
- [ ] Copy audit: a checklist of every user-facing string by surface, each marked kept/rewritten,
      with zero remaining jargon terms from a blocklist in BRAND.md (OBS Browser Source,
      WebSocket, classifier, token, sidecar, preset id, JWT, mint, hub, runtime).
- [ ] Each wizard step and studio tab has exactly one primary button; destructive actions
      confirm; loading/empty/error states exist and read in plain language.
- [ ] `npm run check`, `npm run e2e`, `npm run tour` pass; studio screenshots from the tour are
      reviewed against BRAND.md.
- [ ] Website copy and the app agree (same names for the same things).

## Out of scope
- New effects, pricing, or safety policy changes.
- Generating a preview on the **streamer's own** face ("preview on me") — a later brief; it
  costs GPU per streamer and raises likeness questions.
- A website redesign beyond swapping in previews and aligning copy.
- Localisation.

## Open product questions
1. **Whose face is in the base clip?** — A: an AI-generated "streamer at a desk" clip
   (license-clear, consistent, reusable on the site), B: the PM records themselves at the rig
   (fastest; their face is then on every surface), C: licensed stock footage (cost + rights
   check). **Recommendation:** A.
   → *Answer:* **B** — the PM records the base clip at the rig (DECISIONS #17). One recording
   session covers all 17 effects; the PM's face is the demo streamer on every surface.
2. **Voice.** — A: playful, streamer-native everywhere except money and safety, which stay
   plain and calm; B: calm and confident everywhere; C: neutral/helpful. **Recommendation:** A.
   → *Answer:* **A** (DECISIONS #18).
3. **The one word for the thing a viewer buys.** — A: "effect" (the event is a "hijack");
   B: "look"; C: "preset". **Recommendation:** A — it's already the most used, and "hijack"
   stays the brand verb.
   → *Answer:* **A** — "effect" for the thing, "hijack" for the event (DECISIONS #19).
4. **Sequencing.** — A: three PRs: (1) BRAND.md + preview pipeline + viewer portal, (2) studio +
   wizard, (3) website; B: one PR for everything; C: copy audit first, previews later.
   **Recommendation:** A — the portal is where money changes hands, and each PR stays reviewable.
   → *Answer:* **A** — three PRs, viewer portal first (DECISIONS #20). **PM, 2026-10-20:** the
   recording session itself is out of this run; the PM records tomorrow with their photo ready.
   PR 1 ships the brand guide, the portal rewrite, and the preview slots + batch recorder with
   the CSS art as fallback, so the files drop in without code changes.

## Engineering decisions (filled in by the lead while building)
- PR 1 (portal): `EffectArt` reads one `/previews/manifest.json` (the hosted and Electron
  servers' SPA fallback returns HTML with 200 for missing files, so per-file probing is useless);
  no manifest → identical CSS art. `friendlyError()` is the only path from server/engine text to
  the viewer. Paid state comes from a `?paid=` flag + a sessionStorage receipt, never from copy.
  `POST /api/dev/token` (dev routes only, auth, ≤60 s, 501 on the hosted server) unblocks the
  batch recorder; `encode-clips.sh --app` writes the previews + manifest.
- Expired-claim copy keeps "No payment arrived in time." — a late payment is refunded, not
  dropped, so "nothing was charged" would be false. Cancelled-Stripe state needs a one-line
  server flag (`?cancelled=1` on `cancel_url`); deferred to PR 2 pending the PM.
- The base clip is the PM's own webcam. The recorder batches all 17 effects from one sitting
  so it's a single ~5-minute session, re-runnable when presets change.
- Previews are produced once, offline, with the existing `/decart-test` recorder
  (`site/CLIPS.md`) and committed as static files; nothing user-facing calls the model for
  previews. Cost ≈ 17 × 10 s × $0.02 ≈ $3.40 per full set.
- Copy moves toward a small shared strings module per surface so the audit is checkable.

## Risks / what could go wrong for users
- A preview that over-promises: Lucy's output varies with lighting and movement; previews
  must be typical, not cherry-picked, or viewers feel cheated.
- Rewriting copy can silently change meaning on money/safety screens — the reviewer's money
  and safety checklists apply to copy too.
- Playful voice in error states reads as mocking; errors stay plain.
