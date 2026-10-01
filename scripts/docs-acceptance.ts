// Live tests on a freshly created temporary Google Doc. Never writes the real Doc.
// Requires actual OAuth/Picker authorization stored by the production app.
import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import sharp from "sharp";
import { Google, exchangeToken } from "../lib/docs/google.ts";
import { serviceDb, decrypt, encrypt, DOCUMENT_ID, HttpError } from "../lib/docs/server.ts";
import { inspectDocument, documentModel, planDocument, finishBaselines, desiredHash } from "../lib/docs/merge.ts";
import type { Row } from "../lib/journal.ts";
import type { Baseline, Json, Resolution } from "../lib/docs/types.ts";

const credentials = JSON.parse(await readFile(".credentials/google.json", "utf8"));
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "https://rnilakqmyanujehtqbuk.supabase.co", GOOGLE_CLIENT_ID: credentials.clientId, GOOGLE_CLIENT_SECRET: credentials.clientSecret, GOOGLE_PROJECT_NUMBER: credentials.projectNumber, GOOGLE_PICKER_API_KEY: credentials.pickerApiKey });
for (const name of ["SUPABASE_SERVICE_ROLE_KEY", "DOCS_TOKEN_ENCRYPTION_KEY"]) process.env[name] = (await readFile(".credentials/" + name, "utf8")).trim();
const db = serviceDb(), owner = randomUUID();
const locked = await db.rpc("acquire_docs_lease", { p_owner: owner });
if (locked.error || !locked.data) throw Error("Authorize Google Docs and select the real document in Picker first.");
let connection: any, google: Google;
try {
  const result = await db.from("docs_connections").select("*").eq("lease_owner", owner).single();
  if (result.error) throw Error("Could not read the protected connection.");
  connection = result.data;
  if (connection.enabled || !connection.inspected_at || connection.document_id !== DOCUMENT_ID) throw Error("Initial acceptance requires the inspected real connection with syncing disabled.");
  // An interrupted rerun must not leave a previous report eligible for activation.
  await rm(".credentials/docs-acceptance/report.json", { force: true });
  const token = await exchangeToken({ grant_type: "refresh_token", refresh_token: decrypt(connection.refresh_token_encrypted) });
  if (token.refresh_token) {
    const saved = await db.from("docs_connections").update({ refresh_token_encrypted: encrypt(token.refresh_token) }).eq("lease_owner", owner);
    if (saved.error) throw Error("Could not save renewed authorization.");
  }
  google = new Google(token.access_token);
} finally { await db.rpc("release_docs_lease", { p_owner: owner }); }
async function assertRealWritesDisabled() {
  const checked = await db.from("docs_connections").select("enabled,inspected_at,document_id").eq("id", connection.id).single();
  if (checked.error || checked.data.enabled || checked.data.document_id !== DOCUMENT_ID || checked.data.inspected_at !== connection.inspected_at) throw Error("The real connection changed or syncing was enabled. Temporary acceptance stopped; repeat inspection with real writes disabled.");
}
const original = await google!.read(DOCUMENT_ID), originalInspection = inspectDocument(original, connection.id);
if (originalInspection.region) throw Error("This initial acceptance script expects an original Doc with no managed pages yet.");
const permissions = await google!.permissions(DOCUMENT_ID);
const approved = ["feranmidyro@gmail.com", "kieragreen50@gmail.com"];
if (permissions.some(p => !p.deleted && (p.type !== "user" || !approved.includes(p.emailAddress?.toLowerCase())))) throw Error("The Google Doc has broader sharing. Review its sharing before inserting private journal photos.");
if (approved.some(email => !permissions.some(p => p.emailAddress?.toLowerCase() === email && ["owner", "writer"].includes(p.role)))) throw Error("Share the real Doc as Editor with both approved Google accounts first.");
await mkdir(".credentials/docs-acceptance", { recursive: true, mode: 0o700 });
await writeFile(".credentials/docs-acceptance/original-read-only.json", JSON.stringify(original), { mode: 0o600 });
const temporary = await (await google!.request("drive", "/files", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Moments TEMPORARY acceptance " + randomUUID(), mimeType: "application/vnd.google-apps.document" }) })).json();
if (!temporary.id || temporary.id === DOCUMENT_ID) throw Error("Temporary document identity was not verified.");
let current = await google!.read(temporary.id);
await assertRealWritesDisabled();
await google!.write(temporary.id, current.revisionId, [{ insertText: { location: { index: 1, tabId: current.tabs[0].tabProperties.tabId }, text: "Temporary opening material — preserve this direct edit.\n" } }]);
current = await google!.read(temporary.id);
let staleRejected = false;
await assertRealWritesDisabled();
try { await google!.write(temporary.id, "deliberately-stale-revision", [{ insertText: { location: { index: 1, tabId: current.tabs[0].tabProperties.tabId }, text: "SHOULD NEVER APPEAR" } }]); }
catch (error) { if (error instanceof HttpError && error.code === "version_changed") staleRejected = true; else throw error; }
assert.ok(staleRejected, "The actual API did not reject the stale revision. Do not enable syncing.");
assert.equal((await google!.read(temporary.id)).revisionId, current.revisionId);
const png = await sharp(await readFile("tests/fixtures/portrait.png")).rotate().png().toBuffer({ resolveWithObject: true });
const imageKey = "acceptance/" + randomUUID() + ".png";
const uploaded = await db.storage.from("docs-images").upload(imageKey, png.data, { contentType: "image/png", upsert: false });
if (uploaded.error) throw Error("Temporary private photo upload failed.");
const image = async () => ({ key: imageKey, width: png.info.width, height: png.info.height });
const row = (date: string, caption: string): Row => ({ id: randomUUID(), photo_date: date, caption, image_key: "TEMPORARY-ONLY", author_email: approved[0], created_at: new Date().toISOString() });
const recent = row("2026-01-01", "Temporary portrait to verify the page layout"), older = row("2000-01-01", "Temporary older photo");
let baselines: Baseline[] = [];
async function patch(desired: Map<string, Row | null>, resolutions?: Map<string, Resolution>) {
  current = await google!.read(temporary.id);
  const plan = await planDocument({ document: current, connection: connection.id, operation: randomUUID(), desired, baselines, resolutions, allowCreateRegion: true, photo: image });
  if (plan.changed) {
    const requests = structuredClone(plan.requests);
    for (const request of requests) if (request.insertInlineImage) {
      const signed = await db.storage.from("docs-images").createSignedUrl(imageKey, 600);
      if (signed.error) throw Error("Private image signing failed.");
      request.insertInlineImage.uri = signed.data.signedUrl;
    }
    await assertRealWritesDisabled();
    const written = await google!.write(temporary.id, current.revisionId, requests);
    current = await google!.read(temporary.id);
    assert.equal(current.revisionId, written.writeControl.requiredRevisionId);
    baselines = finishBaselines(plan, current, connection.id);
  } else baselines = plan.baselines;
  return plan;
}
await patch(new Map([[recent.id, recent], [older.id, older]]));
assert.deepEqual(inspectDocument(current, connection.id).entry_ids, [recent.id, older.id]);
assert.equal((await patch(new Map([[recent.id, recent], [older.id, older]]))).changed, false);
const edited = { ...older, photo_date: "2026-02-01", caption: "Edited temporary caption" };
await patch(new Map([[older.id, edited]]));
assert.deepEqual(inspectDocument(current, connection.id).entry_ids, [older.id, recent.id]);
// Review pagination with BOTH photo pages present, before testing deletion.
const layoutPdf = await google!.request("drive", `/files/${encodeURIComponent(temporary.id)}/export?mimeType=application%2Fpdf`);
await writeFile(".credentials/docs-acceptance/layout-review.pdf", new Uint8Array(await layoutPdf.arrayBuffer()), { mode: 0o600 });
let block = documentModel(current, connection.id).blocks.get(older.id)!;
const captionStart = block.start + 13, tabId = current.tabs[0].tabProperties.tabId;
await assertRealWritesDisabled();
await google!.write(temporary.id, current.revisionId, [{ deleteContentRange: { range: { startIndex: captionStart, endIndex: captionStart + edited.caption.length, tabId } } }, { insertText: { location: { index: captionStart, tabId }, text: "Manual Google Docs edit preserved" } }]);
assert.equal((await patch(new Map())).changed, false);
current = await google!.read(temporary.id); block = documentModel(current, connection.id).blocks.get(older.id)!;
assert.match(block.text, /Manual Google Docs edit preserved/);
const conflicting = { ...edited, caption: "Conflicting website change" }, conflictPlan = await patch(new Map([[older.id, conflicting]]));
const conflict = conflictPlan.conflicts.find(c => c.entry_id === older.id)!; assert.ok(conflict);
await patch(new Map([[older.id, conflicting]]), new Map([[older.id, { choice: "document", document_hash: conflict.document_hash, desired_hash: desiredHash(conflicting) }]]));
const deletePlan = await patch(new Map([[recent.id, null]])); assert.equal(deletePlan.conflicts.length, 0);
assert.deepEqual(inspectDocument(current, connection.id).entry_ids, [older.id]);
assert.match(inspectDocument(current, connection.id).text_preview, /Temporary opening material/);
const pdf = await google!.request("drive", `/files/${encodeURIComponent(temporary.id)}/export?mimeType=application%2Fpdf`);
await writeFile(".credentials/docs-acceptance/layout-after-deletion.pdf", new Uint8Array(await pdf.arrayBuffer()), { mode: 0o600 });
const finalOriginal = await google!.read(DOCUMENT_ID); assert.equal(finalOriginal.revisionId, original.revisionId, "Original changed externally during testing; re-inspect it before activation");
await assertRealWritesDisabled();
await writeFile(".credentials/docs-acceptance/report.json", JSON.stringify({ temporary_url: "https://docs.google.com/document/d/" + temporary.id + "/edit", temporary_id: temporary.id, original_id: DOCUMENT_ID, original_revision: original.revisionId, connection_id: connection.id, tested_at: new Date().toISOString(), automated: "passed", both_editor_permissions: "passed", actual_google_signins: "pending", rendered_layout: "pending", activation: "disabled" }, null, 2), { mode: 0o600 });
// Google already copied the private image; its original signed URL expires in 10 minutes.
const removed = await db.storage.from("docs-images").remove([imageKey]); if (removed.error) throw Error("Temporary image cleanup needs retry.");
console.log("Temporary Google Doc API tests passed, including stale revision rejection, older-date sorting, edits, deletion, retries and manual-edit preservation. Original remained unchanged. Review the protected PDF for one uncropped photo per page, and verify both actual Google logins before activation.");
