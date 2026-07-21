# Postmortem: the five bugs between Decart and OBS glass

**2026-07-20 · Outcome: first fully successful live hijack** — fake tip → queue →
duration-capped token → `lucy-2.5` restyle → WebRTC loopback → OBS Browser
Source visible for exactly the paid 15 seconds → `teardown (ok: completed)`.

Getting the first pixel on OBS glass required finding five real bugs stacked on
top of each other, each one masking the next. Worth recording because the
*method* — isolate, instrument, then fix — is the story.

## The method

The breakthrough was refusing to debug the full pipeline at once. We built an
isolated diagnostic page (`/decart-test`: camera → Decart → video element,
no OBS, no loopback, no state machine) which immediately separated "Decart is
broken" from "our plumbing is broken." Decart worked — with a surprise in its
timing (bug #1). Everything else fell out of instrumenting each hop.

## The five bugs

1. **Decart's remote stream arrives empty.** `onRemoteStream` fires with a
   `MediaStream` that has **zero video tracks**; the actual track is added ~1s
   later (visible in the diagnostic log as `tracks: 0` → `tracks: 1`). Our code
   read the stream synchronously, saw nothing, and piped an empty stream to
   OBS. *Fix:* wait for `stream.onaddtrack` before treating the session live.

2. **Origin-locked client tokens killed the media session.** Tokens minted with
   `allowedOrigins` for a localhost origin produced `wasConnected: false` at
   the LiveKit layer — session "connected", no media. *Fix:* drop the origin
   restriction for local dev; re-verify against a deployed origin.

3. **The buffering gate deadlocked by design.** We gated go-live on *rendered*
   frames (`requestVideoFrameCallback`) inside the OBS Browser Source — but OBS
   doesn't render a **hidden** source, so frames never "present", the gate
   never passes, and the source can never be shown. Chicken-and-egg. *Fix:*
   gate on **media arrival** instead — a remote track's `onunmute` fires when
   RTP actually flows, rendering not required. Still impossible to broadcast a
   black frame; works while hidden.

4. **The Browser Source reloaded itself at go-live.** `restart_when_active:
   true` (set by our own setup script) told OBS to refresh the page the moment
   the source became active — destroying the live WebRTC connection exactly
   when the show started. *Found by the user auditing the source properties.*

5. **The overlay was under the webcam.** The `AI Hijack` scene item sat at
   z-index 0, *below* the webcam — invisible even when everything else worked.
   *Found by the user asking "how does it show on top?"*

## Product outcome

The overlay is now a **full-canvas takeover** rather than a webcam-box overlay:
the webcam renders ~4:3 while the AI feed is 16:9, and pixel-matching the box
would distort or misalign. A fullscreen takeover sidesteps the geometry and
reads as intentional drama — "reality got hijacked," not "a filter turned on."

## Takeaways

- Realtime AI SDKs are young: never assume the stream in a ready-callback is
  actually ready. Verify tracks, verify frames, verify *flow*.
- Any readiness gate must hold under the *renderer's* rules — a hidden CEF
  source doesn't paint, so paint-based signals deadlock.
- Two of five bugs were found by non-code questions ("check the properties",
  "how does it layer?"). Auditing configuration is debugging.
