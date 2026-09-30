import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { inspectDocx, mergeDocx, desiredHash } from "../lib/word/docx.ts";
import { Graph } from "../lib/word/graph.ts";
import { encrypt, decrypt, sameSecret, HttpError } from "../lib/word/server.ts";
import { recoveryAction } from "../lib/word/recovery.ts";
import type { Row } from "../lib/journal.ts";
import type { Baseline } from "../lib/word/types.ts";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const connection = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const recent: Row = { id: "11111111-1111-4111-8111-111111111111", photo_date: "2026-09-01", caption: "Recent portrait", image_key: "recent.png", author_email: "feranmidyro@gmail.com", created_at: "2026-01-01T00:00:00Z" };
const older: Row = { ...recent, id: "22222222-2222-4222-8222-222222222222", photo_date: "2010-05-12", caption: "Older portrait", image_key: "older.png" };
function fixture() {
  return zipSync({
    "[Content_Types].xml": strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    "word/document.xml": strToU8(`<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>Original manual evidence — preserve me.</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:bottom="1440" w:left="1440" w:right="1440"/></w:sectPr></w:body></w:document>`),
    "word/styles.xml": strToU8(`<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Original"><w:name w:val="Original custom style"/></w:style></w:styles>`),
    "word/header1.xml": strToU8(`<w:hdr xmlns:w="${W}"><w:p><w:r><w:t>Manual header</w:t></w:r></w:p></w:hdr>`),
    "word/footer1.xml": strToU8(`<w:ftr xmlns:w="${W}"><w:p><w:r><w:t>Manual footer</w:t></w:r></w:p></w:ftr>`),
    "word/comments.xml": strToU8(`<w:comments xmlns:w="${W}"><w:comment w:id="0" w:author="Original author"/></w:comments>`),
    "word/media/original-photo.png": new Uint8Array(readFileSync("tests/fixtures/portrait.png")),
  });
}
const photo = async () => ({ bytes: new Uint8Array(readFileSync("tests/fixtures/portrait.png")), width: 300, height: 600 });
async function merge(bytes: Uint8Array, desired: (Row | [string, null])[], baselines: Baseline[] = [], extra: Partial<Parameters<typeof mergeDocx>[0]> = {}) {
  return mergeDocx({ bytes, desired: new Map(desired.map(row => Array.isArray(row) ? row : [row.id, row])), baselines, connection, operation: randomUUID(), photo, allowCreateRegion: true, ...extra });
}
function editPackage(bytes: Uint8Array, transform: (xml: string) => string) {
  const parts = unzipSync(bytes); parts["word/document.xml"] = strToU8(transform(strFromU8(parts["word/document.xml"]))); return zipSync(parts);
}

test("inspection is read-only and original document content survives insertion", async () => {
  const bytes = fixture();
  assert.equal(inspectDocx(bytes, connection).region, false);
  const result = await merge(bytes, [older, recent]);
  assert.deepEqual(inspectDocx(result.bytes, connection).entry_ids, [recent.id, older.id]);
  const before = unzipSync(bytes), after = unzipSync(result.bytes);
  for (const part of ["word/styles.xml", "word/header1.xml", "word/footer1.xml", "word/comments.xml", "word/media/original-photo.png"]) assert.deepEqual(after[part], before[part]);
  assert.match(strFromU8(after["word/document.xml"]), /Original manual evidence — preserve me\./);
  assert.equal(inspectDocx(result.bytes, connection).operation, result.operation);
});

test("retrying the same entries does not duplicate pages or rewrite the package", async () => {
  const first = await merge(fixture(), [recent, older]);
  const repeat = await merge(first.bytes, [recent, older], first.baselines);
  assert.equal(repeat.changed, false);
  assert.deepEqual(repeat.bytes, first.bytes);
  assert.equal(inspectDocx(repeat.bytes, connection).entry_ids.length, 2);
});

test("portrait is fitted proportionally without crop and each page has date above and caption below", async () => {
  const result = await merge(fixture(), [recent, older]);
  const doc = new DOMParser().parseFromString(strFromU8(unzipSync(result.bytes)["word/document.xml"]), "application/xml");
  const extents = Array.from(doc.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing", "extent"));
  assert.equal(extents.length, 2);
  for (const extent of extents) assert.equal(Number(extent.getAttribute("cy")) / Number(extent.getAttribute("cx")), 2);
  assert.equal(doc.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/main", "srcRect").length, 0);
  assert.equal(doc.getElementsByTagNameNS(W, "pageBreakBefore").length, 2);
  const text = Array.from(doc.getElementsByTagNameNS(W, "t")).map(el => el.textContent);
  assert.deepEqual(text.slice(1), [recent.photo_date, recent.caption, older.photo_date, older.caption]);
});

test("website caption and date changes replace only their page and reorder it", async () => {
  const first = await merge(fixture(), [recent, older]);
  const updated = { ...older, photo_date: "2026-09-02", caption: "Edited website caption" };
  const changed = await merge(first.bytes, [updated], first.baselines);
  assert.deepEqual(inspectDocx(changed.bytes, connection).entry_ids, [older.id, recent.id]);
  assert.match(inspectDocx(changed.bytes, connection).text_preview, /Edited website caption/);
  assert.equal(changed.conflicts.length, 0);
});

test("Word-only edits are preserved; later simultaneous website edits pause", async () => {
  const first = await merge(fixture(), [recent, older]);
  const manual = editPackage(first.bytes, source => source.replace("Older portrait", "Manual Word caption"));
  const wordOnly = await merge(manual, [older], first.baselines);
  assert.equal(wordOnly.changed, false);
  assert.deepEqual(wordOnly.bytes, manual);
  const conflict = await merge(manual, [{ ...older, caption: "New website caption" }], wordOnly.baselines);
  assert.equal(conflict.changed, false);
  assert.equal(conflict.conflicts.length, 1);
  assert.match(conflict.conflicts[0].word_text, /Manual Word caption/);
  assert.match(inspectDocx(conflict.bytes, connection).text_preview, /Manual Word caption/);
});

test("deletion respects Word edits and a regular website deletion removes only its page", async () => {
  const first = await merge(fixture(), [recent, older]);
  const manual = editPackage(first.bytes, source => source.replace("Older portrait", "Manual Word caption"));
  const conflict = await merge(manual, [[older.id, null]], first.baselines);
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(inspectDocx(conflict.bytes, connection).entry_ids.length, 2);
  const deleted = await merge(first.bytes, [[older.id, null]], first.baselines);
  assert.deepEqual(inspectDocx(deleted.bytes, connection).entry_ids, [recent.id]);
  assert.equal(deleted.baselines.find(b => b.entry_id === older.id)?.block_hash, null);
});

test("a manually deleted Word page is not automatically recreated", async () => {
  const first = await merge(fixture(), [recent]);
  const manual = editPackage(first.bytes, source => {
    const doc = new DOMParser().parseFromString(source, "application/xml");
    const block = Array.from(doc.getElementsByTagNameNS(W, "sdt")).find(node => Array.from(node.getElementsByTagNameNS(W, "tag")).some(tag => tag.getAttributeNS(W, "val") === "moments-entry:" + recent.id) && node.parentNode?.nodeName === "w:sdtContent")!;
    block.parentNode!.removeChild(block); return new XMLSerializer().serializeToString(doc);
  });
  const unchanged = await merge(manual, [recent], first.baselines);
  assert.equal(unchanged.changed, false);
  assert.equal(inspectDocx(unchanged.bytes, connection).entry_ids.length, 0);
  const conflict = await merge(manual, [{ ...recent, caption: "Website edit after Word deletion" }], first.baselines);
  assert.equal(conflict.conflicts.length, 1);
});

test("unknown tagged pages require adoption, duplicate tags stop before a write", async () => {
  const first = await merge(fixture(), [recent]);
  const unknown = await merge(first.bytes, [recent]);
  assert.equal(unknown.conflicts.length, 1);
  assert.equal(unknown.changed, false);
  const duplicated = editPackage(first.bytes, source => {
    const doc = new DOMParser().parseFromString(source, "application/xml");
    const block = Array.from(doc.getElementsByTagNameNS(W, "sdt")).find(node => node.parentNode?.nodeName === "w:sdtContent")!;
    block.parentNode!.appendChild(block.cloneNode(true)); return new XMLSerializer().serializeToString(doc);
  });
  await assert.rejects(merge(duplicated, [recent], first.baselines), /Duplicate/);
});

test("explicit conflict resolution is bound to the reviewed Word and website versions", async () => {
  const first = await merge(fixture(), [recent]);
  const manual = editPackage(first.bytes, source => source.replace("Recent portrait", "Manual edit"));
  const row = { ...recent, caption: "Website edit" };
  const conflict = (await merge(manual, [row], first.baselines)).conflicts[0];
  const keep = await merge(manual, [row], first.baselines, { resolutions: new Map([[row.id, { choice: "word", word_hash: conflict.word_hash, desired_hash: conflict.desired_hash }]]) });
  assert.equal(keep.changed, false); assert.equal(keep.conflicts.length, 0);
  assert.equal(keep.baselines[0].website?.caption, "Website edit");
  assert.match(inspectDocx(keep.bytes, connection).text_preview, /Manual edit/);
  const stale = await merge(editPackage(manual, source => source.replace("Manual edit", "Another manual edit")), [row], first.baselines, { resolutions: new Map([[row.id, { choice: "website", word_hash: conflict.word_hash, desired_hash: conflict.desired_hash }]]) });
  assert.equal(stale.conflicts.length, 1); assert.equal(stale.changed, false);
});

test("tracked changes, landscape pages, and excessively long captions stop safely", async () => {
  await assert.rejects(merge(editPackage(fixture(), source => source.replace('<w:t>Original', '<w:ins><w:t>Original').replace('preserve me.</w:t>', 'preserve me.</w:t></w:ins>')), [recent]), /tracked changes/);
  await assert.rejects(merge(editPackage(fixture(), source => source.replace('w:w="12240" w:h="15840"', 'w:w="15840" w:h="12240"')), [recent]), /portrait/);
  await assert.rejects(merge(fixture(), [{ ...recent, caption: "Caption\n".repeat(200) }]), /too long/);
});

test("conditional Graph writes reject stale versions and never retry unconditionally", async () => {
  let calls = 0;
  const transport = async (_url: unknown, options?: RequestInit) => {
    calls++; assert.equal(new Headers(options?.headers).get("If-Match"), '"expected-version"');
    return new Response('{}', { status: 412 });
  };
  await assert.rejects(new Graph("test-token", transport as typeof fetch).write("drive", "item", '"expected-version"', fixture()), (error: unknown) => error instanceof HttpError && error.code === "version_changed");
  assert.equal(calls, 1);
});

test("write recovery recognizes committed operations and pauses ambiguous outcomes", () => {
  const intent = { id: "operation", output_hash: "after", expected_etag: "before" };
  assert.equal(recoveryAction({ operation: "operation", hash: "manually-edited-after-commit", etag: "new" }, intent), "commit");
  assert.equal(recoveryAction({ operation: null, hash: "after", etag: "new" }, intent), "commit");
  assert.equal(recoveryAction({ operation: "old", hash: "before", etag: "before" }, intent), "retry");
  assert.equal(recoveryAction({ operation: "old", hash: "manual", etag: "new" }, intent), "review");
});

test("refresh token encryption authenticates ciphertext and compares callback secrets safely", () => {
  process.env.WORD_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  const ciphertext = encrypt("test-refresh-token"); assert.equal(decrypt(ciphertext), "test-refresh-token");
  const parts = ciphertext.split("."); const altered = Buffer.from(parts[2], "base64url"); altered[0] ^= 1; parts[2] = altered.toString("base64url");
  assert.throws(() => decrypt(parts.join(".")));
  assert.equal(sameSecret("a", "a"), true); assert.equal(sameSecret("a", "b"), false); assert.equal(sameSecret("a", "aa"), false);
  assert.notEqual(desiredHash(recent), desiredHash({ ...recent, caption: "Different" }));
});
