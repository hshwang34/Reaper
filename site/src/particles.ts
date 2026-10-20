// Ambient particles for the hero frame: embers, bubbles, snow, rain. One canvas,
// one mode at a time, ~60 particles, and the loop stops entirely when the mode
// is "none" or the tab is hidden. Nothing here is the model's output; it is set
// dressing for the illustration and is skipped under prefers-reduced-motion.

export type ParticleMode = "none" | "embers" | "bubbles" | "snow" | "rain";

interface P {
  x: number; // 0..1 of width
  y: number; // 0..1 of height
  r: number;
  vx: number;
  vy: number;
  a: number; // alpha
  t: number; // phase
}

const COUNT: Record<ParticleMode, number> = { none: 0, embers: 55, bubbles: 40, snow: 90, rain: 110 };

export class Particles {
  private ctx: CanvasRenderingContext2D | null;
  private ps: P[] = [];
  private mode: ParticleMode = "none";
  private raf = 0;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private last = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d");
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    this.resize();
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.stop();
      else this.start();
    });
  }

  setMode(mode: ParticleMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.ps = [];
    for (let i = 0; i < COUNT[mode]; i++) this.ps.push(this.spawn(true));
    if (mode === "none") {
      this.stop();
      this.ctx?.clearRect(0, 0, this.w, this.h);
    } else {
      this.start();
    }
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(1, Math.round(rect.width * this.dpr));
    this.h = Math.max(1, Math.round(rect.height * this.dpr));
    this.canvas.width = this.w;
    this.canvas.height = this.h;
  }

  private spawn(anywhere: boolean): P {
    const r = Math.random();
    switch (this.mode) {
      case "embers":
        return { x: Math.random(), y: anywhere ? Math.random() : 1.05, r: 1 + r * 2.2, vx: (Math.random() - 0.5) * 0.02, vy: -(0.04 + r * 0.08), a: 0.5 + r * 0.5, t: Math.random() * 6 };
      case "bubbles":
        return { x: Math.random(), y: anywhere ? Math.random() : 1.05, r: 1.5 + r * 4, vx: (Math.random() - 0.5) * 0.01, vy: -(0.05 + r * 0.07), a: 0.25 + r * 0.35, t: Math.random() * 6 };
      case "snow":
        return { x: Math.random(), y: anywhere ? Math.random() : -0.05, r: 1 + r * 2.4, vx: (Math.random() - 0.5) * 0.02, vy: 0.04 + r * 0.06, a: 0.5 + r * 0.5, t: Math.random() * 6 };
      case "rain":
        return { x: Math.random(), y: anywhere ? Math.random() : -0.1, r: 0.6 + r * 0.8, vx: -0.08, vy: 0.9 + r * 0.6, a: 0.25 + r * 0.35, t: 0 };
      default:
        return { x: 0, y: 0, r: 0, vx: 0, vy: 0, a: 0, t: 0 };
    }
  }

  private start(): void {
    if (this.raf || this.mode === "none") return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  private stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private tick = (now: number): void => {
    this.raf = 0;
    const ctx = this.ctx;
    if (!ctx) return;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const { w, h, dpr } = this;
    ctx.clearRect(0, 0, w, h);

    for (let i = 0; i < this.ps.length; i++) {
      const p = this.ps[i]!;
      p.t += dt;
      p.x += (p.vx + (this.mode === "snow" || this.mode === "embers" ? Math.sin(p.t * 1.3) * 0.01 : 0)) * dt;
      p.y += p.vy * dt;
      const off = p.vy < 0 ? p.y < -0.05 : p.y > 1.08;
      if (off || p.x < -0.05 || p.x > 1.05) {
        this.ps[i] = this.spawn(false);
        continue;
      }
      const px = p.x * w;
      const py = p.y * h;
      const pr = p.r * dpr;
      switch (this.mode) {
        case "embers": {
          const flicker = 0.7 + 0.3 * Math.sin(p.t * 9);
          ctx.fillStyle = `rgba(255, ${150 + Math.round(70 * flicker)}, 60, ${p.a * flicker})`;
          ctx.beginPath();
          ctx.arc(px, py, pr, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case "bubbles":
          ctx.strokeStyle = `rgba(220, 245, 255, ${p.a})`;
          ctx.lineWidth = dpr;
          ctx.beginPath();
          ctx.arc(px, py, pr, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = `rgba(255,255,255,${p.a * 0.5})`;
          ctx.beginPath();
          ctx.arc(px - pr * 0.35, py - pr * 0.35, pr * 0.25, 0, Math.PI * 2);
          ctx.fill();
          break;
        case "snow":
          ctx.fillStyle = `rgba(255,255,255,${p.a})`;
          ctx.beginPath();
          ctx.arc(px, py, pr, 0, Math.PI * 2);
          ctx.fill();
          break;
        case "rain":
          ctx.strokeStyle = `rgba(190, 230, 255, ${p.a})`;
          ctx.lineWidth = pr;
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(px - 0.01 * w, py - 0.05 * h);
          ctx.stroke();
          break;
        default:
          break;
      }
    }
    this.raf = requestAnimationFrame(this.tick);
  };
}
