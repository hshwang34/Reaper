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

The **demo rig** runs on one machine with no cloud (the "server" is a local sidecar). The
**commercial path** adds a downloadable Electron app + a hosted control plane; both reuse the
same `core/` money path.

```bash
npm install
cp .env.example .env      # leave keys blank → MOCK mode (camera passthrough, no cost)
npm run dev               # demo rig: concurrently sidecar :7712 + web :5173
npm run typecheck         # tsc --noEmit across all SIX workspaces — the only test gate
npm run build             # builds the web app only
npm run start             # production demo rig: build, then ONE process on :7712

npm run dev:app           # build web, then launch the Electron app (local mode)
npm run dev:server        # the hosted control plane on :8790 (DEV AUTH if no Twitch app)
```

Cloud-mode dev loop: run `dev:server`, then launch the app with
`RH_CLOUD_URL=http://127.0.0.1:8790 RH_CLOUD_LOGIN=<name>` — it dev-signs-in and links.
Package the app: `npm run package --workspace app` (unsigned `--dir`) or `dist` (dmg;
signing/notarization gated on Apple secrets, see `.github/workflows/release.yml`).

Per-workspace dev: `npm run dev:sidecar`, `npm run dev:web`. There is **no test runner and no
linter** — `npm run typecheck` is the check to run after edits.

### Demoing the loop without credentials
1. Open `http://localhost:5173/router`, click **Arm camera** (needs a real Chrome tab).
2. Open `http://localhost:5173/portal`, pick an effect or write a prompt, get a claim code.
3. Click **Send $N test tip** (or `POST /api/dev/fake-tip`) — the router runs the job for N seconds.

`docs/PHASE0.md` covers the real-credential + OBS hardware path.

## Architecture

npm-workspaces monorepo. Six packages. The `core/` money path runs unchanged in three
hosts — the sidecar demo rig, the Electron app's local bridge, and the hosted control
plane's per-channel runtimes — which is the whole point of the extraction.

- **`shared/`** (`@rh/shared`) — the single source of truth: domain `types.ts`, the WS
  `protocol.ts` (discriminated union on `t`; `HelloMsg` carries `auth`/`channel`), and the
  `presets.ts` catalog. Everything imports it; the web consumes it *as source* via a Vite alias.
- **`core/`** (`@rh/core`) — the portable money path: `engine.ts` (tip→job→queue),
  `correlation.ts` (tip↔submission matching), `moderation.ts`, `hub.ts` (WS relay, with a
  local mode that owns a `WebSocketServer` and an adopted mode the hosted front door drives),
  `decart.ts` (ek_ minting), and the trigger adapters. Host-agnostic by construction: `Engine`
  takes an injected `getSettings`, the log sink is swappable (`setLogger`).
- **`sidecar/`** (`@rh/sidecar`, tsx) — the demo-rig composition root. `server.ts` is a
  `createLocalServer(host)` factory (routes + hub + minting + OBS + static serving) that both
  the CLI (`index.ts`, config from `.env`) and the Electron app embed. `obs.ts` also does
  `ensureBrowserSource()` auto-provisioning. In production mode (`npm run start`) it serves the
  built web app — one process, one port.
- **`app/`** (`@rh/app`, Electron) — the "single download" for streamers. Main process embeds
  the sidecar composition as a local bridge (127.0.0.1:17712), auto-provisions the OBS Browser
  Source, holds a per-install auth token, tray + ⌘⇧H panic, and — when signed in — a
  `cloudLink.ts` to the control plane (**cloud mode**: no Decart key on the machine; the local
  bridge keeps only OBS control + signaling + page serving). Renderer runs the existing
  `/router` page in bundled Chromium. `local mode` (pasted keys) is the permanent offline demo.
- **`server/`** (`@rh/server`, tsx) — the hosted control plane. Twitch OAuth → our JWTs,
  per-channel in-memory `ChannelRuntime` (one `@rh/core` engine each), server-side job-gated +
  budget-capped minting, the hijack ledger (SQLite/Drizzle), and the hosted portal at
  `/c/:channel`. One WS front door routes sockets to per-channel adopted hubs.
- **`web/`** (`@rh/web`, Vite + React 19 + Tailwind 4) — routes: `/portal` (viewer; also served
  hosted at `/c/:channel`), `/router` (streamer capture + state machine), `/viewer` (OBS
  Browser Source display), `/setup` (desktop onboarding wizard), `/dashboard` (hosted streamer
  dashboard). `lib/auth.ts` + `lib/channel.ts` make the same pages work local and hosted.

Browser pages talk to whichever host serves them, same-origin (Vite proxy in dev). Secrets
never reach a page. The **local plane** (rtc signaling + `viewer:frames-ok`) never leaves the
streamer's machine — the cloud front door rejects it (`rejectLocalPlane`).

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
