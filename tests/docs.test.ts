import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { planDocument, finishBaselines, inspectDocument, documentModel, desiredHash } from "../lib/docs/merge.ts";
import { Google, SCOPES, ensurePrivateEditors } from "../lib/docs/google.ts";
import { HttpError, encrypt, decrypt } from "../lib/docs/server.ts";
import { recoveryDecision } from "../lib/docs/recovery.ts";
import { DocumentFixture } from "./docs-fixture.ts";
import type { Row } from "../lib/journal.ts";
import type { Baseline, Resolution } from "../lib/docs/types.ts";

const connection = "11111111-1111-4111-8111-111111111111";
const row = (date = "2026-01-01", caption = "Portrait memory"): Row => ({ id: randomUUID(), photo_date: date, caption, image_key: "private/photo.png", author_email: "feranmidyro@gmail.com", created_at: "2026-01-01T00:00:00Z" });
const photo = async (entry: Row) => ({ key: entry.id + ".png", width: 300, height: 600 });
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
