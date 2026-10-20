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
    ["POST /dev/fake-tip", "POST /dev/hijack"],
  );
  assert.ok(hosted.includes("POST /token"), "minting stays");
  assert.ok(hosted.includes("POST /submissions"), "intake stays");
});
