# Architecture review — from working PoC to the cleanest shape

*2026-09-09. A full read of all six workspaces (~6.8k lines) after the commercial
build landed. Three independent review passes (architecture, backend
correctness/security, web/router correctness) plus a hand verification of every
finding against the code. This document records what was found, what was fixed
in the same pass, and what the target ("cleanest") implementation looks like so
the remaining migration can be done in small, typecheck-green steps.*

## Verdict

The `core/` extraction is real: the money path (engine, correlation, moderation,
hub, minting, triggers) is a single implementation that runs unchanged in the
demo rig, the Electron bridge, and the hosted control plane. The invariants that
matter most — capture in a real Chrome tab, the WebRTC loopback into a
display-only viewer, OBS unhidden only on `viewer:frames-ok`, the three
independent cost caps, server-side preset resolution — were all implemented
correctly.

The defects were one level up from the money path:

1. **No host contract.** Each host re-wired the same things by hand
   (submission intake, settings patching, the engine↔hub late-bind, mint
   policy), so the three hosts drifted — and in cloud mode the app's panic
   hotkey, tray, and updater were reading the *wrong engine*.
2. **The wire was trusted.** The hub took `hello.role` straight off the socket
   (an unknown role crashed the process) and accepted lifecycle messages from
   any registered socket, including the public portal role.
3. **Async continuations were unguarded.** The router state machine and the
   Decart session had races where a cancel during an `await` could unhide OBS
   after teardown, flap `router:state`, or leave a Decart session billing until
   its token cap.
4. **Nothing had a lifecycle.** No `dispose()` on Engine, CorrelationStore, or
   Hub; per-channel runtimes on the hosted plane leaked timers and orphaned
   sockets when rebuilt.

## What was fixed in this pass

Severity is the reviewers' consensus; every item was verified by reading the
code before changing it. All fixes keep `npm run typecheck` green and are
covered by the new `npm test` suite where the unit is pure.

| Sev | Area | Defect | Fix |
|---|---|---|---|
| **Critical** | `core/hub.ts` | `hello.role` unvalidated → `byRole[role].add` throws inside the `ws` listener with no handler → **process crash from one unauthenticated packet** (internet-facing on the hosted plane) | Validate against the role set; wrap the message handler; process-level `uncaughtException`/`unhandledRejection` guards in both servers |
| **Critical** | `core/hub.ts` | `router:state` / `job:done` / `viewer:frames-ok` / `rtc:*` accepted from any registered socket — a public portal socket could fail a paid live job (`router:state OFFLINE`) or forge the buffering gate | Control messages gated to `router`; frames-ok to `viewer`; RTC relay refuses portal senders and self-targeting; `from` is stamped from the socket's role, never the payload |
| **High** | `web/router/stateMachine.ts` | Panic during the in-flight `obsToggle(true)`: teardown ran with `wentLive=false` (no hide), then the toggle resolved → **OBS visible on a dead source, forever** | Per-job generation counter; every continuation bails if stale; the post-toggle guard re-hides OBS |
| **High** | `app/main.ts`, `updater.ts` | Cloud mode: hotkey/tray/`/api/panic` paused the idle *local* engine; updater's "never relaunch mid-hijack" read the same dead snapshot | `LocalServerHost.moneyProxy` — `CloudLink` implements `togglePause()` (authed HTTP to the cloud engine) and mirrors `status` downlinks; every panic/status surface goes through `local.togglePause()` / `local.status()` |
| **High** | `server/channels.ts` | Mint gate allowed unlimited tokens per job — each `ek_` opens its own Decart session, so a retrying (or hostile) router could run N sessions off one paid job | One mint per `jobId`, checked against the ledger |
| **Med** | `web/router/decartSession.ts` | Connect-timeout abort called `disconnect()` while `realtime.connect()` was pending; the session then came up unowned and billed until `maxSessionDuration` | Generation guard: a connect that resolves after `disconnect()` is closed on arrival |
| **Med** | `web/router/stateMachine.ts` | `dispose()` during LIVE set OFFLINE, then the pending teardown set IDLE → engine dispatched to a camera-less router → job stalled to the 45 s+ deadline | Teardown ends in OFFLINE when the camera is gone; camera released only after hide→disconnect completes |
| **Med** | `server/index.ts` + `channels.ts` | Saving a Streamlabs token did `stop(); getRuntime()` — the router socket stayed adopted into the old hub; new engine saw the router as OFFLINE | `setStreamlabsToken()` swaps the trigger in place; `stop()` now disposes engine + hub |
| **Med** | `server/channels.ts` | Budget ledger debited *before* the Decart call — failed mints ate the monthly cap | Insert after a successful mint |
| **Med** | `core/engine.ts` | `jobCode` map entry set before the queue-depth check → leaked on every dropped job | Set only on successful enqueue; `dispose()` clears |
| **Med** | `core/correlation.ts` | Rule 3 ("sole pending") hands a stranger's tip to whoever submitted last — fine on a demo rig, wrong on a real channel | `Settings.allowSolePendingMatch` (default on; toggle in router panel + dashboard) |
| **Low** | `core/correlation.ts` | Claim code matched by substring — a 4-char word in the tip message could claim someone's code | Whole-token match |
| **Low** | both hosts | `POST /settings` merged the raw body — an authed client could persist `secondsPerUSD: 1e9` or a non-array blocklist | `sanitizeSettingsPatch()` in `shared/settings.ts`: known keys, right types, bounded |
| **Low** | `sidecar/server.ts` | Local `/api/token` was not job-gated (hosted was) | Same job-gate as the hosted plane |
| **Low** | `web/lib/loopback.ts`, `ViewerPage.tsx` | Receiver/sender never unsubscribed or closed their peer on unmount (StrictMode double-mount → two receivers on one hub) | `dispose()` on both; pages call it |
| **Low** | `app/cloudLink.ts` | Fixed 3 s reconnect — every install hammers the control plane in lockstep during an outage | Exponential backoff with jitter, capped at 60 s |

Duplication removed on the way: submission intake (preset resolution +
enablement + moderation) now lives once in `core/submissions.ts`; the pricing
formula once in `shared/settings.ts` (engine and portal preview call the same
function); the `+15 s` session-cap headroom once as `SESSION_CAP_EXTRA_SEC`;
the app's authed cloud calls once in `CloudLink.authedPost`.

## Test gate

There was no runner. There is now `npm test` (`node --test` via `tsx`, no new
production deps) with 46 tests: `core/test` (Engine, CorrelationStore,
createSubmission, gatedMint, Hub role gating against fake sockets, the
settings/pricing helpers), `web/test` (the router state machine against fake
ports — every invariant in the "must not change" list below is an assertion),
and `server/test` (exchange codes, constant-time compare). `npm run check` =
typecheck + test. A live smoke of the demo rig in MOCK mode exercising every
shared route was run after each host-touching step.

## The target shape

The principle: **`core/` owns policy, hosts own I/O, and the seam between them
is one explicit interface.** Everything a host must provide is named in a port;
everything policy-shaped lives in core and is tested there.

```
shared/    types · protocol (LocalPlaneMsg | ControlPlaneMsg) · presets
           settings (DEFAULT_SETTINGS, computeDurationSec, sanitizeSettingsPatch)
           desktopBridge (the preload contract, typed once)

core/
  domain/  engine · correlation · moderation · submissions · mintPolicy
           ← zero node: imports; ids/clock injected so tests are deterministic
  ports.ts Host = {
             settings: SettingsStore            // get / update(patch)
             obs?: ObsController                // setVisible(scene, source, on)
             minter: TokenMinter                // (durationSec) → ek_ | "MOCK"
             money: MoneyAuthority              // togglePause / status  (local engine or CloudLink)
             ledger?: Ledger                    // hijack rows, mint rows, monthly used
             triggers: TriggerSource[]
           }
  runtime.ts createRuntime(host) → { engine, hub, correlation, dispose() }   // the late-bind, once
  http/    buildApiRouter(runtime, host)  // config · submissions · settings · token · panic · dev/*
           mounted at /api (local) and /api/c/:channel (hosted, after channel middleware)
  node/    hub (ws) · decart minter · triggers/* · default log sink

sidecar/   composition only: .env + settings.json + ObsController + express static
server/    composition only: db-backed SettingsStore + Ledger · auth · WS front door
app/       composition only: electron; local = sidecar host; cloud = CloudLink as MoneyAuthority + TokenMinter
web/       lib/apiClient (one credential model) · lib/hub · lib/desktop
           features/guardrails (one editor for router panel + dashboard)
           router/{machine, ports}  — machine takes { mintToken, setObsVisible, fetchImage, clock }
```

### Migration — complete (2026-09-09, one commit per step, gate green throughout)

| Step | What landed | Where |
|---|---|---|
| 1–3 | Settings helpers, shared submission intake, `dispose()` everywhere, money-authority port | `shared/settings.ts`, `core/submissions.ts`, `LocalServerHost.moneyProxy` |
| 4 | `createRuntime({ getSettings, server, hub, hooks })` — the engine↔hub bind built once; ledger rows and cloud mirroring are hooks | `core/runtime.ts`; sidecar + `server/channels.ts` call it |
| 5 | `buildApiRouter({ context, requireAuth, upload })` — config · presets · submissions · settings · token · panic · dev/* as one Express router; `gatedMint` + `MintLedger` as the single mint policy | `core/http/apiRouter.ts`, `core/mintPolicy.ts`; mounted at `/api` and `/api/c/:channel` |
| 6 | `RouterMachine` behind `MachinePorts` with injectable timeouts; the invariants are tests | `web/src/router/ports.ts`, `web/test/stateMachine.test.ts` |
| 7 | Protocol split into control plane and `LocalPlaneMsg`; typed `sdp`/`candidate`; dead `ARMING`/`ERROR` removed; no casts left in hub or loopback | `shared/src/protocol.ts` |
| 8 | OBS scene/source moved from `Settings` to host wiring (`.env` / keys.json); `loadSettings()` validates persisted files on read | `shared/src/{types,settings}.ts`, `sidecar/config.ts`, `app/config.ts` |
| 9 | `createApiClient` with install / session / none credentials; `GuardrailsEditor`; `DesktopBridge` typed once | `web/src/lib/apiClient.ts`, `web/src/features/*`, `shared/src/desktopBridge.ts` |
| 10 | One-time OAuth exchange code instead of the refresh token in a fragment; constant-time compares | `server/src/auth.ts` (`/auth/exchange`), `core/src/hub.ts` |

The one item from the original list that was deliberately *not* done:
typing `HelloMsg.auth` as `{ kind: "install" | "session" }`. Both credentials
are opaque bearer strings whose meaning is decided by the host that receives
them (the local hub compares, the hosted front door verifies a JWT); a tagged
union would move that decision into the wire format without removing any
check. The comment on `HelloMsg.auth` says so.

### What a future pass could still do

- `core/domain` vs `core/node` split so the engine and correlation have zero
  `node:` imports (they take `node:crypto` for ids today). Only matters if the
  money path ever needs to run in a browser or edge runtime.
- Per-channel log tags on the hosted plane: the logger sink is process-global,
  so `engine:<login>` tags are built and then ignored inside core.
- The hosted `ChannelRuntime` map is in-memory; a second server instance means
  a second engine per channel. Fine for the single-machine alpha it is.

### Must not change (the hard-won constraints)

Capture in a real Chrome/Electron tab, never OBS's CEF. The AI feed re-enters
OBS via the local WebRTC loopback into the display-only `/viewer`. OBS is
unhidden only on `viewer:frames-ok` (media arrival, not rendering). Teardown is
idempotent and hides OBS *before* dropping Decart on every exit path. The three
cost caps stay independent, and `maxSessionDuration` stays on the token. Preset
prompts resolve server-side from the id. The hosted hub rejects the local plane.
No `cors()` on the local server. ESM with explicit `.js` extensions.
