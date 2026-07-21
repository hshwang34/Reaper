// Reference-image uploads. Portal downscales client-side; we still cap size and
// restrict types here. Files are served back (same-origin) so the router can
// fetch them as a Blob for Decart initialState.image. The uploads dir is
// host-provided: repo-local for the sidecar CLI, userData for the Electron app.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { extname } from "node:path";
import multer from "multer";

const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);

export function createUploads(uploadsDir: string) {
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const ext = extname(file.originalname).toLowerCase() || ".jpg";
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => {
      cb(null, ALLOWED.has(file.mimetype));
    },
  });

  /** Public (same-origin) URL for an uploaded file. */
  function publicUploadUrl(filename: string): string {
    return `/uploads/${filename}`;
  }

  function deleteUpload(publicUrl: string | null): void {
    if (!publicUrl) return;
    const name = publicUrl.split("/").pop();
    if (!name) return;
    try {
      rmSync(`${uploadsDir}/${name}`, { force: true });
    } catch {
      /* best effort */
    }
  }

  return { upload, publicUploadUrl, deleteUpload };
}
