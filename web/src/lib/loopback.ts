// Local WebRTC loopback between the router (sender) and viewer (receiver),
// signaled through the hub. A fresh RTCPeerConnection per job keeps init/
// teardown clean. A STUN server is used so both peers gather server-reflexive
// candidates — the reliable way to connect two browser contexts on the same
// machine (Chrome tab ↔ OBS CEF), where mDNS host candidates often fail to
// resolve.

import { isRtcMsg, type ServerMsg } from "@rh/shared";
import type { HubSocket } from "./ws.js";
import { debugLog } from "./debug.js";

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

// The loopback never leaves the machine, so bandwidth is effectively free —
// but WebRTC doesn't know that. A fresh peer starts its bandwidth estimate at
// ~300kbps and ramps over tens of seconds, which for a 5–30s hijack means the
// whole paid window goes out at 320x180–480x270 (measured) while Decart is
// handing us sharp 720p. Pin the encoder high from the first frame instead.
const LOOPBACK_KBPS = { min: 4000, start: 8000, max: 12000 };

/** Add Chrome's x-google-*-bitrate fmtp hints to every video codec, so the
 *  bandwidth estimator starts (and stays) at loopback rates. Chrome reads
 *  these from the SDP; other engines ignore unknown fmtp params. */
function withLoopbackBitrate(sdp: string): string {
  const hint = `x-google-min-bitrate=${LOOPBACK_KBPS.min};x-google-start-bitrate=${LOOPBACK_KBPS.start};x-google-max-bitrate=${LOOPBACK_KBPS.max}`;
  const lines = sdp.split("\r\n");
  const videoPts = new Set<string>();
  const hasFmtp = new Set<string>();
  let inVideo = false;
  for (const line of lines) {
    if (line.startsWith("m=")) inVideo = line.startsWith("m=video");
    const rtp = inVideo && /^a=rtpmap:(\d+) (VP8|VP9|H264|AV1)\//i.exec(line);
    if (rtp) videoPts.add(rtp[1]);
    const fmtp = /^a=fmtp:(\d+) /.exec(line);
    if (fmtp) hasFmtp.add(fmtp[1]);
  }
  return lines
    .flatMap((line) => {
      const fmtp = /^a=fmtp:(\d+) /.exec(line);
      if (fmtp && videoPts.has(fmtp[1]) && !line.includes("x-google-")) return [`${line};${hint}`];
      // VP8 usually ships with no fmtp line at all — add one after its rtpmap.
      const rtp = /^a=rtpmap:(\d+) /.exec(line);
      if (rtp && videoPts.has(rtp[1]) && !hasFmtp.has(rtp[1])) return [line, `a=fmtp:${rtp[1]} ${hint}`];
      return [line];
    })
    .join("\r\n");
}

/** Router side: pushes the AI stream to the viewer. */
export class LoopbackSender {
  private pc: RTCPeerConnection | null = null;
  private jobId = "";
  private statsTimer: ReturnType<typeof setInterval> | undefined;
  private warnedNoFrames = false;
  private unsubscribe: () => void;

  constructor(private hub: HubSocket) {
    this.unsubscribe = hub.on((m) => void this.onMessage(m).catch(() => {}));
  }

  /** Close the peer and stop listening to the hub. */
  dispose(): void {
    this.stop();
    this.unsubscribe();
  }

  async start(jobId: string, stream: MediaStream): Promise<void> {
    this.stop();
    this.jobId = jobId;
    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.pc = pc;
    pc.oniceconnectionstatechange = () =>
      debugLog("loopback:sender", "ice=", pc.iceConnectionState);
    pc.onconnectionstatechange = () =>
      debugLog("loopback:sender", "conn=", pc.connectionState);

    for (const track of stream.getVideoTracks()) {
      const sender = pc.addTrack(track, stream);
      // Belt to the SDP hints' braces: cap high, and under any pressure drop
      // frame rate rather than resolution — a stuttery frame reads as an
      // effect, a blurry one reads as broken.
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = LOOPBACK_KBPS.max * 1000;
      params.degradationPreference = "maintain-resolution";
      void sender.setParameters(params).catch((e) => debugLog("loopback:sender", "setParameters failed", e));
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.hub.send({
          t: "rtc:candidate",
          target: "viewer",
          jobId,
          candidate: e.candidate.toJSON(),
        });
      }
    };

    const created = await pc.createOffer();
    const offer = { type: created.type, sdp: withLoopbackBitrate(created.sdp ?? "") };
    await pc.setLocalDescription(offer);
    this.hub.send({ t: "rtc:offer", target: "viewer", jobId, sdp: offer });
    this.watchStats(pc);
  }

  /** Quality trace: what Decart hands us (media-source) vs. what the loopback
   *  actually encodes (outbound-rtp), every 2s. Separates "the model output is
   *  soft" from "our re-encode is starving it". */
  private watchStats(pc: RTCPeerConnection): void {
    let lastBytes = 0;
    let lastTs = 0;
    this.statsTimer = setInterval(async () => {
      if (this.pc !== pc) return;
      const report = await pc.getStats().catch(() => null);
      if (!report) return;
      let src = "";
      let out = "";
      report.forEach((r) => {
        if (r.type === "media-source" && r.kind === "video") {
          src = `${r.width}x${r.height}@${r.framesPerSecond ?? "?"}`;
        } else if (r.type === "outbound-rtp" && r.kind === "video") {
          const kbps = lastTs ? Math.round(((r.bytesSent - lastBytes) * 8) / (r.timestamp - lastTs)) : 0;
          lastBytes = r.bytesSent;
          lastTs = r.timestamp;
          out = `${r.frameWidth}x${r.frameHeight}@${r.framesPerSecond ?? "?"} ${kbps}kbps limit=${r.qualityLimitationReason}`;
        }
      });
      debugLog("loopback:stats", `decart-in ${src} → encoded ${out}`);
    }, 2000);
  }

  /** Total frames Decart has delivered into the loopback (media-source
   *  stats), or null if unavailable. */
  async framesIn(): Promise<number | null> {
    const report = await this.pc?.getStats().catch(() => null);
    let frames: number | null = null;
    report?.forEach((r) => {
      if (r.type === "media-source" && r.kind === "video" && typeof r.frames === "number") frames = r.frames;
    });
    if (frames === null && report && !this.warnedNoFrames) {
      this.warnedNoFrames = true; // stall detection is off — say so, once
      debugLog("loopback:sender", "media-source frame counter unavailable — stall detection disabled");
    }
    return frames;
  }

  /** Tell the viewer OBS is showing it — start the fade-in. */
  sendReveal(): void {
    if (this.jobId) {
      this.hub.send({ t: "rtc:reveal", target: "viewer", jobId: this.jobId });
    }
  }

  /** Tell the viewer to fade out (or vanish, when `instant`) and tear down its peer. */
  sendReset(instant = false): void {
    if (this.jobId) {
      this.hub.send({ t: "rtc:reset", target: "viewer", jobId: this.jobId, instant });
    }
  }

  stop(): void {
    clearInterval(this.statsTimer);
    this.pc?.close();
    this.pc = null;
  }

  private async onMessage(m: ServerMsg): Promise<void> {
    if (!this.pc || !isRtcMsg(m) || m.jobId !== this.jobId) return;
    if (m.t === "rtc:answer") {
      // The sender's encoder reads the hints off the *remote* (answer) SDP —
      // munging here keeps the viewer page (inside OBS) untouched.
      await this.pc.setRemoteDescription({ type: m.sdp.type, sdp: withLoopbackBitrate(m.sdp.sdp ?? "") });
    } else if (m.t === "rtc:candidate") {
      try {
        await this.pc.addIceCandidate(m.candidate);
      } catch {
        /* ignore late candidates */
      }
    }
  }
}

/** Viewer side: receives the stream, reports it up for rendering. */
export class LoopbackReceiver {
  private pc: RTCPeerConnection | null = null;
  private jobId = "";
  private unsubscribe: () => void;

  constructor(
    private hub: HubSocket,
    private onStream: (stream: MediaStream, jobId: string) => void,
    private onReset: (jobId: string, instant: boolean) => void,
    private onReveal: (jobId: string) => void = () => {},
  ) {
    this.unsubscribe = hub.on((m) => void this.onMessage(m).catch(() => {}));
  }

  /** Close the peer and stop listening to the hub (page unmount). */
  dispose(): void {
    this.pc?.close();
    this.pc = null;
    this.unsubscribe();
  }

  private async onMessage(m: ServerMsg): Promise<void> {
    if (!isRtcMsg(m)) return;
    const rtc = m;
    if (rtc.t === "rtc:offer") {
      debugLog("loopback:viewer", "offer received", rtc.jobId);
      this.pc?.close();
      this.jobId = rtc.jobId;
      const pc = new RTCPeerConnection(RTC_CONFIG);
      this.pc = pc;
      pc.oniceconnectionstatechange = () =>
        debugLog("loopback:viewer", "ice=", pc.iceConnectionState);
      pc.onconnectionstatechange = () =>
        debugLog("loopback:viewer", "conn=", pc.connectionState);

      pc.ontrack = (e) => {
        debugLog("loopback:viewer", "ontrack — stream received");
        this.onStream(e.streams[0], rtc.jobId);
      };
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          this.hub.send({
            t: "rtc:candidate",
            target: "router",
            jobId: rtc.jobId,
            candidate: e.candidate.toJSON(),
          });
        }
      };

      await pc.setRemoteDescription(rtc.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.hub.send({
        t: "rtc:answer",
        target: "router",
        jobId: rtc.jobId,
        sdp: answer,
      });
    } else if (rtc.t === "rtc:candidate" && this.pc && rtc.jobId === this.jobId) {
      try {
        await this.pc.addIceCandidate(rtc.candidate);
      } catch {
        /* ignore */
      }
    } else if (rtc.t === "rtc:reveal" && rtc.jobId === this.jobId) {
      this.onReveal(rtc.jobId);
    } else if (rtc.t === "rtc:reset" && rtc.jobId === this.jobId) {
      this.onReset(rtc.jobId, rtc.instant === true);
      this.pc?.close();
      this.pc = null;
    }
  }
}
