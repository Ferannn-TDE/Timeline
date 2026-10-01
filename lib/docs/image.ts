import sharp from "sharp";
import { HttpError } from "./server.ts";

// Accept common 48/64 MP phone originals, then bound the image Google receives.
// EXIF rotation precedes proportional resizing; neither operation crops photos.
export async function prepareDocsImage(bytes: Uint8Array) {
  try {
    return await sharp(bytes, { limitInputPixels: 80_000_000 }).rotate()
      .resize({ width: 1600, height: 2000, fit: "inside", withoutEnlargement: true })
      .png().toBuffer({ resolveWithObject: true });
  } catch {
    throw new HttpError(422, "This photo could not be prepared for Google Docs. Use a readable image of at most 80 megapixels. The original photo and journal entry remain saved; document changes remain queued.", "image_preparation_failed");
  }
}
