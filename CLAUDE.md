# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Reality Hijack: viewers pay a live streamer, type a prompt (or pick a preset) + optional
reference image, and the streamer's webcam is restyled in real time by Decart's `lucy-2.5`
video model for a duration proportional to the payment (**$1 = 1s**), then reverts. It is both a
working product and a portfolio case study in AI product design under real constraints
(per-second GPU billing, monetization policy, live-video latency, content safety).

The product is **hosted-first**: streamers install the desktop app, sign in with Twitch, and run
on our control plane (live at `reality-hijack.fly.dev`), which holds the Decart key. Viewers fund
every GPU second through **Stripe Connect** checkout. The one-machine demo rig (sidecar, own
keys, Streamlabs tips) remains the offline/dev path.

`FEASIBILITY.md` is the source of truth for *why* the design is shaped this way — read it
before changing the pipeline, cost caps, or trigger layer. Section references (§3, §8, etc.)
appear throughout the code comments. `docs/CONTENT-SAFETY.md` is the equivalent for the
guardrail/moderation layer (stages S0–S6, policy model, implementation phases) — read it
before touching `moderation.ts`, `submissions.ts`, uploads, or anything that puts viewer
bytes in front of the model or on stream.

## Operating model — the user is the PM, you are the eng lead

The user works as **product manager** and doesn't want to do low-level work. You own the *how*:
turn their intent into a brief, decide technical questions yourself, and run the project agents
in `.claude/agents/` (`payments-engineer`, `implementer`, `tester`, `reviewer`) from the main
session. Bring them only **product** calls (money users see, permissions, safety policy, UX,
scope, anything deploying or hard to reverse), batched, with options and a recommendation.
`/feature <idea>` runs the loop (brief → approval → build → gate → PR); `/status` reports what's
waiting on them. The PM merges every PR; deploys and live Stripe need their explicit go. Before
asking a product question, check `docs/product/DECISIONS.md`, and append every new answer there.
Full model: `docs/product/README.md`.

## Commands

The **demo rig** runs on one machine with no cloud (the "server" is a local sidecar). The
**commercial path** adds a downloadable Electron app + a hosted control plane; both reuse the
same `core/` money path.

Use **Node 22+** (CI runs 22). On Node 20, `better-sqlite3@12` has no prebuilt binary and
`npm install` fails in node-gyp.

```bash
npm install
cp .env.example .env      # leave keys blank → MOCK mode (camera passthrough, no cost)
npm run dev               # demo rig: concurrently sidecar :7712 + web :5173
npm run typecheck         # tsc --noEmit across all SIX workspaces
npm test                  # node --test in core, web, server, sidecar, app (see below)
npm run check             # typecheck + test — the gate to run after edits; CI (check.yml) runs it
                          #   plus the web build on every PR and push to main, and its e2e job
                          #   runs e2e + e2e:hosted (Linux, xvfb)
npm run e2e               # mock-mode end-to-end: real sidecar + headless Chrome router/viewer +
                          #   a fake OBS; asserts what the audience sees (needs Google Chrome;
                          #   CHROME_PATH overrides the macOS default path)
npm run e2e:hosted        # the commercial path, zero secrets: real control plane + the real Electron
                          #   app (CDP-driven) + portal checkout against a fake Stripe (signed
                          #   webhooks) + fake OBS; asserts pay→play, settle, panic, refunds
npm run smoke:prod        # read-only checks against the deployed server (hourly in CI: smoke.yml)
npm run smoke:live        # on demand: a real test-mode Stripe Checkout (4242) on prod → real hijack;
                          #   needs the streamer app open + armed; ~$0.06 of Decart per run
npm run build             # builds the web app only
npm run start             # production demo rig: build, then ONE process on :7712

npm run dev:app           # build web, then launch the Electron app (local mode)
npm run dev:server        # the hosted control plane on :8790 (dev: DEV AUTH if no Twitch app,
                          #   no Stripe key → payments off, portal falls back to claim codes)
```

Cloud-mode dev loop: run `dev:server`, then launch the app with
`RH_CLOUD_URL=http://127.0.0.1:8790 RH_CLOUD_LOGIN=<name>` — it dev-signs-in and links.
`RH_SKIP_SETUP=1` skips the first-run wizard. Package the app: `npm run package --workspace app`
(unsigned `--dir`) or `dist` (universal macOS DMG / Windows x64 NSIS installer). Releases are cut
by tagging `v<app version>` (`release.yml`); the build bakes the control-plane URL in from the
`RH_CLOUD_URL` repo variable (`app/scripts/build-main.mjs`). `docs/DISTRIBUTION.md` covers
cross-packaging (`RH_ARCHS`/`RH_PLATFORM`), signing, the Fly deploy, and what's manual.

Deploy the control plane from the **repo root** (`fly.toml` + `Dockerfile` live there; the image
needs `shared/`, `core/`, `web/`, `server/`): `fly deploy --remote-only`. That is production —
ask first. The image runs `RH_ENV=production`, which refuses to boot unless every required
secret is set (`productionProblems` in `server/src/env.ts`) and never mounts dev auth or the
unpaid `/dev/*` routes.

Per-workspace dev: `npm run dev:sidecar`, `npm run dev:web`. There is **no linter**. Tests are
plain `node:test` run through `tsx` (no framework) in `core/test`, `web/test`, `server/test`,
`sidecar/test`, `app/test`. Single file / single test:

```bash
cd core && node --import tsx --test test/engine.test.ts
cd core && node --import tsx --test --test-name-pattern="cooldown" test/engine.test.ts
# server tests must preload test/env.ts (scratch SQLite per process, JWT + webhook secrets):
cd server && node --import tsx --import ./test/env.ts --test test/payments.test.ts
```

Server tests fake Stripe through the narrow `StripeLike` interface (`setStripeForTests`), so the
whole payment path is testable offline. Run workspace scripts from the workspace dir
(or via `npm run … --workspace`): `tsx` applies that workspace's `tsconfig.json` `paths`, which
is what resolves `@rh/*` to source — from the repo root it would fall back to the hoisted
`node_modules` symlinks instead. `docs/ARCHITECTURE-REVIEW.md` records the 2026-09 review, what
it fixed, and the migration to the target layout.

### Demoing the loop without credentials
1. Open `http://localhost:5173/router`, click **Arm camera** (needs a real Chrome tab).
2. Open `http://localhost:5173/portal`, pick an effect or write a prompt, get a claim code.
3. Click **Send $N test tip** (or `POST /api/dev/fake-tip`) — the router runs the job for N seconds.

`docs/PHASE0.md` covers the real-credential + OBS hardware path; `docs/VERIFICATION.md` is the
on-rig go-live checklist (append `?debug=1` to `/router` and `/viewer` for the pipeline trace),
and `docs/POSTMORTEM-first-live-hijack.md` records the five stacked Decart→OBS bugs behind the
first successful live hijack.

### Content safety (docs/CONTENT-SAFETY.md)

With a real Decart key, viewer-authored bytes reach the model only through classifiers:
custom text needs `OPENAI_API_KEY` (the non-LLM floor; `ANTHROPIC_API_KEY` adds the policy check but never suffices alone); **any** reference image needs
Sightengine (`SIGHTENGINE_API_USER`/`SECRET`), the minors check. Missing keys switch the
matching tier off (fail closed); presets always work. MOCK mode ("dev mode") runs blocklist +
structural checks only. Streamer approval and the output guard are **opt-in** (default off, local and
hosted): input screening + the panic hotkey are the baseline, like Streamlabs TTS's filter +
skip. With no approval tier on, a borderline (`review`) classifier result is rejected at
intake, never parked. Invariants: the chain runs before a claim code exists; suspected CSAM
stops before any further vendor and is quarantined, never deleted (`docs/runbooks/csam.md`);
every other check runs to completion so the portal can list **every** failure point
(`findings[]`, streamed live as NDJSON — CONTENT-SAFETY "What the viewer is told");
uploads are deleted at job end / expiry / 1h; output-guard stops are ordinary `teardown()`s
whose `job:done` reason starts with `safety:`.

## Architecture

npm-workspaces monorepo. Six packages. The `core/` money path runs unchanged in three
hosts — the sidecar demo rig, the Electron app's local bridge, and the hosted control
plane's per-channel runtimes — which is the whole point of the extraction.

- **`shared/`** (`@rh/shared`) — the single source of truth: domain `types.ts`, the WS
  `protocol.ts` (discriminated union on `t`, split into a control plane and a local plane;
  `HelloMsg` carries `auth`/`channel`), `settings.ts` (`DEFAULT_SETTINGS`, the pricing
  formula `computeDurationSec`, `sanitizeSettingsPatch` / `loadSettings`), and the `presets.ts`
  catalog. Everything imports it; the web consumes it *as source* via a Vite alias.
- **`core/`** (`@rh/core`) — the portable money path. Policy: `engine.ts` (tip→job→queue),
  `correlation.ts` (tip↔submission matching), `submissions.ts` (intake: preset resolution,
  enablement, moderation), `moderation.ts`, `mintPolicy.ts` (`gatedMint`: job-gated, one token
  per job, budget-capped). Composition: `runtime.ts` (`createRuntime` — the engine↔hub wiring
  + hooks + `dispose()`, built once for every host), `http/apiRouter.ts` (`buildApiRouter` —
  the channel API every host mounts), `hub.ts` (WS relay with role gating; local mode owns a
  `WebSocketServer`, adopted mode is driven by the hosted front door), `decart.ts` (ek_
  minting), and the trigger adapters. Host-agnostic by construction: hosts inject
  `getSettings`, the auth gate, upload storage, and a mint ledger; the log sink is swappable.
- **`sidecar/`** (`@rh/sidecar`, tsx) — the demo-rig composition root. `server.ts` is a
  `createLocalServer(host)` factory (`createRuntime` + `buildApiRouter` + OBS control + static
  serving + the install-token gate) that both the CLI (`index.ts`, config from `.env`) and the
  Electron app embed. OBS scene/source names are host wiring (`.env` / the app's keys.json),
  not `Settings`. `obs.ts` also does `ensureBrowserSource()` auto-provisioning. In production
  mode (`npm run start`) it serves the built web app — one process, one port.
- **`app/`** (`@rh/app`, Electron) — the "single download" for streamers. Main process embeds
  the sidecar composition as a local bridge (127.0.0.1:17712), auto-provisions the OBS Browser
  Source, holds a per-install auth token, tray + ⌘⇧H panic, and — when signed in — a
  `cloudLink.ts` to the control plane (**cloud mode**: no Decart key on the machine; the local
  bridge keeps only OBS control + signaling + page serving, and panic/status go to the cloud
  engine through the bridge's `moneyProxy` — the local engine never holds the job in cloud
  mode). Renderer opens `/setup` (the first-run wizard: Twitch sign-in, camera, OBS websocket
  enable, safety acknowledgement) until it has completed once (`app-state.json` → `setupDone`),
  then `/router` in bundled Chromium. `local mode` (pasted keys) is the offline/dev path; on
  packaged builds it is hidden behind `RH_LOCAL_MODE=1`.
- **`server/`** (`@rh/server`, tsx) — the hosted control plane. Twitch OAuth → our JWTs,
  per-channel in-memory `ChannelRuntime` (one `@rh/core` engine each), server-side job-gated +
  budget-capped minting, the hijack ledger (SQLite/Drizzle, versioned migrations on
  `PRAGMA user_version`), and the hosted portal at `/c/:channel`. One WS front door routes
  sockets to per-channel adopted hubs. `payments.ts` (Stripe Connect) and `fees.ts` (pure fee
  split) are the money layer — see *Viewer payments* below. Exactly **one** Fly machine on
  purpose: every channel's queue and active job live in this process's memory.
- **`web/`** (`@rh/web`, Vite + React 19 + Tailwind 4) — routes: `/portal` (viewer; also served
  hosted at `/c/:channel`), `/router` (streamer capture + state machine), `/viewer` (OBS
  Browser Source display), `/setup` (desktop onboarding wizard), `/dashboard` (hosted streamer
  dashboard). `lib/auth.ts` + `lib/channel.ts` make the same pages work local and hosted.
- **`site/`** — the public marketing site. Deliberately **not** a workspace: a standalone Vite
  project (`cd site && npm install && npm run dev`) so Vercel installs nothing but Vite. No
  framework, no runtime deps. `site/src/main.ts` drives one simulated tip→hijack→revert loop
  that every product mock on the page follows; the picture is a CSS-treated stock photo
  (`site/CREDITS.md`) unless `public/clips/manifest.json` lists recorded clips of the real model
  (`site/CLIPS.md`). The site never calls Decart. Vercel project `reality-hijack` on the
  personal account. Brand sources live in `branding/`.

Browser pages talk to whichever host serves them, same-origin (Vite proxy in dev). Secrets
never reach a page. The **local plane** (rtc signaling + `viewer:frames-ok`) never leaves the
streamer's machine — the cloud front door rejects it (`rejectLocalPlane`).

### The one hard-won constraint (don't "simplify" these)

- **Capture must be a real Chrome tab, not OBS's embedded CEF browser** — CEF blocks camera
  permission. The router page grabs the OBS **Virtual Camera** (set its output to *Source* to
  avoid a feedback loop) via `getUserMedia`.
- **The AI feed re-enters OBS via a local WebRTC loopback** into the display-only `/viewer`
  page, which lives in a Browser Source. The hub relays RTC signaling by role.
- **OBS is unhidden ONLY when Decart reports `generating` AND `/viewer` reports media
  flowing** (`viewer:frames-ok`), never on a timer or `onloadeddata` — a WebRTC stream can
  fire those while still black, and Decart's RTP flows before it generates. This is the
  "buffering gate."
- **The sidecar hides OBS on its own** whenever the router is lost, the engine cancels a job,
  or OBS (re)connects — only the router unhides, but a frozen/reloaded router can't hide.

### Cost safety — three independent caps (FEASIBILITY §3)

A hung Decart session bills per second, so overrun is bounded three ways: (1) the router's
countdown timer, (2) a local watchdog (`durationSec + 10s`), and (3) the Decart **client token
itself** — the sidecar mints a short-lived `ek_` token with `maxSessionDuration` so Decart's own
servers kill the session even if the streamer's machine freezes. Never extend an active session;
every job gets a clean init/teardown. On the hosted plane, `RH_MONTHLY_GPU_SECONDS_CAP` per
channel is a fraud/runaway backstop, and the only GPU we fund ourselves is one fixed-preset 10s
`test-hijack` per channel per UTC day (counted from the ledger, so a restart can't refill it).

### Viewer payments (`server/src/payments.ts`) — don't "simplify" these either

Direct charges with Stripe **Managed Risk** on Express accounts: the Checkout session lives on
the streamer's account (they're seller of record, Stripe absorbs fraud/chargebacks), and our
`application_fee_amount` = GPU cost (rounded **up**) + platform margin (`fees.ts`; margin, GPU
rate and the $3 minimum are server env, never streamer `Settings`). Only account *creation*
uses the preview API version; everything else is on the stable API. Every rule below came
from a security review or a real test payment:

- **Checkout refuses (409) while the channel's router is offline or panic-paused** — a viewer
  must never pay for a hijack that can't run.
- **The webhook trusts nothing the streamer can write.** The streamer can see the session's
  metadata on their own dashboard, so `onPaid` finds the payment by the Checkout session id
  *we* stored, and requires the event's `account` and the amount/currency to match. A paid
  session becomes a `TipEvent { source: "stripe", message: code, ref: paymentId }` into the
  same engine path as every trigger.
- **Refunds are decided from the mint ledger, never the router's report** (the router runs on
  the streamer's machine). No token minted → automatic full refund. Token minted + router
  says failed → `failed_after_start` for manual review, no automatic refund.
- **Payment status is an explicit state machine; every change is one conditional UPDATE**
  (`transition(id, from[], to)`):
  `pending → paid → delivered | failed_after_start | refunding → refunded | refund_failed`.
  Concurrent paths (webhook, job end, offline drop, sweep, boot) can't both act; a refund
  claims `paid → refunding` atomically, with a Stripe idempotency key.
- **Paid hijacks that never start are refunded**: app offline 2 min → queued paid jobs dropped
  (`Engine.dropQueued`) and refunded; a 1-minute sweep refunds any not started within 15 min,
  but never one already dispatched (`recordDispatch` writes the jobId at dispatch). At boot,
  anything still `paid` belonged to a destroyed in-memory engine and is refunded.
- Settlement hangs off `createRuntime`'s `onJobEnded` hook, which fires **exactly once** for
  every accepted job (finished, failed, dropped, rejected in review, cancelled by dispose).
  Any new way for a job to end must still go through it.

### Request flow of one hijack

1. Viewer `POST /api/submissions` (prompt/preset + optional image) → gets a short **claim code**.
   Preset prompts are resolved **server-side from the id** (`core/src/submissions.ts`, called by
   both hosts' routes) so a client
   can't spoof preset text; custom free-text runs through `moderation.ts` against
   streamer-configurable guardrails.
2. Viewer pays with the code. Hosted: `POST /api/c/:channel/checkout` → Stripe Checkout (the
   submission is `hold()`-ed for the session's 30 min) → webhook → `TipEvent`. Demo rig: a tip
   with the code in the message, normalized by a trigger adapter (`triggers/streamlabs.ts`, or
   `triggers/fake.ts` in dev). Either way the engine sees `{source, amount, message, username}`.
3. `Engine.onTip` (`engine.ts`) computes duration, `CorrelationStore.match` (`correlation.ts`)
   pairs tip↔submission (priority: code in message → declared username → sole pending →
   default preset), and the job is queued FIFO (bounded by `queueDepth`, with a `cooldownSec`
   gap between jobs).
4. `Hub` (`hub.ts`) dispatches the `HijackJob` to the router over WS. The `Hub` is pure
   transport — it knows nothing about money logic; it moves messages and reports router presence.
5. `RouterMachine` (`web/src/router/stateMachine.ts`) runs the job:
   `IDLE → AUTHORIZING → CONNECTING → BUFFERING → LIVE(duration) → TEARDOWN → IDLE`.

### The router state machine — the crux (`web/src/router/stateMachine.ts`)

One job at a time. **Every exit path funnels through one idempotent `teardown()`** that always
hides the OBS source *before* dropping the Decart session, and runs on timer completion, error,
panic, watchdog, or page unload. Aborts before `LIVE` (mint fail, >10s connect, >8s no frames)
never unhide OBS. When touching this file, preserve idempotency and the "hide before disconnect"
ordering — those are the invariants that keep OBS from showing a dead source and Decart from
billing a zombie session.

## Conventions

- **ESM everywhere** (`"type": "module"`). Sidecar imports use explicit `.js` extensions on
  relative paths (e.g. `./config.js`) even though the sources are `.ts` — required by
  `NodeNext` resolution; keep it.
- The WS protocol is a discriminated union on `t`; keep both directions in the one union in
  `shared/src/protocol.ts` so the hub and clients stay exhaustively typed. Add new message
  types there, not ad hoc.
- Any new trigger platform is an adapter that emits the normalized `TipEvent` shape — do not
  special-case a platform in the engine.
- Streamer-tunable behavior lives in `Settings` (persisted to gitignored `sidecar/settings.json`,
  merged over `DEFAULT_SETTINGS`); add new knobs there rather than hardcoding.
- Logging: `log()` / `warn()` / `err()`, tagged by module. Inside `core/` use `core/src/log.ts`
  (hosts swap the sink via `setLogger`); `sidecar/` code uses `sidecar/src/log.ts`.

## Git / workflow notes

- This is the **"Reaper"** repo on GitHub account `hshwang34`. Commit substantial changes with
  rich, reasoning-rich messages and well-commented code (portfolio visibility).
- Default branch is `main` and there is **no `staging` branch** — worktrees branch from
  `origin/HEAD` → `main` (an intentional exception to the global branch-off-staging rule).
- Never commit `.env` or `sidecar/settings.json` (both gitignored).
