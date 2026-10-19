// Stage everything electron-builder ships into extraResources.
//
// The main process is bundled (esbuild) with all deps inlined EXCEPT
// @decartai/sdk (lazy-imported, and its browser globals break at bundle
// time) and sharp (a native addon) — so we copy those packages'
// node_modules subtrees next to the bundle. The web build goes to resources/web-dist (config.ts webDistDir()
// reads process.resourcesPath/web-dist in production).

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const repo = resolve(appDir, "..");
const staging = resolve(appDir, "build-resources");

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

// 1. web/dist → build-resources/web-dist
const webDist = resolve(repo, "web", "dist");
if (!existsSync(webDist)) {
  console.error("web/dist missing — run `npm run build` first");
  process.exit(1);
}
cpSync(webDist, resolve(staging, "web-dist"), { recursive: true });

// 2. @decartai/sdk (+ its deps) → build-resources/node_modules
//    electron-builder places extraResources under Contents/Resources, and
//    createRequire in the bundle resolves from there.
const sdk = resolve(repo, "node_modules", "@decartai");
if (existsSync(sdk)) {
  cpSync(sdk, resolve(staging, "node_modules", "@decartai"), {
    recursive: true,
  });
}

// 3. sharp (content-safety image re-encoding) — a native addon, so it can't
//    be inlined by esbuild. Copy it, its prebuilt platform binaries
//    (@img/sharp-<platform>, @img/sharp-libvips-<platform>) and its three
//    small JS deps. The build host's platform is what ships: run `dist` on
//    the target OS/arch (CI does — macOS arm64 first).
for (const pkg of ["sharp", "@img", "detect-libc", "semver"]) {
  const from = resolve(repo, "node_modules", pkg);
  if (existsSync(from)) {
    cpSync(from, resolve(staging, "node_modules", pkg), { recursive: true });
  } else if (pkg === "sharp") {
    console.error("sharp missing from node_modules — run npm install");
    process.exit(1);
  }
}

console.log("staged resources → build-resources/");
