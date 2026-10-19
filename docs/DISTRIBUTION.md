# Distribution — shipping the desktop app

What a streamer downloads, how it's built, and the one-time account steps that
turn an unsigned test build into something a stranger will actually install.

## What ships

| Platform | File | Size | Installs to |
|---|---|---|---|
| macOS, Apple silicon | `Reality-Hijack-<v>-arm64.dmg` | ~145 MB | drag to /Applications |
| macOS, Intel | `Reality-Hijack-<v>-x64.dmg` | ~150 MB | drag to /Applications |
| Windows 10/11, x64 | `Reality-Hijack-Setup-<v>.exe` | ~100 MB | one click, per user (`%LOCALAPPDATA%\Programs`), no admin prompt |

The `.zip` (macOS) and `latest*.yml` files beside them are for electron-updater,
not for people. Settings live in the OS's per-user app-data folder named
"Reality Hijack" (`~/Library/Application Support/`, `%APPDATA%\`).

Most of the size is Electron's bundled Chromium (~90 MB) — the router page
needs a known-good `getUserMedia`/WebRTC stack. The rest is sharp's native
image binaries (content safety) and the Decart SDK with its LiveKit deps,
staged by `app/scripts/stage-resources.mjs`.

## Building

```bash
npm run package --workspace app   # unsigned .app / win-unpacked dir, this OS+arch
npm run dist --workspace app      # installers for this OS
```

Cross-packaging from a Mac works for testing (the Windows installer uses a
bundled Wine for icon/metadata stamping):

```bash
cd app
RH_ARCHS=arm64,x64 npm run prepackage && npx electron-builder --mac --publish never
RH_PLATFORM=win32 RH_ARCHS=x64 node scripts/stage-resources.mjs && npx electron-builder --win --publish never
```

`RH_ARCHS`/`RH_PLATFORM` tell the staging step which sharp binaries to ship —
npm only installs the build machine's own, so the rest are fetched with
`npm pack`. Getting this wrong doesn't fail the build; it fails the first
image upload on a streamer's machine. Release builds go through CI instead,
which builds Windows on Windows.

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

Without it: *"Apple could not verify 'Reality Hijack' is free of malware"*.
Since macOS 15 the user can't even right-click → Open. They have to go to
System Settings → Privacy & Security → Open Anyway.

1. Enroll at developer.apple.com with a personal Apple ID (individual
   enrollment; approval takes ~1–2 days).
2. Create a **Developer ID Application** certificate and export it as `.p12`.
3. Create an app-specific password for the Apple ID (appleid.apple.com).
4. Repo secrets: `CSC_LINK` (base64 of the .p12), `CSC_KEY_PASSWORD`,
   `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.

The next tagged build is then signed **and notarized**. Notarization is
automatic when the `APPLE_*` secrets exist, using the hardened runtime and
`app/build/entitlements.mac.plist`.

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
2. The setup wizard (`/setup`) covers these steps:
   - Twitch sign-in
   - camera
   - OBS: the app finds OBS's websocket settings itself and creates the
     hidden **AI Hijack** source in one click
   - tips
   - the safety acknowledgement
   - a test hijack
3. The app then lives in the menu bar (macOS) or notification area (Windows).
   Panic is ⌘⇧H or Ctrl+Shift+H.

OBS's WebSocket server is off by default in fresh installs. The wizard detects
that and says where to switch it on (Tools → WebSocket Server Settings). It's
the one manual step left.
