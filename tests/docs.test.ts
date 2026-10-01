import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { planDocument, finishBaselines, inspectDocument, documentModel, desiredHash } from "../lib/docs/merge.ts";
import { Google, SCOPES, ensurePrivateEditors } from "../lib/docs/google.ts";
import { HttpError, encrypt, decrypt } from "../lib/docs/server.ts";
import { recoveryDecision } from "../lib/docs/recovery.ts";
import { validateActivationReport, validateActivationConnection } from "../lib/docs/activation.ts";
import { DOCUMENT_ID } from "../lib/docs/server.ts";
import sharp from "sharp";
import { prepareDocsImage } from "../lib/docs/image.ts";
import { DocumentFixture } from "./docs-fixture.ts";
import { missingStartSeparator, verifySeparatorRepair } from "../lib/docs/boundary-repair.ts";
import type { Row } from "../lib/journal.ts";
import type { Baseline, Resolution } from "../lib/docs/types.ts";

const connection = "11111111-1111-4111-8111-111111111111";
const row = (date = "2026-01-01", caption = "Portrait memory"): Row => ({ id: randomUUID(), photo_date: date, caption, image_key: "private/photo.png", author_email: "feranmidyro@gmail.com", created_at: "2026-01-01T00:00:00Z" });
const photo = async (entry: Row) => ({ key: entry.id + ".png", width: 300, height: 600 });
test("48 MP phone photos honor portrait EXIF orientation and shrink without cropping", async () => {
  const jpeg = await sharp({ create: { width: 8064, height: 6048, channels: 3, background: "#abc" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const prepared = await prepareDocsImage(jpeg);
  assert.equal(prepared.info.width, 1500);
  assert.equal(prepared.info.height, 2000);
  assert.equal(prepared.info.width / prepared.info.height, 6048 / 8064);
  assert.equal(prepared.info.format, "png");
  await assert.rejects(prepareDocsImage(Buffer.from("unreadable photo")), /original photo and journal entry remain saved/);
});
test("activation requires genuine passed checks and a still-inspected unchanged document", () => {
  const report = { automated: "passed", both_editor_permissions: "passed", actual_google_signins: "passed", rendered_layout: "passed", original_id: DOCUMENT_ID, original_revision: "reviewed-revision", connection_id: connection, tested_at: "2026-09-30T12:00:00Z" };
  const selected = { id: connection, document_id: DOCUMENT_ID, enabled: false, inspected_at: report.tested_at, state: "awaiting_test" };
  validateActivationReport(report);
  validateActivationConnection(report, selected, report.original_revision);
  for (const field of ["automated", "both_editor_permissions", "actual_google_signins", "rendered_layout"]) assert.throws(() => validateActivationReport({ ...report, [field]: "pending" }));
  assert.throws(() => validateActivationReport({ ...report, original_revision: undefined }));
  assert.throws(() => validateActivationReport({ ...report, tested_at: "invalid" }));
  assert.throws(() => validateActivationConnection(report, selected, "edited-after-review"));
  for (const patch of [{ enabled: true }, { state: "document_selection_required" }, { inspected_at: null }, { id: randomUUID() }, { document_id: "another-document" }]) assert.throws(() => validateActivationConnection(report, { ...selected, ...patch }, report.original_revision));
});
function journal() {
  const fixture = new DocumentFixture(); let baselines: Baseline[] = [];
  const plan = async (desired: Map<string, Row | null>, resolutions?: Map<string, Resolution>) => planDocument({ document: fixture.document(), connection, operation: randomUUID(), desired, baselines, resolutions, allowCreateRegion: true, photo });
  const apply = async (desired: Map<string, Row | null>, resolutions?: Map<string, Resolution>) => {
    const result = await plan(desired, resolutions); if (result.changed) fixture.apply(result.requests);
    baselines = result.changed ? finishBaselines(result, fixture.document(), connection) : result.baselines;
    return result;
  };
  return { fixture, plan, apply, baselines: () => baselines };
}

test("separator recovery restores only one newline and refuses changed captions/photos",async()=>{
  const j=journal(),first=row();await j.apply(new Map([[first.id,first]]));
  const healthy=j.fixture.document(),model=documentModel(healthy,connection),damaged=structuredClone(healthy);
  const tab=damaged.tabs[0].documentTab,body=tab.body.content,index=model.start!.end-1;
  const markerAt=body.findIndex((item:any)=>item.startIndex===model.start!.start),marker=body[markerAt],date=body[markerAt+1];
  marker.paragraph.elements[0].textRun.content="\u2060";marker.paragraph.elements[0].endIndex--;
  marker.paragraph.elements.push(...date.paragraph.elements);marker.endIndex=date.endIndex;body.splice(markerAt+1,1);
  const shift=(value:any)=>{if(!value||typeof value!=="object")return;for(const [key,item]of Object.entries(value)){if(key==='startIndex'&&Number(item)>=index)value[key]=Number(item)-1;else if(key==='endIndex'&&Number(item)>index)value[key]=Number(item)-1;else shift(item);}};
  shift(damaged);
  const plan=missingStartSeparator(damaged,connection);assert.equal(plan.firstEntry,first.id);assert.equal(plan.index,index);
  assert.deepEqual(plan.requests.filter(r=>r.insertText).map(r=>r.insertText.text),['\n']);assert.equal(plan.requests.some(r=>r.deleteContentRange||r.insertInlineImage||r.replaceAllText),false);
  assert.equal(verifySeparatorRepair(damaged,healthy,connection).blocks.size,1);
  const fontChanged=structuredClone(healthy);fontChanged.tabs[0].documentTab.body.content.find((item:any)=>item.startIndex===model.start!.end).paragraph.elements[0].textRun.textStyle={fontSize:{magnitude:10,unit:"PT"}};
  assert.throws(()=>verifySeparatorRepair(damaged,fontChanged,connection),/Date character formatting/);
  assert.throws(()=>missingStartSeparator(healthy,connection));
  const edited=structuredClone(healthy);edited.tabs[0].documentTab.body.content.find((item:any)=>item.paragraph?.elements.some((e:any)=>e.textRun?.content.includes(first.caption))).paragraph.elements[0].textRun.content='Changed caption\n';
  assert.throws(()=>verifySeparatorRepair(damaged,edited,connection),/changed image, caption/);
  const imageChanged=structuredClone(healthy);const object=Object.values(imageChanged.tabs[0].documentTab.inlineObjects)[0] as any;object.inlineObjectProperties.embeddedObject.imageProperties.sourceUri='changed';assert.throws(()=>verifySeparatorRepair(damaged,imageChanged,connection),/changed image, caption/);
});

test("inspection never mutates existing content and pages append outside original material", async () => {
  const j = journal(), original = j.fixture.document(), first = row();
  assert.equal(inspectDocument(original, connection).region, false);
  assert.deepEqual(j.fixture.document(), original);
  const plan = await j.apply(new Map([[first.id, first]]));
  assert.ok(plan.requests.filter(r => r.insertText).every(r => r.insertText.location.index >= original.tabs[0].documentTab.body.content.at(-1).endIndex - 1));
  assert.equal(j.fixture.atoms.map(a => a.char).join("").startsWith("Existing opening material\n"), true);
  assert.deepEqual(j.fixture.document().tabs[0].documentTab.body.content[1], original.tabs[0].documentTab.body.content[1]);
});
test("older photos and equal dates use the exact website order without duplicate retries", async () => {
  const j = journal(), recent = row(), older = row("2000-01-01"), equal = { ...row(), created_at: "2026-01-02T00:00:00Z" };
  await j.apply(new Map([[older.id, older], [equal.id, equal], [recent.id, recent]]));
  assert.deepEqual(inspectDocument(j.fixture.document(), connection).entry_ids, [recent.id, equal.id, older.id]);
  const retry = await j.plan(new Map([[recent.id, recent], [equal.id, equal], [older.id, older]]));
  assert.equal(retry.changed, false); assert.deepEqual(retry.requests, []);
});
test("date, uncropped portrait, and caption form a page with proportional dimensions", async () => {
  const j = journal(), entry = row("2020-01-01", "Caption 😀\nSecond line");
  const planned = await j.apply(new Map([[entry.id, entry]]));
  const image = planned.requests.find(r => r.insertInlineImage)!.insertInlineImage;
  assert.equal(image.objectSize.height.magnitude / image.objectSize.width.magnitude, 2);
  assert.equal(image.uri, "asset://" + entry.id + ".png");
  assert.ok(!JSON.stringify(planned.requests).includes("crop"));
  const block = documentModel(j.fixture.document(), connection).blocks.get(entry.id)!;
  assert.equal(block.text, "2020-01-01\n\ufffc\nCaption 😀\nSecond line\n");
  assert.ok(planned.requests.some(r => r.updateParagraphStyle?.paragraphStyle.pageBreakBefore === true));
});
test("website date/caption edits reorder only the affected page", async () => {
  const j = journal(), a = row(), b = row("2000-01-01");
  await j.apply(new Map([[a.id, a], [b.id, b]]));
  const originalA = documentModel(j.fixture.document(), connection).blocks.get(a.id)!.hash;
  const updated = { ...b, photo_date: "2026-02-01", caption: "Changed" };
  await j.apply(new Map([[b.id, updated]]));
  assert.deepEqual(inspectDocument(j.fixture.document(), connection).entry_ids, [b.id, a.id]);
  assert.equal(documentModel(j.fixture.document(), connection).blocks.get(a.id)!.hash, originalA);
});
test("manual text and formatting survive insertion; simultaneous website edits conflict", async () => {
  const j = journal(), entry = row(); await j.apply(new Map([[entry.id, entry]]));
  j.fixture.editText("Portrait memory", "Manual Google Docs edit");
  const before = documentModel(j.fixture.document(), connection).blocks.get(entry.id)!.hash;
  const newer = row("2026-02-01"); await j.apply(new Map([[newer.id, newer]]));
  assert.equal(documentModel(j.fixture.document(), connection).blocks.get(entry.id)!.hash, before);
  const conflict = await j.plan(new Map([[entry.id, { ...entry, caption: "Website change" }]]));
  assert.equal(conflict.changed, false); assert.equal(conflict.conflicts.length, 1);
  assert.match(conflict.conflicts[0].document_text, /Manual Google Docs edit/);
});
test("regular website deletion removes only its own page; manual edits pause deletion", async () => {
  const j = journal(), a = row(), b = row("2000-01-01", "Other memory");
  await j.apply(new Map([[a.id, a], [b.id, b]]));
  j.fixture.editText("Portrait memory", "Edited directly");
  const blocked = await j.plan(new Map([[a.id, null]])); assert.equal(blocked.conflicts.length, 1); assert.equal(blocked.changed, false);
  await j.apply(new Map([[b.id, null]]));
  assert.deepEqual(inspectDocument(j.fixture.document(), connection).entry_ids, [a.id]);
  assert.ok(j.fixture.atoms.map(a => a.char).join("").includes("Existing opening material"));
});
test("a manually deleted page is preserved as absent until a conflicting change is resolved", async () => {
  const j = journal(), entry = row(); await j.apply(new Map([[entry.id, entry]]));
  const block = documentModel(j.fixture.document(), connection).blocks.get(entry.id)!;
  delete j.fixture.ranges["moments.entry." + entry.id]; j.fixture.editText(block.text, "");
  assert.equal((await j.plan(new Map())).changed, false);
  const conflict = await j.plan(new Map([[entry.id, { ...entry, caption: "Later website edit" }]]));
  assert.equal(conflict.conflicts[0].document_hash, null); assert.equal(conflict.changed, false);
});
test("conflict choices are bound to both reviewed versions", async () => {
  const j = journal(), entry = row(); await j.apply(new Map([[entry.id, entry]])); j.fixture.editText("Portrait memory", "Manual edit");
  const desired = { ...entry, caption: "Website edit" }, conflict = (await j.plan(new Map([[entry.id, desired]]))).conflicts[0];
  const resolution: Resolution = { choice: "document", document_hash: conflict.document_hash, desired_hash: desiredHash(desired) };
  const stale = await j.plan(new Map([[entry.id, { ...desired, caption: "Changed again" }]]), new Map([[entry.id, resolution]]));
  assert.equal(stale.conflicts.length, 1);
  const kept = await j.apply(new Map([[entry.id, desired]]), new Map([[entry.id, resolution]]));
  assert.equal(kept.conflicts.length, 0); assert.equal(kept.changed, false);
  assert.match(documentModel(j.fixture.document(), connection).blocks.get(entry.id)!.text, /Manual edit/);
});
test("duplicate tags, missing boundaries, and inserted untagged material stop safely", async () => {
  const j = journal(), entry = row(); await j.apply(new Map([[entry.id, entry]]));
  const duplicate = j.fixture.document(); duplicate.tabs[0].documentTab.namedRanges["moments.entry." + entry.id].namedRanges.push(duplicate.tabs[0].documentTab.namedRanges["moments.entry." + entry.id].namedRanges[0]);
  assert.throws(() => inspectDocument(duplicate, connection), /Duplicate/);
  const missing = j.fixture.document(); delete missing.tabs[0].documentTab.namedRanges["moments.start." + connection]; assert.throws(() => inspectDocument(missing, connection), /boundary/);
  const untagged = j.fixture.document(); const range = untagged.tabs[0].documentTab.namedRanges["moments.entry." + entry.id].namedRanges[0].ranges[0]; range.endIndex--;
  assert.throws(() => inspectDocument(untagged, connection), /paragraph boundaries/);
});
test("unsupported layout, suggestions, comments and long captions never trigger an overwrite", async () => {
  const j = journal(); j.fixture.style.documentMode = "PAGELESS"; await assert.rejects(j.plan(new Map([["id", row()]])), /paged/); delete j.fixture.style.documentMode;
  await assert.rejects(j.plan(new Map([["id", row("2020-01-01", "x".repeat(2500))]])), /too long/);
  const entry = row(); await j.apply(new Map([[entry.id, entry]]));
  const doc = j.fixture.document(); doc.hasComments = true;
  const commented = await planDocument({ document: doc, connection, operation: randomUUID(), desired: new Map([[entry.id, null]]), baselines: j.baselines(), allowCreateRegion: true, photo });
  assert.equal(commented.changed, false); assert.match(commented.conflicts[0].reason, /comments/);
  doc.tabs[0].documentTab.body.content.find((p: any) => p.paragraph?.elements?.some((e: any) => e.textRun?.content.includes("Portrait"))).paragraph.elements[0].suggestedDeletionIds = ["suggestion"];
  assert.throws(() => inspectDocument(doc, connection), /suggestions/);
});
test("volatile image URLs do not cause conflicts but crop and image changes do", async () => {
  const j = journal(), entry = row(); await j.apply(new Map([[entry.id, entry]]));
  const before = documentModel(j.fixture.document(), connection).blocks.get(entry.id)!.hash;
  const image = Object.values(j.fixture.images)[0] as any; image.inlineObjectProperties.embeddedObject.imageProperties.contentUri = "another-short-lived-url";
  assert.equal(documentModel(j.fixture.document(), connection).blocks.get(entry.id)!.hash, before);
  image.inlineObjectProperties.embeddedObject.imageProperties.cropProperties = { offsetTop: 0.2 };
  assert.notEqual(documentModel(j.fixture.document(), connection).blocks.get(entry.id)!.hash, before);
});
test("Google writes require the exact revision, reject stale revisions, and never retry without it", async () => {
  const calls: any[] = [];
  const transport = async (_url: any, init: any) => { calls.push(JSON.parse(init.body)); return new Response(JSON.stringify({ error: { message: "The provided revision ID does not match the current revision ID" } }), { status: 400 }); };
  const google = new Google("TEST-ONLY", transport as typeof fetch);
  await assert.rejects(google.write("temp", "revision-1", [{ insertText: {} }]), (error: any) => error instanceof HttpError && error.code === "version_changed");
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].writeControl, { requiredRevisionId: "revision-1" });
  await assert.rejects(google.write("temp", "", []), /mandatory/); assert.equal(calls.length, 1);
  assert.ok(SCOPES.includes("drive.file") && !SCOPES.includes("auth/documents") && !SCOPES.includes("auth/drive "));
});
test("uncertain writes pause; durable baselines recover without duplicating applied pages", () => {
  const intent = { id: "operation", expected_revision: "before", applied_revision: null as string | null, baseline_after: null as unknown, plan: { changed: true } };
  assert.equal(recoveryDecision({ operation: null, revision: "before" }, intent), "retry");
  assert.equal(recoveryDecision({ operation: "operation", revision: "after" }, intent), "review");
  intent.applied_revision = "after"; assert.equal(recoveryDecision({ operation: "operation", revision: "after" }, intent), "capture");
  assert.equal(recoveryDecision({ operation: "operation", revision: "manual-edit-after" }, intent), "review");
  intent.baseline_after = []; assert.equal(recoveryDecision({ operation: "operation", revision: "manual-edit-after" }, intent), "commit");
});
test("Google refresh-token encryption authenticates the ciphertext", () => {
  process.env.DOCS_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  const encrypted = encrypt("TEST-REFRESH-TOKEN"); assert.equal(decrypt(encrypted), "TEST-REFRESH-TOKEN");
  const pieces = encrypted.split("."); pieces[2] = Buffer.from("tampered").toString("base64url"); assert.throws(() => decrypt(pieces.join(".")));
});

test("Google document sharing must be restricted to both approved editors before private images are inserted", () => {
  const allowed = [{type:"user",emailAddress:"feranmidyro@gmail.com",role:"owner"},{type:"user",emailAddress:"kieragreen50@gmail.com",role:"writer"}];
  ensurePrivateEditors(allowed);
  assert.throws(() => ensurePrivateEditors([...allowed,{type:"anyone",role:"reader"}]), /restricted/);
  assert.throws(() => ensurePrivateEditors([...allowed,{type:"user",emailAddress:"other@example.com",role:"reader"}]), /restricted/);
  assert.throws(() => ensurePrivateEditors(allowed.slice(0,1)), /Editor access/);
});
