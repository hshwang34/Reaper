// Loopback guard for the local server (demo rig + Electron bridge).
//
// Binding to 127.0.0.1 keeps the LAN out, but not the streamer's own browser:
//   · CSRF — any website can fire a "simple" cross-origin POST (text/plain,
//     no preflight) at http://127.0.0.1:7712. No CORS header means it can't
//     READ the answer, but the side effect still happens: e.g. POST
//     /api/obs/toggle with an unparsed body → `visible` = false → the overlay
//     is hidden mid-stream. The CLI rig has no install token, so nothing else
//     stops it.
//   · DNS rebinding — evil.example re-resolves to 127.0.0.1, making its page
//     "same-origin" with us and able to read responses too. Its requests
//     still carry `Host: evil.example`.
//   · WebSockets aren't CORS-gated at all: any page could open /ws and hello
//     as router (receive jobs) or viewer (fake frames-ok) on the ungated rig.
//
// So: the Host must be a loopback name, and a browser-supplied Origin (sent
// on every cross-origin request and every WS handshake) must be too.
// Requests without an Origin — curl, OBS, same-origin GETs — pass.

import type { IncomingMessage } from "node:http";
import type { RequestHandler } from "express";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function hostnameOf(hostHeader: string): string {
  // "localhost:5173" → "localhost"; "[::1]:7712" → "[::1]"
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(hostHeader.trim().toLowerCase());
  return m ? m[1] : "";
}

export function isLoopbackHost(hostHeader: string | undefined): boolean {
  return Boolean(hostHeader) && LOOPBACK_HOSTNAMES.has(hostnameOf(hostHeader!));
}

export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true; // non-browser client
  try {
    const u = new URL(origin);
    return (u.protocol === "http:" || u.protocol === "https:") && LOOPBACK_HOSTNAMES.has(u.hostname);
  } catch {
    return false; // "null" (sandboxed iframe, file://) and garbage
  }
}

/** True when a request (HTTP or WS upgrade) plausibly comes from a page this
 *  machine served, not a foreign website. */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  return isLoopbackHost(req.headers.host) && isLoopbackOrigin(req.headers.origin);
}

export const loopbackGuard: RequestHandler = (req, res, next) => {
  if (isLoopbackRequest(req)) return next();
  res.status(403).json({ error: "cross-origin request refused" });
};
