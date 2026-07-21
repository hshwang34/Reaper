# Phase 0 — Going live (credential + hardware setup)

The codebase runs in **MOCK mode** with no setup. This checklist lights up the
real integrations. Each step is independent and gated by something only you can
do (an account signup, a hardware permission, a running app), which is why it's
separated from the code.

Estimated time: **under an hour**, under **$1** of API spend.

---

## S1 · OBS Virtual Camera → visible to Chrome

1. Install **OBS Studio 30+** (macOS 13+ ships the camera as a system extension).
2. Add your webcam as a source, then **Start Virtual Camera**. Click the gear
   next to it and set **Output Type → Source** (the raw camera), *not* Program —
   this prevents the AI overlay from feeding back into its own input.
3. First run only: approve the "OBS Virtual Camera" system extension in
   **System Settings → Privacy & Security**.
4. **Verify:** open `http://localhost:5173/router`, click **Arm camera**, and
   grant permission. The event log should say *"armed on OBS Virtual Camera."*

## S2 · Decart (the AI restyle)

1. Sign up at **platform.decart.ai** and create an API key (`dct_…`). New
   accounts get free credits.
2. Put it in `.env`: `DECART_API_KEY=dct_...` and restart (`npm run dev`).
3. The sidecar now mints short-lived `ek_` client tokens per job — your `dct_`
   key never reaches the browser.
4. **Verify:** the router page's Decart indicator flips from **MOCK** to
   **LIVE**. Run a hijack; the styled feed should appear. Watch a session get
   killed at `duration + 15s` even if you never disconnect (the cost backstop).

> Model in use: `lucy-2.5` (realtime video-to-video, 720p). To cut cost roughly
> in half for environment restyles, switch to `lucy-restyle-2` in
> `sidecar/src/decart.ts` and `web/src/router/decartSession.ts`.

## S3 · Streamlabs (the real-money trigger)

1. In **Streamlabs Dashboard → Account Settings → API Settings → API Tokens**,
   copy your **Socket API Token**.
2. Put it in `.env`: `STREAMLABS_SOCKET_TOKEN=...` and restart.
3. **Verify:** the sidecar logs *"streamlabs socket connected."* Fire a
   **Test Donation** from the Streamlabs dashboard with a claim code in the
   message — it should drive a real hijack. (No real money is spent on test
   donations.)

> ⚠️ Confirm the exact test-donation payload against your live token; the
> adapter in `sidecar/src/triggers/streamlabs.ts` is marked where to check.

## S4 · OBS overlay + control

1. In OBS, add a **Browser Source** named exactly **`AI Hijack`** pointing at
   `http://localhost:5173/viewer`. Uncheck "Shutdown source when not visible."
   Set it to your canvas size (e.g. 1280×720). Leave it **hidden** by default.
2. Enable **OBS → Tools → WebSocket Server Settings**. Put the URL/password in
   `.env` (`OBS_WS_URL`, `OBS_WS_PASSWORD`) plus the `OBS_SCENE` / `OBS_SOURCE`
   names, and restart.
3. **Verify:** run a hijack — the `AI Hijack` source should become visible only
   once real frames arrive, then hide on teardown, covered by the glitch-wipe.

---

## Full live demo

With S1–S4 done: open `/router` (arm) and `/portal` on one machine, add the
`/viewer` Browser Source in OBS, submit a prompt+image on the portal, fire a
Streamlabs test donation carrying the claim code, and watch your OBS program
output get hijacked for exactly the paid number of seconds, then revert.

Once that works, harden it into a demo rig you can trust in front of anyone:
work through [`VERIFICATION.md`](./VERIFICATION.md) — the cost-safety, kill-test,
latency, and soak checklist that signs the MVP off as commercialization-ready.
