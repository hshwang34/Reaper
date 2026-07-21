// Camera acquisition + Decart realtime session, with a MOCK passthrough so the
// whole pipeline (loopback → OBS → timing) is demoable without a Decart key.
//
// SDK surface verified against @decartai/sdk 0.1.14 type defs:
//   createDecartClient({ apiKey }).realtime.connect(stream, {
//     model: models.realtime("lucy-2.5"),
//     initialState: { prompt: { text, enhance }, image: Blob|File|string },
//     onRemoteStream: (MediaStream) => void,
//   }) => RealTimeClient  (has .disconnect(), .setPrompt(), .on(...))

import {
  createDecartClient,
  models,
  type RealTimeClient,
} from "@decartai/sdk";
import { debugLog } from "../lib/debug.js";

const OBS_CAMERA_RE = /obs\s*virtual\s*camera/i;

/** Find the OBS Virtual Camera device id (labels require prior permission). */
export async function findObsCameraDeviceId(): Promise<string | null> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cam = devices.find(
    (d) => d.kind === "videoinput" && OBS_CAMERA_RE.test(d.label),
  );
  return cam?.deviceId ?? null;
}

/** All video inputs, for the router's device picker. Labels are only
 *  populated after a getUserMedia grant, so call this post-arm. */
export async function listCameras(): Promise<
  { deviceId: string; label: string }[]
> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === "videoinput")
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
}

/** 1080p ideal-constraints for a specific device: Decart downscales to its
 *  720p input anyway, and a sharper source measurably improves restyle quality. */
function constraintsFor(deviceId: string): MediaStreamConstraints {
  return {
    video: {
      deviceId: { exact: deviceId },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 },
    },
    audio: false,
  };
}

/**
 * Acquire a camera. With no argument: prefer the OBS Virtual Camera by label,
 * falling back to the default camera (so the demo still runs on any webcam).
 * With an explicit deviceId (the router's picker): use exactly that device.
 */
export async function acquireCamera(deviceId?: string): Promise<{
  stream: MediaStream;
  usingObs: boolean;
}> {
  if (deviceId) {
    const stream = await navigator.mediaDevices.getUserMedia(
      constraintsFor(deviceId),
    );
    const track = stream.getVideoTracks()[0];
    const s = track?.getSettings();
    debugLog("camera", `capturing ${s?.width}x${s?.height}@${s?.frameRate}`);
    return { stream, usingObs: OBS_CAMERA_RE.test(track?.label ?? "") };
  }

  // One generic grant first so device labels become visible.
  const probe = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: false,
  });
  const obsId = await findObsCameraDeviceId();
  if (!obsId) return { stream: probe, usingObs: false };

  probe.getTracks().forEach((t) => t.stop());
  const stream = await navigator.mediaDevices.getUserMedia(
    constraintsFor(obsId),
  );
  const s = stream.getVideoTracks()[0]?.getSettings();
  debugLog("camera", `capturing ${s?.width}x${s?.height}@${s?.frameRate}`);
  return { stream, usingObs: true };
}

export interface StartArgs {
  /** ek_ client token, or "MOCK" for passthrough. */
  token: string;
  prompt: string;
  imageBlob: Blob | null;
  camera: MediaStream;
  /** Fires when the styled (or, in MOCK, raw) stream is available. */
  onRemoteStream: (stream: MediaStream) => void;
}

export class DecartSession {
  private client: RealTimeClient | null = null;
  private mock = false;
  /** A clone of the camera published to Decart, so disconnecting the session
   *  never stops the original tracks that feed the router's live preview. */
  private publishStream: MediaStream | null = null;

  async start(a: StartArgs): Promise<void> {
    if (a.token === "MOCK") {
      // No Decart: hand the raw camera straight through as the "AI" stream.
      this.mock = true;
      a.onRemoteStream(a.camera);
      return;
    }

    // Publish a clone, not the original — LiveKit may stop the tracks it owns
    // on teardown, and we want the preview camera to survive across jobs.
    this.publishStream = a.camera.clone();
    const inputTracks = this.publishStream.getVideoTracks();
    debugLog(
      "decart",
      "connecting… input video tracks:",
      inputTracks.length,
      inputTracks[0]?.readyState,
    );

    const decart = createDecartClient({ apiKey: a.token });
    this.client = await decart.realtime.connect(this.publishStream, {
      model: models.realtime("lucy-2.5"),
      resolution: "720p",
      initialState: {
        prompt: { text: a.prompt, enhance: true },
        image: a.imageBlob ?? undefined,
      },
      onConnectionChange: (state) => debugLog("decart", "conn=", state),
      onRemoteStream: (stream) => {
        const n = stream.getVideoTracks().length;
        debugLog("decart", "onRemoteStream — video tracks:", n);
        if (n > 0) {
          a.onRemoteStream(stream);
        } else {
          // Some SDK paths hand back the stream object before the remote track
          // is subscribed — wait for it rather than treating it as empty.
          stream.onaddtrack = () => {
            if (stream.getVideoTracks().length > 0) {
              stream.onaddtrack = null;
              debugLog("decart", "remote video track arrived (late)");
              a.onRemoteStream(stream);
            }
          };
        }
      },
    });
    this.client.on("error", (e) =>
      debugLog("decart", "error:", (e as { message?: string })?.message ?? e),
    );
    this.client.on("generationEnded", (g) =>
      debugLog("decart", "generationEnded:", JSON.stringify(g)),
    );
  }

  disconnect(): void {
    if (this.mock) {
      this.mock = false;
      return;
    }
    try {
      this.client?.disconnect();
    } catch {
      /* already gone */
    }
    this.client = null;
    // Stop only the clone; the original camera keeps feeding the preview.
    this.publishStream?.getTracks().forEach((t) => t.stop());
    this.publishStream = null;
  }
}
