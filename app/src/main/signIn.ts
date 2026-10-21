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

/** Ends the sign-in in flight (the wizard's Cancel), freeing the loopback port. */
let cancelActive: (() => void) | null = null;
export function cancelSignIn(): void {
  cancelActive?.();
}

/** The page the browser lands on. Brand colours (BRAND §6), not the old #0a0a0a;
 *  the ✅ is gone so nothing here depends on the charset header. */
function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Stream Hijack</title>
         <body style="font-family:system-ui;background:#121112;color:#f5f2ec;display:grid;place-items:center;height:100vh;margin:0">
           <div style="text-align:center;max-width:28rem;padding:1rem">
             <h2>${title}</h2>
             <p>${body}</p>
           </div></body>`;
}

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
      cancelActive = null;
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
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(
          page("This sign-in link is stale.", "Go back to the app and try again."),
        );
        return; // do NOT finish() — ignore forged callbacks, keep waiting
      }
      const refresh = url.searchParams.get("refresh") ?? "";
      const channelId = url.searchParams.get("channel") ?? "";
      const login = url.searchParams.get("login") ?? "";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
        refresh
          ? page("You're signed in.", "Close this tab and go back to Stream Hijack.")
          : page("Sign-in didn't work.", "Go back to the app and try again."),
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

    cancelActive = () => finish(null);
    server.listen(LOOPBACK_PORT, "127.0.0.1", () => {
      const u = new URL(`${cloudUrl}/auth/app`);
      u.searchParams.set("app_state", expectedState);
      void shell.openExternal(u.toString());
    });
  });
}
