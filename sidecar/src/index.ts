// Sidecar CLI entrypoint — the single-machine demo rig. All the actual
// composition lives in server.ts (shared verbatim with the Electron app's
// local bridge); this file only resolves the host environment: .env secrets,
// settings.json persistence, repo-relative uploads dir and web/dist.

import { resolve } from "node:path";
import { createLocalServer } from "./server.js";
import {
  env,
  getSettings,
  rootDir,
  updateSettings,
  uploadsDir,
} from "./config.js";

const local = createLocalServer({
  decartApiKey: env.decartApiKey,
  streamlabsToken: env.streamlabsToken,
  obsWsUrl: env.obsWsUrl,
  obsWsPassword: env.obsWsPassword,
  getSettings,
  updateSettings,
  uploadsDir,
  webDist: resolve(rootDir, "web", "dist"),
});

local.start(env.port);
