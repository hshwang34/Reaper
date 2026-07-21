# Go-live verification — the "rock-solid demo rig" sign-off

The code hardening for the demo rig is done (engine backstops, throttle-immune
countdown, gated debug logging, shortened token TTL). What remains can only be
proven at the rig — a real Decart session, a real OBS, real Streamlabs test
donations. This checklist is that proof. Complete it and the project clears the
entry gate to `docs/COMMERCIALIZATION.md` Phase 0/1.

Prereqs: finish `docs/PHASE0.md` (S1–S4) so Decart, OBS, and Streamlabs are all
live. Run everything on the one demo machine. Append `?debug=1` to `/router` and
to the OBS `/viewer` Browser Source URL to see the verbose pipeline trace.

Record outcomes in the **Results** table at the bottom. Run the whole thing
**twice, on different days** — intermittent failures only show on the second cold
run.

---

## 1 · Cost safety (the money-critical claims)

- [ ] **Session cap kills a hung job.** Start a hijack, then freeze the router
  tab mid-LIVE (DevTools → Sources → pause script execution, or throttle CPU to
  the point the interval starves). Confirm in the Decart dashboard the session
  ends on its own at **`durationSec + 15s`** — the `maxSessionDuration` on the
  minted token (`sidecar/src/decart.ts`), not the local timer.
- [ ] **Billed ≈ paid across ~10 jobs.** Run ten hijacks of varied durations.
  From the Decart billing dashboard, record total billed seconds vs. total paid
  seconds. Overhead should be small and roughly constant (the connect/buffer
  lead-in), never runaway.
- [ ] **Token TTL confirmed.** A minted `ek_` token now expires in 45s
  (`sidecar/src/decart.ts`). Confirm a normal hijack still connects well within
  that (mint→connect is seconds). If Decart ever rejects on slow connects, that's
  the number to revisit.
- [ ] **`allowedOrigins` decision — resolve the TODO.** Origin-locking is
  currently off (localhost was rejected). If you can, test re-adding
  `allowedOrigins: ["http://localhost:5173"]` in `mintClientToken` once: if the
  realtime socket connects, keep it; if it still fails (`wasConnected:false`),
  leave it off — the 45s TTL is the compensating control. Note the result.

## 2 · Kill-test matrix (every exit path lands clean)

For **each** case: trigger a hijack to LIVE, apply the disruption, then verify
all three — (i) the OBS `AI Hijack` source ends up **hidden**, (ii) the router
returns to **IDLE**, (iii) no Decart session is left billing (check dashboard),
and (iv) a **subsequent** tip still runs (the queue recovered).

- [ ] **a. Router tab refresh** mid-LIVE.
- [ ] **b. Router tab closed** mid-LIVE (reopen, re-arm, fire another tip).
- [ ] **c. OBS quit** mid-LIVE (relaunch; the `obsToggle(false)` best-effort
  should not have blocked teardown).
- [ ] **d. Sidecar restart** mid-LIVE (`Ctrl-C` the dev server, `npm run dev`
  again; router auto-reconnects the WS).
- [ ] **e. Network cut** (Wi-Fi off) mid-LIVE; restore after ~20s.
- [ ] **f. Panic** toggle mid-LIVE, then **resume** — the active job tears down
  immediately and the queue drains after resume.

> Cases **b/e** exercise the new engine backstop: when the router disconnects, the
> sidecar now fails the active job instead of stalling the queue forever (watch
> the sidecar log for `router disconnected mid-hijack`). If a router ever goes
> silent without disconnecting, the deadline backstop force-fails it at
> `durationSec + 45s` (log: `exceeded deadline — force-failing`). Both are the
> Milestone B changes — confirm you see them fire.

## 3 · Triggers & inputs

- [ ] **Streamlabs live payload** (`sidecar/src/triggers/streamlabs.ts`, the
  PHASE0 ⚠️ TODO). Fire real **Test Donations** and confirm: non-integer amounts
  parse (e.g. $2.50), non-USD currency is handled sanely (ignored or converted —
  decide and note), a reconnect doesn't double-fire the same donation, and the
  `isTest` flag maps through.
- [ ] **Claim-code match paths.** Verify all four in `correlation.ts`: code in
  message, declared username, sole-pending, and no-match→default preset.
- [ ] **Reference image actually shapes output.** Submit a portal job with an
  image; confirm the restyle reflects it (`initialState.image` in
  `decartSession.ts`). If it has no visible effect, decide: keep, or hide the
  image field in the portal until Phase 1 — **no silently-broken UI**.
- [ ] **Rapid-tip queue stress.** Fire six tips fast and watch FIFO order,
  live queue-position updates on the portal, `queueDepth` rejection at the 6th
  (default depth 5), and the cooldown gap between jobs:
  ```bash
  for i in 1 2 3 4 5 6; do
    curl -s localhost:7712/api/dev/fake-tip \
      -H 'content-type: application/json' \
      -d "{\"amount\":3,\"message\":\"stress $i\",\"username\":\"u$i\"}" ; echo
  done
  ```

## 4 · Quality & latency (the "worth paying for?" gate)

- [ ] **Glass-to-glass latency.** Point the camera at a millisecond clock;
  screenshot the OBS program output; diff the timestamps. Do 5 runs. Record
  **camera→router-AI-preview** and **camera→OBS-source** separately (the gap is
  the loopback's cost). This is the number the whole commercialization case rests
  on — no prior benchmark exists for this round trip.
- [ ] **Tune `WIPE_MS`** (`stateMachine.ts` + `ViewerPage.tsx`, currently 420ms).
  The glitch-wipe must fully cover the visible latency jump at hijack start and
  end. Adjust to the measured reality.
- [ ] **Throttle-immunity of the countdown** (verifies the Milestone D fix).
  Start a hijack, then background/occlude the router tab for its whole duration.
  Confirm the effect still ends at the paid time (± a second), **not** stretched.
  The countdown is now wall-clock-deadline based, so a throttled tab can't
  over-bill; if teardown itself lags under heavy throttling, the watchdog
  (`durationSec + 10s`) and the Decart cap still bound it — note if you see any
  visible overrun.
- [ ] **Preset pass on the real model.** Run all six presets
  (`shared/src/presets.ts`) live. Note a per-preset verdict; rewrite weak prompts
  (cheap — it's just text) and drop/replace any that can't look good.
- [ ] **Portal viewer states + mobile.** Confirm every `SubmissionStatus` renders
  clearly in `PortalPage.tsx` (`pending`, `matched`, `queued`, `live`, `done`,
  `expired`, `failed`, queue-full). Load the portal on a phone viewport (viewers
  are on phones) and fix layout breakage — no redesign.

## 5 · Stability soak

- [ ] **3-hour soak, clean.** Arm the router, fire a hijack every ~10 min:
  ```bash
  while true; do
    curl -s localhost:7712/api/dev/fake-tip -H 'content-type: application/json' \
      -d '{"amount":4,"message":"soak","username":"soak"}' >/dev/null
    sleep 600
  done
  ```
  Watch for: router-tab memory growth (each job builds a fresh
  `RTCPeerConnection` — confirm `LoopbackSender.stop()` / receiver cleanup keeps
  it flat), WS reconnect correctness after idle, and OBS Browser Source stability.
  Fix anything that surfaces and re-soak until a clean 3-hour run.

## 6 · Capture the proof

- [ ] **Footage.** Screen-record before/after (OBS program output) for the best
  3–4 presets. Save under `docs/media/`. Replace the "will be added" placeholder
  block in `README.md` with real stills.
- [ ] **Numbers.** Fill the Results table below and copy the headline figures into
  a short "Live verification results" note — these are the exit criteria of
  COMMERCIALIZATION.md Phase 0.

---

## The done-bar (run cold, twice, different days)

1. `npm run dev`; arm `/router`; OBS live with a hidden `AI Hijack` source.
2. Portal: submit prompt + image → claim code.
3. Streamlabs Test Donation carrying the code → hijack runs exactly N seconds →
   glitch-wipe → source hidden.
4. Fire 3 rapid fake tips → FIFO with cooldown gaps.
5. Panic mid-hijack → instant teardown; resume → queue drains.
6. Wi-Fi off mid-hijack → clean local teardown; Decart session dead by the cap.
7. `npm run typecheck` clean; console quiet without `?debug=1`.

All seven pass **twice** + a clean 3-hour soak + footage/numbers committed =
ready to start commercialization.

---

## Results

| Metric | Run 1 | Run 2 | Notes |
|---|---|---|---|
| Billed vs paid seconds (10 jobs) | | | |
| Session-cap kill fired at | | | expect `duration + 15s` |
| Glass-to-glass: camera→OBS | | | ms |
| Loopback added latency | | | camera→OBS minus camera→preview |
| Tuned `WIPE_MS` | | | |
| Kill-matrix a–f | | | all clean? |
| Streamlabs payload quirks | | | |
| Reference-image effect | | | keep / hide |
| Preset verdicts (6) | | | |
| 3-hour soak | | | mem flat? leaks? |
| `allowedOrigins` re-enabled? | | | yes / no + why |
