# Distribution — shipping the desktop app

What a streamer downloads, how it's built, and the one-time account steps that
turn an unsigned test build into something a stranger will actually install.

## What ships

| Platform | File | Size | Installs to |
|---|---|---|---|
| macOS 13+ (Apple silicon and Intel, one universal build) | `Stream-Hijack-mac.dmg` | ~220 MB | drag to /Applications |
| Windows 10/11, x64 | `Stream-Hijack-Setup.exe` | ~100 MB | one click, per user (`%LOCALAPPDATA%\Programs`), no admin prompt |

File names carry no version, so these links are permanent and always point
at the newest release:

- `https://github.com/hshwang34/Reaper/releases/latest/download/Stream-Hijack-mac.dmg`
- `https://github.com/hshwang34/Reaper/releases/latest/download/Stream-Hijack-Setup.exe`

The Mac build is **universal** on purpose. Most people don't know which chip
their Mac has, and a download page can't detect it either (Safari reports
Apple silicon as Intel), so one file that runs natively on both is the only
option with no wrong choice. It costs ~100 MB over a single-chip DMG.

The `.zip` (macOS) and `latest*.yml` files beside them are for electron-updater,
not for people. Settings live in the OS's per-user app-data folder named
"Stream Hijack" (`~/Library/Application Support/`, `%APPDATA%\`).

Most of the size is Electron's bundled Chromium (~90 MB per chip) — the router
page needs a known-good `getUserMedia`/WebRTC stack. The rest is sharp's
native image binaries (content safety) and the Decart SDK with its LiveKit
deps, staged by `app/scripts/stage-resources.mjs`.

## Building

```bash
npm run package --workspace app   # unsigned .app / win-unpacked dir, this OS+arch
npm run dist --workspace app      # installers for this OS
```

Cross-packaging from a Mac works for testing (the Windows installer uses a
bundled Wine for icon/metadata stamping):

```bash
cd app
RH_ARCHS=arm64,x64 npm run prepackage && npx electron-builder --mac --universal --publish never
RH_PLATFORM=win32 RH_ARCHS=x64 node scripts/stage-resources.mjs && npx electron-builder --win --publish never
```

The universal build packages arm64 and x64 apps and merges them; it needs
both chips' sharp binaries staged (`RH_ARCHS=arm64,x64`), which is also what
lets the merge go through without special-casing (`mac.x64ArchFiles`).

`RH_ARCHS`/`RH_PLATFORM` tell the staging step which sharp binaries to ship —
npm only installs the build machine's own, so the rest are fetched with
`npm pack`. Getting this wrong doesn't fail the build; it fails the first
image upload on a streamer's machine. Release builds go through CI instead,
which builds Windows on Windows.

## The hosted control plane

The app is hosted-first: it is useful to a streamer only once `server/` is
deployed and its public URL is set as the `RH_CLOUD_URL` repository variable
(Settings → Secrets and variables → Actions → Variables). Every build after
that signs in against it; builds before it carry no sign-in.

The server code is complete (`server/`, with `Dockerfile` and `fly.toml`).
Deploying it is account work, in this order:

1. **Fly.io account** (personal), `brew install flyctl`, `fly auth login`.
   One shared-cpu machine + a 1 GB volume is ~$5–10/month.
2. **Twitch developer application** at dev.twitch.tv/console → Register Your
   Application. Category "Application Integration", OAuth redirect URL
   `https://reality-hijack.fly.dev/auth/twitch/callback` (adjust if the app
   name changes). Note the Client ID and generate a Client Secret.
3. From the **repo root** (`fly.toml` + `Dockerfile` live there; the image
   needs `shared/`, `core/`, `web/` and `server/`). **Already done for
   `reality-hijack` (2026-10-20)** — this is the from-scratch recipe:
   ```bash
   fly apps create reality-hijack --org personal
   fly volumes create rh_data --size 3 --region iad --app reality-hijack
   fly secrets set --app reality-hijack \
     DECART_API_KEY=… TWITCH_CLIENT_ID=… TWITCH_CLIENT_SECRET=… \
     STRIPE_SECRET_KEY=sk_… STRIPE_WEBHOOK_SECRET=whsec_… \
     RH_JWT_SECRET="$(openssl rand -hex 32)" \
     RH_PUBLIC_URL=https://reality-hijack.fly.dev
   fly deploy --remote-only
   curl https://reality-hijack.fly.dev/healthz   # {"mode":"production",…}
   ```
   The image runs `RH_ENV=production`: it refuses to boot if any of those
   secrets is missing. The Stripe webhook is a **Connect** endpoint
   (`/stripe/webhook`, events: checkout.session.completed,
   checkout.session.async_payment_succeeded, account.updated).
   Content-safety classifier keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
   `SIGHTENGINE_API_USER`, `SIGHTENGINE_API_SECRET`) go in the same way;
   without them hosted custom prompts and photos stay off (presets work).
4. Set the GitHub repository variable `RH_CLOUD_URL=https://reality-hijack.fly.dev`
   and cut a build. That build's wizard signs in for real.
5. Sign in from the packaged app on the rig; a test hijack from the wizard
   then runs through the cloud engine end to end.

The server refuses to look like production without a Twitch app: with no
`TWITCH_CLIENT_ID` it boots in DEV AUTH (fake accounts) and says so loudly.

## Releasing

1. Bump `app/package.json` `version`, commit, then tag `v<version>` and push the
   tag. (CI refuses a tag that doesn't match the version.)
2. `.github/workflows/release.yml` builds macOS (on an Apple-silicon runner)
   and Windows (on a Windows runner), runs `npm run check` on both, and uploads
   everything into one **draft** GitHub Release.
3. Publish the draft. That's the moment installed apps see the update.

**Run workflow** in the Actions tab builds the same installers without
publishing and attaches them to the run. That's the way to get a Windows build
to try before any release.

Auto-update needs the repo (or at least its releases) to be public, since the
app has no GitHub token. On macOS it also needs a **signed** build:
Squirrel.Mac refuses unsigned updates.

## Signing: the account steps (manual, paid)

Unsigned builds work, but both OSes put a scary wall in front of a first-time
user. A streamer who has never heard of us is unlikely to click past it, so
signing is a launch requirement, not polish.

### macOS: Apple Developer Program ($99/yr)

Without it: *"Apple could not verify 'Stream Hijack' is free of malware"*.
Since macOS 15 the user can't even right-click → Open. They have to go to
System Settings → Privacy & Security → Open Anyway.

1. Enroll at developer.apple.com with a personal Apple ID (individual
   enrollment; approval takes ~1–2 days).
2. Create a **Developer ID Application** certificate and export it as `.p12`.
3. Create an app-specific password for the Apple ID (appleid.apple.com).
4. Repo secrets: `CSC_LINK` (base64 of the .p12), `CSC_KEY_PASSWORD`,
   `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.

The next tagged build is then signed **and notarized** (`mac.notarize: true`
in `electron-builder.yml`; it skips with a warning while the `APPLE_*`
secrets are absent), using the hardened runtime and
`app/build/entitlements.mac.plist`. To confirm on a Mac:

```bash
spctl --assess --type execute -v "/Applications/Stream Hijack.app"   # → accepted, source=Notarized Developer ID
```

### Windows: a code-signing certificate

Without it, SmartScreen shows: *"Windows protected your PC — Unknown
publisher"*. The user has to click More info → Run anyway. Options:

| Option | Cost | Notes |
|---|---|---|
| **Azure Trusted Signing** (recommended) | ~$10/mo | Microsoft's managed signing. Individuals are eligible (identity validation). No hardware token. Builds SmartScreen reputation like an EV cert. Needs `win.azureSignOptions` in `electron-builder.yml` plus Azure credentials as secrets, instead of the .pfx below. |
| OV certificate (Sectigo, SSL.com, …) | ~$200–400/yr | Since 2023 issued on a hardware token / cloud HSM, so it doesn't drop into CI as a plain .pfx. Check the vendor's CI story before buying. |

The workflow is wired for the plain-certificate path (`WIN_CSC_LINK`,
`WIN_CSC_KEY_PASSWORD`). Choosing Trusted Signing means a small config change
when the account exists.

## What the streamer sees

1. Download and open the DMG/installer. macOS asks for **camera** access on
   first launch; on Windows, camera access follows the OS privacy setting.
2. **First launch opens the setup wizard** (`/setup`), and keeps doing so
   until it has been finished once (`app-state.json` → `setupDone`). The
   wizard's steps:
   - account: **Sign in with Twitch**. The hosted control plane holds the
     Decart key, minting and moderation; the streamer configures nothing.
     Its URL is baked in at build time from `RH_CLOUD_URL` (CI reads the
     repo *variable* of that name). A build with no URL — every build until
     `server/` is deployed — says "hosted sign-in isn't available in this
     build yet" and continues in passthrough demo mode. Pasted-keys local
     mode exists only as a developer fallback: repo runs, or
     `RH_LOCAL_MODE=1` on a packaged build.
   - camera
   - OBS: the app finds OBS's websocket settings itself. If the server is
     off, **"Enable it for me and start OBS"** flips it in OBS's config
     (only while OBS is closed, since OBS rewrites that file on quit) and
     launches OBS. Then one click creates the hidden **AI Hijack** source.
   - tips
   - the safety acknowledgement
   - a test hijack
   - done → the app relaunches into the router with everything loaded
3. The app then lives in the menu bar (macOS) or notification area (Windows).
   Panic is ⌘⇧H or Ctrl+Shift+H. "Run setup again…" is in the tray menu.

On a first run the app never touches OBS before the wizard's OBS step; on
every later launch it re-checks the overlay source at boot.

### Testing a first run honestly

Create a second macOS user account (System Settings → Users & Groups) and
install there: it has an empty app-data folder and no camera permission
granted, so it behaves exactly like a new streamer's Mac. Deleting
`~/Library/Application Support/Stream Hijack/` on a dev account is the
cheaper approximation (it keeps the camera permission). `RH_SKIP_SETUP=1`
skips the wizard for dev runs.
