// Local WebRTC loopback between the router (sender) and viewer (receiver),
// signaled through the hub. A fresh RTCPeerConnection per job keeps init/
// teardown clean. No ICE servers needed — localhost host candidates connect
// directly.

import type { RtcMsg, ServerMsg } from "@rh/shared";
import type { HubSocket } from "./ws.js";

/** Router side: pushes the AI stream to the viewer. */
export class LoopbackSender {
  private pc: RTCPeerConnection | null = null;
  private jobId = "";

  constructor(private hub: HubSocket) {
    hub.on((m) => this.onMessage(m));
  }

  async start(jobId: string, stream: MediaStream): Promise<void> {
    this.stop();
    this.jobId = jobId;
    const pc = new RTCPeerConnection();
    this.pc = pc;

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
    if (!this.pc) return;
    const rtc = m as RtcMsg;
    if ("jobId" in rtc && rtc.jobId !== this.jobId) return;
    if (rtc.t === "rtc:answer") {
      await this.pc.setRemoteDescription(rtc.sdp as RTCSessionDescriptionInit);
    } else if (rtc.t === "rtc:candidate") {
      try {
        await this.pc.addIceCandidate(rtc.candidate as RTCIceCandidateInit);
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

  constructor(
    private hub: HubSocket,
    private onStream: (stream: MediaStream, jobId: string) => void,
    private onReset: (jobId: string) => void,
  ) {
    hub.on((m) => this.onMessage(m));
  }

  private async onMessage(m: ServerMsg): Promise<void> {
    const rtc = m as RtcMsg;
    if (rtc.t === "rtc:offer") {
      this.pc?.close();
      this.jobId = rtc.jobId;
      const pc = new RTCPeerConnection();
      this.pc = pc;

      pc.ontrack = (e) => this.onStream(e.streams[0], rtc.jobId);
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

      await pc.setRemoteDescription(rtc.sdp as RTCSessionDescriptionInit);
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
        await this.pc.addIceCandidate(rtc.candidate as RTCIceCandidateInit);
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
