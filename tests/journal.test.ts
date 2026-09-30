import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addEntry, editEntry, deleteEntry, loadEntries, validateEntry, validatePhoto, errorMessage, type Row } from "../lib/journal.ts";

const row: Row = { id: "entry-1", photo_date: "2020-01-01", caption: "Original", image_key: "photo.jpg", author_email: "feranmidyro@gmail.com", created_at: "2026-01-01T00:00:00Z" };
const photo = new File([new Uint8Array([1, 2, 3])], "portrait.jpg", { type: "image/jpeg" });

function fake(options: { queryData?: unknown[]; queryError?: { message: string }; uploadError?: { message: string }; cleanupError?: { message: string }; pages?: Row[][] } = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  let page = 0;
  const query: Record<string, unknown> = {};
  for (const name of ["select", "insert", "update", "delete", "eq", "order", "range"]) {
    query[name] = (...args: unknown[]) => { calls.push({ name, args }); return query; };
  }
  query.then = (resolve: (value: unknown) => void) => resolve({ data: options.pages ? options.pages[page++] : options.queryData || [], error: options.queryError || null });
  const client = {
    from: (name: string) => { calls.push({ name: "from", args: [name] }); return query; },
    storage: { from: (name: string) => {
      assert.equal(name, "photo-journal");
      return {
        upload: async (...args: unknown[]) => { calls.push({ name: "upload", args }); return { error: options.uploadError || null }; },
        remove: async (...args: unknown[]) => { calls.push({ name: "remove", args }); return { error: options.cleanupError || null }; },
        createSignedUrls: async (paths: string[]) => ({ data: paths.map(path => ({ path, signedUrl: path === "missing.jpg" ? "" : "https://photos.test/" + path })), error: null }),
      };
    } },
  } as unknown as SupabaseClient;
  return { client, calls };
}

test("validates leap dates, empty captions, and upload limits before writing", () => {
  validateEntry("2024-02-29", "Memory");
  for (const date of ["2023-02-29", "2026-02-30", "0000-01-01", "", "invalid", "2026-13-01"]) assert.throws(() => validateEntry(date, "Memory"));
  assert.throws(() => validateEntry("2024-01-01", "  "));
  assert.throws(() => validateEntry("2024-01-01", "a".repeat(2001)));
  validatePhoto({ type: "image/jpeg", size: 10_000_000 });
  for (const p of [{ type: "image/gif", size: 1 }, { type: "image/png", size: 0 }, { type: "image/webp", size: 10_000_001 }]) assert.throws(() => validatePhoto(p));
});

test("upload failure never removes an object it did not upload", async () => {
  const { client, calls } = fake({ uploadError: { message: "Upload denied" } });
  await assert.rejects(addEntry(client, row.author_email, photo, row.photo_date, row.caption), { message: "Upload denied" });
  assert.equal(calls.some(call => call.name === "remove" || call.name === "insert"), false);
});

test("failed database insert cleans only its newly uploaded object", async () => {
  const { client, calls } = fake({ queryError: { message: "Insert denied" } });
  await assert.rejects(addEntry(client, row.author_email, photo, row.photo_date, row.caption), { message: "Insert denied" });
  const uploaded = calls.find(call => call.name === "upload")!.args[0];
  assert.deepEqual(calls.find(call => call.name === "remove")!.args, [[uploaded]]);
});

test("failed insert cleanup remains visible", async () => {
  const { client } = fake({ queryError: { message: "Insert denied" }, cleanupError: { message: "Storage unavailable" } });
  await assert.rejects(addEntry(client, row.author_email, photo, row.photo_date, row.caption), /could not be cleaned up/);
});

test("save uses an immutable object key and normalizes captions and author", async () => {
  const { client, calls } = fake();
  await addEntry(client, "FERANMIDYRO@gmail.com", photo, "2010-05-12", "  Older memory  ");
  const fields = calls.find(call => call.name === "insert")!.args[0] as Row;
  assert.equal(fields.photo_date, "2010-05-12");
  assert.equal(fields.caption, "Older memory");
  assert.equal(fields.author_email, row.author_email);
  assert.match(fields.image_key, /^[\da-f-]{36}\.jpg$/);
  assert.equal(calls.some(call => call.name === "remove"), false);
});

test("edit checks original fields and rejects a zero-row update", async () => {
  const { client, calls } = fake();
  await assert.rejects(editEntry(client, row, "2010-05-12", "New caption"), /changed or was removed/);
  assert.deepEqual(calls.filter(call => call.name === "eq").map(call => call.args), [["id", row.id], ["photo_date", row.photo_date], ["caption", row.caption]]);
  await editEntry(fake({ queryData: [{ id: row.id }] }).client, row, "2010-05-12", "New caption");
});

test("zero-row deletion leaves the photo untouched", async () => {
  const { client, calls } = fake();
  await assert.rejects(deleteEntry(client, row), /changed or was already removed/);
  assert.equal(calls.some(call => call.name === "remove"), false);
});

test("delete reports an orphan without pretending entry deletion failed", async () => {
  const { client } = fake({ queryData: [{ id: row.id }], cleanupError: { message: "Storage unavailable" } });
  assert.match((await deleteEntry(client, row))!, /private photo could not be deleted/);
  assert.equal(await deleteEntry(fake({ queryData: [{ id: row.id }] }).client, row), null);
});

test("loads older pages with deterministic descending order and preserves missing-photo entries", async () => {
  const fullPage = Array.from({ length: 500 }, (_, i) => ({ ...row, id: String(i) }));
  const { client, calls } = fake({ pages: [fullPage, [{ ...row, id: "older", image_key: "missing.jpg" }]] });
  const entries = await loadEntries(client);
  assert.equal(entries.length, 501);
  assert.equal(entries[500].imageUrl, "");
  assert.deepEqual(calls.filter(call => call.name === "range").map(call => call.args), [[0, 499], [500, 999]]);
  assert.deepEqual(calls.filter(call => call.name === "order").slice(0, 3).map(call => call.args), [["photo_date", { ascending: false }], ["created_at", { ascending: true }], ["id", { ascending: true }]]);
});

test("Supabase plain-object errors are displayed", () => {
  assert.equal(errorMessage({ message: "RLS denied" }, "Unknown error"), "RLS denied");
});
