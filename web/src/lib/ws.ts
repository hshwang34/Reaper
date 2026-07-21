// Typed hub WebSocket client with auto-reconnect + role registration.

import type { ClientMsg, Role, ServerMsg } from "@rh/shared";
import { authToken } from "./auth.js";

export class HubSocket {
  private ws: WebSocket | null = null;
  private listeners = new Set<(m: ServerMsg) => void>();
  private outbox: ClientMsg[] = [];
  private closed = false;

  constructor(
    private role: Role,
    private code?: string,
  ) {}

  connect(): this {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      this.raw({
        t: "hello",
        role: this.role,
        code: this.code,
        auth: authToken(),
      });
      const pending = this.outbox;
      this.outbox = [];
      pending.forEach((m) => this.raw(m));
    };
    ws.onmessage = (e) => {
      let m: ServerMsg;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      this.listeners.forEach((l) => l(m));
    };
    ws.onclose = () => {
      if (!this.closed) setTimeout(() => this.connect(), 1000);
    };
    ws.onerror = () => ws.close();
    return this;
  }

  on(l: (m: ServerMsg) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  send(m: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.raw(m);
    else this.outbox.push(m);
  }

  private raw(m: ClientMsg): void {
    this.ws?.send(JSON.stringify(m));
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
