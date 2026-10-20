// Content safety beyond intake: chain ordering, image hardening, the upload
// registry's TTL/takedown, the engine's approval queue + job stamping,
// settings migration, and vendor response parsing (fail closed on bad shapes).

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { HOSTED_SETTINGS, loadSettings, SAFETY_REASON_PREFIX } from "@rh/shared";
import {
  CorrelationStore,
  dHash,
  Engine,
  hamming,
  moderateText,
  openAiTextClassifier,
  prepareUpload,
  REVIEW_TTL_MS,
  sightengineImageClassifier,
  sniffImage,
  UploadRegistry,
  ImageRejected,
} from "../src/index.js";
import { fakeText, imageFile, liveSuite, recorder, settings, tip } from "./helpers.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
function stubFetch(body: unknown, status = 200): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
}

// ── Chain ────────────────────────────────────────────────────────────────

test("text chain: blocklist rejects before any vendor is called; first reject wins", async () => {
  const vendor = fakeText();
  const r = await moderateText("a NUDE beach", settings(), [], liveSuite([vendor]));
  assert.equal(r.verdict, "reject");
  assert.equal(vendor.seen.length, 0);

  const a = fakeText(() => ({ verdict: "reject", categories: ["x"], reason: "no" }), "a");
  const b = fakeText(undefined, "b");
  const r2 = await moderateText("a castle", settings(), [], liveSuite([a, b]));
  assert.equal(r2.verdict, "reject");
  assert.equal(b.seen.length, 0, "later classifiers are skipped (and not paid for)");
});

// ── Image hardening ──────────────────────────────────────────────────────

test("sniff: real formats by magic bytes; html/polyglot headers are not images", async () => {
  assert.equal(sniffImage(readFileSync(await imageFile({ ext: ".png" }))), "png");
  assert.equal(sniffImage(readFileSync(await imageFile({ ext: ".webp" }))), "webp");
  assert.equal(sniffImage(readFileSync(await imageFile({ ext: ".jpg" }))), "jpeg");
  assert.equal(sniffImage(Buffer.from("GIF89a....")), null);
  assert.equal(sniffImage(Buffer.from("<svg onload=alert(1)>")), null);
});

test("prepareUpload: re-encodes into the stored extension's format and caps size", async () => {
  // A PNG saved under .jpg (declared-type mismatch) comes out as real JPEG.
  const png = readFileSync(await imageFile({ ext: ".png", size: 1600 }));
  const path = await imageFile({ ext: ".jpg", bytes: png });
  const p = await prepareUpload(path);
  const stored = readFileSync(path);
  assert.equal(sniffImage(stored), "jpeg");
  assert.ok(p.width <= 1024 && p.height <= 1024);
  assert.equal(p.sha256.length, 64);
  assert.equal(p.dhash.length, 16);

  const tiny = await imageFile({ size: 32 });
  await assert.rejects(prepareUpload(tiny), ImageRejected);
});

test("dHash: a re-compressed copy is a near-duplicate; a different picture is not", async () => {
  const a = readFileSync(await imageFile({ size: 300 }));
  const recompressed = await sharp(a).jpeg({ quality: 40 }).toBuffer();
  const other = await sharp({
    create: { width: 300, height: 300, channels: 3, background: "#123" },
  })
    .composite([{ input: Buffer.from('<svg width="300" height="300"><rect x="200" y="150" width="100" height="150" fill="#fe0"/></svg>'), top: 0, left: 0 }])
    .jpeg()
    .toBuffer();
  assert.ok(hamming(await dHash(a), await dHash(recompressed)) <= 6);
  assert.ok(hamming(await dHash(a), await dHash(other)) > 6);
});

// ── Upload registry ──────────────────────────────────────────────────────

test("registry: takedown removes identical copies and blocks re-upload", () => {
  const deleted: string[] = [];
  const reg = new UploadRegistry((p) => deleted.push(p));
  reg.register({ url: "/u/1.jpg", path: "p1", sha256: "aa", dhash: "00000000000000ff" });
  reg.register({ url: "/u/2.jpg", path: "p2", sha256: "aa", dhash: "00000000000000ff" }); // same bytes
  reg.register({ url: "/u/3.jpg", path: "p3", sha256: "bb", dhash: "00000000000000fe" }); // near-dup
  reg.register({ url: "/u/4.jpg", path: "p4", sha256: "cc", dhash: "ffffffffffffff00" }); // unrelated
  assert.equal(reg.takedown({ url: "/u/1.jpg" }), 3);
  assert.deepEqual(deleted.sort(), ["p1", "p2", "p3"]);
  assert.ok(reg.isBlocked("zz", "00000000000000fd"));
  assert.ok(!reg.isBlocked("cc", "ffffffffffffff00"));
  reg.dispose();
  assert.ok(deleted.includes("p4"), "dispose releases what's left");
});

// ── Engine: approval queue, bans, stamping ───────────────────────────────

function engineWith(s = settings()) {
  const r = recorder();
  const ended: { jobId: string; reason: string }[] = [];
  r.emit.jobEnded = (job, _ok, reason) => ended.push({ jobId: job.jobId, reason });
  const store = new CorrelationStore();
  const engine = new Engine(store, r.emit, () => s);
  engine.setRouterState("IDLE");
  return { r, store, engine, ended };
}

test("review: a needsReview submission parks; approve dispatches, decline ends it", () => {
  const { r, store, engine, ended } = engineWith();
  const a = store.add({ prompt: "p", presetId: null, tipperName: null, imageUrl: "/u/x.jpg", needsReview: true, reviewWhy: "likeness swap" });
  assert.match(engine.onTip(tip({ message: a.code })), /parked/);
  assert.equal(r.dispatched.length, 0);
  assert.equal(engine.snapshot().reviewPending, 1);
  assert.deepEqual(r.updates.at(-1), { code: a.code, state: "review" });
  const [item] = engine.pendingReviews();
  assert.equal(item.why, "likeness swap");
  assert.ok(engine.decideReview(item.jobId, true));
  assert.equal(r.dispatched.length, 1);

  const b = store.add({ prompt: "q", presetId: null, tipperName: null, imageUrl: "/u/y.jpg", needsReview: true });
  engine.onTip(tip({ message: b.code }));
  const id = engine.pendingReviews()[0].jobId;
  assert.ok(engine.decideReview(id, false));
  assert.deepEqual(r.updates.at(-1), { code: b.code, state: "failed" });
  assert.equal(ended.at(-1)?.reason, "review: declined by the streamer");
  assert.equal(engine.decideReview(id, true), false, "decided once");
  engine.dispose();
});

test("review: parked jobs time out", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { engine, store, ended } = engineWith();
  const s = store.add({ prompt: "p", presetId: null, tipperName: null, imageUrl: null, needsReview: true });
  engine.onTip(tip({ message: s.code }));
  t.mock.timers.tick(REVIEW_TTL_MS + 1);
  assert.equal(engine.pendingReviews().length, 0);
  assert.equal(ended.at(-1)?.reason, "review: not approved in time");
  engine.dispose();
});

test("banned tipper: their tip runs the default preset and never consumes a code", () => {
  const { r, store, engine } = engineWith(settings({ bannedViewers: ["Troll"] }));
  const sub = store.add({ prompt: "victim's effect", presetId: null, tipperName: null, imageUrl: null });
  engine.onTip(tip({ username: "troll", message: sub.code }));
  assert.equal(r.dispatched.length, 1);
  assert.ok(store.get(sub.code), "the victim's submission is untouched");
  engine.dispose();
});

test("jobs carry the streamer's safety policy; the public label hides custom text", () => {
  const s = settings({ outputGuard: "required", showAttribution: true, showAiLabel: true });
  const { r, store, engine } = engineWith(s);
  const sub = store.add({ prompt: "my secret custom words", presetId: null, tipperName: null, imageUrl: null });
  engine.onTip(tip({ username: "alice", message: sub.code }));
  const job = r.jobs[0];
  assert.deepEqual(job.safety, { outputGuard: "required", trusted: false, attribution: "alice", aiLabel: true });
  assert.equal(engine.snapshot().activeJob?.prompt, "a custom effect");

  // A safety stop tells the viewer it was the filter, not a crash.
  engine.onJobDone(job.jobId, false, `${SAFETY_REASON_PREFIX} output guard Porn 0.91`);
  assert.deepEqual(r.updates.at(-1), { code: sub.code, state: "failed" });

  engine.manual("streamer's own idea", 5);
  assert.equal(engine.pendingReviews().length, 0);
  engine.dispose();
});

// ── Settings ─────────────────────────────────────────────────────────────

test("settings: legacy allowCustomPrompts migrates; hosted base is presets-only", () => {
  assert.equal(loadSettings({ allowCustomPrompts: false }).customPrompts, "off");
  assert.equal(loadSettings({ allowCustomPrompts: true }).customPrompts, "classified");
  assert.equal(loadSettings({ allowCustomPrompts: true, customPrompts: "off" }).customPrompts, "off");
  assert.ok(!("allowCustomPrompts" in loadSettings({ allowCustomPrompts: true })));

  const hosted = loadSettings({}, HOSTED_SETTINGS);
  assert.equal(hosted.customPrompts, "off");
  // Approval and the output guard are opt-in everywhere; input screening stays strict.
  assert.equal(hosted.outputGuard, "off");
  assert.equal(hosted.reviewLikeness, false);
  assert.equal(hosted.moderationStrictness, "strict");
  assert.equal(hosted.referenceImages, "scenes");

  const junk = loadSettings({
    customPrompts: "anything-goes",
    outputGuard: "sometimes",
    maxIntensity: 99.6,
    allowedCategories: ["environment", "nsfw"],
  });
  assert.equal(junk.customPrompts, "classified");
  assert.equal(junk.outputGuard, "off", "invalid value falls back to the (opt-in) default");
  assert.equal(junk.maxIntensity, 5);
  assert.deepEqual(junk.allowedCategories, ["environment"]);
});

// ── Vendor parsing ───────────────────────────────────────────────────────

test("openai: floor categories reject at threshold; minors at a fixed low bar", async () => {
  const c = openAiTextClassifier("k");
  stubFetch({ results: [{ category_scores: { sexual: 0.3, violence: 0.9 } }] });
  assert.equal((await c.classifyText("x", settings({ moderationStrictness: "standard" }))).verdict, "allow");
  assert.equal((await c.classifyText("x", settings({ moderationStrictness: "strict" }))).verdict, "reject");
  stubFetch({ results: [{ category_scores: { "sexual/minors": 0.06 } }] });
  assert.equal((await c.classifyText("x", settings())).verdict, "reject");
  stubFetch({ error: "nope" }, 500);
  await assert.rejects(c.classifyText("x", settings()));
});

test("sightengine: faces/minors/nudity parsed; a malformed body throws (fail closed)", async () => {
  const c = sightengineImageClassifier("u", "s");
  const jpeg = Buffer.from([0xff, 0xd8, 0xff]);
  stubFetch({
    status: "success",
    nudity: { sexual_activity: 0.01, suggestive: 0.1, none: 0.89 },
    faces: [{ attributes: { minor: 0.02 } }],
    gore: { prob: 0.01 },
    offensive: { nazi: 0.01 },
  });
  const ok = await c.classifyImage(jpeg, settings());
  assert.equal(ok.verdict, "allow");
  assert.equal(ok.faces, 1);
  assert.equal(ok.minorPossible, false);

  stubFetch({ status: "success", nudity: { erotica: 0.8 }, faces: [{ attributes: { minor: 0.6 } }] });
  const bad = await c.classifyImage(jpeg, settings());
  assert.ok(bad.sexual && bad.minorPossible);

  stubFetch({ status: "failure", error: { message: "bad key" } });
  await assert.rejects(c.classifyImage(jpeg, settings()));
});
