// The channel API's route surface. The console triggers run a job with no
// payment behind it, so a public host must be able to leave them out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApiRouter } from "../src/http/apiRouter.js";

/** "METHOD /path" for every route the router mounts. */
function routes(router: ReturnType<typeof buildApiRouter>): string[] {
  return (router.stack as { route?: { path: string; methods: Record<string, boolean> } }[])
    .filter((l) => l.route)
    .flatMap((l) => Object.keys(l.route!.methods).map((m) => `${m.toUpperCase()} ${l.route!.path}`));
}

const opts = {
  context: () => null,
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  upload: (_req: unknown, _res: unknown, next: () => void) => next(),
};

test("dev routes mount by default (local rig)", () => {
  const r = routes(buildApiRouter(opts as never));
  assert.ok(r.includes("POST /dev/hijack"));
  assert.ok(r.includes("POST /dev/fake-tip"));
});

test("devRoutes:false leaves out exactly the unpaid triggers", () => {
  const all = routes(buildApiRouter(opts as never));
  const hosted = routes(buildApiRouter({ ...opts, devRoutes: false } as never));
  assert.deepEqual(
    all.filter((x) => !hosted.includes(x)).sort(),
    ["POST /dev/fake-tip", "POST /dev/hijack", "POST /dev/token"],
  );
  assert.ok(hosted.includes("POST /token"), "minting stays");
  assert.ok(hosted.includes("POST /submissions"), "intake stays");
});

// ── POST /dev/token (preview batch recorder) ─────────────────────────────

import express from "express";
import type { AddressInfo } from "node:net";

async function withServer(
  routerOpts: Record<string, unknown>,
  devMint: ((d: number) => Promise<string>) | undefined,
  fn: (post: (body: unknown) => Promise<Response>) => Promise<void>,
) {
  const router = buildApiRouter({
    ...opts,
    context: () => ({ devMint }),
    ...routerOpts,
  } as never);
  const app = express().use(express.json()).use("/api", router);
  const server = app.listen(0);
  try {
    const port = (server.address() as AddressInfo).port;
    await fn((body) =>
      fetch(`http://127.0.0.1:${port}/api/dev/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  } finally {
    server.close();
  }
}

test("POST /dev/token mints ungated, validates and caps durationSec", async () => {
  const asked: number[] = [];
  await withServer({}, async (d) => (asked.push(d), "ek_test"), async (post) => {
    const ok = await post({ durationSec: 12 });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { token: "ek_test" });
    assert.deepEqual(asked, [12]);
    for (const bad of [{}, { durationSec: 0 }, { durationSec: -3 }, { durationSec: "x" }, { durationSec: 61 }]) {
      assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
    }
    assert.deepEqual(asked, [12], "refused requests never reach the mint");
  });
});

test("POST /dev/token is 501 on a host without devMint, 404 when devRoutes is off", async () => {
  await withServer({}, undefined, async (post) => {
    assert.equal((await post({ durationSec: 5 })).status, 501);
  });
  await withServer({ devRoutes: false }, async () => "ek_test", async (post) => {
    assert.equal((await post({ durationSec: 5 })).status, 404);
  });
});

test("POST /dev/token honours requireAuth", async () => {
  const deny = (_req: unknown, res: { status(n: number): { end(): void } }) => res.status(401).end();
  await withServer({ requireAuth: deny }, async () => "ek_test", async (post) => {
    assert.equal((await post({ durationSec: 5 })).status, 401);
  });
});
