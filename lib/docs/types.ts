import type { Row } from "../journal.ts";

// The vendor document schema contains extensible paragraph/formatting fields.
export type Json = Record<string, any>;
export type GoogleDocument = Json & { documentId: string; revisionId: string; title: string };
export type Baseline = { entry_id: string; website: Row | null; block_hash: string | null };
export type Resolution = { choice: "document" | "website"; document_hash: string | null; desired_hash: string };
export type Conflict = { entry_id: string; reason: string; website: Row | null; document_text: string; document_hash: string | null; desired_hash: string };
export type Photo = { key: string; width: number; height: number };
export type Block = { id: string; start: number; end: number; hash: string; text: string };
export type Inspection = { tab_id: string; region: boolean; operation: string | null; entry_ids: string[]; text_preview: string; width_pt: number; height_pt: number };
export type Plan = { requests: Json[]; preserved_hashes: Record<string, string>; conflicts: Conflict[]; baselines: Baseline[]; website_after: { entry_id: string; website: Row | null }[]; changed_ids: string[]; changed: boolean; operation: string };
