// Isolated Decart realtime diagnostic — NO loopback, NO OBS, NO state machine.
// Just: camera → lucy-2.5 → output video, with a connectivity preflight and
// full event logging. This answers "does the Decart pipeline work at all?"
// independent of the rest of the app. Open at /decart-test.

import { useEffect, useRef, useState } from "react";
import { createDecartClient, models } from "@decartai/sdk";
import { PRESETS } from "@rh/shared";
import { api } from "../lib/api.js";
import { acquireCamera, DecartSession } from "../router/decartSession.js";
import { downscaleImage } from "../lib/image.js";

const DEFAULT_PROMPT =
  "Transform the person into an ancient Egyptian mummy wrapped head to toe in tattered beige linen bandages, dusty and weathered, dim golden tomb lighting";

/** Save a Blob through a temporary anchor (the browser's download folder). */
function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Record a MediaStream for `sec` seconds and resolve with the WebM blob. */
function recordFor(stream: MediaStream, sec: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9"
      : "video/webm";
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onerror = () => reject(new Error("MediaRecorder error"));
    rec.onstop = () => resolve(new Blob(chunks, { type: mime }));
    rec.start(250);
    setTimeout(() => rec.state !== "inactive" && rec.stop(), sec * 1000);
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Published per-second price used for the cost estimate. */
const USD_PER_SEC = 0.02;

/**
 * Open a Decart session and resolve with the styled stream once it has
 * really started: Decart reports `generating` AND the remote video track is
 * flowing (RTP starts before generation does, so a track alone is not enough —
 * the same rule as the router's buffering gate). Rejects after 20 s.
 */
function connectAndWait(session: DecartSession, args: Omit<Parameters<DecartSession["start"]>[0], "onRemoteStream" | "onGenerating">): Promise<MediaStream> {
  return new Promise((resolve, reject) => {
    let remote: MediaStream | null = null;
    let generating = false;
    const timer = setTimeout(() => reject(new Error("no styled frame within 20s")), 20_000);
    const check = () => {
      const t = remote?.getVideoTracks()[0];
      if (!remote || !generating || !t) return;
      const go = () => {
        clearTimeout(timer);
        resolve(remote!);
      };
      if (t.muted) t.onunmute = go;
      else go();
    };
    session
      .start({
        ...args,
        onRemoteStream: (s) => {
          remote = s;
          check();
        },
        onGenerating: () => {
          generating = true;
          check();
        },
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

export default function DecartTestPage() {
  const inRef = useRef<HTMLVideoElement>(null);
  const outRef = useRef<HTMLVideoElement>(null);
  const clientRef = useRef<{ disconnect: () => void } | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mountedRef = useRef(true);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [clipPreset, setClipPreset] = useState(PRESETS[0]!.id);
  const [clipSec, setClipSec] = useState(10);
  const [recording, setRecording] = useState(false);
  // Batch recorder ("Record all effects"): one camera grant, every effect in turn.
  const [batching, setBatching] = useState(false);
  const [progress, setProgress] = useState("");
  const [samplePhoto, setSamplePhoto] = useState<File | null>(null);
  const stopRef = useRef(false);
  const batchCamRef = useRef<MediaStream | null>(null);
  const batchSessionRef = useRef<DecartSession | null>(null);

  // Leaving the page must release the camera and the (billed) Decart
  // session — previously only the Stop button did, so navigating away left
  // both running.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      release();
    };
  }, []);

  function release() {
    try {
      clientRef.current?.disconnect();
    } catch {
      /* */
    }
    clientRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    stopRef.current = true;
    batchSessionRef.current?.disconnect();
    batchSessionRef.current = null;
    batchCamRef.current?.getTracks().forEach((t) => t.stop());
    batchCamRef.current = null;
  }

  /** Presets the batch will actually run (photo-swap needs the sample photo). */
  const batchPresets = PRESETS.filter((p) => !p.needsImage || samplePhoto);
  const batchCost = batchPresets.length * clipSec * USD_PER_SEC;

  /**
   * Record EVERY effect from one sitting (the PM's webcam is the demo streamer):
   * one camera grant for the whole batch, then per preset — mint a capped dev
   * token, connect, wait for the first real frame, let it settle 2 s, record
   * before + after for `clipSec`, download both, disconnect. The camera is
   * released only at the very end, so the lighting and framing stay identical
   * across all 17 clips. Output feeds `site/tools/encode-clips.sh --app`.
   */
  async function recordAll() {
    stopRef.current = false;
    setBatching(true);
    const notes: string[] = [];
    try {
      push("batch: acquiring camera…");
      const { stream } = await acquireCamera();
      batchCamRef.current = stream;
      if (inRef.current) {
        inRef.current.srcObject = stream;
        await inRef.current.play().catch(() => {});
      }
      const image = samplePhoto ? await downscaleImage(samplePhoto) : null;
      let n = 0;
      for (const preset of PRESETS) {
        if (stopRef.current) break;
        if (preset.needsImage && !image) {
          notes.push(`skipped ${preset.label} (no sample photo)`);
          push(`batch: skipping ${preset.label} — pick a sample photo first`);
          continue;
        }
        n += 1;
        setProgress(`Recording ${n} of ${batchPresets.length} · ${preset.label}`);
        const session = new DecartSession();
        batchSessionRef.current = session;
        try {
          // Headroom for connect + settle on top of the clip; the server caps dev tokens at 60 s.
          const { token } = await api.devToken(clipSec + 25);
          const out = await connectAndWait(session, {
            token,
            prompt: preset.prompt,
            enhance: true,
            imageBlob: preset.needsImage ? image : null,
            camera: stream,
          });
          push(`batch: ${preset.id} generating — settling 2s`);
          await sleep(2000);
          if (stopRef.current) break;
          const [before, after] = await Promise.all([recordFor(stream, clipSec), recordFor(out, clipSec)]);
          if (stopRef.current) break;
          download(before, `${preset.id}-before.webm`);
          await sleep(600); // browsers drop back-to-back programmatic downloads
          download(after, `${preset.id}-after.webm`);
          await sleep(600);
          push(`batch: saved ${preset.id} (${(before.size / 1e6).toFixed(1)} + ${(after.size / 1e6).toFixed(1)} MB)`);
        } catch (e) {
          notes.push(`${preset.label} failed: ${(e as Error).message}`);
          push(`batch: ${preset.id} FAILED — ${(e as Error).message}`);
        } finally {
          session.disconnect();
          batchSessionRef.current = null;
        }
      }
      push(stopRef.current ? "batch: stopped" : "batch: done — run site/tools/encode-clips.sh --app ~/Downloads/*-{before,after}.webm");
    } catch (e) {
      push("batch FAILED: " + (e as Error).message);
    } finally {
      batchSessionRef.current?.disconnect();
      batchSessionRef.current = null;
      batchCamRef.current?.getTracks().forEach((t) => t.stop());
      batchCamRef.current = null;
      setBatching(false);
      setProgress(notes.length ? `Finished with notes: ${notes.join("; ")}` : "");
    }
  }

  function stopBatch() {
    stopRef.current = true;
    batchSessionRef.current?.disconnect(); // stop billing right now
    push("batch: stopping…");
  }

  const push = (s: string) => {
    console.warn("[decart-test]", s); // mirrored to the Vite terminal
    setLog((p) => [`${new Date().toLocaleTimeString()}  ${s}`, ...p].slice(0, 80));
  };

  /**
   * Record a real clip of one preset for the marketing site (site/CLIPS.md):
   * camera → lucy-2.5 for `clipSec` seconds, raw and styled feeds captured in
   * parallel so they stay time-aligned, then disconnect. Token is capped to
   * the clip length, so the cost is bounded to clipSec × $0.02 (+ headroom).
   */
  async function recordClip() {
    const preset = PRESETS.find((p) => p.id === clipPreset);
    if (!preset) return;
    setRecording(true);
    let rt: { disconnect: () => void } | null = null;
    let camera: MediaStream | null = null;
    let done = false;
    try {
      push(`clip: acquiring camera for "${preset.label}"…`);
      const { stream } = await acquireCamera();
      camera = stream;
      if (inRef.current) {
        inRef.current.srcObject = stream;
        await inRef.current.play().catch(() => {});
      }
      push(`clip: minting ${clipSec}s token…`);
      // Dev token: ungated (no live job while recording) and capped server-side.
      const { token } = await api.devToken(clipSec + 25);
      const client = createDecartClient({ apiKey: token });

      // Resolve once the styled stream has a live, unmuted video track: that is
      // the first real frame, and the point the recording should start from.
      // Rejects on a failed connect or no first frame within 15s — otherwise
      // the button would stay stuck on "recording" with the camera held open.
      const styled = new Promise<MediaStream>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no styled frame within 15s")), 15_000);
        const ok = (out: MediaStream) => {
          clearTimeout(timer);
          resolve(out);
        };
        const arm = (out: MediaStream) => {
          const t = out.getVideoTracks()[0];
          if (!t) return false;
          if (!t.muted) ok(out);
          else t.onunmute = () => ok(out);
          return true;
        };
        void client.realtime
          .connect(stream, {
            model: models.realtime("lucy-2.5"),
            resolution: "720p",
            initialState: { prompt: { text: preset.prompt, enhance: true } },
            onConnectionChange: (st) => push("clip: conn = " + st),
            onRemoteStream: (out) => {
              if (outRef.current) {
                outRef.current.srcObject = out;
                void outRef.current.play().catch(() => {});
              }
              if (!arm(out)) out.onaddtrack = () => arm(out);
            },
          })
          .then((c) => {
            rt = c;
            // Connected after we already gave up: drop it so it doesn't bill.
            if (done) c.disconnect();
          })
          .catch((e) => {
            clearTimeout(timer);
            reject(new Error("connect FAILED: " + (e as Error).message));
          });
      });
      const out = await styled;
      push(`clip: first frame — recording ${clipSec}s (before + after)…`);
      const [before, after] = await Promise.all([
        recordFor(stream, clipSec),
        recordFor(out, clipSec),
      ]);
      download(before, `${preset.id}-before.webm`);
      download(after, `${preset.id}-after.webm`);
      push(
        `clip: saved ${preset.id}-before.webm (${(before.size / 1e6).toFixed(1)} MB) and ` +
          `${preset.id}-after.webm (${(after.size / 1e6).toFixed(1)} MB) → run site/tools/encode-clips.sh`,
      );
    } catch (e) {
      push("clip FAILED: " + (e as Error).message);
    } finally {
      done = true;
      try {
        (rt as { disconnect: () => void } | null)?.disconnect();
      } catch {
        /* already gone */
      }
      camera?.getTracks().forEach((t) => t.stop());
      setRecording(false);
      push("clip: disconnected");
    }
  }

  async function run() {
    setRunning(true);
    try {
      push("acquiring camera…");
      const { stream, usingObs } = await acquireCamera();
      streamRef.current = stream;
      if (!mountedRef.current) return release();
      const t = stream.getVideoTracks()[0];
      push(
        `camera OK (${usingObs ? "OBS Virtual Camera" : "default webcam"}) — track ${t?.readyState}, ${t?.getSettings().width}x${t?.getSettings().height}`,
      );
      if (inRef.current) {
        inRef.current.srcObject = stream;
        await inRef.current.play().catch(() => {});
      }

      push("minting token…");
      const { token } = await api.mintToken(30);
      push(`token ${token.slice(0, 8)}…`);

      const client = createDecartClient({ apiKey: token });

      push("connectivity preflight…");
      try {
        const report = await client.realtime.checkConnectivity();
        push("connectivity: " + JSON.stringify(report));
      } catch (e) {
        push("connectivity FAILED: " + (e as Error).message);
      }

      push("connecting realtime (lucy-2.5)…");
      const rt = await client.realtime.connect(stream, {
        model: models.realtime("lucy-2.5"),
        resolution: "720p",
        initialState: { prompt: { text: prompt, enhance: true } },
        onConnectionChange: (st) => push("conn = " + st),
        onRemoteStream: (out) => {
          push("onRemoteStream — video tracks: " + out.getVideoTracks().length);
          if (outRef.current) {
            outRef.current.srcObject = out;
            void outRef.current.play().catch(() => {});
          }
          out.onaddtrack = () =>
            push("addtrack → video tracks: " + out.getVideoTracks().length);
        },
      });
      clientRef.current = rt;
      if (!mountedRef.current) return release(); // left mid-connect
      rt.on("error", (e) =>
        push("ERROR: " + ((e as { message?: string })?.message ?? e)),
      );
      rt.on("generationTick", (g) => push("tick " + JSON.stringify(g)));
      rt.on("generationEnded", (g) => push("generationEnded " + JSON.stringify(g)));
      push("connect() resolved — waiting for frames…");
    } catch (e) {
      push("FAILED: " + (e as Error).message);
      setRunning(false);
    }
  }

  function stop() {
    release();
    setRunning(false);
    push("disconnected");
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <h1 className="mb-1 text-xl font-bold">AI pipeline — isolated test (developers only)</h1>
      <p className="mb-4 text-sm text-zinc-400">
        Camera → lucy-2.5 → output. No OBS, no loopback. If the right panel shows
        the restyle, the AI pipeline works.
      </p>

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={2}
        className="mb-3 w-full rounded-lg border border-zinc-800 bg-zinc-900 p-2 text-sm"
      />
      <div className="mb-4 flex gap-2">
        <button
          onClick={run}
          disabled={running}
          className="rounded-lg bg-emerald-600 px-4 py-2 font-semibold hover:bg-emerald-500 disabled:opacity-50"
        >
          Run the AI test
        </button>
        <button
          onClick={stop}
          disabled={!running}
          className="rounded-lg bg-red-600 px-4 py-2 font-semibold hover:bg-red-500 disabled:opacity-50"
        >
          Stop
        </button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-sm">
        <span className="text-zinc-400">Record clip for the site:</span>
        <select
          value={clipPreset}
          onChange={(e) => setClipPreset(e.target.value)}
          disabled={recording || running || batching}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1"
        >
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.emoji} {p.label}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-zinc-400">
          <input
            type="number"
            min={3}
            max={20}
            value={clipSec}
            onChange={(e) => setClipSec(Math.max(3, Math.min(20, Number(e.target.value) || 10)))}
            disabled={recording || running || batching}
            className="w-16 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono"
          />
          s
        </label>
        <button
          onClick={recordClip}
          disabled={recording || running || batching}
          className="rounded-md bg-fuchsia-600 px-3 py-1 font-semibold hover:bg-fuchsia-500 disabled:opacity-50"
        >
          {recording ? "Recording…" : "Record"}
        </button>
        <span className="text-xs text-zinc-500">
          ≈ ${(clipSec * 0.02).toFixed(2)} of compute · downloads before/after .webm
        </span>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-sm">
        <span className="text-zinc-400">Record all effects ({PRESETS.length}):</span>
        <label className="flex items-center gap-2 text-zinc-400">
          Sample photo (for Photo swap)
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={batching}
            onChange={(e) => setSamplePhoto(e.target.files?.[0] ?? null)}
            className="max-w-48 text-xs"
          />
        </label>
        <button
          onClick={recordAll}
          disabled={recording || running || batching}
          className="rounded-md bg-fuchsia-600 px-3 py-1 font-semibold hover:bg-fuchsia-500 disabled:opacity-50"
        >
          {batching ? "Recording…" : "Record all effects"}
        </button>
        <button
          onClick={stopBatch}
          disabled={!batching}
          className="rounded-md bg-red-600 px-3 py-1 font-semibold hover:bg-red-500 disabled:opacity-50"
        >
          Stop
        </button>
        <span className="text-xs text-zinc-500">
          ≈ ${batchCost.toFixed(2)} ({batchPresets.length} × {clipSec}s × ${USD_PER_SEC}) · uses the clip length above
          {!samplePhoto && " · Photo swap is skipped without a sample photo"}
        </span>
        {progress && <p className="w-full text-sm text-fuchsia-300" role="status">{progress}</p>}
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3">
        <div>
          <p className="mb-1 text-xs text-zinc-500">Camera (input)</p>
          <video ref={inRef} muted playsInline className="w-full rounded-lg border border-zinc-800 bg-black aspect-video object-cover" />
        </div>
        <div>
          <p className="mb-1 text-xs text-zinc-500">AI output</p>
          <video ref={outRef} muted playsInline className="w-full rounded-lg border border-fuchsia-800 bg-black aspect-video object-cover" />
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
        <p className="mb-2 text-xs uppercase tracking-widest text-zinc-500">log</p>
        <div className="max-h-72 space-y-0.5 overflow-y-auto font-mono text-xs text-zinc-300">
          {log.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      </div>
    </div>
  );
}
