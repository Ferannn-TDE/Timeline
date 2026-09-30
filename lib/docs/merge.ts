import { createHash } from "node:crypto";
import { HttpError } from "./server.ts";
import type { Row } from "../journal.ts";
import type { Baseline, Block, Conflict, GoogleDocument, Inspection, Json, Photo, Plan, Resolution } from "./types.ts";

const PREFIX = "moments.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const desiredHash = (row: Row | null) => sha(row && { id: row.id, photo_date: row.photo_date, caption: row.caption, image_key: row.image_key, created_at: row.created_at });
function stable(value: any): any {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  // Indices move after unrelated insertions; Google download URLs are ephemeral.
  return Object.fromEntries(Object.keys(value).sort().filter(key => !["startIndex", "endIndex", "contentUri"].includes(key)).map(key => [key, stable(value[key])]));
}
const fail = (message: string): never => { throw new HttpError(409, message + " Sync paused without overwriting the document.", "recovery_required"); };

export function documentModel(doc: GoogleDocument, connection: string) {
  if (!doc.revisionId) fail("Document revision is missing.");
  const tabs = doc.tabs;
  if (!Array.isArray(tabs) || tabs.length !== 1 || tabs[0].childTabs?.length || !tabs[0].documentTab) fail("Inspect the document tabs before connecting; this integration currently requires one document tab.");
  const tabId: string = tabs[0].tabProperties.tabId, tab = tabs[0].documentTab;
  const content: Json[] = tab.body?.content || [];
  const last = content.at(-1);
  if (!last?.paragraph || !last.endIndex) fail("The document's final paragraph is unavailable.");
  const style = doc.documentStyle || {};
  const pt = (value: any, fallback: number) => !value ? fallback : value.unit === "PT" && Number.isFinite(value.magnitude) ? value.magnitude : fail("Unsupported page measurement.");
  const pageWidth = pt(style.documentSize?.width, 612), pageHeight = pt(style.documentSize?.height, 792);
  const section = content.filter(item => item.sectionBreak).at(-1)?.sectionBreak.sectionStyle || {};
  const width = pageWidth - pt(section.marginLeft || style.marginLeft, 72) - pt(section.marginRight || style.marginRight, 72);
  const height = pageHeight - pt(section.marginTop || style.marginTop, 72) - pt(section.marginBottom || style.marginBottom, 72);
  if (style.documentMode === "PAGELESS" || pageWidth >= pageHeight || width < 200 || height < 300 || section.columnProperties?.length > 1) fail("A paged, single-column portrait layout is required; existing page settings were preserved.");
  const ranges = new Map<string, { start: number; end: number; rangeId: string }>();
  for (const [name, collection] of Object.entries(tab.namedRanges || {}) as [string, any][]) {
    if (!name.startsWith(PREFIX)) continue;
    if (collection.namedRanges?.length !== 1 || collection.namedRanges[0].ranges?.length !== 1) fail("Duplicate or split journal named ranges require review.");
    const named = collection.namedRanges[0], range = named.ranges[0];
    if (range.segmentId || range.tabId && range.tabId !== tabId || !Number.isInteger(range.startIndex) || !Number.isInteger(range.endIndex) || range.startIndex >= range.endIndex) fail("A journal named range is missing or moved outside its document body.");
    ranges.set(name, { start: range.startIndex, end: range.endIndex, rangeId: named.namedRangeId });
  }
  const startName = PREFIX + "start." + connection, endName = PREFIX + "end." + connection;
  const start = ranges.get(startName), end = ranges.get(endName);
  if (!!start !== !!end || start && end && start.end > end.start) fail("The journal boundary was removed or moved.");
  if ([...ranges.keys()].some(name => !name.startsWith(PREFIX + "entry.") && name !== startName && name !== endName && !name.startsWith(PREFIX + "operation."))) fail("This document has a different journal connection.");
  const slice = (a: number, b: number) => {
    const items = content.filter(item => item.endIndex > a && item.startIndex < b);
    if (!items.length || items[0].startIndex !== a || items.at(-1)!.endIndex !== b || items.some(item => !item.paragraph)) fail("A journal page moved across paragraph boundaries or contains an unsupported table.");
    return items;
  };
  const text = (items: Json[]) => items.map(item => (item.paragraph.elements || []).map((element: Json) => element.textRun?.content || (element.inlineObjectElement ? "\ufffc" : "")).join("")).join("");
  if (start && end && (text(slice(start.start, start.end)) !== "\u2060\n" || text(slice(end.start, end.end)) !== "\u2060\n")) fail("The journal boundary content changed.");
  const blocks = new Map<string, Block>();
  for (const [name, range] of ranges) {
    if (!name.startsWith(PREFIX + "entry.")) continue;
    const id = name.slice((PREFIX + "entry.").length);
    if (!UUID.test(id) || !start || !end || range.start < start.end || range.end > end.start) fail("A journal entry was moved outside its managed area.");
    const items = slice(range.start, range.end);
    const photos: Json[] = [];
    for (const item of items) {
      if (item.paragraph.positionedObjectIds?.length || item.paragraph.suggestedParagraphStyleChanges || item.paragraph.suggestedBulletChanges) fail("Resolve unsupported objects or suggested edits on a journal page before syncing.");
      for (const element of item.paragraph.elements || []) {
        if (element.suggestedInsertionIds?.length || element.suggestedDeletionIds?.length || element.suggestedTextStyleChanges || element.footnoteReference || element.person || element.richLink || element.equation || element.pageBreak) fail("A journal page contains suggestions or unsupported annotations.");
        if (element.inlineObjectElement) {
          const object = tab.inlineObjects?.[element.inlineObjectElement.inlineObjectId];
          if (!object?.inlineObjectProperties?.embeddedObject?.imageProperties) fail("A journal page has a missing or unsupported embedded object.");
          photos.push(stable(object));
        } else if (!element.textRun) fail("A journal page contains unsupported content.");
      }
    }
    if (photos.length !== 1) fail("A journal page no longer contains exactly one photo.");
    blocks.set(id, { id, start: range.start, end: range.end, text: text(items), hash: sha([stable(items), photos, stable(style), stable(section), stable(tab.namedStyles || {})]) });
  }
  const ordered = [...blocks.values()].sort((a, b) => a.start - b.start);
  if (start && end) {
    let cursor = start.end;
    for (const block of ordered) { if (block.start !== cursor) fail("Manual content was inserted between journal pages; preserve it by moving it outside the managed area before syncing."); cursor = block.end; }
    if (cursor !== end.start) fail("Unrecognized content or missing entry tags require review.");
  }
  const operations = [...ranges.entries()].filter(([name]) => name.startsWith(PREFIX + "operation."));
  if (operations.length > 1 || operations.some(([name, range]) => !UUID.test(name.slice((PREFIX + "operation.").length)) || !end || range.start !== end.start || range.end !== end.end)) fail("The recovery marker is invalid.");
  return { tabId, content, endIndex: last!.endIndex, width, height, ranges, start, end, blocks, ordered, operation: operations[0]?.[0].slice((PREFIX + "operation.").length) || null };
}
export function inspectDocument(doc: GoogleDocument, connection: string): Inspection {
  const p = documentModel(doc, connection);
  return { tab_id: p.tabId, region: !!p.start, operation: p.operation, entry_ids: p.ordered.map(block => block.id), width_pt: p.width, height_pt: p.height,
    text_preview: p.content.map(item => item.paragraph?.elements?.map((element: Json) => element.textRun?.content || "").join("") || "").join("").slice(0, 3000) };
}
const sortRows = (a: Row, b: Row) => b.photo_date.localeCompare(a.photo_date) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

export async function planDocument(input: { document: GoogleDocument; connection: string; operation: string; desired: Map<string, Row | null>; baselines: Baseline[]; resolutions?: Map<string, Resolution>; allowCreateRegion: boolean; photo: (row: Row) => Promise<Photo> }): Promise<Plan> {
  const p = documentModel(input.document, input.connection);
  if (!p.start && input.baselines.some(b => b.block_hash)) fail("The journal region was removed; it will not be recreated automatically.");
  const base = new Map(input.baselines.map(b => [b.entry_id, b])), conflicts: Conflict[] = [], after: Baseline[] = [];
  const updates = new Map<string, Row | null>(), websites = new Map<string, Row | null>();
  for (const id of new Set([...input.desired.keys(), ...base.keys(), ...p.blocks.keys()])) {
    const baseline = base.get(id), block = p.blocks.get(id);
    const desired = input.desired.has(id) ? input.desired.get(id)! : baseline?.website || null;
    websites.set(id, desired);
    const documentHash = block?.hash || null, resolution = input.resolutions?.get(id);
    const conflict = (reason: string) => conflicts.push({ entry_id: id, reason, website: desired, document_text: block?.text || "Page removed in Google Docs", document_hash: documentHash, desired_hash: desiredHash(desired) });
    if (resolution && (resolution.document_hash !== documentHash || resolution.desired_hash !== desiredHash(desired))) { conflict("The document or website changed again after this conflict was reviewed."); continue; }
    if (resolution?.choice === "document") { after.push({ entry_id: id, website: desired, block_hash: documentHash }); continue; }
    if (!baseline && block && !resolution) { conflict("This existing tagged page has no baseline and cannot be overwritten safely."); continue; }
    const websiteChanged = !baseline || desiredHash(desired) !== desiredHash(baseline.website);
    const documentChanged = !!baseline && documentHash !== baseline.block_hash;
    if (!resolution && websiteChanged && documentChanged) { conflict("This entry changed on both the website and in Google Docs. Choose which version to keep."); continue; }
    if (!resolution && !websiteChanged) { after.push(baseline || { entry_id: id, website: desired, block_hash: documentHash }); continue; }
    if (block && input.document.hasComments) { conflict("The document has comments whose page anchors cannot be safely replaced. Review its comments before replacing or deleting this page."); continue; }
    updates.set(id, desired);
    if (!desired) after.push({ entry_id: id, website: null, block_hash: null });
  }
  const mutations = [...updates].filter(([id, desired]) => desired || p.blocks.has(id));
  if (!mutations.length) return { requests: [], preserved_hashes: {}, baselines: after, conflicts, website_after: [], changed_ids: [], changed: false, operation: input.operation };
  if (!p.start && !input.allowCreateRegion) fail("Inspect the original document before creating its managed area.");
  const requests: Json[] = [];
  for (const range of p.ranges.values()) requests.push({ deleteNamedRange: { namedRangeId: range.rangeId, tabsCriteria: { tabIds: [p.tabId] } } });
  const range = (a: number, b: number) => ({ startIndex: a, endIndex: b, tabId: p.tabId });
  const location = (index: number) => ({ index, tabId: p.tabId });
  let start = p.start ? { ...p.start } : null, end = p.end ? { ...p.end } : null;
  const kept = p.ordered.filter(block => !updates.has(block.id)).map(block => ({ ...block }));
  const removed = p.ordered.filter(block => updates.has(block.id)).sort((a, b) => b.start - a.start);
  for (const block of removed) {
    requests.push({ deleteContentRange: { range: range(block.start, block.end) } });
    const size = block.end - block.start;
    for (const remaining of kept) if (remaining.start >= block.end) { remaining.start -= size; remaining.end -= size; }
    if (end) { end.start -= size; end.end -= size; }
  }
  if (!start || !end) {
    const at = p.endIndex - 1;
    requests.push({ insertText: { location: location(at), text: "\n\u2060\n\u2060\n" } });
    start = { start: at + 1, end: at + 3, rangeId: "" }; end = { start: at + 3, end: at + 5, rangeId: "" };
  }
  const conflicted = new Set(conflicts.map(c => c.entry_id));
  const keyFor = (block: Block): Row | null => conflicted.has(block.id) ? base.get(block.id)?.website || null : websites.get(block.id) || base.get(block.id)?.website || null;
  const anchors = kept.map(block => ({ block, row: keyFor(block) }));
  if (anchors.some(anchor => !anchor.row) || anchors.some((anchor, index) => index && sortRows(anchors[index - 1].row!, anchor.row!) > 0)) fail("Manual page order or an unrecognized tagged page needs review before more pages can be inserted.");
  const orderedNew = [...updates.values()].filter((row): row is Row => !!row).sort(sortRows);
  for (const row of orderedNew) {
    const next = anchors.find(anchor => sortRows(row, anchor.row!) < 0);
    const at = next ? next.block.start : end.start;
    const photo = await input.photo(row);
    const lines = row.caption.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / Math.max(12, Math.floor(p.width / 7)))), 0);
    const availableHeight = Math.min(p.height - 65 - lines * 14, 440);
    if (availableHeight < 125 || photo.width <= 0 || photo.height <= 0) throw new HttpError(422, "This caption is too long for one portrait page, or its photo cannot be decoded. Shorten the caption; the website entry remains saved.");
    const scale = Math.min((p.width - 8) / photo.width, availableHeight / photo.height);
    const text = row.photo_date + "\n\n" + row.caption + "\n", size = text.length + 1;
    requests.push({ insertText: { location: location(at), text } }, { insertInlineImage: { location: location(at + 11), uri: "asset://" + photo.key, objectSize: { width: { magnitude: photo.width * scale, unit: "PT" }, height: { magnitude: photo.height * scale, unit: "PT" } } } });
    requests.push({ deleteParagraphBullets: { range: range(at, at + size) } },
      { updateTextStyle: { range: range(at, at + size), textStyle: { weightedFontFamily: { fontFamily: "Arial" }, fontSize: { magnitude: 10, unit: "PT" }, bold: false, italic: false, underline: false }, fields: "weightedFontFamily,fontSize,bold,italic,underline,link" } },
      { updateParagraphStyle: { range: range(at, at + size), paragraphStyle: { namedStyleType: "NORMAL_TEXT", alignment: "START", lineSpacing: 100, spaceAbove: { magnitude: 0, unit: "PT" }, spaceBelow: { magnitude: 0, unit: "PT" }, indentStart: { magnitude: 0, unit: "PT" }, indentEnd: { magnitude: 0, unit: "PT" }, indentFirstLine: { magnitude: 0, unit: "PT" }, keepWithNext: true, keepLinesTogether: true, pageBreakBefore: false }, fields: "namedStyleType,alignment,lineSpacing,spaceAbove,spaceBelow,indentStart,indentEnd,indentFirstLine,keepWithNext,keepLinesTogether,pageBreakBefore" } },
      { updateParagraphStyle: { range: range(at, at + 11), paragraphStyle: { pageBreakBefore: true, spaceBelow: { magnitude: 6, unit: "PT" } }, fields: "pageBreakBefore,spaceBelow" } },
      { updateTextStyle: { range: range(at, at + 10), textStyle: { bold: true, fontSize: { magnitude: 12, unit: "PT" } }, fields: "bold,fontSize" } },
      { updateParagraphStyle: { range: range(at + 11, at + 13), paragraphStyle: { alignment: "CENTER", spaceBelow: { magnitude: 6, unit: "PT" } }, fields: "alignment,spaceBelow" } },
      { updateParagraphStyle: { range: range(at + size - 1, at + size), paragraphStyle: { keepWithNext: false }, fields: "keepWithNext" } });
    for (const block of kept) if (block.start >= at) { block.start += size; block.end += size; }
    end.start += size; end.end += size;
    const inserted = { id: row.id, start: at, end: at + size, hash: "", text: "" };
    kept.push(inserted); anchors.push({ block: inserted, row }); anchors.sort((a, b) => a.block.start - b.block.start);
  }
  for (const marker of [start, end]) requests.push({ updateTextStyle: { range: range(marker.start, marker.end), textStyle: { fontSize: { magnitude: 1, unit: "PT" } }, fields: "fontSize" } }, { updateParagraphStyle: { range: range(marker.start, marker.end), paragraphStyle: { pageBreakBefore: false, keepWithNext: false, lineSpacing: 100, spaceAbove: { magnitude: 0, unit: "PT" }, spaceBelow: { magnitude: 0, unit: "PT" } }, fields: "pageBreakBefore,keepWithNext,lineSpacing,spaceAbove,spaceBelow" } });
  requests.push({ createNamedRange: { name: PREFIX + "start." + input.connection, range: range(start.start, start.end) } }, { createNamedRange: { name: PREFIX + "end." + input.connection, range: range(end.start, end.end) } }, { createNamedRange: { name: PREFIX + "operation." + input.operation, range: range(end.start, end.end) } });
  for (const block of kept) requests.push({ createNamedRange: { name: PREFIX + "entry." + block.id, range: range(block.start, block.end) } });
  return { requests, preserved_hashes: Object.fromEntries(p.ordered.filter(block => !updates.has(block.id)).map(block => [block.id, block.hash])), baselines: after, conflicts, website_after: [...updates].map(([entry_id, website]) => ({ entry_id, website })), changed_ids: [...updates.keys()], changed: true, operation: input.operation };
}

export function finishBaselines(plan: Plan, document: GoogleDocument, connection: string): Baseline[] {
  const blocks = documentModel(document, connection).blocks;
  for (const [id, hash] of Object.entries(plan.preserved_hashes)) if (blocks.get(id)?.hash !== hash) fail("An untouched Google Docs page changed while the update was being confirmed; review is required before committing its baseline.");
  return [...plan.baselines.filter(base => !plan.changed_ids.includes(base.entry_id)), ...plan.website_after.map(item => {
    const block = blocks.get(item.entry_id);
    if (!!item.website !== !!block) fail("The saved document does not contain the expected entry pages.");
    return { ...item, block_hash: block?.hash || null };
  })];
}
