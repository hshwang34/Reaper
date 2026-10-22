// A stream chat column: ambient chatter, payment alerts, and the room reacting.
// Shared by the hero replay and the "What's possible" section; each owns one
// instance bound to its own <ol>.

export interface Chatter {
  n: string;
  c: string;
  b?: "mod" | "sub" | "vip";
}

// A small cast with the usual badge mix. All generic; no real handles.
export const CHATTERS: Chatter[] = [
  { n: "pixel_pat", c: "#ff7a59" },
  { n: "kay_io", c: "#5ec5ff" },
  { n: "marz", c: "#b685ff", b: "sub" },
  { n: "deadl1ne", c: "#59ff9a", b: "mod" },
  { n: "tofu_tv", c: "#ffd166" },
  { n: "nia_exe", c: "#ff5ca8", b: "vip" },
  { n: "borkbork", c: "#8ad7ff" },
  { n: "sunny_d", c: "#ffb86b", b: "sub" },
  { n: "lowpoly", c: "#9ef0e0" },
];

export const IDLE_LINES = [
  "LOL",
  "hi chat",
  "anyone else here from the clip",
  "what effect is next",
  "do the underwater one again",
  "first time here, what is the hijack thing",
  "the countdown is so good",
  "opening the link rn",
  "W stream",
  "wait so you pick the effect and pay? sick",
  "haunted one tonight pls",
];

const CHAT_MAX = 18;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
export const esc = (s: string) =>
  s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

export interface PaidAlert {
  who: string;
  amount: number;
  /** One line under the alert, e.g. "Lava Room, 7 seconds". */
  detail: string;
  /** Highlight as the reader's own payment. */
  self?: boolean;
}

export class Chat {
  private timer = 0;
  private gen = 0;
  private lastChatter: Chatter | null = null;

  constructor(private list: HTMLElement) {}

  /** Ambient chatter at a human-looking cadence. */
  startIdle(lines: string[] = IDLE_LINES): void {
    this.stop();
    const gen = ++this.gen;
    const loop = () => {
      if (gen !== this.gen) return;
      this.say(pick(lines));
      this.timer = window.setTimeout(loop, 1300 + Math.random() * 1500);
    };
    this.timer = window.setTimeout(loop, 600);
  }

  /** The room reacts: a quick burst, then a slower trickle until stopped. */
  async burst(lines: string[], idle: string[] = IDLE_LINES): Promise<void> {
    this.stop();
    const gen = ++this.gen;
    const first = [...lines].sort(() => Math.random() - 0.5).slice(0, 7);
    for (const line of first) {
      if (gen !== this.gen) return;
      this.say(line);
      await sleep(260 + Math.random() * 320);
    }
    if (gen !== this.gen) return;
    const loop = () => {
      if (gen !== this.gen) return;
      this.say(pick([...idle, ...lines]));
      this.timer = window.setTimeout(loop, 900 + Math.random() * 900);
    };
    this.timer = window.setTimeout(loop, 700);
  }

  stop(): void {
    clearTimeout(this.timer);
    this.gen++;
  }

  clear(): void {
    this.list.innerHTML = "";
  }

  say(text: string): void {
    let who = pick(CHATTERS);
    if (who === this.lastChatter) who = pick(CHATTERS);
    this.lastChatter = who;
    this.push(
      `<li>${who.b ? `<i class="badge ${who.b}"></i>` : ""}<span class="chat-user" style="color:${who.c}">${esc(who.n)}</span>: ${esc(text)}</li>`,
    );
  }

  alert(a: PaidAlert): void {
    this.push(
      `<li class="chat-alert${a.self ? " chat-alert-self" : ""}"><b>${esc(a.who)}</b> paid <b>$${a.amount}.00</b> to hijack<small>${esc(a.detail)}</small></li>`,
    );
  }

  system(text: string): void {
    this.push(`<li class="chat-sys">${esc(text)}</li>`);
  }

  private push(html: string): void {
    this.list.insertAdjacentHTML("beforeend", html);
    while (this.list.children.length > CHAT_MAX) this.list.firstElementChild?.remove();
  }
}
