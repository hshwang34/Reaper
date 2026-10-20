// Preloaded (--import) before every server test file: db.ts opens SQLite at
// import time, so the scratch database path and a fixed JWT secret must be in
// place first. Set here rather than as `VAR=x node …` in package.json so the
// script also runs under Windows' cmd.exe.

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One file per test process: node --test runs files in parallel, and two
// processes migrating the same fresh database race (seen as a flaky failure).
const dbPath = join(tmpdir(), `rh-server-test-${process.pid}.sqlite`);
process.env.RH_DATABASE_PATH = dbPath;
// Best effort: Windows refuses to delete a file SQLite still holds open
// (EBUSY), and the OS temp dir gets cleaned eventually anyway.
process.on("exit", () => {
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      rmSync(f, { force: true });
    } catch {}
  }
});
process.env.RH_JWT_SECRET = "test-secret";
