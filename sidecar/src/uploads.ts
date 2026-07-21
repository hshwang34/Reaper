// Reference-image uploads. Portal downscales client-side; we still cap size and
// restrict types here. Files are served back (proxied same-origin by Vite) so
// the router can fetch them as a Blob for Decart initialState.image.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { extname } from "node:path";
import multer from "multer";
import { uploadsDir } from "./config.js";

if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });

const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = extname(file.originalname).toLowerCase() || ".jpg";
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
  },
});

export const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    cb(null, ALLOWED.has(file.mimetype));
  },
});

/** Public (Vite-proxied, same-origin) URL for an uploaded file. */
export function publicUploadUrl(filename: string): string {
  return `/uploads/${filename}`;
}

export function deleteUpload(publicUrl: string | null): void {
  if (!publicUrl) return;
  const name = publicUrl.split("/").pop();
  if (!name) return;
  try {
    rmSync(`${uploadsDir}/${name}`, { force: true });
  } catch {
    /* best effort */
  }
}
