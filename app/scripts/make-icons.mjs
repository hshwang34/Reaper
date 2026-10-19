// Render the app + tray icons from the brand mark (the site favicon: a dark
// chamfered tile, a cream "play" wedge, the red hijack bar). Run once after
// changing the mark: `node scripts/make-icons.mjs`. Outputs are committed so
// packaging never depends on this script.
//
//   build/icon.png            1024² app icon — electron-builder derives the
//                             .icns (macOS) and .ico (Windows) from it.
//   assets/trayTemplate.png   macOS menu-bar icon. "Template" in the name
//   assets/trayTemplate@2x.png  makes macOS tint it for light/dark menu bars,
//                             so it's pure black + alpha.
//   assets/tray.png, @2x      Windows notification-area icon (full colour —
//                             Windows doesn't tint tray icons).

import sharp from "sharp";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The favicon's 32-unit geometry, reused at every size.
const wedge = "M5 6l15 8.3v3.4L5 26z";
const tile = "M2 0h28l2 2v28l-2 2H2l-2-2V2z";

// App icon: macOS wants the artwork inset in its 1024 canvas (824² tile,
// ~22% corner radius) so it sits level with other Dock icons; Windows
// renders the same PNG fine.
const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs><clipPath id="c"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath></defs>
  <g clip-path="url(#c)">
    <rect x="100" y="100" width="824" height="824" fill="#0a0a0c"/>
    <g transform="translate(100 100) scale(25.75)">
      <path d="${wedge}" fill="#f2f0ea"/>
      <rect x="20" y="0" width="4" height="32" fill="#ff3b1f"/>
    </g>
  </g>
</svg>`;

// Tray: the wedge + bar only (no tile) — a solid square reads as a blob at
// 16px. A small gap keeps the two shapes distinct.
const traySvg = (fillWedge, fillBar) => `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <path d="M4 5l14 8.5v5L4 27z" fill="${fillWedge}"/>
  <rect x="21" y="2" width="5" height="28" fill="${fillBar}"/>
</svg>`;

const out = async (svg, size, file) =>
  sharp(Buffer.from(svg)).resize(size, size)
    .png()
    .toFile(resolve(app, file));

await out(appIcon, 1024, "build/icon.png");
await out(traySvg("#000", "#000"), 16, "assets/trayTemplate.png");
await out(traySvg("#000", "#000"), 32, "assets/trayTemplate@2x.png");
await out(traySvg("#f2f0ea", "#ff3b1f"), 16, "assets/tray.png");
await out(traySvg("#f2f0ea", "#ff3b1f"), 32, "assets/tray@2x.png");
console.log("icons written");
