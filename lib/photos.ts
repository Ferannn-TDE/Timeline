export const PHOTO_LIMIT = 10_000_000;
export const PIXEL_LIMIT = 80_000_000;
export const PHOTO_FORMATS = "JPEG, PNG, WebP, HEIC or HEIF";
export function isHeifName(name: string) { return /\.hei[cf]$/i.test(name); }
export function photoDisplayKey(key: string) { return isHeifName(key) ? key + ".preview.jpg" : key; }
export function photoKeys(key: string) { return [...new Set([key, photoDisplayKey(key)])]; }
export function photoType(photo: { type: string; name?: string }) {
  // iOS/share sheets sometimes supply octet-stream, an empty type, or JPEG for HEIC.
  if (isHeifName(photo.name || "")) return /\.heif$/i.test(photo.name!) ? "image/heif" : "image/heic";
  if (["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"].includes(photo.type)) return "image/heic";
  if (["image/jpeg", "image/png", "image/webp"].includes(photo.type)) return photo.type;
  if (!photo.type || photo.type === "application/octet-stream") {
    if (/\.jpe?g$/i.test(photo.name || "")) return "image/jpeg";
    if (/\.png$/i.test(photo.name || "")) return "image/png";
    if (/\.webp$/i.test(photo.name || "")) return "image/webp";
  }
  return "";
}
export function checkPixels(width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > PIXEL_LIMIT || Math.max(width,height) > 20000) throw Error("This photo exceeds the decoded-image limit of 80 megapixels or 20,000 pixels per side. Choose a smaller original.");
}
export async function detectHeif(file: Blob) {
  const bytes = new Uint8Array(await file.slice(0, 256).arrayBuffer());
  if (bytes.length < 16 || String.fromCharCode(...bytes.slice(4,8)) !== "ftyp") return false;
  const size = Math.min(new DataView(bytes.buffer).getUint32(0), bytes.length);
  for(let i=8;i+4<=size;i+=4) {
    if(i===12)continue;
    if (["heic","heix","hevc","hevx","heim","heis","mif1","msf1"].includes(String.fromCharCode(...bytes.slice(i,i+4)))) return true;
  }
  return false;
}
