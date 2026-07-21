# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Reality Hijack: viewers tip a live streamer, type a prompt (or pick a preset) + optional
reference image, and the streamer's webcam is restyled in real time by Decart's `lucy-2.5`
video model for a duration proportional to the tip (**$1 = 1s**), then reverts. It is both a
working MVP and a portfolio case study in AI product design under real constraints (per-second
GPU billing, monetization policy, live-video latency, content safety).

`FEASIBILITY.md` is the source of truth for *why* the design is shaped this way — read it
before changing the pipeline, cost caps, or trigger layer. Section references (§3, §8, etc.)
appear throughout the code comments.

## Commands

Everything runs on one machine. There is no cloud backend; the "server" is a local sidecar.

```bash
npm install
cp .env.example .env      # leave keys blank → MOCK mode (camera passthrough, no cost)
npm run dev               # concurrently: sidecar :7712 + web :5173
npm run typecheck         # typechecks shared, core, sidecar, web in order — the only test gate
npm run build             # builds the web app only
npm run start             # production mode: build, then ONE process on :7712 serving everything
```

Per-workspace: `npm run dev:sidecar`, `npm run dev:web`. There is **no test runner and no
linter** — `npm run typecheck` (tsc `--noEmit` across all four workspaces) is the check to run
after edits.

### Demoing the loop without credentials
1. Open `http://localhost:5173/router`, click **Arm camera** (needs a real Chrome tab).
2. Open `http://localhost:5173/portal`, pick an effect or write a prompt, get a claim code.
3. Click **Send $N test tip** (or `POST /api/dev/fake-tip`) — the router runs the job for N seconds.

`docs/PHASE0.md` covers the real-credential + OBS hardware path.

## Architecture

npm-workspaces monorepo. Four packages:

- **`shared/`** (`@rh/shared`) — the single source of truth: domain `types.ts`, the WS
  `protocol.ts` (discriminated union on `t`), and the `presets.ts` catalog. Everything
  imports it; the web consumes it *as source* via a Vite alias (see `web/vite.config.ts`).
- **`core/`** (`@rh/core`) — the portable money path: `engine.ts` (tip→job→queue),
  `correlation.ts` (tip↔submission matching), `moderation.ts`, `hub.ts` (WS relay), and the
  trigger adapters. Host-agnostic by construction: `Engine` takes an injected `getSettings`,
  the log sink is swappable (`setLogger`). One implementation, multiple hosts (sidecar today;
  the hosted control plane and Electron app per `docs/COMMERCIALIZATION.md`).
- **`sidecar/`** (`@rh/sidecar`, tsx) — the demo-rig composition root: Node/Express wiring
  `@rh/core` to local config, uploads, Decart token minting, and server-side OBS control.
  Holds all secrets. In production mode (`npm run start`) it also serves the built web app,
  so the whole product is one process on one port.
- **`web/`** (`@rh/web`, Vite + React 19 + Tailwind 4) — three routes, each a distinct role:
  - `/portal` — viewer UI (prompt, image, claim code, live status).
  - `/router` — the streamer's real Chrome tab: captures the camera, runs the per-job state
    machine, talks to Decart.
  - `/viewer` — a dumb display page loaded inside an **OBS Browser Source**; receives the AI
    stream over a local WebRTC loopback and reports verified frames.

The browser only ever talks to the sidecar, same-origin, through the Vite dev proxy
(`/api`, `/uploads`, `/ws` → `:7712`). Secrets never reach a page.

### The one hard-won constraint (don't "simplify" these)

- **Capture must be a real Chrome tab, not OBS's embedded CEF browser** — CEF blocks camera
  permission. The router page grabs the OBS **Virtual Camera** (set its output to *Source* to
  avoid a feedback loop) via `getUserMedia`.
- **The AI feed re-enters OBS via a local WebRTC loopback** into the display-only `/viewer`
  page, which lives in a Browser Source. The hub relays RTC signaling by role.
- **OBS is unhidden ONLY after `/viewer` reports N verified decoded frames**
  (`viewer:frames-ok`), never on a timer or `onloadeddata` — a WebRTC stream can fire those
  while still black. This is the "buffering gate."

### Cost safety — three independent caps (FEASIBILITY §3)

A hung Decart session bills per second, so overrun is bounded three ways: (1) the router's
countdown timer, (2) a local watchdog (`durationSec + 10s`), and (3) the Decart **client token
itself** — the sidecar mints a short-lived `ek_` token with `maxSessionDuration` so Decart's own
servers kill the session even if the streamer's machine freezes. Never extend an active session;
every job gets a clean init/teardown.

### Request flow of one hijack

1. Viewer `POST /api/submissions` (prompt/preset + optional image) → gets a short **claim code**.
   Preset prompts are resolved **server-side from the id** (`sidecar/src/index.ts`) so a client
   can't spoof preset text; custom free-text runs through `moderation.ts` against
   streamer-configurable guardrails.
2. Viewer tips with the code in the message. A trigger adapter (`triggers/streamlabs.ts`, or
   `triggers/fake.ts` in dev) normalizes it to a `TipEvent` `{source, amount, message, username}`.
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
- Logging: `log()` / `warn()` from `sidecar/src/log.ts`, tagged by module.

## Git / workflow notes

- This is the **"Reaper"** repo on GitHub account `hshwang34`. Commit substantial changes with
  rich, reasoning-rich messages and well-commented code (portfolio visibility).
- Default branch is `main` and there is **no `staging` branch** — worktrees branch from
  `origin/HEAD` → `main` (an intentional exception to the global branch-off-staging rule).
- Never commit `.env` or `sidecar/settings.json` (both gitignored).
