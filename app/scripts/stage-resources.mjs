// Stage everything electron-builder ships into extraResources.
//
// The main process is bundled (esbuild) with all deps inlined EXCEPT
// @decartai/sdk and sharp — so we copy those packages and their dependency
// closures next to the bundle. The web build goes to resources/web-dist (config.ts webDistDir()
// reads process.resourcesPath/web-dist in production).

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
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

// 2. The packages esbuild leaves external, WITH their full dependency
//    closure → build-resources/node_modules. electron-builder places
//    extraResources under Contents/Resources, and createRequire in the
//    bundle resolves from there (the asar ships no node_modules).
//    - @decartai/sdk: lazy-imported, and its browser globals break at bundle
//      time. Its deps (livekit-client, zod, …) must come along — they used to
//      resolve only by accident, from a duplicate tree inside the asar.
//    - sharp (content-safety image re-encoding): a native addon. Its
//      prebuilt binaries are optional deps, handled per arch in step 3.
const nodeModules = resolve(repo, "node_modules");
const staged = new Set();

/** Node's lookup: <dir>/node_modules/<name>, then each parent's, up to the
 *  repo root. Returns the package dir or null. */
function findPackage(name, fromDir) {
  for (let dir = fromDir; dir.startsWith(repo); dir = dirname(dir)) {
    const candidate = resolve(dir, "node_modules", name);
    if (existsSync(resolve(candidate, "package.json"))) return candidate;
    if (dir === repo) break;
  }
  return null;
}

function stageWithDeps(name, fromDir = repo) {
  const dir = findPackage(name, fromDir);
  if (!dir) {
    console.error(`${name} missing from node_modules — run npm install`);
    process.exit(1);
  }
  if (staged.has(dir)) return;
  staged.add(dir);
  // Same path relative to the repo's node_modules, so hoisting and nested
  // version conflicts resolve exactly as they do in development.
  cpSync(dir, resolve(staging, "node_modules", relative(nodeModules, dir)), {
    recursive: true,
    dereference: true,
  });
  const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
  for (const dep of Object.keys(pkg.dependencies ?? {})) stageWithDeps(dep, dir);
}

stageWithDeps("@decartai/sdk");
stageWithDeps("sharp");

// 3. sharp's prebuilt binaries for EVERY arch being packaged — whichever
//    of its optional deps match <os>-<arch> (@img/sharp-darwin-arm64 +
//    @img/sharp-libvips-darwin-arm64 on macOS; Windows bundles libvips into
//    @img/sharp-win32-x64). npm only installs the build host's own, so the
//    others (e.g. x64 when an arm64 Mac builds the Intel DMG) are fetched
//    with `npm pack`, which ignores os/cpu.
//    RH_ARCHS lists the target arches (default: this machine's); RH_PLATFORM
//    overrides the OS (default: this machine's) for cross-packaging.
const platform = process.env.RH_PLATFORM ?? process.platform;
const archs = (process.env.RH_ARCHS ?? process.arch).split(",").map((a) => a.trim());
const sharpOptional = JSON.parse(
  readFileSync(resolve(nodeModules, "sharp", "package.json"), "utf8"),
).optionalDependencies;
for (const arch of archs) {
  const binaries = Object.keys(sharpOptional).filter((pkg) =>
    new RegExp(`^@img/sharp-(libvips-)?${platform}-${arch}$`).test(pkg),
  );
  if (binaries.length === 0) {
    console.error(`sharp has no prebuilt binary for ${platform}-${arch}`);
    process.exit(1);
  }
  for (const pkg of binaries) {
    const dest = resolve(staging, "node_modules", pkg);
    const installed = resolve(nodeModules, pkg);
    if (existsSync(installed)) {
      cpSync(installed, dest, { recursive: true });
      continue;
    }
    const tmp = mkdtempSync(join(tmpdir(), "rh-sharp-"));
    execFileSync("npm", ["pack", `${pkg}@${sharpOptional[pkg]}`, "--silent", "--pack-destination", tmp], {
      stdio: ["ignore", "ignore", "inherit"],
      shell: process.platform === "win32", // npm is npm.cmd there
    });
    const tarball = readdirSync(tmp).find((f) => f.endsWith(".tgz"));
    // npm tarballs unpack to package/; strip that prefix into dest.
    mkdirSync(dest, { recursive: true });
    execFileSync("tar", ["-xzf", join(tmp, tarball), "-C", dest, "--strip-components=1"]);
    rmSync(tmp, { recursive: true, force: true });
    console.log(`fetched ${pkg}@${sharpOptional[pkg]}`);
  }
}

console.log("staged resources → build-resources/");
