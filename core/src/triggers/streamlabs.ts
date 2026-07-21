// Streamlabs Socket API adapter. Streamlabs runs a socket.io v2 SERVER, so the
// client MUST be socket.io-client v2 (pinned in package.json). The dashboard
// "Test Donation" button and real donations both arrive as `donation` events.
//
// VERIFY IN PHASE 0 (S3): confirm the exact payload shape against a live token.
// Observed/documented shape: { type: "donation", message: [ { name, amount,
// message, formatted_amount, currency, isTest? }, ... ] }. amount is a string.

// The shim ships with this file (triple-slash, not tsconfig include) so every
// host that compiles @rh/core from source — sidecar, server, app — gets it
// without repeating the ambient declaration in its own tsconfig.
/// <reference path="../types/socket.io-client.d.ts" />
import ioClient from "socket.io-client";
import type { TipEvent } from "@rh/shared";
import type { TriggerAdapter } from "./types.js";
import { log, warn, err } from "../log.js";

// socket.io-client v2's CJS default export is the io() function.
const io = (ioClient as unknown as { default?: typeof ioClient }).default ??
  ioClient;

export function createStreamlabsAdapter(token: string): TriggerAdapter {
  let socket: ReturnType<typeof io> | null = null;

  return {
    name: "streamlabs",
    start(emit) {
      socket = io(`https://sockets.streamlabs.com?token=${token}`, {
        transports: ["websocket"],
        reconnection: true,
      });

      socket.on("connect", () => log("streamlabs", "socket connected"));
      socket.on("disconnect", () => warn("streamlabs", "socket disconnected"));
      socket.on("error", (e: unknown) => err("streamlabs", "socket error", e));

      socket.on("event", (payload: any) => {
        if (!payload || payload.type !== "donation") return;
        const items: any[] = Array.isArray(payload.message)
          ? payload.message
          : [];
        for (const d of items) {
          const amount = parseFloat(d.amount);
          if (!Number.isFinite(amount)) continue;
          const e: TipEvent = {
            source: "streamlabs",
            amount,
            message: typeof d.message === "string" ? d.message : "",
            username: typeof d.name === "string" ? d.name : "anonymous",
            isTest: Boolean(d.isTest),
          };
          emit(e);
        }
      });
    },
    stop() {
      socket?.close();
      socket = null;
    },
  };
}
