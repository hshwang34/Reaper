// The viewer-facing page. A viewer composes a hijack (preset or custom prompt +
// optional reference image), submits it, and receives a short CLAIM CODE to put
// in their tip message. The tip itself happens off-page (Streamlabs); for the
// demo, a dev "Simulate tip" control fires the same path via /api/dev/fake-tip.
//
// Product-design note: prompt text is resolved server-side from a preset id, or
// moderated when custom — the viewer never controls raw prompt bytes that reach
// the model unchecked. That guardrail is the heart of the project.

import { useEffect, useMemo, useRef, useState } from "react";
import type { SubmissionStatus } from "@rh/shared";
import { api, type PublicConfig } from "../lib/api.js";
import { HubSocket } from "../lib/ws.js";
import { downscaleImage } from "../lib/image.js";

export default function PortalPage() {
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  const [presetId, setPresetId] = useState<string | null>(null);
  const [customPrompt, setCustomPrompt] = useState("");
  const [tipperName, setTipperName] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [tipAmount, setTipAmount] = useState(8);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [status, setStatus] = useState<SubmissionStatus | null>(null);
  const [now, setNow] = useState(Date.now());

  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.getConfig().then(setCfg).catch((e) => setError(e.message));
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

  const durationPreview = useMemo(() => {
    if (!cfg) return 0;
    return Math.min(
      Math.max(1, Math.floor(tipAmount * cfg.secondsPerUSD)),
      cfg.maxDurationSec,
    );
  }, [cfg, tipAmount]);

  const secsLeft =
    expiresAt != null ? Math.max(0, Math.round((expiresAt - now) / 1000)) : null;

  function pickPreset(id: string) {
    setPresetId(id);
    setCustomPrompt(""); // preset and custom are mutually exclusive
  }

  async function onImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setImageFile(file);
    setImagePreview(file ? URL.createObjectURL(file) : null);
  }

  async function submit() {
    if (!cfg) return;
    setError(null);
    if (!presetId && !customPrompt.trim()) {
      setError("Pick a preset or write a custom prompt.");
      return;
    }
    setSubmitting(true);
    try {
      const form = new FormData();
      if (presetId) form.set("presetId", presetId);
      else form.set("prompt", customPrompt.trim());
      if (tipperName.trim()) form.set("tipperName", tipperName.trim());
      if (imageFile) {
        const blob = await downscaleImage(imageFile);
        form.set("image", blob, "reference.jpg");
      }
      const res = await api.submit(form);
      setCode(res.code);
      setExpiresAt(res.expiresAt);
      setStatus({ code: res.code, state: "pending" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function simulateTip() {
    if (!code) return;
    // Real viewers tip via Streamlabs with the code in the message; this is the
    // demo shortcut that drives the identical server-side path.
    await api.fakeTip(tipAmount, `Reality hijack ${code}`, tipperName || undefined);
  }

  function reset() {
    setCode(null);
    setExpiresAt(null);
    setStatus(null);
    setPresetId(null);
    setCustomPrompt("");
    setImageFile(null);
    setImagePreview(null);
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
        <h1 className="bg-gradient-to-r from-fuchsia-400 to-cyan-400 bg-clip-text text-3xl font-black text-transparent">
          Reality Hijack
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
        <div className="space-y-6">
          {/* Presets */}
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-zinc-500">
              Choose an effect
            </h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {cfg.presets.map((p) => (
                <button
                  key={p.id}
                  onClick={() => pickPreset(p.id)}
                  className={`rounded-xl border p-3 text-left transition ${
                    presetId === p.id
                      ? "border-fuchsia-500 bg-fuchsia-500/10"
                      : "border-zinc-800 bg-zinc-900 hover:border-zinc-600"
                  }`}
                >
                  <div className="text-2xl">{p.emoji}</div>
                  <div className="mt-1 text-sm font-semibold">{p.label}</div>
                </button>
              ))}
            </div>
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
                placeholder="e.g. turn the room into a snow globe"
                rows={2}
                className="w-full rounded-xl border border-zinc-800 bg-zinc-900 p-3 text-sm outline-none focus:border-cyan-500"
              />
              <p className="mt-1 text-xs text-zinc-600">
                Custom prompts are checked against the streamer's guardrails
                before they run.
              </p>
            </section>
          )}

          {/* Reference image */}
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-zinc-500">
              Reference image <span className="text-zinc-600">(optional)</span>
            </h2>
            <div className="flex items-center gap-3">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={onImage}
                className="text-sm text-zinc-400 file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-zinc-200"
              />
              {imagePreview && (
                <img
                  src={imagePreview}
                  alt="reference"
                  className="h-12 w-12 rounded-lg object-cover"
                />
              )}
            </div>
          </section>

          {/* Identity + amount */}
          <section className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-sm">
              <span className="text-zinc-400">Name you'll tip as</span>
              <input
                value={tipperName}
                onChange={(e) => setTipperName(e.target.value)}
                placeholder="optional"
                className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-zinc-400">
                Tip amount → {durationPreview}s
              </span>
              <input
                type="number"
                min={1}
                value={tipAmount}
                onChange={(e) => setTipAmount(Number(e.target.value))}
                className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm"
              />
            </label>
          </section>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <button
            onClick={submit}
            disabled={submitting}
            className="w-full rounded-xl bg-gradient-to-r from-fuchsia-600 to-cyan-600 px-4 py-3 font-bold hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? "Submitting…" : "Get my claim code"}
          </button>
          <p className="text-center text-xs text-zinc-600">
            Minimum tip ${cfg.minTipUSD}. Effect runs for{" "}
            {durationPreview}s once your tip lands.
          </p>
        </div>
      ) : (
        <ClaimView
          code={code}
          secsLeft={secsLeft}
          status={status}
          tipAmount={tipAmount}
          durationPreview={durationPreview}
          onSimulate={simulateTip}
          onReset={reset}
        />
      )}
    </div>
  );
}

function ClaimView(props: {
  code: string;
  secsLeft: number | null;
  status: SubmissionStatus | null;
  tipAmount: number;
  durationPreview: number;
  onSimulate: () => void;
  onReset: () => void;
}) {
  const { code, secsLeft, status, tipAmount, durationPreview } = props;
  const expired = status?.state === "expired" || secsLeft === 0;

  return (
    <div className="space-y-6 text-center">
      <div className="rounded-2xl border border-fuchsia-500/40 bg-fuchsia-500/5 p-6">
        <p className="text-sm text-zinc-400">
          Include this code in your tip message:
        </p>
        <p className="my-2 font-mono text-5xl font-black tracking-[0.3em] text-fuchsia-300">
          {code}
        </p>
        {secsLeft != null && !expired && (
          <p className="text-xs text-zinc-500">
            expires in {Math.floor(secsLeft / 60)}:
            {String(secsLeft % 60).padStart(2, "0")}
          </p>
        )}
      </div>

      <StatusTimeline status={status} expired={expired} />

      {/* Dev-only shortcut: fire the same server path a real Streamlabs tip
          would, so the whole demo runs on one machine. */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
        <p className="mb-2 text-xs uppercase tracking-widest text-zinc-500">
          Demo · simulate the tip
        </p>
        <button
          onClick={props.onSimulate}
          disabled={expired}
          className="w-full rounded-lg bg-emerald-600 px-4 py-2 font-semibold hover:bg-emerald-500 disabled:opacity-50"
        >
          Send ${tipAmount} test tip ({durationPreview}s)
        </button>
      </div>

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
}: {
  status: SubmissionStatus | null;
  expired: boolean;
}) {
  const state = expired ? "expired" : (status?.state ?? "pending");
  const label: Record<string, string> = {
    pending: "Waiting for your tip…",
    matched: "Tip received — queued!",
    queued: `In queue${status?.queuePosition ? ` · position ${status.queuePosition}` : ""}`,
    live: `LIVE${status?.remainingSec != null ? ` · ${status.remainingSec}s left` : ""}`,
    done: "Hijack complete 🎉",
    expired: "Expired — no tip arrived in time.",
    failed: `Failed — ${status?.message ?? "error"}`,
  };
  const tone =
    state === "live"
      ? "text-fuchsia-300"
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
