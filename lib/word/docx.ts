import { DOMParser, XMLSerializer, type Document, type Element, type Node } from "@xmldom/xmldom";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { createHash } from "node:crypto";
import type { Row } from "../journal.ts";
import type { Baseline, Conflict, Inspection, MergeResult, PreparedPhoto, Resolution } from "./types.ts";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const REGION = "moments-journal-v1:";
const ENTRY = "moments-entry:";
const xml = new XMLSerializer();
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const desiredHash = (row: Row | null) => sha(JSON.stringify(row && { id: row.id, photo_date: row.photo_date, caption: row.caption, image_key: row.image_key, created_at: row.created_at }));
const children = (node: Node) => Array.from(node.childNodes).filter(n => n.nodeType === 1) as Element[];
const all = (node: Element | Document, ns: string, name: string) => Array.from(node.getElementsByTagNameNS(ns, name));
const first = (node: Element | Document, ns: string, name: string) => all(node, ns, name)[0];
const val = (node?: Element) => node?.getAttributeNS(W, "val") || "";
const tag = (node: Element) => val(first(children(node).find(n => n.localName === "sdtPr") || node, W, "tag"));
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function parse(source: string): Document & { documentElement: Element } {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw Error("Unsupported XML declarations. The document has not been changed.");
  const doc = new DOMParser({ onError: (_level, message) => { throw Error("Invalid document XML: " + message); } }).parseFromString(source, "application/xml");
  if (!doc.documentElement) throw Error("The document XML has no root element.");
  return doc as Document & { documentElement: Element };
}
function canonical(node: Node): string {
  if (node.nodeType === 3) return escape(node.nodeValue || "");
  if (node.nodeType !== 1) return "";
  const element = node as Element;
  const attrs = Array.from(element.attributes).filter(a => !a.name.startsWith("xmlns") && !a.name.startsWith("w:rsid"))
    .map(a => [a.namespaceURI || "", a.localName, a.value]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify([element.namespaceURI, element.localName, attrs]) + Array.from(element.childNodes).map(canonical).join("") + "/";
}
function packageDoc(bytes: Uint8Array, connection: string) {
  if (bytes.length > 25_000_000) throw Error("Document exceeds the 25 MB safe sync limit.");
  // Bound expanded ZIP size before allocating its contents (ZIP bombs).
  let size = 0;
  const files = unzipSync(bytes, { filter: file => {
    size += file.originalSize;
    if (size > 100_000_000 || file.originalSize > 50_000_000) throw Error("Document archive exceeds the safe size limit.");
    if (file.name.includes("..") || file.name.startsWith("/")) throw Error("Unsafe document archive path.");
    return true;
  } });
  if (!files["word/document.xml"] || !files["[Content_Types].xml"]) throw Error("This file is not a supported .docx document.");
  if (Object.keys(files).some(name => name.startsWith("_xmlsignatures/"))) throw Error("Signed documents cannot be patched safely.");
  const doc = parse(strFromU8(files["word/document.xml"]));
  const body = first(doc, W, "body");
  if (!body) throw Error("Word document body is missing.");
  if (all(doc, W, "ins").length || all(doc, W, "del").length || all(doc, W, "moveFrom").length || all(doc, W, "moveTo").length) throw Error("Resolve tracked changes in Word before syncing; no changes were made.");
  const settings = files["word/settings.xml"] && parse(strFromU8(files["word/settings.xml"]));
  if (settings && (all(settings, W, "documentProtection").some(el => el.getAttributeNS(W, "enforcement") === "1") || all(settings, W, "trackRevisions").length)) throw Error("Protected documents or enabled change tracking require review before syncing.");
  const regions = all(doc, W, "sdt").filter(node => tag(node).startsWith(REGION));
  if (regions.length > 1 || (regions[0] && tag(regions[0]) !== REGION + connection)) throw Error("The document contains an unexpected or duplicate journal region. Review it before syncing.");
  const region = regions[0];
  if (region && region.parentNode !== body) throw Error("The journal region was moved outside the document body.");
  const content = region && children(region).find(n => n.namespaceURI === W && n.localName === "sdtContent");
  if (region && !content) throw Error("The journal region is missing its content.");
  const blocks = new Map<string, Element>();
  for (const node of all(doc, W, "sdt").filter(node => tag(node).startsWith(ENTRY))) {
    const id = tag(node).slice(ENTRY.length);
    if (!/^[0-9a-f-]{36}$/i.test(id) || blocks.has(id)) throw Error("Duplicate or invalid journal entry tags require review.");
    if (!content || node.parentNode !== content) throw Error("A journal entry was moved outside its managed region.");
    if (all(node, W, "sdt").length || all(node, W, "sectPr").length || all(node, W, "commentReference").length || all(node, W, "footnoteReference").length || all(node, W, "endnoteReference").length || all(node, W, "bookmarkStart").length || all(node, W, "hyperlink").length || all(node, W, "fldChar").length) throw Error("A journal page contains unsupported annotations or markup. Review it in Word before syncing.");
    blocks.set(id, node);
  }
  if (content && children(content).some(node => node.localName !== "sdt" || !tag(node).startsWith(ENTRY))) throw Error("Manual content was added inside the journal region. Move it outside the region before syncing.");
  const sect = children(body).find(node => node.namespaceURI === W && node.localName === "sectPr");
  if (!sect) throw Error("The final page layout is missing; inspect the document before syncing.");
  const page = first(sect, W, "pgSz"), margins = first(sect, W, "pgMar");
  const number = (element: Element | undefined, attr: string, fallback: number) => Number(element?.getAttributeNS(W, attr) || fallback);
  const width = number(page, "w", 12240) - number(margins, "left", 1440) - number(margins, "right", 1440) - number(margins, "gutter", 0);
  const height = number(page, "h", 15840) - number(margins, "top", 1440) - number(margins, "bottom", 1440);
  if (width < 4000 || height < 6000 || number(page, "w", 12240) >= number(page, "h", 15840) || all(sect, W, "cols").some(el => Number(el.getAttributeNS(W, "num") || 1) > 1)) throw Error("The journal needs a single-column portrait page layout. Existing sections were preserved.");
  const rels = parse(files["word/_rels/document.xml.rels"] ? strFromU8(files["word/_rels/document.xml.rels"]) : `<Relationships xmlns="${REL}"/>`);
  function blockHash(block: Element) {
    const references = all(block, A, "blip").map(blip => {
      if (blip.hasAttributeNS(R, "link")) throw Error("A journal photo uses an external image link; review it before syncing.");
      const id = blip.getAttributeNS(R, "embed");
      const rel = all(rels, REL, "Relationship").find(el => el.getAttribute("Id") === id);
      const target = rel?.getAttribute("Target");
      if (!target || target.includes("..") || rel?.getAttribute("TargetMode") === "External" || !files["word/" + target]) throw Error("A journal photo relationship is missing or unsupported.");
      return sha(files["word/" + target]);
    });
    return sha(canonical(block) + references.join(":") + (files["word/styles.xml"] ? sha(files["word/styles.xml"]) : ""));
  }
  const operation = region && val(first(region, W, "alias")).match(/^Moments operation ([0-9a-f-]{36})$/i)?.[1] || null;
  return { files, doc, body, region, content, blocks, width, height, rels, blockHash, operation };
}

export function inspectDocx(bytes: Uint8Array, connection: string): Inspection {
  const p = packageDoc(bytes, connection);
  return { paragraphs: all(p.doc, W, "p").length, images: all(p.doc, A, "blip").length, region: !!p.region, entry_ids: [...p.blocks.keys()],
    text_preview: all(p.doc, W, "t").map(el => el.textContent).join(" ").slice(0, 3000), width_twips: p.width, height_twips: p.height, operation: p.operation };
}

function makeBlock(row: Row, photo: PreparedPhoto, width: number, height: number, relationship: string, drawingId: number): Element {
  // Fixed line spacing, direct font formatting and conservative width estimates
  // reserve caption space before scaling the image without changing its ratio.
  const lineHeight = 260;
  const charsPerLine = Math.max(12, Math.floor(width / 180));
  const lines = row.caption.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
  const photoHeight = Math.min(height - 900 - lines * lineHeight, 8500);
  if (photoHeight < 2500) throw Error("This caption is too long for one portrait page. Shorten it before syncing; the website entry is preserved.");
  const scale = Math.min((width - 100) * 635 / photo.width, photoHeight * 635 / photo.height);
  const cx = Math.floor(photo.width * scale), cy = Math.floor(photo.height * scale);
  const paragraphs = row.caption.split("\n").map(line => `<w:p><w:pPr><w:keepNext/><w:spacing w:before="0" w:after="0" w:line="${lineHeight}" w:lineRule="exact"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${escape(line)}</w:t></w:r></w:p>`).join("");
  const source = `<w:sdt xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="${A}" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:sdtPr><w:alias w:val="${escape(row.photo_date + "|" + row.created_at)}"/><w:tag w:val="${ENTRY + row.id}"/></w:sdtPr><w:sdtContent>
<w:p><w:pPr><w:pageBreakBefore/><w:keepNext/><w:spacing w:before="0" w:after="120" w:line="300" w:lineRule="exact"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:sz w:val="24"/></w:rPr><w:t>${escape(row.photo_date)}</w:t></w:r></w:p>
<w:p><w:pPr><w:keepNext/><w:jc w:val="center"/><w:spacing w:before="0" w:after="120"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${drawingId}" name="Moments photo ${row.id}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="Portrait photo"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relationship}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>${paragraphs}</w:sdtContent></w:sdt>`;
  const block = parse(source).documentElement;
  // Keep caption paragraphs together, but not chained to the next entry/page.
  const lastParagraph = all(block, W, "p").at(-1)!;
  const keep = first(lastParagraph, W, "keepNext");
  if (keep) keep.parentNode!.removeChild(keep);
  return block;
}

export async function mergeDocx(input: { bytes: Uint8Array; connection: string; operation: string; desired: Map<string, Row | null>; baselines: Baseline[]; resolutions?: Map<string, Resolution>; photo: (row: Row) => Promise<PreparedPhoto>; allowCreateRegion: boolean }): Promise<MergeResult> {
  const p = packageDoc(input.bytes, input.connection);
  if (!p.region && input.baselines.some(b => b.block_hash !== null)) throw Error("The journal region was removed in Word. Sync paused; it will not be recreated automatically.");
  const baselines = new Map(input.baselines.map(b => [b.entry_id, b]));
  const conflicts: Conflict[] = [], after: Baseline[] = [];
  let changed = false;
  let content = p.content;
  const ensureRegion = () => {
    if (content) return content;
    if (!input.allowCreateRegion) throw Error("The existing document must be inspected and approved for sync before creating a journal region.");
    const region = parse(`<w:sdt xmlns:w="${W}"><w:sdtPr><w:alias w:val="Moments operation ${input.operation}"/><w:tag w:val="${REGION + input.connection}"/></w:sdtPr><w:sdtContent/></w:sdt>`).documentElement;
    const imported = p.doc.importNode(region, true) as Element;
    p.body.insertBefore(imported, children(p.body).find(n => n.localName === "sectPr") || null);
    content = first(imported, W, "sdtContent");
    changed = true;
    return content!;
  };
  const ids = new Set([...input.desired.keys(), ...baselines.keys(), ...p.blocks.keys()]);
  let drawingId = Math.max(0, ...Array.from(p.doc.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing", "docPr")).map(el => Number(el.getAttribute("id")) || 0)) + 1;
  for (const id of ids) {
    // Untouched entries retain their previous website state until an event arrives.
    const baseline = baselines.get(id);
    const desired = input.desired.has(id) ? input.desired.get(id)! : baseline?.website || null;
    const block = p.blocks.get(id);
    const wordHash = block ? p.blockHash(block) : null;
    const conflict = (reason: string) => conflicts.push({ entry_id: id, reason, website: desired, word_text: block ? all(block, W, "t").map(el => el.textContent).join("\n") : "Page removed in Word", word_hash: wordHash, desired_hash: desiredHash(desired) });
    const resolution = input.resolutions?.get(id);
    if (resolution && (resolution.word_hash !== wordHash || resolution.desired_hash !== desiredHash(desired))) { conflict("The website or Word page changed again after the conflict was reviewed."); continue; }
    if (resolution?.choice === "word") { after.push({ entry_id: id, website: desired, block_hash: wordHash }); continue; }
    if (!baseline && block && !resolution) { conflict("An existing tagged page has no sync baseline; it cannot be overwritten safely."); continue; }
    const websiteChanged = !baseline || desiredHash(desired) !== desiredHash(baseline.website);
    const wordChanged = !!baseline && wordHash !== baseline.block_hash;
    if (!resolution && websiteChanged && wordChanged) { conflict("This entry changed on both the website and in Word. Choose which version to keep."); continue; }
    if (!resolution && !websiteChanged) { after.push(baseline || { entry_id: id, website: desired, block_hash: wordHash }); continue; }
    if (!desired) {
      if (block) { block.parentNode!.removeChild(block); p.blocks.delete(id); changed = true; }
      after.push({ entry_id: id, website: null, block_hash: null });
      continue;
    }
    const photo = await input.photo(desired);
    if (!photo.width || !photo.height || !photo.bytes.length) throw Error("Photo could not be decoded safely.");
    const relationship = "rMoments" + input.operation.replace(/-/g, "") + drawingId;
    const media = `media/moments-${input.operation}-${drawingId}.png`;
    p.files["word/" + media] = new Uint8Array(photo.bytes);
    const rel = p.rels.createElementNS(REL, "Relationship");
    rel.setAttribute("Id", relationship); rel.setAttribute("Type", R + "/image"); rel.setAttribute("Target", media); p.rels.documentElement.appendChild(rel);
    const next = p.doc.importNode(makeBlock(desired, photo, p.width, p.height, relationship, drawingId++), true) as Element;
    if (block) block.parentNode!.replaceChild(next, block); else ensureRegion().appendChild(next);
    p.blocks.set(id, next); changed = true;
    after.push({ entry_id: id, website: desired, block_hash: p.blockHash(next) });
  }
  // Move only tagged pages within the managed region; unrelated content never moves.
  if (content) {
    const conflicted = new Set(conflicts.map(conflict => conflict.entry_id));
    const current = children(content);
    const order = [...p.blocks.entries()].sort(([idA, a], [idB, b]) => {
      const websiteA = (conflicted.has(idA) ? null : input.desired.get(idA)) || baselines.get(idA)?.website;
      const websiteB = (conflicted.has(idB) ? null : input.desired.get(idB)) || baselines.get(idB)?.website;
      const sortA = websiteA ? websiteA.photo_date + "|" + websiteA.created_at : val(first(a, W, "alias"));
      const sortB = websiteB ? websiteB.photo_date + "|" + websiteB.created_at : val(first(b, W, "alias"));
      return (sortB.split("|")[0] || "").localeCompare(sortA.split("|")[0] || "") || (sortA.split("|")[1] || "").localeCompare(sortB.split("|")[1] || "") || idA.localeCompare(idB);
    }).map(([, block]) => block);
    if (current.some((node, i) => node !== order[i])) { order.forEach(block => content!.appendChild(block)); changed = true; }
  }
  if (!changed) return { bytes: input.bytes, baselines: after, conflicts, changed: false, operation: input.operation };
  const region = content!.parentNode as Element;
  const properties = children(region).find(n => n.localName === "sdtPr")!;
  let alias = first(properties, W, "alias");
  if (!alias) { alias = p.doc.createElementNS(W, "w:alias"); properties.appendChild(alias); }
  alias.setAttributeNS(W, "w:val", "Moments operation " + input.operation);
  const types = parse(strFromU8(p.files["[Content_Types].xml"]));
  if (!all(types, CT, "Default").some(el => el.getAttribute("Extension") === "png")) {
    const type = types.createElementNS(CT, "Default"); type.setAttribute("Extension", "png"); type.setAttribute("ContentType", "image/png"); types.documentElement.appendChild(type);
  }
  p.files["word/document.xml"] = strToU8(xml.serializeToString(p.doc));
  p.files["word/_rels/document.xml.rels"] = strToU8(xml.serializeToString(p.rels));
  p.files["[Content_Types].xml"] = strToU8(xml.serializeToString(types));
  return { bytes: zipSync(p.files), baselines: after, conflicts, changed: true, operation: input.operation };
}
