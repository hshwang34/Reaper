// Render the macOS menu-bar (tray) icon: a monochrome "Template" image macOS
// tints for light/dark menu bars, so it's pure black + alpha. Run after
// changing the mark: `node scripts/make-icons.mjs`. Outputs are committed.
//
// The APP icon (build/icon.png) is the hijacker mascot from branding/,
// exported by scripts/export-brand.mjs at the repo root — not made here.
// Windows' tray uses that same mascot at runtime (main.ts); only macOS needs
// a separate monochrome mark.

import sharp from "sharp";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The brand mark's wedge + bar, no tile — a solid square reads as a blob at
// 16px. A small gap keeps the two shapes distinct.
const traySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <path d="M4 5l14 8.5v5L4 27z" fill="#000"/>
  <rect x="21" y="2" width="5" height="28" fill="#000"/>
</svg>`;

const out = async (svg, size, file) =>
  sharp(Buffer.from(svg)).resize(size, size).png().toFile(resolve(app, file));

await out(traySvg, 16, "assets/trayTemplate.png");
await out(traySvg, 32, "assets/trayTemplate@2x.png");
console.log("tray icons written");
