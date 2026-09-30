import type { SupabaseClient } from "@supabase/supabase-js";

export const BUCKET = "photo-journal";
export const APPROVED_EMAILS = ["feranmidyro@gmail.com", "kieragreen50@gmail.com"];
export type Row = { id: string; photo_date: string; caption: string; image_key: string; author_email: string; created_at: string };
export type Entry = Row & { imageUrl: string };

export function errorMessage(error: unknown, fallback: string): string {
  return error && typeof error === "object" && "message" in error && typeof error.message === "string"
    ? error.message : fallback;
}

export function validateEntry(date: string, caption: string) {
  const parsed = new Date(date + "T12:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith("0000") || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw Error("Choose a valid photo date.");
  }
  if (!caption.trim() || caption.trim().length > 2000) throw Error("Add a caption between 1 and 2,000 characters.");
}

export function validatePhoto(photo: Pick<File, "type" | "size">) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(photo.type) || photo.size > 10_000_000 || photo.size === 0) {
    throw Error("Choose a JPEG, PNG or WebP photo up to 10 MB.");
  }
}

export async function loadEntries(client: SupabaseClient): Promise<Entry[]> {
  const rows: Row[] = [];
  // Supabase limits responses. Fetch pages so older entries cannot disappear silently.
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await client.from("entries")
      .select("id,photo_date,caption,image_key,author_email,created_at")
      .order("photo_date", { ascending: false }).order("created_at", { ascending: true })
      .order("id", { ascending: true }).range(offset, offset + 499);
    if (error) throw error;
    rows.push(...(data || []));
    if ((data || []).length < 500) break;
  }
  const entries: Entry[] = [];
  for (let offset = 0; offset < rows.length; offset += 100) {
    const batch = rows.slice(offset, offset + 100);
    const { data, error } = await client.storage.from(BUCKET).createSignedUrls(batch.map(row => row.image_key), 3600);
    if (error) throw error;
    const links = new Map((data || []).map(link => [link.path, link]));
    for (const row of batch) {
      const link = links.get(row.image_key);
      // One missing object must not hide the rest of the journal.
      entries.push({ ...row, imageUrl: link?.signedUrl || "" });
    }
  }
  return entries;
}

export async function addEntry(client: SupabaseClient, accountEmail: string, photo: File, date: string, caption: string) {
  validateEntry(date, caption);
  validatePhoto(photo);
  const ext = photo.type === "image/png" ? "png" : photo.type === "image/webp" ? "webp" : "jpg";
  const imageKey = crypto.randomUUID() + "." + ext;
  const { error: uploadError } = await client.storage.from(BUCKET).upload(imageKey, photo, { contentType: photo.type, upsert: false });
  if (uploadError) throw uploadError;
  const { error: insertError } = await client.from("entries").insert({ photo_date: date, caption: caption.trim(), image_key: imageKey, author_email: accountEmail.toLowerCase() });
  if (insertError) {
    const { error: cleanupError } = await client.storage.from(BUCKET).remove([imageKey]);
    if (cleanupError) throw Error(`${errorMessage(insertError, "Could not save photo.")} The uploaded photo could not be cleaned up; retry cleanup before uploading it again.`);
    throw insertError;
  }
}

export async function editEntry(client: SupabaseClient, original: Row, date: string, caption: string) {
  validateEntry(date, caption);
  const { data, error } = await client.from("entries").update({ photo_date: date, caption: caption.trim() })
    .eq("id", original.id).eq("photo_date", original.photo_date).eq("caption", original.caption).select("id");
  if (error) throw error;
  if (data?.length !== 1) throw Error("This entry changed or was removed by the other editor. Refresh the timeline before saving again.");
}

export async function deleteEntry(client: SupabaseClient, original: Row): Promise<string | null> {
  const { data, error } = await client.from("entries").delete().eq("id", original.id)
    .eq("photo_date", original.photo_date).eq("caption", original.caption).select("id");
  if (error) throw error;
  if (data?.length !== 1) throw Error("This entry changed or was already removed. Refresh the timeline before removing it again.");
  const { error: cleanupError } = await client.storage.from(BUCKET).remove([original.image_key]);
  return cleanupError ? "Entry removed, but its private photo could not be deleted from storage. Storage cleanup is still needed." : null;
}
