// Isolated Decart realtime diagnostic — NO loopback, NO OBS, NO state machine.
// Just: camera → lucy-2.5 → output video, with a connectivity preflight and
// full event logging. This answers "does the Decart pipeline work at all?"
// independent of the rest of the app. Open at /decart-test.

import { useRef, useState } from "react";
import { createDecartClient, models } from "@decartai/sdk";
import { api } from "../lib/api.js";
import { acquireCamera } from "../router/decartSession.js";

const DEFAULT_PROMPT =
  "Transform the person into an ancient Egyptian mummy wrapped head to toe in tattered beige linen bandages, dusty and weathered, dim golden tomb lighting";

export default function DecartTestPage() {
  const inRef = useRef<HTMLVideoElement>(null);
  const outRef = useRef<HTMLVideoElement>(null);
  const clientRef = useRef<{ disconnect: () => void } | null>(null);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  const push = (s: string) => {
    console.warn("[decart-test]", s); // mirrored to the Vite terminal
    setLog((p) => [`${new Date().toLocaleTimeString()}  ${s}`, ...p].slice(0, 80));
  };

  async function run() {
    setRunning(true);
    try {
      push("acquiring camera…");
      const { stream, usingObs } = await acquireCamera();
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
    try {
      clientRef.current?.disconnect();
    } catch {
      /* */
    }
    clientRef.current = null;
    setRunning(false);
    push("disconnected");
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <h1 className="mb-1 text-xl font-bold">Decart pipeline — isolated test</h1>
      <p className="mb-4 text-sm text-zinc-400">
        Camera → lucy-2.5 → output. No OBS, no loopback. If the right panel shows
        the restyle, Decart works.
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
          Run Decart test
        </button>
        <button
          onClick={stop}
          disabled={!running}
          className="rounded-lg bg-red-600 px-4 py-2 font-semibold hover:bg-red-500 disabled:opacity-50"
        >
          Stop
        </button>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3">
        <div>
          <p className="mb-1 text-xs text-zinc-500">Camera (input)</p>
          <video ref={inRef} muted playsInline className="w-full rounded-lg border border-zinc-800 bg-black aspect-video object-cover" />
        </div>
        <div>
          <p className="mb-1 text-xs text-zinc-500">Decart output</p>
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
