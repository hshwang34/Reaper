// CorrelationStore: the tip↔submission matching ladder.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CorrelationStore } from "../src/index.js";
import { tip } from "./helpers.js";

const sub = (store: CorrelationStore, tipperName: string | null = null) =>
  store.add({ prompt: "p", presetId: null, tipperName, imageUrl: null });

test("rule 1: claim code anywhere in the message, case-insensitive, consumed", () => {
  const store = new CorrelationStore();
  const s = sub(store);
  const m = store.match(tip({ message: `here you go: ${s.code.toLowerCase()} !!` }));
  assert.equal(m.matchedBy, "code");
  assert.equal(m.submission?.code, s.code);
  assert.equal(store.size, 0, "matched submissions are consumed");
  store.dispose();
});

test("rule 1 matches whole tokens only — a word containing the code does not claim it", () => {
  const store = new CorrelationStore();
  const s = sub(store);
  // Two pending so rule 3 can't rescue the match.
  sub(store);
  const m = store.match(tip({ message: `x${s.code}y` }));
  assert.equal(m.matchedBy, "default-preset");
  store.dispose();
});

test("rule 2: declared tipper name matches the tip username", () => {
  const store = new CorrelationStore();
  sub(store, "Alice");
  sub(store, "Bob");
  const m = store.match(tip({ username: "  alice " }));
  assert.equal(m.matchedBy, "username");
  assert.equal(m.submission?.tipperName, "Alice");
  store.dispose();
});

test("rule 3: sole pending submission matches — unless disabled", () => {
  const store = new CorrelationStore();
  sub(store);
  assert.equal(store.match(tip(), { allowSolePendingMatch: false }).matchedBy, "default-preset");
  assert.equal(store.size, 1, "a refused match must not consume");
  assert.equal(store.match(tip()).matchedBy, "sole-pending");
  store.dispose();
});

test("rule 4: nothing pending → default preset", () => {
  const store = new CorrelationStore();
  assert.equal(store.match(tip()).matchedBy, "default-preset");
  store.dispose();
});

test("dispose clears pending so nothing can match afterwards", () => {
  const store = new CorrelationStore();
  const s = sub(store);
  store.dispose();
  assert.equal(store.get(s.code), undefined);
  assert.equal(store.match(tip({ message: s.code })).matchedBy, "default-preset");
});
