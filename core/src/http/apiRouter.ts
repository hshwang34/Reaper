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
import { PRESETS, sanitizeSettingsPatch, type Settings } from "@rh/shared";
import { MintError } from "../mintPolicy.js";
import { createSubmission } from "../submissions.js";
import { parseFakeTip } from "../triggers/fake.js";
import { log } from "../log.js";
import type { Runtime } from "../runtime.js";

/** The subset of a multer file the router needs (no @types/multer in core). */
export interface UploadedFile {
  filename: string;
  path: string;
}

export interface ApiContext {
  runtime: Runtime;
  updateSettings(patch: Partial<Settings>): Settings;
  /** True when a real dct_ key backs this context (else tokens are "MOCK"). */
  decartEnabled: boolean;
  /** Policy-gated mint (see mintPolicy.ts). Throws MintError on refusal. */
  mint(durationSec: number, origin: string): Promise<string>;
  /** Panic toggle against whichever engine owns the money path. */
  togglePause(): Promise<boolean>;
  /** Public same-origin URL for a stored upload. */
  imageUrl(file: UploadedFile): string;
  /** Remove a stored upload whose submission was rejected. */
  discardUpload(file: UploadedFile): void;
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
}

type ReqWithFile = Request & { file?: UploadedFile };

export function buildApiRouter(opts: ApiRouterOptions): Router {
  // mergeParams: the hosted plane mounts us under /api/c/:channel and the
  // context resolver needs that param.
  const r = Router({ mergeParams: true });

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

  /** What the portal needs to render, with no secrets. */
  r.get(
    "/config",
    withCtx((ctx, _req, res) => {
      const s = ctx.runtime.getSettings();
      res.json({
        presets: PRESETS.filter((p) => s.enabledPresetIds.includes(p.id)),
        allowCustomPrompts: s.allowCustomPrompts,
        minTipUSD: s.minTipUSD,
        maxDurationSec: s.maxDurationSec,
        secondsPerUSD: s.secondsPerUSD,
        decartEnabled: ctx.decartEnabled,
      });
    }),
  );

  r.get("/presets", (_req, res) => res.json(PRESETS));

  /** Viewer submission: prompt/preset + optional image, before tipping. */
  r.post(
    "/submissions",
    opts.upload,
    withCtx((ctx, req, res) => {
      const file = req.file;
      const imageUrl = file ? ctx.imageUrl(file) : null;
      const out = createSubmission(ctx.runtime.correlation, ctx.runtime.getSettings(), {
        ...(req.body as Record<string, unknown>),
        imageUrl,
      });
      if (!out.ok) {
        if (file) ctx.discardUpload(file);
        return res.status(out.status).json({ error: out.error });
      }
      ctx.onSubmission?.({ code: out.code, presetId: out.presetId, hasImage: Boolean(file) });
      res.json({ code: out.code, expiresAt: out.expiresAt });
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
