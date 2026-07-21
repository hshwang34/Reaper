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

const OBS_CAMERA_RE = /obs\s*virtual\s*camera/i;

/** Find the OBS Virtual Camera device id (labels require prior permission). */
export async function findObsCameraDeviceId(): Promise<string | null> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cam = devices.find(
    (d) => d.kind === "videoinput" && OBS_CAMERA_RE.test(d.label),
  );
  return cam?.deviceId ?? null;
}

/**
 * Acquire the OBS Virtual Camera at 720p. Falls back to the default camera if
 * OBS's virtual cam isn't present (so the demo still runs on any webcam).
 */
export async function acquireCamera(): Promise<{
  stream: MediaStream;
  usingObs: boolean;
}> {
  // One generic grant first so device labels become visible.
  const probe = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: false,
  });
  const obsId = await findObsCameraDeviceId();
  if (!obsId) return { stream: probe, usingObs: false };

  probe.getTracks().forEach((t) => t.stop());
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      deviceId: { exact: obsId },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
    audio: false,
  });
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

  async start(a: StartArgs): Promise<void> {
    if (a.token === "MOCK") {
      // No Decart: hand the raw camera straight through as the "AI" stream.
      this.mock = true;
      a.onRemoteStream(a.camera);
      return;
    }

    const decart = createDecartClient({ apiKey: a.token });
    this.client = await decart.realtime.connect(a.camera, {
      model: models.realtime("lucy-2.5"),
      resolution: "720p",
      initialState: {
        prompt: { text: a.prompt, enhance: true },
        image: a.imageBlob ?? undefined,
      },
      onRemoteStream: (stream) => a.onRemoteStream(stream),
    });
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
  }
}
