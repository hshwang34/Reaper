# The commercial build — status & operator guide

The "one download → sign in → live in ~5 minutes" product from
`COMMERCIALIZATION.md` is **built end-to-end**. This doc is the map: what each
piece is, how to run it, and the external-account steps that are the only thing
between here and a public alpha.

## What exists

| Piece | Package | State |
|---|---|---|
| Portable money path (engine, queue, matching, minting, hub) | `core/` | done — runs in all 3 hosts |
| Single-machine demo rig | `sidecar/` | done (the portfolio artifact) |
| Downloadable streamer app (Electron) | `app/` | done — local + cloud modes |
| Hosted control plane (accounts, per-channel engines, ledger, portal) | `server/` | done |
| Onboarding wizard + hosted dashboard | `web/` `/setup` `/dashboard` | done |
| Packaging (dmg/zip), auto-update, Fly deploy, CI | `app/`, `server/`, `.github/` | done (unsigned verified) |

Two modes, one app:
- **Local mode** — pasted keys, everything on the machine. The offline demo.
- **Cloud mode** — signed in with Twitch; the control plane holds the Decart
  key and runs the money logic. No API key ever touches the streamer's disk.
  Video still stays peer-to-peer local (webcam → Decart → OBS); the cloud
  carries only control messages.

## Run it locally (no external accounts)

```bash
# 1. Hosted control plane in DEV AUTH mode (fake Twitch accounts)
RH_JWT_SECRET=$(openssl rand -hex 32) npm run dev:server      # :8790

# 2. The app, cloud-linked to it
RH_CLOUD_URL=http://127.0.0.1:8790 RH_CLOUD_LOGIN=me npm run dev:app
```

The app dev-signs-in as channel `me`, links, and auto-provisions the OBS
source. The hosted viewer portal is `http://127.0.0.1:8790/c/me`; the streamer
dashboard is `/dashboard`. Fire a test hijack from the wizard's step 5.

For the pure single-machine demo (no control plane), `npm run start` or
`npm run dev` as before — unchanged.

## The verification that was run

- Control-plane E2E (`20/20`): auth isolation, cross-channel rejection, WS
  front-door role rules (portal public, router JWT, viewer refused), job-gated
  + over-duration mint rejection, moderation, ledger, refresh rotation,
  local-plane drop.
- Live app round trip: cloud-side tip → `CloudLink` downlink → local hub →
  router LIVE + done uplink → cloud ledger records `completed`.
- Packaged unsigned `.app` boots from its bundle and serves `/router`,
  `/setup`, and `web-dist` from `process.resourcesPath`.
- Every security-review finding fixed (see the milestone commits).

## What's left — external accounts only

These need a person with the right logins; none are code:

1. **Apple Developer Program** ($99/yr). Enroll → export a Developer ID
   Application cert → set the CI secrets in `.github/workflows/release.yml`
   (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
   `APPLE_TEAM_ID`). Tag `v*` → a signed, notarized DMG on GitHub Releases.
2. **Twitch OAuth app** (dev.twitch.tv/console). Set `TWITCH_CLIENT_ID` /
   `TWITCH_CLIENT_SECRET` on the server → real "Sign in with Twitch" replaces
   DEV AUTH. Redirect URL: `<RH_PUBLIC_URL>/auth/twitch/callback`.
3. **Streamlabs OAuth app** — replaces the pasted-token connect once approved
   (approval has a lead time; the pasted token works meanwhile).
4. **Deploy the control plane**: `cd server && fly launch` (uses `fly.toml`),
   then `fly secrets set DECART_API_KEY=… TWITCH_CLIENT_ID=… … RH_PUBLIC_URL=…`.
5. **Human-at-rig**: run `docs/VERIFICATION.md` against the packaged app, and
   the one-time Decart `allowedOrigins` spike (needs a live in-app hijack).

## Business-model hooks still to build (post-alpha, per COMMERCIALIZATION §3)

Stripe checkout on the viewer page (our own rail), the Twitch Bits Extension
tier, and the LLM moderation upgrade are Phase 2/3 — deliberately out of this
build, which targets the hand-recruited alpha cohort keeping 100% of their
Streamlabs tips while we eat metered GPU under the per-channel monthly cap.
