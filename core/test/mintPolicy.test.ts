// gatedMint: job-gated, one-per-job, budget-capped, debit-after-success.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CorrelationStore, Engine, MintError, SESSION_CAP_EXTRA_SEC, gatedMint, memoryLedger, type MintLedger } from "../src/index.js";
import { recorder, settings, tip } from "./helpers.js";

function activeEngine(durationSec = 10) {
  const r = recorder();
  const engine = new Engine(new CorrelationStore(), r.emit, () =>
    settings({ minTipUSD: 0, maxDurationSec: 60 }),
  );
  engine.setRouterState("IDLE");
  engine.onTip(tip({ amount: durationSec }));
  return engine;
}

const okMint = async (d: number) => `ek_${d}`;

test("refuses with 400 on a bad duration and 403 with no active job", async () => {
  const engine = new Engine(new CorrelationStore(), recorder().emit, () => settings());
  await assert.rejects(gatedMint(engine, NaN, okMint), (e: MintError) => e.status === 400);
  await assert.rejects(gatedMint(engine, 5, okMint), (e: MintError) => e.status === 403);
  engine.dispose();
});

test("allows up to remaining + headroom, refuses beyond", async () => {
  const engine = activeEngine(10);
  await assert.rejects(gatedMint(engine, 10 + SESSION_CAP_EXTRA_SEC + 1, okMint), /exceeds/);
  assert.equal(await gatedMint(engine, 10, okMint), "ek_10");
  engine.dispose();
});

test("one token per job, even with the default in-memory ledger", async () => {
  const engine = activeEngine(10);
  const ledger = memoryLedger();
  await gatedMint(engine, 10, okMint, ledger);
  await assert.rejects(gatedMint(engine, 10, okMint, ledger), /already minted/);
  engine.dispose();
});

test("budget is checked on capped seconds and debited only after success", async () => {
  const engine = activeEngine(10);
  const rows: { cappedSec: number }[] = [];
  const ledger: MintLedger = {
    hasMintFor: () => false,
    usedSec: () => rows.reduce((a, r) => a + r.cappedSec, 0),
    capSec: () => 10 + SESSION_CAP_EXTRA_SEC, // exactly one mint fits
    record: (e) => {
      rows.push(e);
    },
  };
  await assert.rejects(
    gatedMint(engine, 10, async () => {
      throw new Error("decart down");
    }, ledger),
    /decart down/,
  );
  assert.equal(rows.length, 0, "a failed mint must not be debited");
  await gatedMint(engine, 10, okMint, ledger);
  assert.equal(rows.length, 1);
  await assert.rejects(gatedMint(engine, 1, okMint, ledger), /budget/);
  engine.dispose();
});
