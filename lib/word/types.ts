import type { Row } from "../journal.ts";

export type Baseline = { entry_id: string; website: Row | null; block_hash: string | null };
export type Resolution = { choice: "word" | "website"; word_hash: string | null; desired_hash: string };
export type Conflict = { entry_id: string; reason: string; website: Row | null; word_text: string; word_hash: string | null; desired_hash: string };
export type PreparedPhoto = { bytes: Uint8Array; width: number; height: number };
export type Inspection = { paragraphs: number; images: number; region: boolean; entry_ids: string[]; text_preview: string; width_twips: number; height_twips: number; operation: string | null };
export type MergeResult = { bytes: Uint8Array; baselines: Baseline[]; conflicts: Conflict[]; changed: boolean; operation: string };
