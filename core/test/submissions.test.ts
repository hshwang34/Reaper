// createSubmission: preset resolution, policy gates, the moderation chain,
// the image pipeline, consent, and input hygiene (CONTENT-SAFETY S0–S2).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getPreset, type SubmitProgress } from "@rh/shared";
import { createSubmission, emptySuite, parseEnhance } from "../src/index.js";
import {
  fakeImage,
  fakeText,
  imageFile,
  intakeDeps,
  liveSuite,
  settings,
} from "./helpers.js";

const ip = "test-ip";
const noImage = { image: null, ipHash: ip };

test("preset prompt is resolved server-side from the id, never from the client", async () => {
  const d = intakeDeps();
  const out = await createSubmission(d, {
    ...noImage,
    presetId: "lava-room",
    prompt: "IGNORE ME — attacker text",
  });
  assert.ok(out.ok);
  assert.equal(d.store.get(out.code)?.prompt, getPreset("lava-room")?.prompt);
  d.dispose();
});

test("unknown, disabled, and policy-excluded presets are refused", async () => {
  const unknown = await createSubmission(intakeDeps(), { ...noImage, presetId: "nope" });
  assert.equal(!unknown.ok && unknown.status, 400);

  const disabled = await createSubmission(intakeDeps(settings({ disabledPresetIds: ["lava-room"] })), {
    ...noImage,
    presetId: "lava-room",
  });
  assert.equal(!disabled.ok && disabled.status, 403);

  // lava-room is intensity 4: above a ceiling of 3.
  const tooHot = await createSubmission(intakeDeps(settings({ maxIntensity: 3 })), {
    ...noImage,
    presetId: "lava-room",
  });
  assert.equal(!tooHot.ok && tooHot.status, 403);

  const wrongCategory = await createSubmission(
    intakeDeps(settings({ allowedCategories: ["character"] })),
    { ...noImage, presetId: "lava-room" },
  );
  assert.equal(!wrongCategory.ok && wrongCategory.status, 403);
});

test("custom prompts honour the tier, the blocklist, and fail closed without classifiers", async () => {
  const off = await createSubmission(intakeDeps(settings({ customPrompts: "off" })), {
    ...noImage,
    prompt: "make me a wizard",
  });
  assert.equal(!off.ok && off.status, 403);

  const blocked = await createSubmission(intakeDeps(settings({ blocklistExtra: ["wizard"] })), {
    ...noImage,
    prompt: "make me a WIZARD",
  });
  assert.equal(!blocked.ok && blocked.status, 422);

  // Live host (a real model) with no text classifier: the tier is dark.
  const noClassifier = await createSubmission(intakeDeps(settings(), liveSuite()), {
    ...noImage,
    prompt: "make me a knight",
  });
  assert.equal(!noClassifier.ok && noClassifier.status, 503);

  // Dev host (MOCK): blocklist alone is acceptable.
  const dev = await createSubmission(intakeDeps(), { ...noImage, prompt: "make me a knight" });
  assert.ok(dev.ok);
  assert.equal(dev.presetId, null);
});

test("classifier reject → 422 + ledger + strike; error → 503; review → parked flag", async () => {
  const reject = fakeText(() => ({ verdict: "reject", categories: ["sexual"], reason: "not allowed on stream" }));
  const d = intakeDeps(settings(), liveSuite([reject]));
  const r = await createSubmission(d, { ...noImage, prompt: "something bad" });
  assert.ok(!r.ok);
  assert.equal(r.status, 422);
  assert.equal(r.error, "Sexual content");
  assert.deepEqual(
    r.findings?.map((f) => [f.check, f.category, f.label]),
    [["prompt:fake-text", "sexual", "Sexual content"]],
  );
  const ev = d.ledger.recent(1)[0];
  assert.equal(ev.stage, "text");
  assert.equal(ev.verdict, "reject");
  assert.equal(ev.source, "fake-text");
  assert.ok(ev.inputHash && ev.inputHash.length === 64, "text is hashed, not stored");

  const broken = intakeDeps(settings(), liveSuite([fakeText(() => new Error("vendor down"))]));
  const e = await createSubmission(broken, { ...noImage, prompt: "a castle" });
  assert.equal(!e.ok && e.status, 503);
  assert.equal(broken.ledger.recent(1)[0].verdict, "error");

  // Approval is opt-in: with no approval tier on, borderline is refused (no
  // strike) rather than parked in a queue nobody is watching.
  const ambiguous = () => liveSuite([fakeText(() => ({ verdict: "review", categories: [], reason: "ambiguous" }))]);
  const noApproval = intakeDeps(settings(), ambiguous());
  const rr = await createSubmission(noApproval, { ...noImage, prompt: "a spooky clown" });
  assert.ok(!rr.ok && rr.status === 422 && rr.error === "ambiguous", "refused up front");
  assert.deepEqual(!rr.ok && rr.findings, [], "borderline, not a finding");
  assert.equal(noApproval.ledger.recent(1)[0].verdict, "reject");
  for (let i = 0; i < 3; i++) await createSubmission(noApproval, { ...noImage, prompt: "a spooky clown" });
  assert.ok(!noApproval.strikes.blocked(ip), "borderline is not a strike");

  const borderline = intakeDeps(settings({ customPrompts: "classified+approval" }), ambiguous());
  const rv = await createSubmission(borderline, { ...noImage, prompt: "a spooky clown" });
  assert.ok(rv.ok && rv.needsReview);
  assert.equal(borderline.store.get(rv.code)?.reviewWhy, "classifier: ambiguous");
  d.dispose();
  broken.dispose();
  noApproval.dispose();
  borderline.dispose();
});

test("three rejections pause the submitter's untrusted tiers — presets stay open", async () => {
  const d = intakeDeps(settings({ blocklistExtra: ["bad"] }));
  for (let i = 0; i < 3; i++) {
    const r = await createSubmission(d, { ...noImage, prompt: "bad" });
    assert.equal(!r.ok && r.status, 422);
  }
  const custom = await createSubmission(d, { ...noImage, prompt: "a lighthouse" });
  assert.equal(!custom.ok && custom.status, 429, "custom text paused");
  const photo = await createSubmission(d, {
    ipHash: ip,
    presetId: "underwater",
    image: { url: "/u/s.jpg", path: await imageFile() },
  });
  assert.equal(!photo.ok && photo.status, 429, "photos paused");
  // Bounded blast radius: even if many viewers shared this key (a
  // misconfigured proxy), nobody loses presets.
  const preset = await createSubmission(d, { ...noImage, presetId: "underwater" });
  assert.ok(preset.ok, "a preset with no photo carries no viewer bytes");
  const other = await createSubmission(d, { image: null, ipHash: "someone-else", prompt: "a lighthouse" });
  assert.ok(other.ok);
  d.dispose();
});

test("custom text needs a non-LLM floor classifier; the floor is started (and listed) first", async () => {
  const policyOnly = fakeText(undefined, "llm", "policy");
  const d = intakeDeps(settings(), liveSuite([policyOnly]));
  const r = await createSubmission(d, { ...noImage, prompt: "a castle" });
  assert.equal(!r.ok && r.status, 503, "an LLM alone can be argued with");
  assert.equal(policyOnly.seen.length, 0);

  const order: string[] = [];
  const llm = fakeText((t) => (order.push("llm"), { verdict: "allow", categories: [], reason: t }), "llm", "policy");
  const floor = fakeText(() => (order.push("floor"), { verdict: "allow", categories: [], reason: "ok" }), "floor", "floor");
  const both = intakeDeps(settings(), liveSuite([llm, floor]));
  const ok = await createSubmission(both, { ...noImage, prompt: "a castle" });
  assert.ok(ok.ok);
  assert.deepEqual(order, ["floor", "llm"]);
  d.dispose();
  both.dispose();
});

test("banned tipper names and the approval tier", async () => {
  const banned = await createSubmission(intakeDeps(settings({ bannedViewers: ["Troll"] })), {
    ...noImage,
    presetId: "underwater",
    tipperName: "troll",
  });
  assert.equal(!banned.ok && banned.status, 403);

  const d = intakeDeps(settings({ customPrompts: "classified+approval" }));
  const r = await createSubmission(d, { ...noImage, prompt: "a pirate ship" });
  assert.ok(r.ok && r.needsReview);
  d.dispose();
});

test("custom text runs literally unless the streamer allows enhancement", async () => {
  const d = intakeDeps();
  const custom = await createSubmission(d, { ...noImage, prompt: "a lighthouse", enhance: "1" });
  assert.ok(custom.ok);
  assert.equal(d.store.get(custom.code)?.enhance, false);
  const preset = await createSubmission(d, { ...noImage, presetId: "underwater" });
  assert.ok(preset.ok);
  assert.equal(d.store.get(preset.code)?.enhance, true);

  const opted = intakeDeps(settings({ enhanceCustomPrompts: true }));
  const o = await createSubmission(opted, { ...noImage, prompt: "a lighthouse" });
  assert.ok(o.ok);
  assert.equal(opted.store.get(o.code)?.enhance, true);
  d.dispose();
  opted.dispose();
});

test("image: non-images are rejected by bytes, not by declared type", async () => {
  const path = await imageFile({ bytes: Buffer.from("<html><script>alert(1)</script>") });
  const d = intakeDeps();
  const r = await createSubmission(d, {
    ipHash: ip,
    presetId: "underwater",
    image: { url: "/uploads/x.jpg", path },
  });
  assert.equal(!r.ok && r.status, 400);
  d.dispose();
});

test("image: re-encoded in place (metadata gone), registered, released on expiry", async () => {
  const path = await imageFile({ ext: ".jpg" });
  assert.ok(readFileSync(path).includes("secret-gps-owner"), "fixture carries EXIF");
  const d = intakeDeps();
  const r = await createSubmission(d, {
    ipHash: ip,
    presetId: "underwater",
    image: { url: "/uploads/a.jpg", path },
  });
  assert.ok(r.ok);
  assert.ok(!readFileSync(path).includes("secret-gps-owner"), "EXIF stripped");
  assert.equal(d.uploads.size, 1);
  d.uploads.releaseCode(r.code, "test");
  assert.deepEqual(d.deleted, [path]);
  d.dispose();
});

test("image: live hosts need a minors-covering classifier before any upload", async () => {
  const path = await imageFile();
  const nonMinor = fakeImage({}, { coversMinors: false });
  const d = intakeDeps(settings(), liveSuite([], [nonMinor]));
  const r = await createSubmission(d, {
    ipHash: ip,
    presetId: "underwater",
    image: { url: "/u/b.jpg", path },
  });
  assert.equal(!r.ok && r.status, 503);
  assert.equal(nonMinor.calls, 0);
  d.dispose();
});

test("image: minors and faces-under-scenes are rejected; CSAM stops the chain and quarantines", async () => {
  const minorCheck = fakeImage({ faces: 1, minorPossible: true });
  const d1 = intakeDeps(settings(), liveSuite([], [minorCheck]));
  const minor = await createSubmission(d1, {
    ipHash: ip,
    presetId: "underwater",
    image: { url: "/u/c.jpg", path: await imageFile() },
  });
  assert.equal(!minor.ok && minor.status, 422);

  const d2 = intakeDeps(settings({ referenceImages: "scenes" }), liveSuite([], [fakeImage({ faces: 2 })]));
  const face = await createSubmission(d2, {
    ipHash: ip,
    presetId: "underwater",
    image: { url: "/u/d.jpg", path: await imageFile() },
  });
  assert.equal(!face.ok && face.status, 422);

  const first = fakeImage({ faces: 1, minorPossible: true, sexual: true, verdict: "reject" });
  const second = fakeImage({}, { coversMinors: false, name: "llm" });
  const d3 = intakeDeps(settings(), liveSuite([], [second, first]));
  const path = await imageFile();
  const csam = await createSubmission(d3, {
    ipHash: ip,
    presetId: "underwater",
    image: { url: "/u/e.jpg", path },
  });
  assert.ok(!csam.ok && csam.quarantine, "quarantined, not deleted");
  assert.equal(second.calls, 0, "no further vendor saw the bytes");
  assert.equal(d3.ledger.recent(1)[0].categories[0], "csam-suspected");
  // …and the picture is blocked from coming back.
  const again = await createSubmission(d3, {
    image: { url: "/u/f.jpg", path: await imageFile({ bytes: readFileSync(path) }) },
    ipHash: "other",
    presetId: "underwater",
  });
  assert.equal(!again.ok && again.status, 422);
  for (const d of [d1, d2, d3]) d.dispose();
});

test("likeness swap: needs a face, consent attestation, and review when configured", async () => {
  const faces = fakeImage({ faces: 1 });
  const s = settings({ reviewLikeness: true });
  const d = intakeDeps(s, liveSuite([], [faces]));
  const noConsent = await createSubmission(d, {
    ipHash: ip,
    presetId: "photo-swap",
    image: { url: "/u/g.jpg", path: await imageFile() },
  });
  assert.equal(!noConsent.ok && noConsent.status, 400);

  const ok = await createSubmission(d, {
    ipHash: ip,
    presetId: "photo-swap",
    consent: "1",
    image: { url: "/u/h.jpg", path: await imageFile() },
  });
  assert.ok(ok.ok && ok.needsReview);
  const sub = d.store.get(ok.code)!;
  assert.match(sub.consent!.statement, /18 or older/);
  assert.equal(sub.consent!.ipHash, ip);

  const noFace = intakeDeps(s, liveSuite([], [fakeImage({ faces: 0 })]));
  const landscape = await createSubmission(noFace, {
    ipHash: ip,
    presetId: "photo-swap",
    consent: "1",
    image: { url: "/u/i.jpg", path: await imageFile() },
  });
  assert.equal(!landscape.ok && landscape.status, 400);
  d.dispose();
  noFace.dispose();
});

test("non-string fields are treated as absent, long prompts are truncated", async () => {
  const d = intakeDeps();
  const junk = await createSubmission(d, { ...noImage, presetId: { $ne: null }, prompt: 42 });
  assert.equal(!junk.ok && junk.status, 400);
  const long = await createSubmission(d, { ...noImage, prompt: "a".repeat(2000) });
  assert.ok(long.ok);
  assert.equal(d.store.get(long.code)?.prompt.length, 500);
  d.dispose();
});

test("parseEnhance: absent = Decart default (on); only explicit off values disable", () => {
  assert.equal(parseEnhance(undefined), true);
  assert.equal(parseEnhance(null), true);
  for (const on of ["1", "true", "on", "yes", ""]) assert.equal(parseEnhance(on), true, on);
  for (const off of ["0", "false", "OFF", " no "]) assert.equal(parseEnhance(off), false, off);
});

test("a needsImage preset without a photo is a 400 and stores nothing", async () => {
  const d = intakeDeps(settings(), emptySuite(true));
  const noPhoto = await createSubmission(d, { ...noImage, presetId: "photo-swap" });
  assert.deepEqual(noPhoto, { ok: false, status: 400, error: "This effect needs a photo." });
  assert.equal(d.store.size, 0);
  d.dispose();
});

// ── What the viewer is told (shared/src/safetyChecks.ts) ─────────────────

test("progress: the plan comes first, then each check's state; the outcome carries final states", async () => {
  const floor = fakeText(undefined, "floor");
  const llm = fakeText(() => ({ verdict: "review", categories: [], reason: "borderline" }), "llm", "policy");
  const gate = fakeImage({ faces: 0 }, { name: "gate" });
  // Approval on, so the borderline verdict parks instead of refusing.
  const d = intakeDeps(settings({ customPrompts: "classified+approval" }), liveSuite([floor, llm], [gate]));
  const events: SubmitProgress[] = [];
  const out = await createSubmission(
    d,
    { ipHash: ip, prompt: "a castle", image: { url: "/u/p.jpg", path: await imageFile() } },
    (ev) => events.push(ev),
  );
  assert.ok(out.ok && out.needsReview);
  const [plan, ...rest] = events;
  assert.equal(plan.t, "plan");
  assert.deepEqual(
    plan.t === "plan" && plan.checks.map((c) => [c.id, c.subject]),
    [
      ["prompt:blocklist", "prompt"],
      ["prompt:floor", "prompt"],
      ["prompt:llm", "prompt"],
      ["photo:file", "photo"],
      ["photo:gate", "photo"],
    ],
  );
  assert.ok(rest.every((e) => e.t === "check"));
  assert.deepEqual(
    out.checks.map((c) => [c.id, c.state]),
    [
      ["prompt:blocklist", "pass"],
      ["prompt:floor", "pass"],
      ["prompt:llm", "review"],
      ["photo:file", "pass"],
      ["photo:gate", "pass"],
    ],
  );
  d.dispose();
});

test("findings: prompt AND photo failures come back together, one strike for the lot", async () => {
  const d = intakeDeps(
    settings({ referenceImages: "scenes" }),
    liveSuite(
      [fakeText(() => ({ verdict: "reject", categories: ["hate"], reason: "not allowed on stream" }), "floor")],
      [fakeImage({ faces: 1, verdict: "reject", categories: ["gore"] }, { name: "gate" })],
    ),
  );
  const out = await createSubmission(d, {
    ipHash: ip,
    prompt: "naked zombies",
    image: { url: "/u/q.jpg", path: await imageFile() },
  });
  assert.ok(!out.ok);
  assert.equal(out.status, 422);
  assert.deepEqual(
    out.findings?.map((f) => [f.subject, f.check, f.category]),
    [
      ["prompt", "prompt:blocklist", "blocklist"],
      ["prompt", "prompt:floor", "hate"],
      ["photo", "photo:gate", "gore"],
      ["photo", "photo:gate", "face-not-allowed"],
    ],
  );
  assert.match(out.error, /^4 problems found/);
  // One strike for the whole submission: the 3-strike pause isn't reached.
  assert.equal(d.strikes.blocked(ip), false);
  d.dispose();
});

test("findings: a non-minor reject at the gate still lets later checks add theirs; a minor stops them", async () => {
  const gate = fakeImage({ verdict: "reject", categories: ["offensive-symbol"] }, { name: "gate" });
  const llm = fakeImage({ verdict: "reject", categories: ["public-figure"] }, { coversMinors: false, name: "llm" });
  const d = intakeDeps(settings(), liveSuite([], [llm, gate]));
  const both = await createSubmission(d, {
    ipHash: ip,
    presetId: "underwater",
    image: { url: "/u/r.jpg", path: await imageFile() },
  });
  assert.deepEqual(!both.ok && both.findings?.map((f) => f.category), ["offensive-symbol", "public-figure"]);

  const minorGate = fakeImage({ faces: 1, minorPossible: true }, { name: "gate" });
  const later = fakeImage({}, { coversMinors: false, name: "llm" });
  const d2 = intakeDeps(settings(), liveSuite([], [later, minorGate]));
  const minor = await createSubmission(d2, {
    ipHash: "other-ip",
    presetId: "underwater",
    image: { url: "/u/s2.jpg", path: await imageFile() },
  });
  assert.ok(!minor.ok);
  assert.equal(later.calls, 0, "no further vendor sees a possible minor");
  assert.deepEqual(minor.findings?.map((f) => f.category), ["minor"]);
  assert.deepEqual(minor.checks?.map((c) => c.state), ["pass", "fail", "skipped"]);
  d.dispose();
  d2.dispose();
});

test("findings: suspected CSAM gives the viewer one generic line, nothing descriptive", async () => {
  const d = intakeDeps(
    settings(),
    liveSuite([], [fakeImage({ faces: 1, minorPossible: true, sexual: true, verdict: "reject", categories: ["sexual", "minor"] })]),
  );
  const out = await createSubmission(d, {
    ipHash: ip,
    presetId: "underwater",
    image: { url: "/u/t.jpg", path: await imageFile() },
  });
  assert.ok(!out.ok && out.quarantine);
  assert.deepEqual(out.findings?.map((f) => [f.category, f.label]), [["rejected", "Image rejected"]]);
  assert.equal(out.error, "Image rejected");
  d.dispose();
});

test("findings: a file that isn't an image is a 400 with a finding, and no strike", async () => {
  const d = intakeDeps(settings(), liveSuite([], [fakeImage({}, { name: "gate" })]));
  for (let i = 0; i < 3; i++) {
    const out = await createSubmission(d, {
      ipHash: ip,
      presetId: "underwater",
      image: { url: "/u/x.jpg", path: await imageFile({ bytes: Buffer.from("not an image") }) },
    });
    assert.ok(!out.ok);
    assert.equal(out.status, 400);
    assert.deepEqual(out.findings?.map((f) => f.category), ["structure"]);
    assert.deepEqual(out.checks?.map((c) => c.state), ["fail", "skipped"]);
  }
  assert.equal(d.strikes.blocked(ip), false);
  d.dispose();
});
