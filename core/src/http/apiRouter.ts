// The channel API — ONE Express router mounted by every host:
//   · demo rig / Electron bridge:  app.use("/api", buildApiRouter(...))
//   · hosted control plane:        app.use("/api/c/:channel", buildApiRouter(...))
//
// Hosts supply the three things that genuinely differ: how to resolve the
// runtime for a request (a single local runtime vs. one per channel), what
// "authenticated streamer" means (install token vs. session JWT), and how an
// uploaded reference image is stored. Everything else — the public config
// projection, submission intake, settings patching, token minting, panic,
// and the dev triggers — is identical by construction.

import { Router, type Request, type RequestHandler } from "express";
import {
  CONSENT_STATEMENT,
  NDJSON,
  PRESETS,
  presetAllowed,
  sanitizeSettingsPatch,
  type Settings,
  type SubmitEvent,
} from "@rh/shared";
import { MintError } from "../mintPolicy.js";
import { imagesReady, textReady } from "../moderation.js";
import { clientKey, RateLimiter } from "../safetyLedger.js";
import { createSubmission } from "../submissions.js";
import { parseFakeTip } from "../triggers/fake.js";
import { log, warn } from "../log.js";
import type { Runtime } from "../runtime.js";

/** The subset of a multer file the router needs (no @types/multer in core). */
export interface UploadedFile {
  filename: string;
  path: string;
}

export interface ApiContext {
  runtime: Runtime;
  /** Canonical channel id (hosted) — never the raw URL segment, which may
   *  be a login or an id in any casing for the same channel. Absent on the
   *  single-channel local rig. Strike / rate-limit keys use this. */
  channelId?: string;
  updateSettings(patch: Partial<Settings>): Settings;
  /** True when a real dct_ key backs this context (else tokens are "MOCK"). */
  decartEnabled: boolean;
  /** Policy-gated mint (see mintPolicy.ts). Throws MintError on refusal. */
  mint(durationSec: number, origin: string): Promise<string>;
  /** Ungated mint for the dev-only batch recorder (POST /dev/token). Only a
   *  host that spends its own key (the local rig) provides it; the route is
   *  mounted only when `devRoutes` is on, and answers 501 without this. */
  devMint?(durationSec: number, origin: string): Promise<string>;
  /** Panic toggle against whichever engine owns the money path. */
  togglePause(): Promise<boolean>;
  /** Public same-origin URL for a stored upload. */
  imageUrl(file: UploadedFile): string;
  /** Remove a stored upload whose submission was rejected. */
  discardUpload(file: UploadedFile): void;
  /** Move a suspected-CSAM upload out of the served tree and keep it for the
   *  preservation period (docs/runbooks/csam.md). Required by every host. */
  quarantineUpload(file: UploadedFile): void;
  /** Optional audit hook after a submission was accepted. */
  onSubmission?(sub: { code: string; presetId: string | null; hasImage: boolean }): void;
}

export interface ApiRouterOptions {
  /** Resolve the request's context; null → 404 "unknown channel". */
  context(req: Request): ApiContext | null;
  /** Gate for streamer-privileged routes. */
  requireAuth: RequestHandler;
  /** `multer(...).single("image")` for this host's storage. */
  upload: RequestHandler;
  /** Mount the streamer console triggers (/dev/hijack, /dev/fake-tip)? They
   *  run a job with no payment behind it: right for the local rig, where the
   *  streamer pays their own Decart bill, and wrong for a public host
   *  spending its key. Default true. */
  devRoutes?: boolean;
}

/** Longest session a dev (ungated) token may be minted for. */
export const MAX_DEV_TOKEN_SEC = 60;

type ReqWithFile = Request & { file?: UploadedFile };

export function buildApiRouter(opts: ApiRouterOptions): Router {
  // mergeParams: the hosted plane mounts us under /api/c/:channel and the
  // context resolver needs that param.
  const r = Router({ mergeParams: true });

  /** Strike / rate-limit identity: (canonical channel, real client IP). Keyed
   *  on the RESOLVED channel id, not the URL segment: `/c/Alice`, `/c/alice`
   *  and `/c/<id>` are one channel, and keying on the raw segment would hand
   *  an abuser a fresh budget per spelling. `req.ip` is the client only when
   *  the host set `trust proxy` correctly — see clientKey. */
  const submitter = (req: Request) => clientKey(opts.context(req)?.channelId, req.ip);

  /** Resolve-or-404, so every handler below can assume a context. */
  const withCtx =
    (h: (ctx: ApiContext, req: ReqWithFile, res: Parameters<RequestHandler>[1]) => unknown): RequestHandler =>
    (req, res, next) => {
      const ctx = opts.context(req);
      if (!ctx) {
        res.status(404).json({ error: "unknown channel" });
        return;
      }
      Promise.resolve(h(ctx, req as ReqWithFile, res)).catch(next);
    };

  // ── Public (viewers) ──────────────────────────────────────────────────

  /** What the portal needs to render, with no secrets. Every capability here
   *  is the EFFECTIVE one — the streamer's tier AND this host's classifiers —
   *  so the portal never offers something intake would refuse. */
  r.get(
    "/config",
    withCtx((ctx, _req, res) => {
      const s = ctx.runtime.getSettings();
      const m = ctx.runtime.moderation;
      const images = s.referenceImages !== "off" && imagesReady(m) ? s.referenceImages : "off";
      res.json({
        presets: PRESETS.filter(
          (p) => presetAllowed(p, s) && (!p.needsImage || images === "likeness"),
        ),
        allowCustomPrompts: s.customPrompts !== "off" && textReady(m),
        customPromptsNeedApproval: s.customPrompts === "classified+approval",
        referenceImages: images,
        consentStatement: CONSENT_STATEMENT,
        minTipUSD: s.minTipUSD,
        maxDurationSec: s.maxDurationSec,
        secondsPerUSD: s.secondsPerUSD,
        decartEnabled: ctx.decartEnabled,
      });
    }),
  );

  r.get("/presets", (_req, res) => res.json(PRESETS));

  /** Resolve the channel BEFORE multer touches the body: this route is
   *  public, and letting the upload hit disk first means every request to a
   *  bogus/suspended channel leaves a file behind (the 404 path has no ctx to
   *  discard it) — an unauthenticated disk-fill. Multer's own errors (size
   *  limit, extra files) become JSON 413/400 instead of Express's default
   *  500 HTML page. */
  const guardedUpload: RequestHandler = (req, res, next) => {
    if (!opts.context(req)) {
      res.status(404).json({ error: "unknown channel" });
      return;
    }
    opts.upload(req, res, (err?: unknown) => {
      if (!err) return next();
      const code = (err as { code?: string }).code;
      if (code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: "That photo is over 5 MB. Pick a smaller one." });
      } else {
        res.status(400).json({ error: "invalid upload" });
      }
    });
  };

  /** Viewer submission: prompt/preset + optional image, before tipping.
   *  The whole moderation chain runs here (see submissions.ts) — before a
   *  claim code exists, so nothing the viewer sent can reach a job unchecked.
   *
   *  Two response shapes, same decision:
   *    · `Accept: application/x-ndjson` (the portal) — 200, then one JSON
   *      line per event: the check `plan`, each `check` state as it
   *      resolves, and a final `result` carrying the real status. The checks
   *      take seconds; the viewer watches them happen instead of a spinner.
   *    · otherwise — one JSON body with the matching HTTP status. */
  r.post(
    "/submissions",
    guardedUpload,
    withCtx(async (ctx, req, res) => {
      const file = req.file;
      const rt = ctx.runtime;
      const streaming = (req.headers.accept ?? "").includes(NDJSON);
      const send = (ev: SubmitEvent) => res.write(`${JSON.stringify(ev)}\n`);
      if (streaming) {
        res.status(200);
        res.setHeader("Content-Type", `${NDJSON}; charset=utf-8`);
        // Defeat proxy buffering (nginx, compression) so each line lands live.
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();
      }
      let out;
      try {
        out = await createSubmission(
          {
            store: rt.correlation,
            settings: rt.getSettings(),
            moderation: rt.moderation,
            uploads: rt.uploads,
            ledger: rt.ledger,
            strikes: rt.strikes,
          },
          {
            ...(req.body as Record<string, unknown>),
            image: file ? { url: ctx.imageUrl(file), path: file.path } : null,
            ipHash: submitter(req),
          },
          streaming ? send : undefined,
        );
      } catch (e) {
        // Never leave an unvetted file on disk behind an unexpected throw.
        if (file) ctx.discardUpload(file);
        if (!streaming) throw e;
        // Headers are gone: the error has to travel as the result line.
        warn("api", `submission failed: ${(e as Error).message}`);
        send({ t: "result", ok: false, status: 500, error: "something went wrong — try again", findings: [], checks: [] });
        return res.end();
      }
      if (!out.ok) {
        if (file) {
          if (out.quarantine) ctx.quarantineUpload(file);
          else ctx.discardUpload(file);
        }
        const body = { error: out.error, findings: out.findings ?? [], checks: out.checks ?? [] };
        if (!streaming) return res.status(out.status).json(body);
        send({ t: "result", ok: false, status: out.status, ...body });
        return res.end();
      }
      ctx.onSubmission?.({ code: out.code, presetId: out.presetId, hasImage: Boolean(file) });
      const body = { code: out.code, expiresAt: out.expiresAt, needsReview: out.needsReview, checks: out.checks };
      if (!streaming) return res.json(body);
      send({ t: "result", ok: true, ...body });
      res.end();
    }),
  );

  // Public safety surface (S5). Rate-limited per submitter per channel; both
  // land in the ledger the streamer reads, and a takedown acts immediately.
  const publicLimiter = new RateLimiter(10, 60_000);
  const limited: RequestHandler = (req, res, next) => {
    if (publicLimiter.allow(submitter(req))) return next();
    res.status(429).json({ error: "too many requests" });
  };
  const field = (v: unknown, max: number) =>
    typeof v === "string" ? v.trim().slice(0, max) : "";

  /** Viewer report: "this effect / this stream overlay was not OK". */
  r.post(
    "/report",
    limited,
    withCtx((ctx, req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const reason = field(b.reason, 500);
      if (!reason) return res.status(400).json({ error: "tell us what was wrong" });
      const ev = ctx.runtime.ledger.record({
        stage: "report",
        verdict: "info",
        source: "viewer",
        reason,
        categories: [],
        code: field(b.code, 8) || null,
        jobId: field(b.jobId, 64) || null,
        ipHash: submitter(req),
      });
      warn("safety", `viewer report ${ev.id.slice(0, 8)}: ${reason.slice(0, 80)}`);
      res.json({ ok: true, id: ev.id });
    }),
  );

  /** TAKE IT DOWN-style removal request (docs/runbooks/takedown.md). Deletes
   *  the named upload and every EXACT (sha256) copy we hold now, and blocks
   *  that picture from being uploaded again. Near-duplicate fan-out is the
   *  streamer's call (POST /moderation/takedown) — an anonymous requester
   *  can't wipe everyone's similar-looking photos. The requester's contact
   *  goes to the operator-only store, never the streamer-visible ledger.
   *  The 48h SLA clock starts at the ledger timestamp. */
  r.post(
    "/takedown",
    limited,
    withCtx((ctx, req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const contact = field(b.contact, 200);
      const description = field(b.description, 2000);
      const imageUrl = field(b.imageUrl, 500) || undefined;
      const code = field(b.code, 8).toUpperCase() || undefined;
      if (!contact || !description) {
        return res.status(400).json({ error: "contact and description are required" });
      }
      // Only the image URL acts automatically: it carries a random filename,
      // so possessing it means you saw the picture. A 4-character claim code
      // is guessable — acting on it anonymously would let anyone delete
      // strangers' pending uploads — so a code-only request is recorded for
      // the operator to verify and action within the SLA.
      const { removed, blocked } = imageUrl
        ? ctx.runtime.uploads.takedown({ url: imageUrl }, { requester: submitter(req) })
        : { removed: 0, blocked: true };
      // A refused re-upload block (anonymous budget full) is escalated, never
      // reported as blocked: the streamer re-files it via /moderation/takedown,
      // which is unbudgeted.
      const ev = ctx.runtime.ledger.record({
        stage: "takedown",
        verdict: blocked ? "info" : "review",
        source: "requester",
        reason:
          `${description.slice(0, 300)} — removed ${removed} exact copy(ies)` +
          (imageUrl ? "" : " — code/description only: operator to verify") +
          (blocked ? "" : " — re-upload NOT blocked (anonymous budget full): re-file as a streamer takedown"),
        categories: blocked ? ["takedown"] : ["takedown", "block-refused"],
        code: code ?? null,
        ipHash: submitter(req),
      });
      ctx.runtime.ledger.recordContact(ev.id, contact);
      warn(
        "safety",
        `TAKEDOWN request ${ev.id.slice(0, 8)} — removed ${removed}${blocked ? "" : ", block REFUSED"}; 48h SLA (docs/runbooks/takedown.md)`,
      );
      res.json({ ok: true, ticket: ev.id, removed });
    }),
  );

  /** Streamer/operator takedown: the full fan-out — exact copies AND dHash
   *  near-duplicates (re-compressed / resized), blocked from re-upload. */
  r.post(
    "/moderation/takedown",
    opts.requireAuth,
    withCtx((ctx, req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const imageUrl = field(b.imageUrl, 500) || undefined;
      const sha256 = /^[0-9a-f]{64}$/.test(field(b.sha256, 64)) ? field(b.sha256, 64) : undefined;
      if (!imageUrl && !sha256) return res.status(400).json({ error: "imageUrl or sha256 required" });
      const { removed } = ctx.runtime.uploads.takedown(
        { url: imageUrl, sha256 },
        { nearDuplicates: true, source: "streamer" },
      );
      const ev = ctx.runtime.ledger.record({
        stage: "takedown",
        verdict: "info",
        source: "streamer",
        reason: `streamer takedown incl. near-duplicates — removed ${removed} file(s)`,
        categories: ["takedown", "near-duplicates"],
        inputHash: sha256 ?? null,
      });
      res.json({ ok: true, ticket: ev.id, removed });
    }),
  );

  // ── Streamer-privileged ───────────────────────────────────────────────

  r.get(
    "/settings",
    opts.requireAuth,
    withCtx((ctx, _req, res) => res.json(ctx.runtime.getSettings())),
  );

  r.post(
    "/settings",
    opts.requireAuth,
    withCtx((ctx, req, res) => {
      const next = ctx.updateSettings(sanitizeSettingsPatch(req.body));
      ctx.runtime.broadcastStatus(); // reflect any wiring changes
      res.json(next);
    }),
  );

  /** Paid jobs waiting on the streamer (S3). */
  r.get(
    "/review",
    opts.requireAuth,
    withCtx((ctx, _req, res) => res.json(ctx.runtime.engine.pendingReviews())),
  );

  r.post(
    "/review/:jobId",
    opts.requireAuth,
    withCtx((ctx, req, res) => {
      const approve = (req.body as { approve?: unknown } | undefined)?.approve === true;
      const ok = ctx.runtime.engine.decideReview(String(req.params.jobId), approve);
      if (!ok) return res.status(404).json({ error: "no such pending review" });
      res.json({ ok: true, approved: approve });
    }),
  );

  /** The moderation ledger, newest first (dashboard + router incident log). */
  r.get(
    "/moderation",
    opts.requireAuth,
    withCtx((ctx, req, res) => {
      const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100) || 100));
      res.json({
        events: ctx.runtime.ledger.recent(limit),
        classifiers: {
          text: ctx.runtime.moderation.text.map((c) => c.name),
          image: ctx.runtime.moderation.image.map((c) => c.name),
          devMode: ctx.runtime.moderation.devMode,
          textReady: textReady(ctx.runtime.moderation),
          imagesReady: imagesReady(ctx.runtime.moderation),
        },
      });
    }),
  );

  /** Mint a per-job Decart client token (ek_) capped to the paid duration. */
  r.post(
    "/token",
    opts.requireAuth,
    withCtx(async (ctx, req, res) => {
      const body = (req.body ?? {}) as { durationSec?: unknown; origin?: unknown };
      const durationSec = Number(body.durationSec);
      const origin = typeof body.origin === "string" ? body.origin : "";
      try {
        res.json({ token: await ctx.mint(durationSec, origin) });
      } catch (e) {
        const status = e instanceof MintError ? e.status : 502;
        res.status(status).json({ error: (e as Error).message });
      }
    }),
  );

  /** Streamer panic toggle (hotkey on the router page / tray / ⌘⇧H). */
  r.post(
    "/panic",
    opts.requireAuth,
    withCtx(async (ctx, _req, res) => {
      try {
        res.json({ paused: await ctx.togglePause() });
      } catch (e) {
        res.status(502).json({ error: (e as Error).message });
      }
    }),
  );

  if (opts.devRoutes === false) return r;

  /** Ungated token for the offline preview recorder (/decart-test "Record all
   *  effects"): there is no job to gate on while recording. Dev routes only
   *  (absent when devRoutes is false, i.e. in production), authed, and capped
   *  so even a dev token can't open an unbounded session. */
  r.post(
    "/dev/token",
    opts.requireAuth,
    withCtx(async (ctx, req, res) => {
      const body = (req.body ?? {}) as { durationSec?: unknown; origin?: unknown };
      const durationSec = Number(body.durationSec);
      if (!Number.isFinite(durationSec) || durationSec <= 0) {
        return res.status(400).json({ error: "durationSec must be positive" });
      }
      if (durationSec > MAX_DEV_TOKEN_SEC) {
        return res.status(400).json({ error: `durationSec is capped at ${MAX_DEV_TOKEN_SEC}` });
      }
      if (!ctx.devMint) return res.status(501).json({ error: "this host doesn't mint dev tokens" });
      try {
        const origin = typeof body.origin === "string" ? body.origin : "";
        res.json({ token: await ctx.devMint(durationSec, origin) });
      } catch (e) {
        res.status(502).json({ error: (e as Error).message });
      }
    }),
  );

  /** Streamer console trigger — the identical job pipeline minus payment. */
  r.post(
    "/dev/hijack",
    opts.requireAuth,
    withCtx((ctx, req, res) => {
      const body = (req.body ?? {}) as { prompt?: unknown; durationSec?: unknown };
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      const durationSec = Number(body.durationSec ?? 15);
      if (!prompt) return res.status(400).json({ error: "prompt required" });
      if (!Number.isFinite(durationSec) || durationSec <= 0) {
        return res.status(400).json({ error: "durationSec must be positive" });
      }
      const outcome = ctx.runtime.engine.manual(prompt, durationSec);
      log("manual", `${durationSec}s "${prompt.slice(0, 40)}…" → ${outcome}`);
      res.json({ ok: true, outcome });
    }),
  );

  /** Dev trigger — fakes a tip so the whole path runs without Streamlabs. */
  r.post(
    "/dev/fake-tip",
    opts.requireAuth,
    withCtx((ctx, req, res) => {
      const parsed = parseFakeTip(req.body);
      if ("error" in parsed) return res.status(400).json(parsed);
      const outcome = ctx.runtime.engine.onTip(parsed);
      log("fake-tip", `$${parsed.amount} "${parsed.message}" → ${outcome}`);
      res.json({ ok: true, outcome });
    }),
  );

  return r;
}
