// Imported FIRST by main.ts: config.ts and cloudLink.ts resolve their file
// paths from app.getPath("userData") at module load, so the override has to
// land before any of them evaluate.
//
// RH_USER_DATA gives the app a throwaway profile — the hosted e2e
// (scripts/e2e-hosted.mjs) runs the real app next to a streamer's installed
// copy without touching its sign-in, keys or setup state. The single-instance
// lock is per profile too, so the two don't collide.
import { app } from "electron";

const dir = process.env.RH_USER_DATA?.trim();
if (dir) app.setPath("userData", dir);
