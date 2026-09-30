// Requires a real Microsoft connection. Never writes to PHOTO EVIDENCE.docx.
// Leaves the temporary document available for Word Online/desktop layout review.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
import sharp from "sharp";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { Graph, exchangeToken } from "../lib/word/graph.ts";
import { serviceDb, decrypt, encrypt, HttpError } from "../lib/word/server.ts";
import { mergeDocx, inspectDocx, desiredHash } from "../lib/word/docx.ts";
import type { Row } from "../lib/journal.ts";
import type { Baseline } from "../lib/word/types.ts";

const microsoft = JSON.parse(await readFile(".credentials/microsoft.json", "utf8"));
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "https://rnilakqmyanujehtqbuk.supabase.co", MICROSOFT_TENANT_ID: microsoft.tenantId, MICROSOFT_CLIENT_ID: microsoft.clientId, MICROSOFT_CLIENT_SECRET: microsoft.clientSecret });
for (const name of ["SUPABASE_SERVICE_ROLE_KEY", "WORD_TOKEN_ENCRYPTION_KEY"]) process.env[name] = (await readFile(".credentials/" + name, "utf8")).trim();
const db = serviceDb(), owner = randomUUID();
const locked = await db.rpc("acquire_word_lease", { p_owner: owner });
if (locked.error || !locked.data) throw Error("Connect Microsoft first and wait for any active sync to finish.");
let connection: any, graph: Graph;
try {
  const result = await db.from("word_connections").select("*").eq("lease_owner", owner).single();
  if (result.error) throw Error("Could not read the protected Word connection.");
  connection = result.data;
  if (connection.enabled) throw Error("Disable syncing before running initial acceptance tests.");
  const token = await exchangeToken({ grant_type: "refresh_token", refresh_token: decrypt(connection.refresh_token_encrypted) });
  if (token.refresh_token) {
    const saved = await db.from("word_connections").update({ refresh_token_encrypted: encrypt(token.refresh_token) }).eq("lease_owner", owner);
    if (saved.error) throw Error("Refreshed authorization could not be saved.");
  }
  graph = new Graph(token.access_token);
} finally { await db.rpc("release_word_lease", { p_owner: owner }); }
const original = await graph!.read(connection.drive_id, connection.item_id);
inspectDocx(original.bytes, connection.id);
const versions = await (await graph!.request(graph!.path(connection.drive_id, connection.item_id) + "/versions")).json();
if (!Array.isArray(versions.value) || !versions.value.length) throw Error("Document version history is unavailable; stop for review.");
await mkdir(".credentials/word-acceptance", { recursive: true, mode: 0o700 });
await writeFile(".credentials/word-acceptance/original-read-only.docx", original.bytes, { mode: 0o600 });
const name = "Moments TEMPORARY acceptance " + randomUUID() + ".docx";
const temporary = await (await graph!.request(graph!.path(connection.drive_id, original.item.parentReference.id) + "/children", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, file: {}, "@microsoft.graph.conflictBehavior": "fail" }) })).json();
if (temporary.id === connection.item_id || !temporary.eTag) throw Error("Temporary document identity could not be verified.");
await graph!.write(connection.drive_id, temporary.id, temporary.eTag, original.bytes);
let current = await graph!.read(connection.drive_id, temporary.id);
let staleRejected = false;
try { await graph!.write(connection.drive_id, temporary.id, '"moments-deliberately-stale-version"', current.bytes); }
catch (error) { if (error instanceof HttpError && error.code === "version_changed") staleRejected = true; else throw error; }
assert.ok(staleRejected, "This drive did not enforce If-Match. Do not enable syncing; implement a conditional upload-session commit.");
const unchanged = await graph!.read(connection.drive_id, temporary.id);
assert.equal(unchanged.item.eTag, current.item.eTag, "Rejected write changed the document");
const png = await sharp(await readFile("tests/fixtures/portrait.png")).png().toBuffer({ resolveWithObject: true });
const photo = async () => ({ bytes: png.data, width: png.info.width, height: png.info.height });
const row = (date: string, caption: string): Row => ({ id: randomUUID(), photo_date: date, caption, image_key: "TEMPORARY-ONLY", author_email: "feranmidyro@gmail.com", created_at: new Date().toISOString() });
const recent = row("2026-01-01", "Temporary portrait layout review"), older = row("2000-01-01", "Temporary older photo");
let baselines: Baseline[] = [];
async function patch(desired: Map<string, Row | null>, resolutions?: any) {
  current = await graph!.read(connection.drive_id, temporary.id);
  const merged = await mergeDocx({ bytes: current.bytes, connection: connection.id, operation: randomUUID(), desired, baselines, resolutions, allowCreateRegion: !inspectDocx(current.bytes, connection.id).region, photo });
  if (merged.changed) await graph!.write(connection.drive_id, temporary.id, current.item.eTag, merged.bytes);
  baselines = merged.baselines;
  return merged;
}
let merged = await patch(new Map([[recent.id, recent], [older.id, older]]));
const entryIds = inspectDocx(merged.bytes, connection.id).entry_ids;
assert.ok(entryIds.indexOf(recent.id) < entryIds.indexOf(older.id));
merged = await patch(new Map([[recent.id, recent], [older.id, older]]));
assert.equal(merged.changed, false, "Retry duplicated or changed entries");
const moved = { ...older, photo_date: "2026-02-01", caption: "Edited temporary caption" };
merged = await patch(new Map([[older.id, moved]]));
const reordered = inspectDocx(merged.bytes, connection.id).entry_ids;
assert.ok(reordered.indexOf(older.id) < reordered.indexOf(recent.id));
current = await graph!.read(connection.drive_id, temporary.id);
const parts = unzipSync(current.bytes);
parts["word/document.xml"] = strToU8(strFromU8(parts["word/document.xml"]).replace("Edited temporary caption", "Manual Word edit preserved"));
await graph!.write(connection.drive_id, temporary.id, current.item.eTag, zipSync(parts));
merged = await patch(new Map());
assert.equal(merged.changed, false, "Word-only edit was overwritten");
const conflicting = { ...moved, caption: "Conflicting website edit" };
merged = await patch(new Map([[older.id, conflicting]]));
const conflict = merged.conflicts.find(c => c.entry_id === older.id)!;
assert.ok(conflict && conflict.word_text.includes("Manual Word edit preserved"));
merged = await patch(new Map([[older.id, conflicting]]), new Map([[older.id, { choice: "word", word_hash: conflict.word_hash, desired_hash: desiredHash(conflicting) }]]));
assert.equal(merged.conflicts.length, 0);
merged = await patch(new Map([[recent.id, null]]));
assert.ok(!inspectDocx(merged.bytes, connection.id).entry_ids.includes(recent.id));
// Keep one portrait in the TEMPORARY file for manual rendering review.
const finalOriginal = await graph!.read(connection.drive_id, connection.item_id);
assert.equal(createHash("sha256").update(finalOriginal.bytes).digest("hex"), createHash("sha256").update(original.bytes).digest("hex"), "The original changed externally during testing; re-inspect it before activation");
await writeFile(".credentials/word-acceptance/report.json", JSON.stringify({ temporary_url: temporary.webUrl, temporary_item_id: temporary.id, original_item_id: connection.item_id, original_etag: original.item.eTag, tested_at: new Date().toISOString(), automated_checks: "passed", word_online_layout: "pending", desktop_word_layout: "pending", two_editor_access: "pending", activation: "disabled" }, null, 2), { mode: 0o600 });
console.log("Temporary-document Graph tests passed. Original document remained unchanged. Review the temporary document listed in the protected report in Word Online and desktop Word; check both editors before enabling sync.");
