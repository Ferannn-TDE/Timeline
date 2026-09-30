// Small independent interpreter for the API operations used by the merge planner.
// It verifies index arithmetic and content preservation, not Google's rendering.
import type { GoogleDocument, Json } from "../lib/docs/types.ts";

type Atom = { char: string; textStyle: Json; paragraphStyle: Json; image?: string };
export class DocumentFixture {
  atoms: Atom[] = [];
  ranges: Json = {};
  images: Json = {};
  style: Json = { documentSize: { width: { magnitude: 612, unit: "PT" }, height: { magnitude: 792, unit: "PT" } }, marginTop: { magnitude: 72, unit: "PT" }, marginBottom: { magnitude: 72, unit: "PT" }, marginLeft: { magnitude: 72, unit: "PT" }, marginRight: { magnitude: 72, unit: "PT" } };
  revision = 1;
  constructor(text = "Existing opening material\n") { for (let index = 0; index < text.length; index++) this.atoms.push({ char: text[index], textStyle: { bold: true }, paragraphStyle: { namedStyleType: "NORMAL_TEXT" } }); }
  document(): GoogleDocument {
    const content: Json[] = [{ startIndex: 0, endIndex: 1, sectionBreak: { sectionStyle: {} } }];
    let from = 0;
    for (let i = 0; i < this.atoms.length; i++) {
      if (this.atoms[i].char !== "\n") continue;
      const elements: Json[] = [];
      for (let j = from; j <= i; j++) {
        const atom = this.atoms[j], last = elements.at(-1);
        if (atom.image) elements.push({ startIndex: j + 1, endIndex: j + 2, inlineObjectElement: { inlineObjectId: atom.image, textStyle: structuredClone(atom.textStyle) } });
        else if (last?.textRun && JSON.stringify(last.textRun.textStyle) === JSON.stringify(atom.textStyle)) { last.endIndex++; last.textRun.content += atom.char; }
        else elements.push({ startIndex: j + 1, endIndex: j + 2, textRun: { content: atom.char, textStyle: structuredClone(atom.textStyle) } });
      }
      content.push({ startIndex: from + 1, endIndex: i + 2, paragraph: { elements, paragraphStyle: structuredClone(this.atoms[i].paragraphStyle) } });
      from = i + 1;
    }
    return { documentId: "test-document", revisionId: "revision-" + this.revision, title: "Test only", documentStyle: structuredClone(this.style), tabs: [{ tabProperties: { tabId: "tab-1" }, documentTab: { body: { content }, namedRanges: structuredClone(this.ranges), inlineObjects: structuredClone(this.images) } }] };
  }
  apply(requests: Json[]) {
    for (const request of requests) {
      if (request.deleteNamedRange) {
        for (const name of Object.keys(this.ranges)) if (this.ranges[name].namedRanges.some((r: Json) => r.namedRangeId === request.deleteNamedRange.namedRangeId)) delete this.ranges[name];
      } else if (request.insertText) {
        const at = request.insertText.location.index - 1, inherit = this.atoms[at] || this.atoms.at(-1)!;
        const atoms: Atom[] = [];
        for (let i = 0; i < request.insertText.text.length; i++) atoms.push({ char: request.insertText.text[i], textStyle: structuredClone(inherit.textStyle), paragraphStyle: structuredClone(inherit.paragraphStyle) });
        this.atoms.splice(at, 0, ...atoms);
      } else if (request.insertInlineImage) {
        const at = request.insertInlineImage.location.index - 1, id = "image-" + (Object.keys(this.images).length + 1);
        this.images[id] = { objectId: id, inlineObjectProperties: { embeddedObject: { size: request.insertInlineImage.objectSize, imageProperties: { contentUri: "temporary-google-download-url", sourceUri: request.insertInlineImage.uri } } } };
        this.atoms.splice(at, 0, { char: "\ufffc", image: id, textStyle: {}, paragraphStyle: {} });
      } else if (request.deleteContentRange) {
        const r = request.deleteContentRange.range; this.atoms.splice(r.startIndex - 1, r.endIndex - r.startIndex);
      } else if (request.updateTextStyle) {
        const r = request.updateTextStyle.range;
        for (let i = r.startIndex - 1; i < r.endIndex - 1; i++) this.setFields(this.atoms[i].textStyle, request.updateTextStyle.textStyle, request.updateTextStyle.fields);
      } else if (request.updateParagraphStyle) {
        const r = request.updateParagraphStyle.range;
        let from = 1;
        for (let i = 0; i < this.atoms.length; i++) if (this.atoms[i].char === "\n") {
          if (from < r.endIndex && i + 2 > r.startIndex) this.setFields(this.atoms[i].paragraphStyle, request.updateParagraphStyle.paragraphStyle, request.updateParagraphStyle.fields);
          from = i + 2;
        }
      } else if (request.createNamedRange) {
        const name = request.createNamedRange.name;
        this.ranges[name] = { namedRanges: [{ name, namedRangeId: "named-" + name, ranges: [structuredClone(request.createNamedRange.range)] }] };
      } else if (!request.deleteParagraphBullets) throw Error("Unexpected request in fixture: " + Object.keys(request));
    }
    this.revision++;
  }
  setFields(target: Json, values: Json, fields: string) {
    for (const key of fields.split(",")) { if (key in values) target[key] = structuredClone(values[key]); else delete target[key]; }
  }
  editText(from: string, to: string) {
    const text = this.atoms.map(a => a.char).join(""), index = text.indexOf(from);
    if (index < 0) throw Error("Fixture edit target not found");
    const inherit = this.atoms[index], delta = to.length - from.length;
    this.atoms.splice(index, from.length, ...Array.from({ length: to.length }, (_, i) => ({ ...structuredClone(inherit), char: to[i] })));
    for (const collection of Object.values(this.ranges) as any[]) for (const named of collection.namedRanges) for (const range of named.ranges) {
      if (range.startIndex > index + 1) range.startIndex += delta;
      if (range.endIndex > index + 1) range.endIndex += delta;
    }
    this.revision++;
  }
}
