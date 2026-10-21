// Render the marketing site's "What's possible" clips: one recorded base clip of
// a streamer, run through the real lucy-2.5 realtime model once per capability
// in site/src/capabilities.json, so every effect is frame-aligned with the base
// and the site can switch between them mid-playback (site/CLIPS.md).
//
//   node scripts/render-lucy.mjs <base-video> [--yes] [--only id,id] [--seconds 30] [--headed] [--mock]
//
// --mock skips Decart entirely (the "output" is the input, hue-shifted) to test
// the capture/alignment/encode pipeline for free.
//
// How one render works: a headless Chrome page plays the (already encoded) base
// clip, feeds the <video>'s captureStream() to Decart as if it were the camera,
// waits for the first styled frame, jumps to just before the loop point, and
// records the model's output for exactly one pass of the clip, starting at the
// moment the base wraps to 0. The site loops both files, so effect frame t
// lines up with base frame t (minus the model's latency, see LEAD_SEC).
//
// Cost safety mirrors the product (FEASIBILITY §3) without touching its money
// path: the product's mint is job-gated, so this script mints its own ek_
// tokens from DECART_API_KEY, each capped at clip length + 15s by Decart's own
// server, and it refuses to spend anything without --yes.
//
// Prompts go to the model with Decart's prompt rewriter OFF, so the prompt the
// site types out is exactly the text the model received.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { createDecartClient } from "@decartai/sdk";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "site/public/clips/possible");
const RAW = join(ROOT, ".render-lucy"); // gitignored scratch: raw .webm captures
const CATALOG = JSON.parse(readFileSync(join(ROOT, "site/src/capabilities.json"), "utf8"));
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PRICE_PER_SEC = 0.02; // Decart's published realtime rate
const SESSION_CAP_EXTRA_SEC = 15; // same headroom as core/src/decart.ts
// lucy-2.5's output trails its input by roughly this much; the site seeks the
// effect clip ahead by it so a switch doesn't visibly jump back in time.
const LEAD_SEC = 0.15;

/* ---------- args + env ---------- */

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const input = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.match(/^--(only|seconds)$/));
if (!input || !existsSync(input)) {
  console.error("usage: node scripts/render-lucy.mjs <base-video> [--yes] [--only id,id] [--seconds 30] [--headed]");
  process.exit(1);
}

function envKey() {
  if (process.env.DECART_API_KEY) return process.env.DECART_API_KEY;
  const f = join(ROOT, ".env");
  if (!existsSync(f)) return "";
  const m = readFileSync(f, "utf8").match(/^DECART_API_KEY=(.*)$/m);
  return (m?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
}
const MOCK = flag("mock");
const apiKey = envKey();
if (!MOCK && !apiKey.startsWith("dct_")) {
  console.error("DECART_API_KEY (dct_…) not found in the environment or .env");
  process.exit(1);
}

const only = opt("only")?.split(",").map((s) => s.trim());
const caps = CATALOG.capabilities.filter((c) => !only || only.includes(c.id));
if (!caps.length) {
  console.error(`no capabilities match --only ${opt("only")}`);
  process.exit(1);
}

function run(cmd, argv) {
  const r = spawnSync(cmd, argv, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} failed (exit ${r.status})`);
  return r.stdout;
}
for (const bin of ["ffmpeg", "ffprobe"]) {
  if (spawnSync(bin, ["-version"]).status !== 0) {
    console.error(`${bin} not found (brew install ffmpeg)`);
    process.exit(1);
  }
}

const srcDur = Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", input]).trim());
const seconds = Math.min(Number(opt("seconds") ?? 30), srcDur);
const perClip = seconds + 6; // warm-up + first frame, typically
const estimate = caps.length * perClip * PRICE_PER_SEC;
const ceiling = caps.length * (seconds + SESSION_CAP_EXTRA_SEC) * PRICE_PER_SEC;

console.log(`base: ${input} (${srcDur.toFixed(1)}s, using ${seconds.toFixed(1)}s)`);
console.log(`renders: ${caps.map((c) => c.id).join(", ")}`);
console.log(`cost: ≈ $${estimate.toFixed(2)} expected, $${ceiling.toFixed(2)} hard ceiling (token caps)`);
if (MOCK) console.log("MOCK: no Decart calls, no cost");
else if (!flag("yes")) {
  console.log("dry run — re-run with --yes to spend it");
  process.exit(0);
}

/* ---------- 1. the base clip, encoded once, used as both input and site asset ---------- */

mkdirSync(OUT, { recursive: true });
mkdirSync(RAW, { recursive: true });

// Short GOP (-g 15) so the site can seek into any clip quickly when a tip lands.
const H264 = ["-an", "-c:v", "libx264", "-preset", "slow", "-crf", "26", "-g", "15", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];
const base = join(OUT, "base.mp4");
console.log("encode base.mp4");
run("ffmpeg", ["-y", "-loglevel", "error", "-i", input, "-t", String(seconds),
  "-vf", "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,fps=30", ...H264, base]);
run("ffmpeg", ["-y", "-loglevel", "error", "-ss", "1", "-i", base, "-frames:v", "1", "-q:v", "4", join(OUT, "base.jpg")]);
const baseDur = Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", base]).trim());

/* ---------- 2. the render page (bundled so the browser gets the real SDK) ---------- */

const pageJs = (
  await build({
    write: false,
    bundle: true,
    format: "esm",
    platform: "browser",
    stdin: {
      resolveDir: ROOT,
      contents: `
import { createDecartClient, models } from "@decartai/sdk";
const v = document.getElementById("src");
const log = (s) => fetch("/log", { method: "POST", body: s });

// requestVideoFrameCallback-driven: resolves when playback wraps to the start.
const nextWrap = () => new Promise((resolve) => {
  let last = v.currentTime;
  const step = (_now, meta) => {
    if (meta.mediaTime + 0.25 < last) return resolve();
    last = meta.mediaTime;
    v.requestVideoFrameCallback(step);
  };
  v.requestVideoFrameCallback(step);
});

// Mock output: the input itself through a hue-rotating canvas, ~150ms behind.
function mockOut() {
  const c = document.createElement("canvas");
  c.width = 1280; c.height = 720;
  const g = c.getContext("2d");
  g.filter = "hue-rotate(160deg) saturate(1.6)";
  const draw = () => { g.drawImage(v, 0, 0, 1280, 720); requestAnimationFrame(draw); };
  draw();
  return c.captureStream(30);
}

window.renderOne = async (id, prompt, dur, mock) => {
  v.currentTime = 0;
  await v.play();
  if (mock) return record(id, mockOut(), dur);
  const { token } = await (await fetch("/token?sec=" + Math.ceil(dur))).json();
  const client = createDecartClient({ apiKey: token });
  let rt = null;
  try {
    const out = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no styled frame within 12s")), 12000);
      const arm = (s) => {
        const t = s.getVideoTracks()[0];
        if (!t) return false;
        const ok = () => { clearTimeout(timer); resolve(s); };
        if (!t.muted) ok(); else t.onunmute = ok;
        return true;
      };
      client.realtime.connect(v.captureStream(30), {
        model: models.realtime("lucy-2.5"),
        resolution: "720p",
        initialState: { prompt: { text: prompt, enhance: false } },
        onConnectionChange: (st) => log(id + " conn=" + st),
        onRemoteStream: (s) => { if (!arm(s)) s.onaddtrack = () => arm(s); },
      }).then((c) => { rt = c; }, (e) => { clearTimeout(timer); reject(e); });
    });
    return await record(id, out, dur);
  } finally {
    try { rt?.disconnect(); } catch {}
    v.pause();
  }
};

// Let the model settle on the prompt, then line up the recording with the
// base's loop point so effect t == base t.
async function record(id, out, dur) {
  await new Promise((r) => setTimeout(r, 1200));
  v.currentTime = Math.max(0, v.duration - 0.8);
  await nextWrap();
  const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
  const rec = new MediaRecorder(out, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((r) => (rec.onstop = r));
  rec.start(250);
  await new Promise((r) => setTimeout(r, dur * 1000));
  rec.stop();
  await stopped;
  const blob = new Blob(chunks, { type: mime });
  await fetch("/out?id=" + encodeURIComponent(id), { method: "POST", body: blob });
  return blob.size;
}
`,
    },
  })
).outputFiles[0].text;

const html = `<!doctype html><meta charset="utf-8"><title>render-lucy</title>
<video id="src" src="/base.mp4" muted playsinline loop preload="auto" width="1280" height="720"></video>
<script type="module" src="/page.js"></script>`;

/* ---------- 3. a local server: page, base clip, capped mints, uploads ---------- */

const decart = MOCK ? null : createDecartClient({ apiKey });
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/") return res.writeHead(200, { "content-type": "text/html" }).end(html);
    if (url.pathname === "/page.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(pageJs);
    if (url.pathname === "/base.mp4") return res.writeHead(200, { "content-type": "video/mp4" }).end(readFileSync(base));
    if (url.pathname === "/token") {
      const sec = Math.min(Number(url.searchParams.get("sec")), 60);
      const t = await decart.tokens.create({
        expiresIn: 45,
        allowedModels: ["lucy-2.5"],
        constraints: { realtime: { maxSessionDuration: sec + SESSION_CAP_EXTRA_SEC } },
      });
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ token: t.apiKey }));
    }
    const parts = [];
    for await (const chunk of req) parts.push(chunk);
    const body = Buffer.concat(parts);
    if (url.pathname === "/out") {
      writeFileSync(join(RAW, `${url.searchParams.get("id")}.webm`), body);
      return res.writeHead(204).end();
    }
    if (url.pathname === "/log") {
      console.log("  ·", body.toString());
      return res.writeHead(204).end();
    }
    res.writeHead(404).end();
  } catch (e) {
    console.error("  server:", e.message);
    res.writeHead(500).end(e.message);
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

/* ---------- 4. render each capability, then encode for the web ---------- */

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: !flag("headed"),
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
page.on("console", (m) => m.type() === "error" && console.log("  page:", m.text()));
await page.goto(origin);

const manifestPath = join(OUT, "manifest.json");
const prior = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : { clips: {} };
const manifest = {
  model: "lucy-2.5",
  enhance: false,
  rendered: new Date().toISOString().slice(0, 10),
  // a --mock run must never ship: the site labels it as a mock
  mock: MOCK,
  duration: Number(baseDur.toFixed(3)),
  leadSec: LEAD_SEC,
  base: "/clips/possible/base.mp4",
  poster: "/clips/possible/base.jpg",
  // keep earlier renders when re-running with --only, unless the base changed
  clips: only ? prior.clips ?? {} : {},
};

const failed = [];
for (const c of caps) {
  console.log(`render ${c.id} …`);
  try {
    const bytes = await page.evaluate(([id, p, d, m]) => window.renderOne(id, p, d, m), [c.id, c.prompt, baseDur, MOCK]);
    console.log(`  captured ${(bytes / 1e6).toFixed(1)} MB`);
    const mp4 = join(OUT, `${c.id}.mp4`);
    run("ffmpeg", ["-y", "-loglevel", "error", "-i", join(RAW, `${c.id}.webm`), "-t", String(baseDur),
      "-vf", "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,fps=30", ...H264, mp4]);
    run("ffmpeg", ["-y", "-loglevel", "error", "-ss", "2", "-i", mp4, "-frames:v", "1", "-q:v", "4", join(OUT, `${c.id}.jpg`)]);
    manifest.clips[c.id] = { src: `/clips/possible/${c.id}.mp4`, poster: `/clips/possible/${c.id}.jpg`, prompt: c.prompt };
  } catch (e) {
    console.error(`  FAILED: ${e.message}`);
    failed.push(c.id);
  }
}

await browser.close();
server.close();
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote ${manifestPath} (${Object.keys(manifest.clips).length} clips)`);
if (failed.length) {
  console.error(`failed: ${failed.join(", ")} — re-run with --only ${failed.join(",")}`);
  process.exit(1);
}
