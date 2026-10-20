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
  type SubmissionStatus,
} from "@rh/shared";
import { api, type PaymentsInfo, type PublicConfig } from "../lib/api.js";
import { HubSocket } from "../lib/ws.js";
import { channelSlug } from "../lib/channel.js";
import { downscaleImage } from "../lib/image.js";
import { SafetyChecklist, SafetyFindings } from "./SafetyChecks.js";

/** Hard client-side ceiling on the raw file before downscaling (Decart's own
 *  reference-image limit is 10 MB post-encode; we shrink to 720p so any
 *  sensible photo fits — this only stops multi-hundred-MB mistakes). */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** A rejected submission, pinned to exactly what was checked. */
interface Failure {
  findings: SafetyFinding[];
  checks: CheckResult[];
  prompt: string | null;
  image: File | null;
}

/** Server messages are lower-case fragments; sentence-case them for display. */
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default function PortalPage() {
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  const [presetId, setPresetId] = useState<string | null>(null);
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
  const [tipAmount, setTipAmount] = useState(8);

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
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [status, setStatus] = useState<SubmissionStatus | null>(null);
  const [now, setNow] = useState(Date.now());

  const fileRef = useRef<HTMLInputElement>(null);
  /** Hosted payments for this channel (null = claim-code flow). */
  const [pay, setPay] = useState<PaymentsInfo | null>(null);
  const paid = pay?.enabled === true;

  useEffect(() => {
    api.getConfig().then(setCfg).catch((e) => setError(e.message));
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
      setStatus({ code: back, state: "pending", message: "Payment received — your effect is next in line." });
      history.replaceState(null, "", location.pathname);
    }
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Subscribe to live status for this submission once we have a code.
  useEffect(() => {
    if (!code) return;
    const hub = new HubSocket("portal", code).connect();
    const off = hub.on((m) => {
      if (m.t === "submission:update" && m.status.code === code) {
        setStatus(m.status);
      }
    });
    return () => {
      off();
      hub.close();
    };
  }, [code]);

  // Same formula the engine bills with (shared/settings.ts) — the preview a
  // viewer sees is exactly the duration they will get.
  const durationPreview = useMemo(
    () => (cfg ? computeDurationSec(tipAmount, cfg) : 0),
    [cfg, tipAmount],
  );

  const secsLeft =
    expiresAt != null ? Math.max(0, Math.round((expiresAt - now) / 1000)) : null;

  const selectedPreset = cfg?.presets.find((p) => p.id === presetId) ?? null;

  function pickPreset(id: string) {
    setPresetId(id);
    setCustomPrompt(""); // preset and custom are mutually exclusive
  }

  async function onImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setError(null);
    if (file && file.size > MAX_UPLOAD_BYTES) {
      // Decart's own ceiling is 10 MB; we downscale to 720p before upload so
      // anything under this cap is fine. Bigger files just stall the submit.
      setError("That image is over 25 MB — please pick a smaller one.");
      e.target.value = "";
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

  async function submit() {
    if (!cfg || submitting) return;
    setError(null);
    setFailure(null);
    setChecks([]);
    if (!presetId && !customPrompt.trim()) {
      setError("Pick a preset or write a custom prompt.");
      return;
    }
    if (selectedPreset?.needsImage && !imageFile) {
      setError(`"${selectedPreset.label}" needs a reference photo — add one below.`);
      return;
    }
    if (selectedPreset?.needsImage && !consent) {
      setError("Tick the consent box — you need permission to put someone's face on stream.");
      return;
    }
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
          const { url } = await api.checkout(res.code, tipAmount, tipperName.trim());
          location.href = url;
          return;
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
      } else if (res.findings.length) {
        setFailure({ findings: res.findings, checks: res.checks, prompt: checkedPrompt, image: checkedImage });
      } else {
        setError(sentence(res.error));
      }
    } catch (e) {
      if (ac.signal.aborted) return;
      setError((e as Error).message);
    } finally {
      setPreparing(null);
      setSubmitting(false);
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
    setCustomPrompt("");
    setImageFile(null);
    replacePreview(null);
    setEnhance(true);
    setConsent(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  if (!cfg) {
    return (
      <div className="grid h-screen place-items-center text-zinc-500">
        {error ?? "Loading…"}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl p-6">
      <header className="mb-6 text-center">
        <h1 className="text-3xl font-black text-zinc-100">
          Your turn to hijack the stream.
        </h1>
        <p className="mt-1 text-sm text-zinc-400">
          Transform the streamer's room in real time. $
          {cfg.secondsPerUSD === 1 ? "1 = 1 second" : `1 = ${cfg.secondsPerUSD}s`}.
        </p>
        {!cfg.decartEnabled && (
          <p className="mt-2 inline-block rounded bg-amber-900/40 px-2 py-0.5 text-xs text-amber-300">
            demo mode — camera passthrough (no Decart key)
          </p>
        )}
      </header>

      {!code ? (
        <form
          className="space-y-6"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <fieldset disabled={submitting} className="mx-0 min-w-0 space-y-6 border-0 p-0">
          {/* Presets */}
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-zinc-500">
              Choose an effect
            </h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {cfg.presets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={presetId === p.id}
                  onClick={() => pickPreset(p.id)}
                  className={`relative rounded-xl border p-3 text-left transition ${
                    presetId === p.id
                      ? "border-brand-500 bg-brand-500/10"
                      : "border-zinc-800 bg-zinc-900 hover:border-zinc-600"
                  }`}
                >
                  <div className="text-2xl">{p.emoji}</div>
                  <div className="mt-1 text-sm font-semibold">{p.label}</div>
                  {p.needsImage && (
                    <span
                      className={`absolute right-2 top-2 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                        imageFile
                          ? "bg-emerald-500/20 text-emerald-300"
                          : "bg-zinc-800 text-zinc-400"
                      }`}
                    >
                      {imageFile ? "photo ✓" : "needs photo"}
                    </span>
                  )}
                </button>
              ))}
            </div>
            {selectedPreset?.needsImage && !imageFile && (
              <p className="mt-2 text-xs text-amber-300">
                This effect puts the person from your photo on camera — attach a
                reference image below to use it.
              </p>
            )}
          </section>

          {/* Custom prompt */}
          {cfg.allowCustomPrompts && (
            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-zinc-500">
                …or write your own
              </h2>
              <textarea
                value={customPrompt}
                onChange={(e) => {
                  setCustomPrompt(e.target.value);
                  if (e.target.value) setPresetId(null);
                }}
                onKeyDown={(e) => {
                  // Enter submits, Shift+Enter breaks the line. Never mid-IME
                  // composition: Enter there confirms a Hangul/kana candidate.
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder="e.g. turn the room into a snow globe"
                rows={2}
                className="w-full rounded-xl border border-zinc-800 bg-zinc-900 p-3 text-sm outline-none focus:border-brand-500"
              />
              <p className="mt-1 text-xs text-zinc-600">
                Checked by an AI moderator against the streamer's rules before
                you get a code — no nudity, real people, hate or gore.
                {cfg.customPromptsNeedApproval &&
                  " The streamer also approves each custom effect before it runs."}
                <span className="hidden sm:inline"> Enter to submit · Shift+Enter for a new line.</span>
              </p>
            </section>
          )}

          {/* Reference image — lucy-2.5 uses it as a character/style anchor.
              Only offered when the streamer's tier AND the host's classifiers
              allow it (cfg.referenceImages is the effective tier). */}
          {cfg.referenceImages !== "off" && (
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-zinc-500">
              Reference photo{" "}
              <span className="text-zinc-600">
                {selectedPreset?.needsImage ? "(required for this effect)" : "(optional)"}
              </span>
            </h2>
            <div className="flex items-center gap-3">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={onImage}
                className="min-w-0 flex-1 text-sm text-zinc-400 file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-zinc-200"
              />
              {imagePreview && (
                <div className="relative shrink-0">
                  <img
                    src={imagePreview}
                    alt="reference"
                    className="h-14 w-14 rounded-lg object-cover"
                  />
                  <button
                    type="button"
                    onClick={clearImage}
                    aria-label="Remove reference photo"
                    className="absolute -right-2 -top-2 grid h-5 w-5 place-items-center rounded-full bg-zinc-700 text-xs text-zinc-200 hover:bg-red-500"
                  >
                    ×
                  </button>
                </div>
              )}
            </div>
            <p className="mt-1 text-xs text-zinc-600">
              {cfg.referenceImages === "scenes"
                ? "A scene or style to borrow from — a place, a painting, a texture. This stream doesn't allow photos of people."
                : "The AI uses this as a character or style anchor — a clear, well-lit photo works best. Mention it in a custom prompt (“the person in the reference image…”)."}{" "}
              Checked by a safety filter, then deleted after your effect runs.
              JPEG, PNG or WebP; resized to 720p before upload.
            </p>
            {imageFile && cfg.referenceImages === "likeness" && (
              <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-xl border border-amber-700/50 bg-amber-950/30 p-3">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-amber-500"
                />
                <span className="text-xs text-amber-100">
                  {cfg.consentStatement}
                  <span className="block text-amber-300/70">
                    Required if the photo shows a person. Public figures and
                    anyone under 18 are always refused.
                  </span>
                </span>
              </label>
            )}
          </section>
          )}

          {/* Decart prompt enhancement — the last per-session knob lucy-2.5
              exposes. On = Decart rewrites/expands the prompt (its default);
              off = literal prompt for precise edits. */}
          <section>
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-3">
              <input
                type="checkbox"
                checked={enhance}
                onChange={(e) => setEnhance(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-brand-500"
              />
              <span className="text-sm">
                <span className="font-semibold text-zinc-200">Enhance prompt</span>
                <span className="block text-xs text-zinc-500">
                  Let the AI expand your prompt for richer results. Turn off for
                  a literal, precise edit (e.g. “make the wall light blue”).
                  Your own text may run literally either way — the moderator
                  approves exactly what you wrote.
                </span>
              </span>
            </label>
          </section>

          {/* Identity + amount */}
          <section className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-sm">
              <span className="text-zinc-400">{paid ? "Your name (shown on stream)" : "Name you'll tip as"}</span>
              <input
                value={tipperName}
                onChange={(e) => setTipperName(e.target.value)}
                placeholder="optional"
                className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-zinc-400">
                {paid ? "Amount ($)" : "Tip amount"} → {durationPreview}s
              </span>
              <input
                type="number"
                min={paid ? pay!.minUsd : 1}
                value={tipAmount}
                onChange={(e) => setTipAmount(Number(e.target.value))}
                className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm"
              />
            </label>
          </section>

          </fieldset>
          {paid && !pay!.live && (
            <p className="rounded-lg bg-amber-900/30 px-3 py-2 text-sm text-amber-300">
              Hijacks are paused right now — the streamer's Stream Hijack
              app isn't live. Check back when they're streaming.
            </p>
          )}

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
          {error && (
            <p role="alert" className="text-sm text-red-400">
              {error}
            </p>
          )}

          {/* Re-sending exactly what just failed would fail the same way —
              and cost the viewer a strike — so it waits for an edit. */}
          <button
            type="submit"
            disabled={submitting || unchangedFailure || (paid && !pay!.live)}
            className={`w-full rounded-xl bg-brand-600 px-4 py-3 font-bold hover:opacity-90 disabled:opacity-50 ${
              submitting ? "disabled:cursor-wait" : "disabled:cursor-not-allowed"
            }`}
          >
            {submitting
              ? (preparing ?? (checks.length ? `Running safety checks… ${checksDone}/${checks.length}` : "Checking…"))
              : unchangedFailure
                ? "Edit your request to check again"
                : paid
                  ? `Pay $${tipAmount} — ${durationPreview}s hijack`
                : "Get my claim code"}
          </button>
          <p className="text-center text-xs text-zinc-600">
            {paid ? (
              <>
                Minimum ${pay!.minUsd}. Secure payment by Stripe. If the hijack
                never starts, you're refunded automatically.
              </>
            ) : (
              <>
                Minimum tip ${cfg.minTipUSD}. Effect runs for {durationPreview}s
                once your tip lands.
              </>
            )}
          </p>
        </form>
      ) : (
        <ClaimView
          paid={paid || status?.message?.startsWith("Payment received") === true}
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

/** Report + removal request (CONTENT-SAFETY S5). Both land in the streamer's
 *  moderation log; a removal request naming an image URL acts immediately,
 *  and the 48-hour clock (TAKE IT DOWN Act) starts at submission. */
function SafetyFooter({ code }: { code: string | null }) {
  const [open, setOpen] = useState<null | "report" | "takedown">(null);
  const [text, setText] = useState("");
  const [contact, setContact] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function send() {
    setErr(null);
    try {
      if (open === "report") {
        await api.report(text.trim(), code ? { code } : {});
        setDone("Thanks — the streamer's moderation log has your report.");
      } else {
        const r = await api.takedown({
          contact: contact.trim(),
          description: text.trim(),
          imageUrl: imageUrl.trim() || undefined,
        });
        setDone(
          `Request ${r.ticket.slice(0, 8)} received${r.removed ? ` — ${r.removed} file(s) removed now` : ""}. We act on removal requests within 48 hours.`,
        );
      }
      setOpen(null);
      setText("");
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <footer className="mt-10 border-t border-zinc-900 pt-4 text-center text-xs text-zinc-600">
      {done && <p className="mb-2 text-emerald-400">{done}</p>}
      {!open ? (
        <p className="space-x-3">
          <button className="underline hover:text-zinc-300" onClick={() => setOpen("report")}>
            Report a problem
          </button>
          <button className="underline hover:text-zinc-300" onClick={() => setOpen("takedown")}>
            Request removal of an image of you
          </button>
        </p>
      ) : (
        <div className="space-y-2 text-left">
          {open === "takedown" && (
            <>
              <input
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                placeholder="How we can reach you (email)"
                className="w-full rounded bg-zinc-900 px-2 py-1 text-sm"
              />
              <input
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                placeholder="Image link, if you have it (optional)"
                className="w-full rounded bg-zinc-900 px-2 py-1 text-sm"
              />
            </>
          )}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            placeholder={open === "report" ? "What was wrong?" : "What should be removed, and when you saw it"}
            className="w-full rounded bg-zinc-900 px-2 py-1 text-sm"
          />
          {err && <p className="text-red-400">{err}</p>}
          <div className="flex justify-end gap-3">
            <button className="text-zinc-500" onClick={() => setOpen(null)}>
              Cancel
            </button>
            <button
              className="rounded bg-zinc-800 px-3 py-1 text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
              disabled={!text.trim() || (open === "takedown" && !contact.trim())}
              onClick={() => void send()}
            >
              Send
            </button>
          </div>
        </div>
      )}
    </footer>
  );
}

function ClaimView(props: {
  /** Paid through Stripe: there's no code to copy, just the live status. */
  paid: boolean;
  code: string;
  secsLeft: number | null;
  status: SubmissionStatus | null;
  tipAmount: number;
  durationPreview: number;
  /** Safety checks this submission passed (0 for a plain preset). */
  passedChecks: number;
  onSimulate: () => void;
  onReset: () => void;
}) {
  const { code, secsLeft, status, tipAmount, durationPreview, passedChecks } = props;
  // The claim-code TTL only matters while we're still waiting for a tip. Once a
  // tip has matched (queued/live/done/failed), the code is consumed server-side
  // — so a lapsed TTL must not overwrite a real terminal state (e.g. flip a
  // completed "done" into a false "expired" if the viewer lingers on the page).
  const stillWaiting = !status || status.state === "pending";
  const expired = status?.state === "expired" || (stillWaiting && secsLeft === 0);
  const terminal = expired || status?.state === "done" || status?.state === "failed";

  if (props.paid) {
    return (
      <div className="space-y-6 text-center">
        <StatusTimeline status={status} expired={false} paid />
        {status?.state === "failed" && (
          <p className="text-sm text-zinc-400">
            If it never started, you're refunded automatically — it can take a
            few days to show on your statement.
          </p>
        )}
        <button onClick={props.onReset} className="text-sm text-zinc-500 underline hover:text-zinc-300">
          Hijack again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6 text-center">
      <div className="rounded-2xl border border-brand-500/40 bg-brand-500/5 p-6">
        <p className="text-sm text-zinc-400">
          Include this code in your tip message:
        </p>
        <p className="my-2 font-mono text-5xl font-black tracking-[0.3em] text-brand-300">
          {code}
        </p>
        {stillWaiting && secsLeft != null && !expired && (
          <p className="text-xs text-zinc-500">
            expires in {Math.floor(secsLeft / 60)}:
            {String(secsLeft % 60).padStart(2, "0")}
          </p>
        )}
        {passedChecks > 0 && (
          <p className="mt-3 text-xs text-emerald-400">
            ✓ Passed {passedChecks === 1 ? "the safety check" : `all ${passedChecks} safety checks`}
          </p>
        )}
      </div>

      <StatusTimeline status={status} expired={expired} />

      {/* Dev-only shortcut: fire the same server path a real Streamlabs tip
          would, so the whole demo runs on one machine. Hidden on the hosted
          portal (/c/…) — there the endpoint is streamer-authed and viewers
          pay through the real tip rail. */}
      {!channelSlug() && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
          <p className="mb-2 text-xs uppercase tracking-widest text-zinc-500">
            Demo · simulate the tip
          </p>
          <button
            onClick={props.onSimulate}
            disabled={terminal}
            className="w-full rounded-lg bg-emerald-600 px-4 py-2 font-semibold hover:bg-emerald-500 disabled:opacity-50"
          >
            Send ${tipAmount} test tip ({durationPreview}s)
          </button>
        </div>
      )}

      <button
        onClick={props.onReset}
        className="text-sm text-zinc-500 underline hover:text-zinc-300"
      >
        Start over
      </button>
    </div>
  );
}

function StatusTimeline({
  status,
  expired,
  paid = false,
}: {
  status: SubmissionStatus | null;
  expired: boolean;
  paid?: boolean;
}) {
  const state = expired ? "expired" : (status?.state ?? "pending");
  const label: Record<string, string> = {
    pending: paid ? "Payment received — starting soon…" : "Waiting for your tip…",
    review: "Tip received — waiting for the streamer to approve…",
    matched: "Tip received — queued!",
    queued: `In queue${status?.queuePosition ? ` · position ${status.queuePosition}` : ""}`,
    live: `LIVE${status?.remainingSec != null ? ` · ${status.remainingSec}s left` : ""}`,
    done: "Hijack complete 🎉",
    expired: "Expired — no tip arrived in time.",
    failed: `Failed — ${status?.message ?? "error"}`,
  };
  const tone =
    state === "live"
      ? "text-brand-300"
      : state === "done"
        ? "text-emerald-400"
        : state === "expired" || state === "failed"
          ? "text-red-400"
          : "text-zinc-300";
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <p className={`font-semibold ${tone}`}>{label[state]}</p>
      {status?.message && state !== "failed" && (
        <p className="mt-1 text-xs text-zinc-500">{status.message}</p>
      )}
    </div>
  );
}
