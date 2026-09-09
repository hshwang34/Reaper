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

/** Router side: pushes the AI stream to the viewer. */
export class LoopbackSender {
  private pc: RTCPeerConnection | null = null;
  private jobId = "";
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

    for (const track of stream.getVideoTracks()) pc.addTrack(track, stream);

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

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.hub.send({ t: "rtc:offer", target: "viewer", jobId, sdp: offer });
  }

  /** Tell the viewer to play its out-wipe and tear down its peer. */
  sendReset(): void {
    if (this.jobId) {
      this.hub.send({ t: "rtc:reset", target: "viewer", jobId: this.jobId });
    }
  }

  stop(): void {
    this.pc?.close();
    this.pc = null;
  }

  private async onMessage(m: ServerMsg): Promise<void> {
    if (!this.pc || !isRtcMsg(m) || m.jobId !== this.jobId) return;
    if (m.t === "rtc:answer") {
      await this.pc.setRemoteDescription(m.sdp);
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
    private onReset: (jobId: string) => void,
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
    } else if (rtc.t === "rtc:reset" && rtc.jobId === this.jobId) {
      this.onReset(rtc.jobId);
      this.pc?.close();
      this.pc = null;
    }
  }
}
