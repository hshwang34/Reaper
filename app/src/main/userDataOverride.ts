// Imported FIRST by main.ts: config.ts and cloudLink.ts resolve their file
// paths from app.getPath("userData") at module load, so the override has to
// land before any of them evaluate.
//
// RH_USER_DATA gives the app a throwaway profile — the hosted e2e
// (scripts/e2e-hosted.mjs) runs the real app next to a streamer's installed
// copy without touching its sign-in, keys or setup state. The single-instance
// lock is per profile too, so the two don't collide.
//
// Rename migration: userData follows productName, so the Reality Hijack →
// Stream Hijack rename moved it (~/Library/Application Support/Reality
// Hijack → …/Stream Hijack). Without this, an upgrade would sign the
// streamer out, re-run setup, and mint a new install token (= a new OBS
// overlay URL). On the first launch under the new name, copy the old
// profile across once. keys.json stays behind: it's encrypted with the OS
// keychain under the OLD app name and can't be read by the new one (in
// cloud mode it only held OBS details, which are re-discovered anyway).
import { app } from "electron";
import { cpSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const LEGACY_NAMES = ["Reality Hijack"];

const dir = process.env.RH_USER_DATA?.trim();
if (dir) {
  app.setPath("userData", dir);
} else {
  const now = app.getPath("userData");
  const old = LEGACY_NAMES.map((n) => join(dirname(now), n)).find((p) => p !== now && existsSync(p));
  if (old && !existsSync(now)) {
    try {
      cpSync(old, now, {
        recursive: true,
        // Chromium's own caches and locks are rebuilt; our files are what matter.
        filter: (src) => !/(Singleton|Cache|GPUCache|Code Cache|DawnCache|keys\.json$)/.test(basename(src)),
      });
      console.log(`[app] migrated profile from ${old}`);
    } catch (e) {
      console.warn(`[app] profile migration from ${old} failed: ${(e as Error).message}`);
    }
  }
}
