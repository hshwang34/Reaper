// The display surface loaded inside an OBS Browser Source. Deliberately dumb:
// receive the loopback stream, render it full-bleed, and — critically — gate on
// verified decoded frames before telling the router it's safe to unhide OBS.
//
// This page needs NO camera/mic permission (it only *receives* video), which is
// why it works inside OBS's CEF where the capturing router page cannot.

import { useEffect, useRef, useState } from "react";
import { HubSocket } from "../lib/ws.js";
import { LoopbackReceiver } from "../lib/loopback.js";
import { debugLog, setDebugSink } from "../lib/debug.js";

const FRAMES_REQUIRED = 10; // consecutive decoded frames before we call it "up"
// The hijack dissolves in from a blur over the real camera (this page is
// transparent, and OBS stacks it on top of the camera), then dissolves back
// out. The fade softens the cut AND hides the AI feed's few-hundred-ms lag
// behind the camera, which a plain crossfade would show as a ghosted double.
const FADE_IN_MS = 500;
const FADE_OUT_MS = 400; // keep in sync with DEFAULT_TIMEOUTS.fadeOutMs (router/ports.ts)
const FADE_BLUR_PX = 24;
// Only a direct browser preview shows the "standby" label — inside OBS it
// could flash on stream in the instant between the fade-out and the hide.
const IN_OBS = typeof window !== "undefined" && "obsstudio" in window;

type Fade = { shown: boolean; ms: number };

export default function ViewerPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [fade, setFade] = useState<Fade>({ shown: false, ms: 0 });
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    // Transparent page: whatever isn't the (faded-in) AI feed shows the real
    // camera underneath in OBS. The shared stylesheet paints body dark.
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    const hub = new HubSocket("viewer").connect();
    setDebugSink((line) => hub.send({ t: "page:log", line }));
    const video = videoRef.current!;
    let sentOkForJob = "";

    const onStream = (stream: MediaStream, jobId: string) => {
      setConnected(true);
      // Start invisible. The fade-in waits for rtc:reveal (sent once OBS has
      // actually unhidden us) — the source is hidden and unrendered until then.
      setFade({ shown: false, ms: 0 });
      video.srcObject = stream;
      void video.play().catch(() => {});

      // Frame gate — must work while this source is HIDDEN in OBS. A hidden
      // browser source is not rendered, so rendering-based signals
      // (requestVideoFrameCallback / rAF) never fire and would deadlock the
      // show-when-ready handshake. Instead gate on MEDIA ARRIVAL: a remote
      // WebRTC video track starts `muted` and fires `onunmute` exactly when
      // real video data flows — rendering not required, black screen still
      // impossible.
      const sendOk = (why: string) => {
        if (video.srcObject !== stream || sentOkForJob === jobId) return;
        sentOkForJob = jobId;
        debugLog("viewer", "frames-ok →", why);
        hub.send({ t: "viewer:frames-ok", jobId });
      };
      const track = stream.getVideoTracks()[0];
      if (track) {
        if (!track.muted) sendOk("track already unmuted");
        else track.onunmute = () => sendOk("track unmuted (media flowing)");
        // Media stopping mid-job is the one signal that survives a frozen
        // router tab — it's how the Decart session cap is observed firing.
        track.onmute = () => debugLog("viewer", "track muted (media stopped)");
        track.onended = () => debugLog("viewer", "track ended");
      }
      // Belt-and-suspenders: if the tab IS rendering (e.g. previewed in a
      // normal browser), decoded frames confirm too — whichever fires first.
      const anyVideo = video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => number;
      };
      if (typeof anyVideo.requestVideoFrameCallback === "function") {
        let seen = 0;
        const tick = () => {
          if (video.srcObject !== stream) return; // superseded by a new job
          seen += 1;
          if (seen >= FRAMES_REQUIRED) return sendOk(`${seen} rendered frames`);
          anyVideo.requestVideoFrameCallback!(tick);
        };
        anyVideo.requestVideoFrameCallback(tick);
      }
    };

    const onReveal = () => {
      debugLog("viewer", "reveal — fading in");
      setFade({ shown: true, ms: FADE_IN_MS });
    };

    // instant = panic/cancel: the router already hid OBS; just vanish.
    const onReset = (_jobId: string, instant: boolean) => {
      const ms = instant ? 0 : FADE_OUT_MS;
      setFade({ shown: false, ms });
      setTimeout(() => {
        setConnected(false);
        video.srcObject = null;
      }, ms);
    };

    const receiver = new LoopbackReceiver(hub, onStream, onReset, onReveal);

    return () => {
      // StrictMode double-mounts effects in dev: without this the first
      // receiver would keep its peer + hub listener alive alongside the second.
      setDebugSink(null);
      receiver.dispose();
      hub.close();
    };
  }, []);

  return (
    <div className="relative h-screen w-screen overflow-hidden">
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          // Exact frame size — the OBS-side crop calibration depends on this.
          debugLog("viewer", `frame ${v.videoWidth}x${v.videoHeight}`);
        }}
        // Fires on every mid-stream resolution change — the loopback's
        // quality ramp (or collapse) shows up here, as OBS actually sees it.
        onResize={(e) => {
          const v = e.currentTarget;
          debugLog("viewer", `resized ${v.videoWidth}x${v.videoHeight}`);
        }}
        // object-fill maps the frame 1:1 onto the 1280x720 page, so OBS-side
        // pixel crops line up with frame pixels. (cover would re-crop/scale
        // whenever the frame isn't exactly 16:9, silently shifting geometry.)
        className="h-full w-full"
        style={{
          objectFit: "fill",
          opacity: fade.shown ? 1 : 0,
          filter: `blur(${fade.shown ? 0 : FADE_BLUR_PX}px)`,
          // ease-out in (lands softly), ease-in out (lets go gradually).
          transition:
            fade.ms > 0
              ? `opacity ${fade.ms}ms ${fade.shown ? "ease-out" : "ease-in"}, filter ${fade.ms}ms ${fade.shown ? "ease-out" : "ease-in"}`
              : "none",
        }}
      />
      {!connected && !IN_OBS && (
        <div className="absolute inset-0 grid place-items-center text-zinc-700">
          {/* Invisible in OBS until a hijack starts; handy when previewing the
              page directly in a browser. */}
          <span className="text-sm tracking-widest uppercase">standby</span>
        </div>
      )}
    </div>
  );
}
