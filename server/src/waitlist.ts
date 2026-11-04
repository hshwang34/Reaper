// Streamer waitlist: the marketing site's "Join the alpha" form, and the
// approve → single-use Discord invite step behind it.
//
// Why the gate lives here and not in Discord: every Discord invite page shows
// "N online · M members", and no server setting hides it. Applicants never see
// a Discord link until we approve them — then they get ONE invite that works
// once and expires in a week, so a forwarded link can't let a crowd in.
//
// Why we don't send the email: streamhijack.com is a brand-new sending domain
// (docs/DOMAIN-AND-EMAIL.md §5 — hand-written, a few a day, no bulk tools).
// The admin CLI (scripts/waitlist.mjs) opens a pre-filled Gmail draft from
// hello@ instead; a human presses send.
//
// Routes (mounted by index.ts):
//   POST /api/waitlist                     — public, CORS for the site origins
//   GET  /api/admin/waitlist[?status=]     — Bearer RH_ADMIN_TOKEN
//   POST /api/admin/waitlist/:id/invite    — mint the invite, pending → invited
//   POST /api/admin/waitlist/:id/decline   — pending → declined

import { randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";
import { and, desc, eq } from "drizzle-orm";
import { ipHash, log, warn } from "@rh/core";
import { db, waitlist } from "./db.js";
import { env } from "./env.js";

export const VIEWER_BANDS = ["under-10", "10-50", "50-200", "200-plus"] as const;
export type ViewerBand = (typeof VIEWER_BANDS)[number];

export interface Signup {
  email: string;
  channel: string;
  viewers: ViewerBand;
  idea: string;
}

/** Single-use, 7-day invite (Discord's max_age is in seconds). */
export const INVITE_MAX_AGE_SEC = 7 * 24 * 3600;

// Deliberately loose: one @, a dot in the domain, no spaces. Real validation is
// the invite email arriving; a strict regex only rejects valid addresses.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const clean = (v: unknown, max: number) =>
  typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";

/** Validate the form body. Returns the normalized signup, or the one message
 *  the form shows next to the submit button. */
export function parseSignup(body: unknown): { ok: true; value: Signup } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const email = clean(b.email, 254).toLowerCase();
  const channel = clean(b.channel, 200);
  const viewers = clean(b.viewers, 20) as ViewerBand;
  const idea = clean(b.idea, 280);
  if (!EMAIL_RE.test(email)) return { ok: false, error: "Enter a valid email address." };
  if (channel.length < 3) return { ok: false, error: "Add your channel link or handle." };
  if (!VIEWER_BANDS.includes(viewers)) return { ok: false, error: "Pick your average viewers." };
  return { ok: true, value: { email, channel, viewers, idea } };
}

/** Insert a signup. A repeat email is a silent no-op so the form can't be
 *  used to test whether someone already applied. */
export function addSignup(s: Signup, ip: string | undefined): { created: boolean } {
  const res = db
    .insert(waitlist)
    .values({
      id: randomUUID(),
      ...s,
      status: "pending",
      ipHash: ipHash(ip),
      createdAt: Date.now(),
    })
    .onConflictDoNothing({ target: waitlist.email })
    .run();
  return { created: res.changes === 1 };
}

export function listSignups(status?: string) {
  const q = db.select().from(waitlist);
  return (status ? q.where(eq(waitlist.status, status)) : q).orderBy(desc(waitlist.createdAt)).all();
}

export class WaitlistError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Seam for tests: the one outbound call. */
type InviteMinter = () => Promise<string>;
let mintInviteImpl: InviteMinter = mintDiscordInvite;
export function setInviteMinterForTests(fn: InviteMinter | null): void {
  mintInviteImpl = fn ?? mintDiscordInvite;
}

async function mintDiscordInvite(): Promise<string> {
  if (!env.discordBotToken || !env.discordInviteChannelId) {
    throw new WaitlistError(503, "DISCORD_BOT_TOKEN / DISCORD_INVITE_CHANNEL_ID not configured");
  }
  const res = await fetch(`https://discord.com/api/v10/channels/${env.discordInviteChannelId}/invites`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${env.discordBotToken}`,
      "Content-Type": "application/json",
      "X-Audit-Log-Reason": "waitlist approval",
    },
    // unique: never hand back an existing invite — each approval is its own code.
    body: JSON.stringify({ max_uses: 1, max_age: INVITE_MAX_AGE_SEC, unique: true }),
  });
  if (!res.ok) throw new WaitlistError(502, `Discord refused the invite (${res.status}): ${await res.text()}`);
  const { code } = (await res.json()) as { code: string };
  return `https://discord.gg/${code}`;
}

/** Approve one signup: mint its invite, then pending → invited. Re-inviting
 *  an already-invited row returns the stored link instead of a second one. */
export async function inviteSignup(id: string) {
  const row = db.select().from(waitlist).where(eq(waitlist.id, id)).get();
  if (!row) throw new WaitlistError(404, "no such signup");
  if (row.status === "invited") return row;
  if (row.status !== "pending") throw new WaitlistError(409, `signup is ${row.status}`);
  const inviteUrl = await mintInviteImpl();
  // Conditional update: two concurrent approvals can't both win. The loser's
  // invite is unused and expires on its own in a week.
  const won =
    db
      .update(waitlist)
      .set({ status: "invited", inviteUrl, invitedAt: Date.now() })
      .where(and(eq(waitlist.id, id), eq(waitlist.status, "pending")))
      .run().changes === 1;
  if (!won) warn("waitlist", `invite race on ${id} — a parallel approval won`);
  log("waitlist", `invited ${id}`);
  return db.select().from(waitlist).where(eq(waitlist.id, id)).get()!;
}

export function declineSignup(id: string) {
  const changed =
    db
      .update(waitlist)
      .set({ status: "declined" })
      .where(and(eq(waitlist.id, id), eq(waitlist.status, "pending")))
      .run().changes === 1;
  if (!changed) throw new WaitlistError(409, "only a pending signup can be declined");
}

function adminAuthorized(header: string | undefined): boolean {
  const token = env.adminToken;
  if (token.length < 32) return false; // unset / weak → admin API off
  const given = Buffer.from(header?.replace(/^Bearer\s+/i, "") ?? "");
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** The public signup route + the admin routes, as one router. */
export function waitlistRouter(): express.Router {
  const r = express.Router();

  // CORS for the static marketing site, which lives on another origin
  // (Vercel). Only our own origins; no credentials, so no cookies ride along.
  r.use("/api/waitlist", (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && env.siteOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "POST");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Max-Age", "86400");
    }
    if (req.method === "OPTIONS") return void res.status(204).end();
    next();
  });

  r.post("/api/waitlist", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Honeypot: a field humans never see. Bots that fill it get a fake success.
    if (clean(body.website, 200)) return void res.json({ ok: true });
    const parsed = parseSignup(body);
    if (!parsed.ok) return void res.status(400).json({ error: parsed.error });
    const { created } = addSignup(parsed.value, req.ip);
    if (created) log("waitlist", `new signup (${parsed.value.viewers})`);
    res.json({ ok: true });
  });

  r.use("/api/admin/waitlist", (req, res, next) => {
    if (adminAuthorized(req.headers.authorization)) return next();
    res.status(401).json({ error: "admin token required" });
  });
  r.get("/api/admin/waitlist", (req, res) => {
    res.json({ signups: listSignups(typeof req.query.status === "string" ? req.query.status : undefined) });
  });
  const handle =
    (fn: (id: string) => unknown): express.RequestHandler =>
    (req, res) => {
      Promise.resolve()
        .then(() => fn(String(req.params.id)))
        .then((out) => res.json(out ?? { ok: true }))
        .catch((e) => {
          const status = e instanceof WaitlistError ? e.status : 500;
          res.status(status).json({ error: (e as Error).message });
        });
    };
  r.post("/api/admin/waitlist/:id/invite", handle(inviteSignup));
  r.post("/api/admin/waitlist/:id/decline", handle(declineSignup));
  return r;
}
