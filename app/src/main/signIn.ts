// "Sign in with Twitch" from the desktop app — the loopback OAuth pattern:
// open the system browser (never an embedded webview — users shouldn't type
// Twitch credentials into an app-controlled surface) at the control plane's
// /auth/app, which runs the full OAuth dance and redirects the finished
// session to a one-shot listener on 127.0.0.1:17716.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { shell } from "electron";
import { log, warn } from "@rh/core";
import { saveCloudConfig, type CloudConfig } from "./cloudLink.js";

const LOOPBACK_PORT = 17716;
const TIMEOUT_MS = 5 * 60 * 1000;

export function signInWithBrowser(cloudUrl: string): Promise<CloudConfig | null> {
  return new Promise((resolve) => {
    let settled = false;
    // Bind this sign-in to a nonce the app generates and round-trips through
    // the OAuth flow. The callback only accepts a response carrying it back —
    // otherwise any local process could POST forged tokens to the loopback
    // listener and fixate the app onto an attacker's channel (session
    // fixation — security-review finding).
    const expectedState = randomBytes(32).toString("hex");
    const finish = (cfg: CloudConfig | null) => {
      if (settled) return;
      settled = true;
      server.close();
      clearTimeout(timer);
      resolve(cfg);
    };

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${LOOPBACK_PORT}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      if (url.searchParams.get("state") !== expectedState) {
        warn("sign-in", "callback state mismatch — rejected");
        res.writeHead(400).end("state mismatch");
        return; // do NOT finish() — ignore forged callbacks, keep waiting
      }
      const refresh = url.searchParams.get("refresh") ?? "";
      const channelId = url.searchParams.get("channel") ?? "";
      const login = url.searchParams.get("login") ?? "";
      res.writeHead(200, { "content-type": "text/html" }).end(
        `<body style="font-family:system-ui;background:#0a0a0a;color:#e4e4e7;display:grid;place-items:center;height:100vh">
           <div style="text-align:center">
             <h2>${refresh ? "Signed in ✅" : "Sign-in failed"}</h2>
             <p>You can close this tab and return to Reality Hijack.</p>
           </div></body>`,
      );
      if (!refresh || !channelId) {
        warn("sign-in", "callback missing tokens");
        finish(null);
        return;
      }
      const cfg: CloudConfig = { url: cloudUrl, channelId, login, refresh };
      saveCloudConfig(cfg);
      log("sign-in", `signed in as ${login}`);
      finish(cfg);
    });

    server.on("error", (e) => {
      warn("sign-in", `loopback listener failed: ${(e as Error).message}`);
      finish(null);
    });

    const timer = setTimeout(() => {
      warn("sign-in", "timed out waiting for the browser");
      finish(null);
    }, TIMEOUT_MS);

    server.listen(LOOPBACK_PORT, "127.0.0.1", () => {
      const u = new URL(`${cloudUrl}/auth/app`);
      u.searchParams.set("app_state", expectedState);
      void shell.openExternal(u.toString());
    });
  });
}
