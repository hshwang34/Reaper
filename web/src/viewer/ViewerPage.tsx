// The display surface loaded inside an OBS Browser Source. Deliberately dumb:
// receive the loopback stream, render it full-bleed, and — critically — gate on
// verified decoded frames before telling the router it's safe to unhide OBS.
//
// This page needs NO camera/mic permission (it only *receives* video), which is
// why it works inside OBS's CEF where the capturing router page cannot.

import { useEffect, useRef, useState } from "react";
import { HubSocket } from "../lib/ws.js";
import { LoopbackReceiver } from "../lib/loopback.js";

const FRAMES_REQUIRED = 10; // consecutive decoded frames before we call it "up"
const WIPE_MS = 420;

export default function ViewerPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [wipe, setWipe] = useState<"in" | "out" | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const hub = new HubSocket("viewer").connect();
    const video = videoRef.current!;
    let sentOkForJob = "";

    const flashWipe = (dir: "in" | "out") => {
      setWipe(dir);
      setTimeout(() => setWipe(null), WIPE_MS);
    };

    const onStream = (stream: MediaStream, jobId: string) => {
      setConnected(true);
      video.srcObject = stream;
      void video.play().catch(() => {});
      flashWipe("in");

      // Frame gate: count real decoded frames, then report once per job.
      const anyVideo = video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => number;
      };
      if (typeof anyVideo.requestVideoFrameCallback === "function") {
        let seen = 0;
        const tick = () => {
          if (video.srcObject !== stream) return; // superseded by a new job
          seen += 1;
          if (seen >= FRAMES_REQUIRED) {
            if (sentOkForJob !== jobId) {
              sentOkForJob = jobId;
              hub.send({ t: "viewer:frames-ok", jobId });
            }
            return;
          }
          anyVideo.requestVideoFrameCallback!(tick);
        };
        anyVideo.requestVideoFrameCallback(tick);
      } else {
        // Fallback for engines without rVFC: a short settle delay.
        setTimeout(() => {
          if (video.srcObject === stream && sentOkForJob !== jobId) {
            sentOkForJob = jobId;
            hub.send({ t: "viewer:frames-ok", jobId });
          }
        }, 600);
      }
    };

    const onReset = () => {
      flashWipe("out");
      setConnected(false);
      setTimeout(() => {
        video.srcObject = null;
      }, WIPE_MS);
    };

    new LoopbackReceiver(hub, onStream, onReset);

    return () => {
      hub.close();
    };
  }, []);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black">
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className="h-full w-full object-cover"
      />
      {/* Glitch wipe covers the cut in/out so the latency-jump reads as an
          intentional effect rather than a stutter. */}
      {wipe && (
        <div
          className={`pointer-events-none absolute inset-0 ${
            wipe === "in" ? "animate-[wipeIn_420ms_ease-out]" : "animate-[wipeOut_420ms_ease-in]"
          }`}
          style={{
            background:
              "repeating-linear-gradient(0deg, rgba(255,0,120,0.35) 0px, rgba(0,255,220,0.35) 3px, rgba(0,0,0,0.6) 6px)",
            mixBlendMode: "screen",
          }}
        />
      )}
      {!connected && (
        <div className="absolute inset-0 grid place-items-center text-zinc-700">
          {/* Invisible in OBS until a hijack starts; handy when previewing the
              page directly in a browser. */}
          <span className="text-sm tracking-widest uppercase">standby</span>
        </div>
      )}
      <style>{`
        @keyframes wipeIn { from { opacity: 1; transform: translateY(-100%); } to { opacity: 0; transform: translateY(0); } }
        @keyframes wipeOut { from { opacity: 0; transform: translateY(0); } to { opacity: 1; transform: translateY(100%); } }
      `}</style>
    </div>
  );
}
