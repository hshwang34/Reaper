// The viewer-facing page. A viewer composes a hijack — preset or custom prompt,
// optional reference image, and Decart's "enhance prompt" switch (together,
// the full per-session surface lucy-2.5 exposes over the realtime API) —
// submits it, and then pays for it one of two ways:
//   · hosted (/c/<channel>, Stripe configured, streamer verified): straight
//     to Stripe Checkout and back to live status. The payment IS the trigger
//     — no code to copy, and the money funds the GPU (server/src/payments.ts).
//   · local rig: a short CLAIM CODE to put in a Streamlabs tip message; for
//     the demo, a "Simulate tip" control fires the same path via
//     /api/dev/fake-tip.
//
// The page is a phone-first, three-step flow: Pick (EffectPicker.tsx) →
// Customize (prompt, photo, amount — this file) → Pay (a sticky bottom bar on
// phones, the end of the side panel on desktop). The steps are presentation
// only: it is still ONE form and ONE submission, exactly as before.
//
// Product-design note: prompt text is resolved server-side from a preset id, or
// moderated when custom — the viewer never controls raw prompt bytes that reach
// the model unchecked. That guardrail is the heart of the project. What this
// page offers is the EFFECTIVE policy from /config (streamer tiers AND the
// host's classifiers), so it never shows a control intake would refuse; a
// photo of a person needs the consent box, whose text is exactly what the
// server records (docs/CONTENT-SAFETY.md S2).
//
// Submitting runs the server's safety checks before a claim code exists. The
// page streams them (SafetyChecks.tsx): a live checklist while they run, and
// on a reject every failure point — which check, what it caught, the exact
// words. The form is locked while checking so what's shown is what was checked.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  computeDurationSec,
  type CheckResult,
  type SafetyFinding,
  type StatusSnapshot,
  type SubmissionStatus,
} from "@rh/shared";
import { api, type PaymentsInfo, type PublicConfig } from "../lib/api.js";
import { HubSocket } from "../lib/ws.js";
import { channelSlug } from "../lib/channel.js";
import { downscaleImage } from "../lib/image.js";
import { EffectArt, PreviewPlayButton, useHasPreview } from "../features/EffectArt.js";
import { FALLBACK, friendlyError } from "../lib/friendlyError.js";
import { clampToBounds, payLabel } from "./format.js";
import { SafetyChecklist, SafetyFindings } from "./SafetyChecks.js";
import { EffectPicker } from "./EffectPicker.js";
import { ClaimView } from "./StatusView.js";
import { SafetyFooter } from "./SafetyFooter.js";

/** Hard client-side ceiling on the raw file before downscaling (Decart's own
 *  reference-image limit is 10 MB post-encode; we shrink to 720p so any
 *  sensible photo fits — this only stops multi-hundred-MB mistakes). */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** Mirrors the server's cap (core/src/submissions.ts MAX_PROMPT_CHARS). */
const MAX_PROMPT_CHARS = 500;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

/** Sentence stems from Decart's Lucy prompt guide: one change, where it goes.
 *  `at` is where the caret lands — the blank the viewer fills in. */
const STARTERS: Array<{ label: string; text: string; at: number }> = [
  { label: "Become…", text: "Replace the character in the video with ", at: 39 },
  { label: "Add…", text: "Add  to the person's shoulders", at: 4 },
  { label: "New background…", text: "Change the background to ", at: 25 },
  { label: "Restyle…", text: "Transform the entire scene into ", at: 32 },
  { label: "Outfit…", text: "Change the person's outfit to ", at: 30 },
];
const EXAMPLES = [
  "Add a long blue cape and heart-shaped sunglasses",
  "Change the background to a neon-lit Tokyo street at night",
  "Transform the entire scene into a claymation world",
];

/** A rejected submission, pinned to exactly what was checked. */
interface Failure {
  findings: SafetyFinding[];
  checks: CheckResult[];
  prompt: string | null;
  image: File | null;
}

/** What the viewer paid, remembered across the Stripe round trip so the
 *  status page can show a receipt line (sessionStorage; best effort). */
interface Receipt {
  amount: number;
  seconds: number;
  effect: string;
}
const receiptKey = (code: string) => `rh:paid:${code}`;
function saveReceipt(code: string, r: Receipt) {
  try {
    sessionStorage.setItem(receiptKey(code), JSON.stringify(r));
  } catch {
    /* private mode — the receipt line just won't show */
  }
}
function loadReceipt(code: string): Receipt | null {
  try {
    const r = JSON.parse(sessionStorage.getItem(receiptKey(code)) ?? "null") as Receipt | null;
    return r && typeof r.amount === "number" && typeof r.seconds === "number" && typeof r.effect === "string" ? r : null;
  } catch {
    return null;
  }
}
/** The single-column (phone/tablet) layout, where steps stack. */
const stacked = () => window.matchMedia("(max-width: 1023px)").matches;

/** The amount a viewer may pay: the streamer's minimum up to what fills the
 *  maximum duration (the same ceiling the "capped" line used to describe). */
function amountBounds(cfg: PublicConfig, pay: PaymentsInfo | null) {
  const min = pay?.enabled ? pay.minUsd : cfg.minTipUSD;
  const max = Math.max(min, Math.ceil(cfg.maxDurationSec / cfg.secondsPerUSD));
  return { min, max };
}

export default function PortalPage() {
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  const [presetId, setPresetId] = useState<string | null>(null);
  /** "Write your own" is the chosen tile (presetId is then null). */
  const [writing, setWriting] = useState(false);
  const [customPrompt, setCustomPrompt] = useState("");
  const [tipperName, setTipperName] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  // Blob URLs pin the file in memory until revoked — release the old
  // preview whenever it's swapped out, and on unmount.
  const previewRef = useRef<string | null>(null);
  const replacePreview = (url: string | null) => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = url;
    setImagePreview(url);
  };
  useEffect(() => () => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
  }, []);
  // Decart prompt enhancement. Default ON (Decart's default, and what the
  // preset catalog is written for); OFF = literal prompt, for precise edits.
  const [enhance, setEnhance] = useState(true);
  const [consent, setConsent] = useState(false);
  const [tipAmount, setTipAmount] = useState(10);
  /** The free-typing amount field is tucked behind "Other amount". */
  const [otherAmount, setOtherAmount] = useState(false);
  const [amountDraft, setAmountDraft] = useState("10");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Safety-check progress: `preparing` covers the client-side stretch (photo
  // shrink + upload) until the server announces its checks.
  const [checks, setChecks] = useState<CheckResult[]>([]);
  const [preparing, setPreparing] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [passedChecks, setPassedChecks] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  /** Checks passed and we're handing the viewer to Stripe (no cancelling now). */
  const [redirecting, setRedirecting] = useState(false);
  /** Same flag for the `finally` in submit() (state is stale inside that closure). */
  const redirectingRef = useRef(false);
  // Back button from Stripe restores this page from the bfcache mid-redirect.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      redirectingRef.current = false;
      setRedirecting(false);
      setSubmitting(false);
      setPreparing(null);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [status, setStatus] = useState<SubmissionStatus | null>(null);
  /** Came back from Stripe Checkout (?paid=<code>) — read from the redirect, not from copy. */
  const [fromCheckout, setFromCheckout] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  /** A photo-only effect was submitted without its photo: highlight the drop zone. */
  const [photoMissing, setPhotoMissing] = useState(false);
  const dropRef = useRef<HTMLLabelElement>(null);
  /** The channel's public status broadcast — drives the "Live now" chip. */
  const [snapshot, setSnapshot] = useState<StatusSnapshot | null>(null);
  const [now, setNow] = useState(Date.now());

  const fileRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const pickRef = useRef<HTMLElement>(null);
  const customizeRef = useRef<HTMLDivElement>(null);
  /** Set by a tap on a card: scroll the stacked layout to step 2 once it renders. */
  const scrollToCustomize = useRef(false);
  const [dragging, setDragging] = useState(false);
  /** Hosted payments for this channel (null = claim-code flow). */
  const [pay, setPay] = useState<PaymentsInfo | null>(null);
  const paid = pay?.enabled === true;

  function loadConfig() {
    setLoadFailed(false);
    api.getConfig().then(setCfg).catch(() => setLoadFailed(true));
  }

  useEffect(() => {
    loadConfig();
    if (channelSlug()) {
      api
        .paymentsInfo()
        .then((p) => {
          setPay(p);
          if (p.enabled) setTipAmount((a) => Math.max(a, p.minUsd));
        })
        .catch(() => setPay(null));
    }
    // Back from Stripe Checkout (?paid=<code>): resume that submission's live
    // status. The webhook — not this redirect — is what actually starts the
    // hijack, so the page only listens.
    const back = new URLSearchParams(location.search).get("paid");
    if (back) {
      setCode(back);
      setFromCheckout(true);
      setReceipt(loadReceipt(back));
      setStatus({ code: back, state: "pending", message: "Payment received. Your effect is next in line." });
      history.replaceState(null, "", location.pathname);
    }
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // One public portal socket: the channel's status broadcast always, plus
  // this submission's live status once we have a code (the code rides the
  // hello, so a new code means a fresh registration).
  useEffect(() => {
    const hub = new HubSocket("portal", code ?? undefined).connect();
    const off = hub.on((m) => {
      if (m.t === "status") setSnapshot(m.status);
      else if (code && m.t === "submission:update" && m.status.code === code) {
        setStatus(m.status);
      }
    });
    return () => {
      off();
      hub.close();
    };
  }, [code]);

  const clampAmount = (n: number) => {
    if (!cfg || !Number.isFinite(n)) return tipAmount;
    const { min, max } = amountBounds(cfg, pay);
    return clampToBounds(n, min, max);
  };

  // Once the streamer's limits are known, hold tipAmount itself inside them so
  // the button label, the seconds preview and the charge (submit) all read the
  // same number. (The default $10 can exceed a low streamer maximum.)
  useEffect(() => {
    if (!cfg) return;
    const { min, max } = amountBounds(cfg, pay);
    setTipAmount((a) => {
      const c = clampToBounds(a, min, max);
      setAmountDraft(String(c));
      return c;
    });
  }, [cfg, pay]);

  // Same formula the engine bills with (shared/settings.ts) — the preview a
  // viewer sees is exactly the duration they will get.
  const durationPreview = useMemo(
    () => (cfg ? computeDurationSec(tipAmount, cfg) : 0),
    [cfg, tipAmount],
  );

  const secsLeft =
    expiresAt != null ? Math.max(0, Math.round((expiresAt - now) / 1000)) : null;

  const selectedPreset = cfg?.presets.find((p) => p.id === presetId) ?? null;
  const hasSelectedPreview = useHasPreview(selectedPreset?.id ?? "");
  const chosen = selectedPreset != null || writing;

  // Phones: a tap on a card brings step 2 into view.
  useEffect(() => {
    if (!scrollToCustomize.current || !chosen) return;
    scrollToCustomize.current = false;
    if (stacked()) customizeRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (writing) promptRef.current?.focus({ preventScroll: true });
  }, [chosen, presetId, writing]);

  function pickPreset(id: string) {
    setPresetId(id);
    setWriting(false);
    setCustomPrompt(""); // preset and custom are mutually exclusive
    scrollToCustomize.current = true;
  }

  function pickWriting() {
    setPresetId(null);
    setWriting(true);
    scrollToCustomize.current = true;
  }

  function pickAmount(a: number) {
    setTipAmount(a);
    setAmountDraft(String(a));
  }

  function backToPicker() {
    pickRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function takeImage(file: File | null) {
    setError(null);
    setPhotoMissing(false);
    if (file && !IMAGE_TYPES.includes(file.type)) {
      setError("That file isn't a JPEG, PNG or WebP image. Pick a different photo.");
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    if (file && file.size > MAX_UPLOAD_BYTES) {
      // Decart's own ceiling is 10 MB; we downscale to 720p before upload so
      // anything under this cap is fine. Bigger files just stall the submit.
      setError("That photo is over 25 MB. Pick a smaller one.");
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    setImageFile(file);
    replacePreview(file ? URL.createObjectURL(file) : null);
  }

  function clearImage() {
    setImageFile(null);
    replacePreview(null);
    if (fileRef.current) fileRef.current.value = "";
    // A photo-only preset can't run without its photo.
    if (selectedPreset?.needsImage) setPresetId(null);
  }

  /** Drop an idea-starter stem into the box and park the caret in its blank. */
  function insertStarter(s: (typeof STARTERS)[number]) {
    const base = customPrompt.trim();
    const joiner = base ? (/[.!?]$/.test(base) ? " " : ". ") : "";
    const next = (base + joiner + s.text).slice(0, MAX_PROMPT_CHARS);
    const caret = Math.min(base.length + joiner.length + s.at, next.length);
    setCustomPrompt(next);
    requestAnimationFrame(() => {
      const el = promptRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }

  async function submit() {
    if (!cfg || submitting) return;
    setError(null);
    setFailure(null);
    setChecks([]);
    setPhotoMissing(false);
    if (!presetId && !customPrompt.trim()) {
      setError(writing ? "Describe your effect first." : "Pick an effect or describe your own.");
      return;
    }
    if (selectedPreset?.needsImage && !imageFile) {
      setError(`${selectedPreset.label} needs a photo. Add one above.`);
      setPhotoMissing(true);
      dropRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (selectedPreset?.needsImage && !consent) {
      setError("Check the consent box. You need permission to put someone's face on stream.");
      return;
    }
    const amount = clampAmount(tipAmount);
    setSubmitting(true);
    const checkedPrompt = presetId ? null : customPrompt.trim();
    const checkedImage = imageFile;
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const form = new FormData();
      if (presetId) form.set("presetId", presetId);
      else form.set("prompt", customPrompt.trim());
      if (tipperName.trim()) form.set("tipperName", tipperName.trim());
      // Sent as "1"/"0": multipart fields are strings, and the server treats
      // an absent field as Decart's default (on) for older clients.
      form.set("enhance", enhance ? "1" : "0");
      if (imageFile) {
        setPreparing("Preparing your photo…");
        const blob = await downscaleImage(imageFile);
        form.set("image", blob, "reference.jpg");
        if (consent) form.set("consent", "1");
      }
      setPreparing(imageFile ? "Uploading…" : "Sending…");
      const res = await api.submit(
        form,
        (ev) => {
          if (ev.t === "plan") {
            setPreparing(null);
            setChecks(ev.checks.map((c) => ({ ...c, state: "pending" })));
          } else {
            setChecks((prev) => prev.map((c) => (c.id === ev.id ? { ...c, state: ev.state } : c)));
          }
        },
        ac.signal,
      );
      // The result carries the final state of every check — the source of truth.
      if (res.checks.length) setChecks(res.checks);
      if (res.ok) {
        setPassedChecks(res.checks.length);
        if (paid) {
          // Every check passed and the code exists — now the money. Stripe
          // holds the effect for the 30 minutes its checkout page lives.
          redirectingRef.current = true;
          setRedirecting(true);
          setPreparing("Taking you to checkout…");
          let url: string;
          try {
            ({ url } = await api.checkout(res.code, amount, tipperName.trim()));
          } catch (e) {
            // Specific words for the cases a viewer can act on (streamer went
            // offline, request expired); otherwise the plain checkout line.
            const friendly = friendlyError(e);
            setError(friendly === FALLBACK ? "We couldn't start checkout. Try again." : friendly);
            redirectingRef.current = false;
            setRedirecting(false);
            return;
          }
          saveReceipt(res.code, {
            amount,
            seconds: computeDurationSec(amount, cfg),
            effect: selectedPreset?.label ?? "your own idea",
          });
          location.href = url;
          return; // stay "busy" until the browser leaves the page
        }
        setCode(res.code);
        setExpiresAt(res.expiresAt);
        setStatus({
          code: res.code,
          state: "pending",
          message: res.needsReview
            ? "The streamer approves this kind of effect before it runs. If they decline (or don't answer within 2 minutes), it won't run."
            : undefined,
        });
        window.scrollTo({ top: 0 });
      } else if (res.findings.length) {
        setFailure({ findings: res.findings, checks: res.checks, prompt: checkedPrompt, image: checkedImage });
      } else {
        setError(friendlyError(res.error));
      }
    } catch (e) {
      if (ac.signal.aborted) {
        setChecks([]);
        return;
      }
      setError(friendlyError(e));
    } finally {
      if (!redirectingRef.current) {
        setPreparing(null);
        setSubmitting(false);
      }
    }
  }

  // Results describe what was checked; once the viewer edits, say so.
  const failureStale =
    failure != null &&
    (failure.prompt !== (presetId ? null : customPrompt.trim()) || failure.image !== imageFile);
  const unchangedFailure = failure != null && !failureStale;
  const checksDone = checks.filter((c) => c.state !== "pending" && c.state !== "running").length;

  async function simulateTip() {
    if (!code) return;
    // Real viewers tip via Streamlabs with the code in the message; this is the
    // demo shortcut that drives the identical server-side path.
    await api.fakeTip(tipAmount, `Stream hijack ${code}`, tipperName || undefined);
  }

  function reset() {
    setChecks([]);
    setFailure(null);
    setPassedChecks(0);
    setCode(null);
    setExpiresAt(null);
    setStatus(null);
    setPresetId(null);
    setWriting(false);
    setCustomPrompt("");
    setImageFile(null);
    replacePreview(null);
    setEnhance(true);
    setConsent(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  if (!cfg) {
    if (loadFailed) {
      return (
        <div className="mx-auto grid min-h-[60vh] max-w-md place-items-center px-4 text-center">
          <div>
            <p role="alert" className="text-base text-red-300">
              We couldn't load this page. Check your connection and try again.
            </p>
            <button
              type="button"
              onClick={loadConfig}
              className="mt-4 min-h-12 rounded-2xl bg-brand-600 px-6 font-bold text-white hover:bg-brand-700"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    // Loading: say so, and hold the shape of the page with a skeleton grid.
    return (
      <div className="mx-auto max-w-6xl px-4 pt-2 sm:px-6" aria-busy="true">
        <p role="status" className="mb-6 text-lg text-zinc-300">
          Loading the hijack page…
        </p>
        <div aria-hidden className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:max-w-3xl">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="overflow-hidden rounded-2xl border border-zinc-800">
              <div className="aspect-video bg-zinc-900 motion-safe:animate-pulse" />
              <div className="space-y-2 bg-zinc-900/80 p-3">
                <div className="h-4 w-2/3 rounded bg-zinc-800 motion-safe:animate-pulse" />
                <div className="h-3 w-full rounded bg-zinc-800/70 motion-safe:animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const channel = channelSlug();
  const { min: minAmount, max: maxAmount } = amountBounds(cfg, pay);
  const quickAmounts = [...new Set([minAmount, 5, 10, 20, 30])]
    .filter((a) => a >= minAmount && a <= maxAmount)
    .sort((a, b) => a - b);
  const effectName = selectedPreset?.label ?? "your effect";
  const offline = paid ? !pay!.live : snapshot?.routerState === "OFFLINE";
  const busy = snapshot && (snapshot.activeJob != null || snapshot.queueLength > 0);
  const photoTier = cfg.referenceImages;
  const streamerName = channel ?? "The streamer";

  return (
    <div className={`mx-auto max-w-6xl px-4 pt-2 sm:px-6 ${code || !chosen ? "pb-10" : "pb-48 lg:pb-10"}`}>
      {offline && (
        <div
          role="status"
          className="mb-6 rounded-2xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-200"
        >
          You can still browse effects while you wait. Payments open when {streamerName} is streaming.
        </div>
      )}
      <header className="mb-8 max-w-2xl">
        <h1 className="text-[2rem] leading-[1.1] font-bold text-zinc-50 sm:text-5xl">
          Hijack {channel ? `${channel}'s` : "the"} stream
        </h1>
        <p className="mt-3 text-base text-zinc-300 sm:text-lg">
          Pick an effect, pay, and watch it happen live.{" "}
          <span className="whitespace-nowrap text-zinc-100">
            $1 = {cfg.secondsPerUSD === 1 ? "1 second" : `${cfg.secondsPerUSD} seconds`}.
          </span>
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {(snapshot || paid) && (
            <span
              className={`inline-flex min-h-8 items-center gap-2 rounded-full border px-3 text-sm font-medium ${
                offline
                  ? "border-zinc-700 bg-zinc-900 text-zinc-300"
                  : busy
                    ? "border-amber-400/40 bg-amber-400/10 text-amber-200"
                    : "border-emerald-400/40 bg-emerald-400/10 text-emerald-200"
              }`}
            >
              <span
                aria-hidden
                className={`h-2 w-2 rounded-full ${
                  offline ? "bg-zinc-500" : busy ? "bg-amber-300" : "bg-emerald-400 motion-safe:animate-pulse"
                }`}
              />
              {offline
                ? `${streamerName} isn't live right now. Check back when they're streaming.`
                : busy
                  ? `An effect is on stream · ${snapshot!.queueLength} in line`
                  : "Live now"}
            </span>
          )}
          {!cfg.decartEnabled && (
            <span className="inline-flex min-h-8 items-center rounded-full border border-amber-500/30 px-3 text-xs text-amber-300">
              Demo mode: effects are simulated
            </span>
          )}
        </div>
      </header>

      {!code ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <fieldset
            className="m-0 min-w-0 border-0 p-0 lg:grid lg:grid-cols-[minmax(0,1fr)_420px] lg:items-start lg:gap-10"
          >
            {/* ── Step 1: pick ── */}
            <section ref={pickRef} aria-labelledby="step-pick" className="scroll-mt-4" inert={submitting}>
              <StepHeading n={1} id="step-pick">Pick an effect or describe your own</StepHeading>
              <EffectPicker
                presets={cfg.presets}
                selectedId={presetId}
                writing={writing}
                allowCustom={cfg.allowCustomPrompts}
                hasPhoto={imageFile != null}
                emptyText={`${streamerName} hasn't turned any effects on yet.`}
                onPick={pickPreset}
                onWrite={pickWriting}
              />
            </section>

            {/* ── Steps 2 + 3: customize, pay ── */}
            <div ref={customizeRef} className="mt-10 scroll-mt-4 lg:sticky lg:top-6 lg:mt-0">
              {!chosen ? (
                <div className="hidden rounded-3xl border border-dashed border-zinc-700 p-8 text-center lg:block">
                  <p className="text-4xl" aria-hidden>👈</p>
                  <p className="mt-3 text-lg font-semibold text-zinc-100">Pick an effect to start</p>
                  <ol className="mx-auto mt-4 max-w-56 space-y-2 text-left text-sm text-zinc-400">
                    <li>1 · Pick an effect or describe your own</li>
                    <li>2 · Add a photo or tweak the details</li>
                    <li>3 · Pay. It plays on stream right away.</li>
                  </ol>
                </div>
              ) : (
                <section aria-labelledby="step-customize" className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-5 lg:pb-0 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto lg:[scrollbar-width:thin]">
                  <StepHeading n={2} id="step-customize">Add a photo or tweak the details</StepHeading>

                  {/* Selected effect. With a recorded preview it gets a large 16:9
                      example; without one, today's small thumbnail. */}
                  {selectedPreset && hasSelectedPreview && (
                    <figure className="relative mb-4 max-w-[380px]">
                      <EffectArt preset={selectedPreset} size="lg" autoPlay className="w-full rounded-2xl" />
                      <div className="pointer-events-none absolute inset-x-0 top-0 aspect-video">
                        <div className="absolute inset-0">
                          <PreviewPlayButton id={selectedPreset.id} label={selectedPreset.label} reducedMotionOnly />
                        </div>
                      </div>
                      <figcaption className="mt-2 text-sm text-zinc-400">
                        {selectedPreset.id === "photo-swap" ? "Example photo. " : "Example. "}
                        Your streamer's results will look different.
                      </figcaption>
                    </figure>
                  )}
                  <div className="flex items-center gap-3">
                    {selectedPreset ? (
                      !hasSelectedPreview && <EffectArt preset={selectedPreset} size="sm" className="w-24 shrink-0 rounded-xl" />
                    ) : (
                      <div aria-hidden className="grid aspect-video w-24 shrink-0 place-items-center rounded-xl bg-[linear-gradient(135deg,#1c1617,#3a2722)] text-2xl text-brand-300">
                        ✎
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold leading-tight text-zinc-50">{selectedPreset?.label ?? "Your own idea"}</p>
                      <p className="mt-0.5 line-clamp-2 text-sm leading-snug text-zinc-400">
                        {selectedPreset?.pitch ?? "Describe it below"}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={backToPicker}
                      className="min-h-11 shrink-0 rounded-xl px-3 text-sm font-semibold text-brand-300 hover:bg-zinc-800 lg:hidden"
                    >
                      Change effect
                    </button>
                  </div>

                  <div className="mt-6 space-y-6" inert={submitting}>
                    {/* Custom prompt */}
                    {writing && (
                      <div>
                        <div className="mb-2 flex items-baseline justify-between">
                          <label htmlFor="rh-prompt" className="text-sm font-semibold text-zinc-100">
                            Describe your effect
                          </label>
                          <span className="text-xs tabular-nums text-zinc-400" aria-live="polite">
                            {customPrompt.length}/{MAX_PROMPT_CHARS}
                          </span>
                        </div>
                        <textarea
                          id="rh-prompt"
                          ref={promptRef}
                          value={customPrompt}
                          maxLength={MAX_PROMPT_CHARS}
                          onChange={(e) => setCustomPrompt(e.target.value)}
                          onKeyDown={(e) => {
                            // Enter submits, Shift+Enter breaks the line. Never mid-IME
                            // composition: Enter there confirms a Hangul/kana candidate.
                            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                              e.preventDefault();
                              e.currentTarget.form?.requestSubmit();
                            }
                          }}
                          placeholder="e.g. Add a long blue cape and heart-shaped sunglasses"
                          rows={3}
                          aria-describedby="rh-prompt-hint"
                          className="w-full resize-none rounded-2xl border border-zinc-700 bg-zinc-950 p-3.5 text-base text-zinc-50 placeholder:text-zinc-500 focus:border-brand-400 focus:outline-none"
                        />
                        <p id="rh-prompt-hint" className="mt-2 text-sm text-zinc-400">
                          Describe one change and where it goes. Be specific, and say what you
                          want rather than what to avoid.
                          {cfg.customPromptsNeedApproval && " The streamer approves custom effects before they run."}
                        </p>

                        <p className="mt-4 mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                          Idea starters
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {STARTERS.map((s) => (
                            <button
                              key={s.label}
                              type="button"
                              onClick={() => insertStarter(s)}
                              className="min-h-11 rounded-full border border-zinc-700 bg-zinc-950 px-4 text-sm text-zinc-200 hover:border-brand-400 hover:text-zinc-50"
                            >
                              {s.label}
                            </button>
                          ))}
                        </div>
                        <ul className="mt-3 space-y-1">
                          {EXAMPLES.map((ex) => (
                            <li key={ex}>
                              <button
                                type="button"
                                onClick={() => setCustomPrompt(ex)}
                                className="flex min-h-11 w-full items-center gap-2 rounded-xl px-2 text-left text-sm text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50"
                              >
                                <span aria-hidden className="text-brand-300">↳</span>
                                <span>“{ex}”</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Reference image — lucy-2.5 uses it as a character/style anchor.
                        Only offered when the streamer's tier AND the host's classifiers
                        allow it (cfg.referenceImages is the effective tier). */}
                    {photoTier !== "off" && (
                      <div>
                        <input
                          ref={fileRef}
                          id="rh-photo"
                          type="file"
                          accept={IMAGE_TYPES.join(",")}
                          onChange={(e) => takeImage(e.target.files?.[0] ?? null)}
                          className="sr-only"
                        />
                        {imagePreview ? (
                          <div className="flex items-center gap-4 rounded-2xl border border-zinc-700 bg-zinc-950 p-3">
                            <img src={imagePreview} alt="Your photo" className="h-20 w-20 rounded-xl object-cover" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-semibold text-zinc-100">Photo added</p>
                              <p className="text-sm text-zinc-400">Safety-checked, then deleted after your effect runs.</p>
                              <div className="mt-1 flex gap-1">
                                <label
                                  htmlFor="rh-photo"
                                  className="inline-flex min-h-11 cursor-pointer items-center rounded-lg px-2 text-sm font-semibold text-brand-300 hover:bg-zinc-800"
                                >
                                  Replace photo
                                </label>
                                <button
                                  type="button"
                                  onClick={clearImage}
                                  className="min-h-11 rounded-lg px-2 text-sm font-semibold text-zinc-300 hover:bg-zinc-800"
                                >
                                  Remove photo
                                </button>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <label
                            ref={dropRef}
                            htmlFor="rh-photo"
                            onDragOver={(e) => {
                              e.preventDefault();
                              setDragging(true);
                            }}
                            onDragLeave={() => setDragging(false)}
                            onDrop={(e) => {
                              e.preventDefault();
                              setDragging(false);
                              takeImage(e.dataTransfer.files?.[0] ?? null);
                            }}
                            className={`flex min-h-24 cursor-pointer items-center gap-4 rounded-2xl border-2 border-dashed p-4 ${
                              photoMissing
                                ? "border-red-400 bg-red-400/10 ring-2 ring-red-400/50"
                                : dragging
                                ? "border-brand-400 bg-brand-500/10"
                                : selectedPreset?.needsImage
                                  ? "border-amber-400/60 bg-amber-400/5 hover:border-amber-300"
                                  : "border-zinc-700 hover:border-zinc-500"
                            }`}
                          >
                            <span aria-hidden className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-zinc-800 text-2xl">
                              📷
                            </span>
                            <span>
                              <span className="block font-semibold text-zinc-100">
                                {selectedPreset?.needsImage
                                  ? "Add a photo of who they'll become"
                                  : photoTier === "scenes"
                                    ? "Add a scene photo (optional)"
                                    : "Add a photo (optional)"}
                              </span>
                              <span className="block text-sm text-zinc-400">
                                {photoTier === "scenes"
                                  ? "A place, painting or texture to borrow. No photos of people."
                                  : "Clear, well-lit, facing the camera"}
                              </span>
                            </span>
                          </label>
                        )}
                        {imageFile && photoTier === "likeness" && (
                          <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-2xl border border-amber-500/40 bg-amber-950/30 p-4">
                            <input
                              type="checkbox"
                              checked={consent}
                              onChange={(e) => setConsent(e.target.checked)}
                              className="mt-0.5 h-5 w-5 shrink-0 accent-amber-500"
                            />
                            <span className="text-sm text-amber-50">
                              {cfg.consentStatement}
                              <span className="mt-1 block text-sm text-amber-200/80">
                                Required if the photo shows a person. Public figures and
                                anyone under 18 are always refused.
                              </span>
                            </span>
                          </label>
                        )}
                      </div>
                    )}

                    {/* Decart prompt enhancement — the last per-session knob lucy-2.5
                        exposes. On = Decart rewrites/expands the prompt (its default);
                        off = literal prompt for precise edits. */}
                    <label className="flex cursor-pointer items-center justify-between gap-4">
                      <span>
                        <span className="block text-sm font-semibold text-zinc-100">Let AI polish my idea</span>
                        <span className="block text-sm text-zinc-400">Turn off to run it exactly as written.</span>
                      </span>
                      <span className="relative inline-flex shrink-0">
                        <input
                          type="checkbox"
                          role="switch"
                          checked={enhance}
                          onChange={(e) => setEnhance(e.target.checked)}
                          className="peer sr-only"
                        />
                        <span
                          aria-hidden
                          className="h-7 w-12 rounded-full bg-zinc-700 transition-colors peer-checked:bg-brand-500 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand-400"
                        />
                        <span
                          aria-hidden
                          className="absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5"
                        />
                      </span>
                    </label>

                    {/* Amount */}
                    <div>
                      <p id="rh-amount-label" className="mb-2 text-sm font-semibold text-zinc-100">
                        How long?
                      </p>
                      <div role="group" aria-labelledby="rh-amount-label" className="flex flex-wrap gap-2">
                        {quickAmounts.map((a) => (
                          <button
                            key={a}
                            type="button"
                            aria-pressed={tipAmount === a}
                            onClick={() => pickAmount(a)}
                            className={`min-h-11 min-w-14 rounded-xl border px-3 text-sm font-semibold tabular-nums ${
                              tipAmount === a
                                ? "border-brand-400 bg-brand-400/10 text-brand-200"
                                : "border-zinc-700 bg-zinc-950 text-zinc-200 hover:border-zinc-500"
                            }`}
                          >
                            ${a}
                          </button>
                        ))}
                        {!otherAmount && (
                          <button
                            type="button"
                            onClick={() => {
                              setAmountDraft(String(tipAmount));
                              setOtherAmount(true);
                            }}
                            className="min-h-11 rounded-xl px-3 text-sm font-semibold text-brand-300 hover:bg-zinc-800"
                          >
                            Other amount
                          </button>
                        )}
                      </div>
                      <div className={`mt-3 grid gap-3 ${otherAmount ? "grid-cols-2" : "grid-cols-1"}`}>
                        {otherAmount && (
                          <label className="block">
                            <span className="mb-1 block text-sm text-zinc-400">{paid ? "Amount ($)" : "Tip amount ($)"}</span>
                            <input
                              type="number"
                              inputMode="decimal"
                              min={minAmount}
                              max={maxAmount}
                              value={amountDraft}
                              onChange={(e) => {
                                setAmountDraft(e.target.value);
                                if (e.target.value !== "") setTipAmount(clampAmount(Number(e.target.value)));
                              }}
                              onBlur={() => setAmountDraft(String(tipAmount))}
                              className="min-h-11 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-base tabular-nums text-zinc-50 focus:border-brand-400 focus:outline-none"
                            />
                          </label>
                        )}
                        <label className="block">
                          <span className="mb-1 block text-sm text-zinc-400">
                            {paid ? "Name on stream (optional)" : "Name you'll tip as"}
                          </span>
                          <input
                            value={tipperName}
                            onChange={(e) => setTipperName(e.target.value)}
                            placeholder="optional"
                            maxLength={64}
                            className="min-h-11 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-base text-zinc-50 placeholder:text-zinc-500 focus:border-brand-400 focus:outline-none"
                          />
                        </label>
                      </div>
                      <p className="mt-2 text-sm text-zinc-300" aria-live="polite">
                        <span className="font-semibold tabular-nums text-zinc-50">
                          {durationPreview} {durationPreview === 1 ? "second" : "seconds"}
                        </span>{" "}
                        of {effectName}
                        {tipAmount >= maxAmount && (
                          <span className="text-zinc-400"> · the most the streamer allows is {cfg.maxDurationSec}s</span>
                        )}
                      </p>
                    </div>

                  </div>
                  <div className="mt-6 space-y-6">
                    {(submitting || checks.length > 0) && (
                      <SafetyChecklist checks={checks} preparing={preparing} running={submitting} stale={failureStale} />
                    )}
                    {failure && (
                      <SafetyFindings
                        findings={failure.findings}
                        checks={failure.checks}
                        prompt={failure.prompt}
                        stale={failureStale}
                      />
                    )}
                  </div>

                  {/* ── Step 3: pay. A fixed bar on phones, inline on desktop. ── */}
                  <div className="fixed inset-x-0 bottom-0 z-20 border-t border-zinc-800 bg-[#121112]/95 px-4 pt-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] backdrop-blur lg:sticky lg:-mx-5 lg:mt-6 lg:rounded-b-3xl lg:bg-[#171617] lg:px-5 lg:pb-5 lg:backdrop-blur-none">
                    <div className="mx-auto max-w-xl lg:max-w-none">
                      {paid && !pay!.live && (
                        <p className="mb-2 rounded-xl bg-zinc-800 px-3 py-2 text-sm text-zinc-200">
                          {streamerName} isn't live right now, so payments are paused. Check back when they're streaming.
                        </p>
                      )}
                      {error && (
                        <p role="alert" className="mb-2 text-sm text-red-300">
                          {error}
                        </p>
                      )}
                      {/* Re-sending exactly what just failed would fail the same way —
                          and cost the viewer a strike — so it waits for an edit. */}
                      {unchangedFailure && !submitting && (
                        <p className="mb-2 text-sm text-zinc-300">Change your idea or photo first.</p>
                      )}
                      <button
                        type="submit"
                        disabled={submitting || unchangedFailure || (paid && !pay!.live)}
                        className={`min-h-14 w-full rounded-2xl bg-brand-600 px-4 text-base font-bold text-white shadow-[0_8px_30px_-8px_rgba(255,121,92,.6)] hover:bg-brand-700 disabled:opacity-50 disabled:shadow-none ${
                          submitting ? "disabled:cursor-wait" : "disabled:cursor-not-allowed"
                        }`}
                      >
                        {submitting
                          ? (preparing ?? (checks.length ? `Running safety checks… ${checksDone}/${checks.length}` : "Checking your idea…"))
                          : unchangedFailure
                            ? "Check again"
                            : paid
                              ? payLabel(tipAmount, durationPreview, effectName)
                              : "Get my claim code"}
                      </button>
                      {submitting && !redirecting && (
                        <button
                          type="button"
                          onClick={() => abortRef.current?.abort()}
                          className="mt-2 min-h-11 w-full rounded-2xl px-4 text-sm font-semibold text-zinc-300 hover:bg-zinc-800"
                        >
                          Cancel
                        </button>
                      )}
                      <p className="mt-2 text-center text-sm text-zinc-400">
                        {paid
                          ? `Starts right after payment. If it doesn't play, you're refunded automatically. Min $${pay!.minUsd}.`
                          : `Minimum tip $${cfg.minTipUSD}. Runs for ${durationPreview}s once your tip lands.`}
                      </p>
                    </div>
                  </div>
                </section>
              )}
            </div>
          </fieldset>
        </form>
      ) : (
        <ClaimView
          paid={paid || fromCheckout}
          receipt={receipt}
          code={code}
          secsLeft={secsLeft}
          status={status}
          tipAmount={tipAmount}
          durationPreview={durationPreview}
          passedChecks={passedChecks}
          onSimulate={simulateTip}
          onReset={reset}
        />
      )}
      <SafetyFooter code={code} />
    </div>
  );
}

function StepHeading({ n, id, children }: { n: number; id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="mb-4 flex items-center gap-3 text-lg font-semibold text-zinc-50">
      <span aria-hidden className="grid h-7 w-7 place-items-center rounded-full bg-zinc-800 text-sm font-bold text-brand-300">
        {n}
      </span>
      {children}
    </h2>
  );
}
