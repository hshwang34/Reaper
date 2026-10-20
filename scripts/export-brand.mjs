// Export every product icon from the approved mascot; never redraw it per surface.
import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = resolve(root, "branding/hijacker-v2/mascot-expressive.png");
for (const folder of ["site/public/brand", "web/public/brand"]) {
  await mkdir(resolve(root, folder), { recursive: true });
  for (const size of [32, 180, 512, 640]) {
    await sharp(source).resize(size, size).png().toFile(
      resolve(root, folder, `${size === 640 ? "mascot" : "icon"}-${size}.png`),
    );
  }
}
await mkdir(resolve(root, "app/build"), { recursive: true });
await sharp(source).resize(1024, 1024).png().toFile(resolve(root, "app/build/icon.png"));
console.log("Brand PNG exports updated for website, web app, and desktop packaging.");
