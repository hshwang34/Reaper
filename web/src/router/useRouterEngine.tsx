// The router, as a hook. Everything that makes a page *the* router — the hub
// socket in the "router" role, the loopback sender into OBS's Browser Source,
// the output guard, the state machine, the camera — lives here, so two pages
// can be a router without two copies of the wiring:
//
//   · /router (the studio) — the streamer's everyday home.
//   · /setup, test step — the first-run wizard fires its free 10-second test
//     while the window is still on the wizard. Before this hook the wizard
//     was NOT a router, so the job was dispatched to nobody and the streamer
//     saw nothing happen (the hub logs "no router connected for job:start").
//
// The hook is DOM-bound (getUserMedia, WebRTC) and deliberately thin over
// RouterMachine, whose invariants are asserted in web/test/stateMachine.test.ts.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AnyMsg, RouterState, StatusSnapshot } from "@rh/shared";
import { api, type RouterConfig } from "../lib/api.js";
import { HubSocket } from "../lib/ws.js";
import { LoopbackSender } from "../lib/loopback.js";
import { setDebugSink } from "../lib/debug.js";
import { RouterMachine } from "./stateMachine.js";
import { browserPorts } from "./ports.js";
import { FrameGuard } from "./frameGuard.js";
import { acquireCamera, listCameras } from "./decartSession.js";

export interface CameraInfo {
  label: string;
  /** The device is OBS's Virtual Camera (what the product is built around). */
  usingObs: boolean;
}

export interface RouterEngine {
  state: RouterState;
  remainingSec: number | undefined;
  status: StatusSnapshot | null;
  cfg: RouterConfig | null;
  logLines: string[];
  pushLog: (line: string) => void;
  /** The model's output for the running job (null between jobs). */
  aiStream: MediaStream | null;
  /** The armed camera (null until `arm` succeeds). */
  cameraStream: MediaStream | null;
  camera: CameraInfo | null;
  armError: string | null;
  cams: { deviceId: string; label: string }[];
  camId: string;
  /** Acquire a camera and go IDLE. No argument: prefer the OBS Virtual Camera. */
  arm: (deviceId?: string) => Promise<void>;
  /** Picker fallback, only between jobs. "auto" = prefer OBS. */
  switchCamera: (id: string) => void;
  /** Toggle the engine's pause (cancels the live job). Returns the new paused flag. */
  panic: () => Promise<boolean>;
  /** Warm the output guard model (after a settings save that turns it on). */
  warmGuard: () => void;
}

export function useRouterEngine(): RouterEngine {
  const machineRef = useRef<RouterMachine | null>(null);
  const hubRef = useRef<HubSocket | null>(null);
  const guardRef = useRef<FrameGuard | null>(null);
  const camStreamRef = useRef<MediaStream | null>(null);

  const [state, setState] = useState<RouterState>("OFFLINE");
  const [remainingSec, setRemaining] = useState<number | undefined>();
  const [status, setStatus] = useState<StatusSnapshot | null>(null);
  const [cfg, setCfg] = useState<RouterConfig | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [aiStream, setAiStream] = useState<MediaStream | null>(null);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [camera, setCamera] = useState<CameraInfo | null>(null);
  const [armError, setArmError] = useState<string | null>(null);
  const [cams, setCams] = useState<{ deviceId: string; label: string }[]>([]);
  const [camId, setCamId] = useState<string>("auto");

  const pushLog = useCallback((line: string) => {
    setLogLines((prev) => [`${new Date().toLocaleTimeString()}  ${line}`, ...prev].slice(0, 40));
    hubRef.current?.send({ t: "page:log", line });
  }, []);

  useEffect(() => {
    const hub = new HubSocket("router").connect();
    hubRef.current = hub;
    setDebugSink((line) => hub.send({ t: "page:log", line }));
    const sender = new LoopbackSender(hub);
    // Output guard (CONTENT-SAFETY S4) is opt-in. When it's on, warm the
    // model now so the first guarded job doesn't spend its pre-LIVE budget
    // loading weights; when it's off, never download it.
    const guard = new FrameGuard(pushLog);
    guardRef.current = guard;
    api
      .getSettings()
      .then((s) => s.outputGuard !== "off" && void guard.ready())
      .catch(() => {});
    const machine = new RouterMachine(browserPorts(hub, sender, guard), {
      onState: (s, rem) => {
        setState(s);
        setRemaining(rem);
      },
      log: pushLog,
      onAiStream: setAiStream,
    });
    machineRef.current = machine;
    const offDrop = hub.onDrop(() => machine.abandon("lost sidecar connection"));

    const off = hub.on((m) => {
      const msg = m as AnyMsg;
      switch (msg.t) {
        case "job:start":
          void machine.runJob(msg.job);
          break;
        case "job:cancel":
          machine.cancel(msg.jobId, msg.reason);
          break;
        case "viewer:frames-ok":
          machine.onFramesOk(msg.jobId);
          break;
        case "status":
          setStatus(msg.status);
          break;
      }
    });

    // The OBS tile must track the live connection (OBS is often launched
    // after this page, and can drop mid-stream), so poll the cheap local
    // config endpoint rather than fetching it once at mount.
    const refreshCfg = () => api.getRouterConfig().then(setCfg).catch(() => {});
    void refreshCfg();
    const cfgTimer = window.setInterval(refreshCfg, 5000);

    // Panic hotkey inside the page: Escape toggles pause on the engine
    // (which cancels any active job). The streamer's face is the canvas —
    // this must be instant. (⌘⇧H is the app-wide one, registered by Electron.)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void api.panic().then(({ paused }) => pushLog(paused ? "PANIC — paused" : "resumed"));
    };
    window.addEventListener("keydown", onKey);
    const onUnload = () => void machine.dispose();
    window.addEventListener("pagehide", onUnload);

    return () => {
      off();
      offDrop();
      setDebugSink(null);
      window.clearInterval(cfgTimer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pagehide", onUnload);
      void machine.dispose();
      sender.dispose();
      hub.close();
      camStreamRef.current?.getTracks().forEach((t) => t.stop());
      camStreamRef.current = null;
    };
  }, [pushLog]);

  const arm = useCallback(
    async (deviceId?: string) => {
      setArmError(null);
      try {
        const { stream, usingObs } = await acquireCamera(deviceId);
        // Re-arm path (picker change): release the previous device first.
        camStreamRef.current?.getTracks().forEach((t) => t.stop());
        camStreamRef.current = stream;
        setCameraStream(stream);
        const label = stream.getVideoTracks()[0]?.label ?? (deviceId ? "selected camera" : "default camera");
        setCamera({ label: usingObs ? "OBS Virtual Camera" : label, usingObs });
        machineRef.current?.setCamera(stream);
        pushLog(
          usingObs
            ? "armed on OBS Virtual Camera"
            : deviceId
              ? `armed on ${label}`
              : "armed on default camera (OBS Virtual Camera not found)",
        );
        // Labels are visible now that permission is granted — populate picker.
        setCams(await listCameras());
      } catch (e) {
        setArmError((e as Error).message);
      }
    },
    [pushLog],
  );

  const switchCamera = useCallback(
    (id: string) => {
      setCamId(id);
      void arm(id === "auto" ? undefined : id);
    },
    [arm],
  );

  const panic = useCallback(async () => {
    const { paused } = await api.panic();
    pushLog(paused ? "PANIC — paused" : "resumed");
    return paused;
  }, [pushLog]);

  const warmGuard = useCallback(() => void guardRef.current?.ready(), []);

  return {
    state,
    remainingSec,
    status,
    cfg,
    logLines,
    pushLog,
    aiStream,
    cameraStream,
    camera,
    armError,
    cams,
    camId,
    arm,
    switchCamera,
    panic,
    warmGuard,
  };
}

/** A <video> bound to a MediaStream (or blank when null). */
export function StreamVideo({
  stream,
  className,
}: {
  stream: MediaStream | null;
  className?: string;
}) {
  return (
    <video
      muted
      playsInline
      autoPlay
      className={className}
      ref={(el) => {
        if (!el) return;
        if (el.srcObject !== stream) {
          el.srcObject = stream;
          if (stream) void el.play().catch(() => {});
        }
      }}
    />
  );
}
