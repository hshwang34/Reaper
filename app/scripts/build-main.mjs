// Bundle the main process + preload with esbuild. A script rather than a
// package.json one-liner because one input is baked in at build time and
// shell expansion differs between sh and cmd.exe (CI builds on both):
//
//   RH_CLOUD_URL  the hosted control plane this build signs in to. Set by CI
//                 from the repo variable of the same name. Empty = no hosted
//                 sign-in in this build (the wizard says so).

import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cloudUrl = (process.env.RH_CLOUD_URL ?? "").trim().replace(/\/+$/, "");
if (cloudUrl) console.log(`build-main: hosted control plane → ${cloudUrl}`);
else console.log("build-main: no RH_CLOUD_URL — this build has no hosted sign-in");

await build({
  entryPoints: [resolve(app, "src/main/main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["electron", "@decartai/sdk", "sharp"],
  alias: {
    "@rh/shared": resolve(app, "../shared/src/index.ts"),
    "@rh/core": resolve(app, "../core/src/index.ts"),
    "@rh/sidecar": resolve(app, "../sidecar/src/server.ts"),
  },
  define: { __RH_CLOUD_URL__: JSON.stringify(cloudUrl) },
  banner: { js: "import{createRequire}from'module';const require=createRequire(import.meta.url);" },
  outfile: resolve(app, "dist/main.mjs"),
});
await build({
  entryPoints: [resolve(app, "src/preload.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  outfile: resolve(app, "dist/preload.cjs"),
});
