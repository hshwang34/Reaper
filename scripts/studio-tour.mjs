#!/usr/bin/env node
// Creator Studio UI tour — drives the REAL desktop app (cloud mode, against a
// local control plane) through every streamer-facing screen, clicks every
// button, asserts what each one did, and screenshots each state, so UX is
// reviewed as pictures and every control is proven to work:
//
//   npm run tour                       # → tour/<timestamp>/*.png + report.json
//   TOUR_OUT=/some/dir npm run tour
//
// Rig: dev-mode server (DEV AUTH, MOCK Decart — free), the app with a fake
// camera, a stateful fake OBS with a real streamer layout, headless Chrome
// for the viewer portal. Payments stay off (no Stripe), so Earnings shows
// its not-configured state; e2e:hosted covers the money path.

import { spawn, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startFakeObs, webcam, layer } from "./lib/fakeObs.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const LOGIN = process.env.TOUR_LOGIN ?? "tourstreamer";
// Screenshots for the public setup guide (site/setup.html):
//   TOUR_CAMERA=<…/OBS Virtual Camera/file.mjpeg>  a recorded clip as the camera instead of
//                                  Chrome's test pattern (the folder name makes it count as OBS's)
//   TOUR_LINK_HOST=<host>          shows hijack links with the production host, not 127.0.0.1:<port>
const CAMERA = process.env.TOUR_CAMERA;
const LINK_HOST = process.env.TOUR_LINK_HOST;
const OUT = resolve(process.env.TOUR_OUT ?? join(root, "tour", new Date().toISOString().replace(/[:.]/g, "-")));
mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}
const section = (t) => console.log(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeoutMs, stepMs = 150) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await pred().catch(() => false)) return true;
    await sleep(stepMs);
  }
  return false;
}
function freePort() {
  return new Promise((done, fail) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
    s.on("error", fail);
  });
}
let shot = 0;
async function snap(page, name, opts = {}) {
  if (LINK_HOST || CAMERA) {
    await page
      .evaluate(([host, cam]) => {
        const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          let t = n.textContent ?? "";
          if (host) t = t.replace(/(https?:\/\/)?127\.0\.0\.1:\d+/g, host);
          // the fake camera's label is its file path; put the file in a folder named
          // "OBS Virtual Camera" so the app treats it as one, and show just the name
          if (cam) t = t.split(cam).join("OBS Virtual Camera");
          if (t !== n.textContent) n.textContent = t;
        }
      }, [LINK_HOST ?? "", CAMERA ?? ""])
      .catch(() => {});
  }
  const file = join(OUT, `${String(++shot).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true, ...opts });
  console.log(`    📸 ${file}`);
}
const text = (page) => page.locator("body").innerText();
const button = (page, name) => page.getByRole("button", { name });

let server, appProc, browser;
const scratch = mkdtempSync(join(tmpdir(), "rh-tour-"));

async function launchApp(userData, serverBase) {
  const cdpPort = await freePort();
  const proc = spawn(
    require("electron"),
    [
      resolve(root, "app"),
      `--remote-debugging-port=${cdpPort}`,
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      ...(CAMERA ? [`--use-file-for-fake-video-capture=${CAMERA}`] : []),
      "--autoplay-policy=no-user-gesture-required",
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    ],
    {
      env: {
        ...process.env,
        RH_USER_DATA: userData,
        RH_CLOUD_URL: serverBase,
        RH_CLOUD_LOGIN: LOGIN,
        DECART_API_KEY: "",
        STREAMLABS_SOCKET_TOKEN: "",
      },
      stdio: process.env.TOUR_VERBOSE ? "inherit" : "ignore",
    },
  );
  appProc = proc;
  const exited = new Promise((r) => proc.once("exit", r));
  const up = await waitFor(async () => (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).ok, 30_000, 250);
  if (!up) throw new Error("app never opened its debugging port");
  const cdp = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  let page = null;
  await waitFor(async () => {
    page = cdp.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("http://127.0.0.1:")) ?? null;
    return Boolean(page);
  }, 30_000);
  if (!page) throw new Error("app window never loaded");
  await page.setViewportSize({ width: 1280, height: 860 }).catch(() => {});
  return {
    page,
    cdpPort,
    close: async () => {
      await cdp.close().catch(() => {});
      proc.kill("SIGTERM");
      await Promise.race([exited, sleep(5000)]);
      if (proc.exitCode === null) proc.kill("SIGKILL");
      appProc = null;
    },
  };
}

async function main() {
  console.log("building web + app main …");
  execSync("npm run build", { cwd: root, stdio: "ignore" });
  execSync("npm run build:main --workspace app", { cwd: root, stdio: "ignore" });

  const [port, obsPort] = [await freePort(), await freePort()];
  const serverBase = `http://127.0.0.1:${port}`;
  const obs = startFakeObs(obsPort, {
    scenes: {
      "Starting Soon": [layer("Countdown", "ffmpeg_source")],
      "Just Chatting": [layer("Background"), webcam("Facecam"), layer("Cam frame"), layer("Alerts", "browser_source")],
      Gaming: [layer("Game", "game_capture"), webcam("Facecam")],
    },
    program: "Just Chatting",
  });
  const data = join(scratch, "server");
  mkdirSync(data, { recursive: true });
  server = spawn("npm", ["run", "start", "--workspace", "server"], {
    cwd: root,
    env: {
      ...process.env,
      RH_ENV: "",
      RH_SERVER_PORT: String(port),
      RH_PUBLIC_URL: serverBase,
      RH_DATABASE_PATH: join(data, "db.sqlite"),
      RH_UPLOADS_DIR: join(data, "uploads"),
      RH_QUARANTINE_DIR: join(data, "quarantine"),
      RH_BACKUP_DIR: join(data, "backups"),
      TWITCH_CLIENT_ID: "",
      TWITCH_CLIENT_SECRET: "",
      DECART_API_KEY: "",
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      SIGHTENGINE_API_USER: "",
      SIGHTENGINE_API_SECRET: "",
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
      // The wizard's test and the studio preview each use a free test.
      RH_FREE_TESTS_PER_DAY: "5",
    },
    stdio: process.env.TOUR_VERBOSE ? "inherit" : "ignore",
  });
  const healthy = await waitFor(async () => (await fetch(`${serverBase}/healthz`)).ok, 40_000, 300);
  if (!check("control plane boots", healthy, serverBase)) return;
  // The streamer's session, to read back what the studio saved server-side.
  const session = await (
    await fetch(`${serverBase}/auth/dev`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: LOGIN }) })
  ).json();
  const cloudSettings = async () =>
    (await fetch(`${serverBase}/api/c/${LOGIN}/settings`, { headers: { authorization: `Bearer ${session.access}` } })).json();

  {
    const s = await cloudSettings();
    check(
      "a new channel starts on the hosted defaults (Anything goes, strict screening, no sole-pending matching)",
      s.customPrompts === "classified" && s.referenceImages === "likeness" && s.moderationStrictness === "strict" && s.allowSolePendingMatch === false,
      JSON.stringify({ customPrompts: s.customPrompts, referenceImages: s.referenceImages, moderationStrictness: s.moderationStrictness, allowSolePendingMatch: s.allowSolePendingMatch }),
    );
  }

  const profile = join(scratch, "profile");
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "keys.json"), JSON.stringify({ plain: { obsWsUrl: `ws://127.0.0.1:${obsPort}`, obsWsPassword: "" } }));

  // ── 1. Setup wizard ─────────────────────────────────────────────────────
  section("setup wizard");
  let app = await launchApp(profile, serverBase);
  let win = app.page;
  check("first launch opens /setup", await waitFor(async () => new URL(win.url()).pathname === "/setup", 20_000), win.url());
  await waitFor(async () => (await text(win)).includes(LOGIN), 10_000);
  await snap(win, "setup-1-signed-in");
  await button(win, /^continue$/i).click();

  // OBS first: the overlay is installed before the camera is chosen.
  await waitFor(async () => /add the overlay/i.test(await text(win)), 15_000);
  await button(win, /add the overlay/i).click();
  check(
    "OBS step installs into every webcam scene, in plain words",
    await waitFor(async () => /Installed in "Just Chatting" over "Facecam", "Gaming" over "Facecam"/.test(await text(win)), 10_000),
    (await text(win)).match(/Installed in[^\n]*/)?.[0] ?? "",
  );
  check("overlay sits directly above the webcam, under frame + alerts", obs.scene("Just Chatting").join() === "Background,Facecam,AI Hijack,Cam frame,Alerts", obs.scene("Just Chatting").join(" < "));
  check("the scene with no webcam is untouched", obs.scene("Starting Soon").join() === "Countdown");
  await snap(win, "setup-2-obs");
  await button(win, /^continue$/i).click();

  await button(win, /use the obs virtual camera/i).click();
  check("camera step captures a camera", await waitFor(async () => /Capturing/.test(await text(win)), 10_000));
  await snap(win, "setup-3-camera");
  await button(win, /continue/i).first().click();

  await sleep(800);
  await snap(win, "setup-4-get-paid");
  check("no Streamlabs / API-key step", !/streamlabs|api key/i.test(await text(win)));
  await button(win, /^continue$/i).click();
  for (const box of await win.getByRole("checkbox").all()) await box.check();
  await snap(win, "setup-5-safety");
  await button(win, /i understand/i).click();

  // The test step is itself a router: it plays a real (MOCK) effect, which
  // needs OBS's Browser Source rendering /viewer — headless Chrome stands in.
  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  const obsSource = await (await browser.newContext()).newPage();
  await obsSource.goto(obs.provisionedUrl());
  const run = button(win, /run the 10-second test/i);
  check("test step arms the camera", await waitFor(async () => await run.isEnabled(), 15_000));
  await run.click();
  check("wizard test hijack goes live", await waitFor(async () => /LIVE/.test(await text(win)), 20_000));
  check("…and shows in OBS", await waitFor(async () => obs.visibility.some((v) => v.visible), 5000));
  await snap(win, "setup-6-test-live");
  check("asks 'did you see it?'", await waitFor(async () => /Did your|Did the/.test(await text(win)), 25_000));
  await button(win, /yes — it worked/i).click();
  await sleep(500);
  await snap(win, "setup-7-done");
  await button(win, /open the studio/i).click();
  // The app marks setup done and relaunches ITSELF (same argv, so same debug
  // port) — a process we didn't spawn, holding the single-instance lock.
  // Wait for the flag, then stop that copy so the next launch is ours.
  check(
    "finishing setup is remembered",
    await waitFor(async () => JSON.parse(readFileSync(join(profile, "app-state.json"), "utf8")).setupDone === true, 10_000),
  );
  await app.close();
  await sleep(1500);
  try {
    execSync(`pkill -f -- "--remote-debugging-port=${app.cdpPort}"`);
  } catch {
    /* already gone */
  }
  await sleep(1500);

  // ── 2. Studio: first-run tour ───────────────────────────────────────────
  section("studio — first-run tour");
  app = await launchApp(profile, serverBase);
  win = app.page;
  check("after setup the app opens the studio", await waitFor(async () => new URL(win.url()).pathname === "/router", 20_000), win.url());
  check("first visit shows the tour", await waitFor(async () => /How it works · 1 of 4/i.test(await text(win)), 10_000));
  for (let i = 1; i <= 4; i++) {
    await snap(win, `tour-${i}`, { fullPage: false });
    if (i < 4) await button(win, /^next$/i).click();
  }
  await button(win, /explore the effects/i).click();
  check("tour ends on the Effects gallery", await waitFor(async () => /Your effects/.test(await text(win)), 5000));

  // ── 3. Effects ──────────────────────────────────────────────────────────
  section("studio — effects");
  await sleep(600);
  await snap(win, "effects");
  const t = await text(win);
  check("no developer jargon on screen", !/IDLE|AUTHORIZING|MOCK|Decart|Sightengine|OpenAI|Anthropic|Streamlabs|API key|event log/i.test(t));
  await win.getByRole("switch", { name: /Haunted available/i }).locator("xpath=ancestor::label[1]").click();
  check(
    "switching an effect off saves to the hosted channel",
    await waitFor(async () => (await cloudSettings()).disabledPresetIds?.includes("haunted"), 5000),
  );
  await win.getByRole("tab", { name: /^off$/i }).click();
  await snap(win, "effects-filter-off", { fullPage: false });
  await win.getByRole("switch", { name: /Haunted available/i }).locator("xpath=ancestor::label[1]").click();
  check(
    "switching it back on saves too",
    await waitFor(async () => !(await cloudSettings()).disabledPresetIds?.includes("haunted"), 5000),
  );
  await win.getByRole("tab", { name: /^all$/i }).click();

  // ── 4. Live ─────────────────────────────────────────────────────────────
  section("studio — live");
  await win.getByRole("button", { name: /^live$/i }).click();
  await sleep(500);
  await snap(win, "live-off", { fullPage: false });
  check("hijack link shown", (await text(win)).includes(`/c/${LOGIN}`));
  check(
    "camera off: Turn on Stream Hijack is the only filled button (Copy link is secondary)",
    !(await button(win, /copy link/i).evaluate((el) => el.className.includes("bg-brand-600"))) &&
      (await button(win, /turn on stream hijack/i).evaluate((el) => el.className.includes("bg-brand-600"))),
  );
  await button(win, /^sign out$/i).click();
  check("Sign out asks first, in plain words", await waitFor(async () => /Chat won't be able to pay until you sign in again/.test(await text(win)), 3000));
  await button(win, /^stay$/i).click();
  check("Stay closes it and signs nobody out", await waitFor(async () => !/Sign out of Stream Hijack\?/.test(await text(win)), 3000));
  check("OBS readiness says where the overlay is", /overlay in “Just Chatting” over “Facecam”/.test(await text(win)));
  // The OBS stand-in (opened in the wizard) reconnects on its own.
  await button(win, /turn on stream hijack/i).click();
  check("turn on → ready", await waitFor(async () => /Ready · waiting for a viewer/.test(await text(win)), 15_000));
  await snap(win, "live-ready", { fullPage: false });
  await button(win, /try an effect on me/i).click();
  await snap(win, "live-picker", { fullPage: false });
  await win.getByRole("dialog").getByRole("button", { name: /cyberpunk city/i }).click();
  check("preview goes live on my camera", await waitFor(async () => /Effect live/.test(await text(win)), 20_000));
  check("OBS overlay shown during the preview", obs.visibility.some((v) => v.visible));
  await snap(win, "live-playing", { fullPage: false });
  await button(win, /stop effect/i).click();
  check("Stop effect stops it (and pauses new ones)", await waitFor(async () => /Paused/.test(await text(win)), 5000));
  check("…and hides the OBS overlay", await waitFor(async () => obs.visibility.at(-1)?.visible === false, 5000));
  await snap(win, "live-paused", { fullPage: false });
  await button(win, /resume hijacks/i).click();
  check("Resume brings it back", await waitFor(async () => /Ready · waiting/.test(await text(win)), 5000));
  await button(win, /add the overlay again/i).click();
  check("Add the overlay again reports where it went", await waitFor(async () => /Installed in/.test(await text(win)), 8000));
  await button(win, /^how it works$/i).click();
  check("How it works reopens the tour", await waitFor(async () => /How it works · 1 of 4/i.test(await text(win)), 3000));
  await button(win, /^skip$/i).click();

  // ── 5. Safety ───────────────────────────────────────────────────────────
  section("studio — rules");
  await win.getByRole("button", { name: /^rules$/i }).click();
  await sleep(500);
  await snap(win, "rules");
  for (const [label, want] of [
    ["Family-friendly", { customPrompts: "off", referenceImages: "off", maxIntensity: 3 }],
    ["Balanced", { customPrompts: "classified", referenceImages: "scenes", maxIntensity: 4 }],
    ["Anything goes", { customPrompts: "classified", referenceImages: "likeness", maxIntensity: 5 }],
  ]) {
    await win.getByRole("radio", { name: new RegExp(label, "i") }).click();
    const ok = await waitFor(async () => {
      const s = await cloudSettings();
      return Object.entries(want).every(([k, v]) => s[k] === v);
    }, 5000);
    check(`level "${label}" saves to the hosted channel`, ok);
  }
  // Switching level overwrites details, so it offers a six-second Undo.
  await win.getByRole("radio", { name: /balanced/i }).click();
  check("a level switch offers Undo", await waitFor(async () => /Switched to Balanced/.test(await text(win)), 3000));
  await button(win, /^undo$/i).click();
  check(
    "Undo puts the previous rules back",
    await waitFor(async () => {
      const s = await cloudSettings();
      return s.customPrompts === "classified" && s.referenceImages === "likeness" && s.maxIntensity === 5;
    }, 5000),
  );
  const closed = win.locator("details:not([open]) summary");
  while ((await closed.count()) > 0) await closed.first().click();
  await snap(win, "rules-expanded");
  await win.getByLabel(/extra blocked words/i).fill("spider, clown");
  await win.getByLabel(/extra blocked words/i).press("Enter");
  check("blocked words save", await waitFor(async () => (await cloudSettings()).blocklistExtra?.join() === "spider,clown", 5000));
  await win.getByRole("radio", { name: /^I approve each$/i }).locator("xpath=ancestor::label[1]").click();
  check("typed-idea approval saves", await waitFor(async () => (await cloudSettings()).customPrompts === "classified+approval", 5000));
  await win.getByRole("radio", { name: /anything goes/i }).click();

  // ── 6. Earnings ─────────────────────────────────────────────────────────
  section("studio — earnings");
  await win.getByRole("button", { name: /^earnings$/i }).click();
  await sleep(1000);
  await snap(win, "earnings");
  check("earnings shows recent hijacks (the preview)", await waitFor(async () => /Cyberpunk City/.test(await text(win)), 5000));

  // ── 7. Viewer portal ────────────────────────────────────────────────────
  section("viewer portal");
  const portal = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  await portal.goto(`${serverBase}/c/${LOGIN}`);
  await sleep(2000);
  await snap(portal, "portal-desktop");
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
  await phone.goto(`${serverBase}/c/${LOGIN}`);
  await sleep(2000);
  await snap(phone, "portal-phone");
  check("portal lists the expanded catalog", /Yarn World|Parrot Party/.test(await text(portal)));

  await app.close();
}

try {
  await main();
} catch (e) {
  check("tour ran without throwing", false, e?.stack?.split("\n").slice(0, 3).join(" | ") ?? String(e));
} finally {
  await browser?.close().catch(() => {});
  appProc?.kill("SIGKILL");
  server?.kill("SIGTERM");
}
const failed = results.filter((r) => !r.ok).length;
writeFileSync(join(OUT, "report.json"), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed}/${results.length} passed · screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
