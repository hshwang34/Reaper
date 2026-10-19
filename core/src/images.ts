// Reference-image hardening — the structural half of CONTENT-SAFETY S2, run
// on every upload before any classifier or the model sees it:
//
//   1. sniff   — trust the bytes, not the declared mimetype
//   2. re-encode — decode + re-encode through sharp at ≤1024px. Drops EXIF/GPS
//                 (sharp writes no metadata unless asked), applies the EXIF
//                 orientation first, and defuses polyglot files: what we store
//                 and serve is a fresh image we produced, never the upload.
//   3. hash    — sha256 of the stored bytes (exact "identical copies" for
//                TAKE IT DOWN takedowns) + a 64-bit dHash (near-duplicates).
//
// The stored file keeps its host-chosen extension; we re-encode INTO that
// format so the extension, the served Content-Type and the bytes agree.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import sharp from "sharp";

export type ImageFormat = "jpeg" | "png" | "webp";

/** Magic-byte sniff for the three formats we accept. */
export function sniffImage(buf: Buffer): ImageFormat | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "png";
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

const EXT_FORMAT: Record<string, ImageFormat> = {
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".png": "png",
  ".webp": "webp",
};

/** Longest edge we keep. Decart wants ≥512; nothing needs more than this. */
const MAX_EDGE = 1024;
/** Decoder guard against decompression bombs (sharp's own default is huge). */
const MAX_INPUT_PIXELS = 40_000_000;

export interface PreparedImage {
  sha256: string;
  /** 64-bit difference hash, hex — Hamming distance ≤ 6 ≈ same picture. */
  dhash: string;
  width: number;
  height: number;
  /** Metadata-free JPEG copy for the classifiers (never stored). */
  classifierJpeg: Buffer;
}

export class ImageRejected extends Error {}

/**
 * Validate and rewrite the stored upload in place. Throws ImageRejected for
 * anything that isn't a real, decodable jpeg/png/webp of sane size.
 */
export async function prepareUpload(path: string): Promise<PreparedImage> {
  const original = await readFile(path);
  const sniffed = sniffImage(original);
  if (!sniffed) throw new ImageRejected("not a jpeg, png or webp image");

  const target = EXT_FORMAT[extname(path).toLowerCase()] ?? sniffed;
  const meta = await sharp(original, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
    .metadata()
    .catch(() => {
      throw new ImageRejected("image could not be decoded");
    });
  if (!meta.width || !meta.height || meta.width < 64 || meta.height < 64) {
    throw new ImageRejected("image is too small");
  }

  const base = sharp(original, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
    .rotate() // apply EXIF orientation before it's discarded
    .resize(MAX_EDGE, MAX_EDGE, { fit: "inside", withoutEnlargement: true });

  let stored: Buffer;
  try {
    stored = await base.clone().toFormat(target, { quality: 88 }).toBuffer();
  } catch {
    throw new ImageRejected("image could not be re-encoded");
  }
  await writeFile(path, stored);

  const classifierJpeg = await sharp(stored)
    .resize(768, 768, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  const out = await sharp(stored).metadata();

  return {
    sha256: sha256Hex(stored),
    dhash: await dHash(stored),
    width: out.width ?? 0,
    height: out.height ?? 0,
    classifierJpeg,
  };
}

export function sha256Hex(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Difference hash: 9×8 greyscale, compare horizontal neighbours → 64 bits. */
export async function dHash(buf: Buffer): Promise<string> {
  const px = await sharp(buf).greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1n) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, "0");
}

export function hamming(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}
