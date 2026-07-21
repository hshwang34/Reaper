// Client-side downscale so reference images fit Decart's 720p world and don't
// bloat the upload. Preserves aspect ratio, caps at 1280×720, re-encodes JPEG.

const MAX_W = 1280;
const MAX_H = 720;

export async function downscaleImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(MAX_W / bitmap.width, MAX_H / bitmap.height, 1);
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  return new Promise<Blob>((resolve) => {
    canvas.toBlob(
      (blob) => resolve(blob ?? file),
      "image/jpeg",
      0.85,
    );
  });
}
