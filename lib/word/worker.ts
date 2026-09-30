import sharp from "sharp";
import { randomUUID, createHash } from "node:crypto";
import { serviceDb, encrypt, decrypt, HttpError } from "./server.ts";
import { exchangeToken, Graph } from "./graph.ts";
import { inspectDocx, mergeDocx } from "./docx.ts";
import { recoveryAction } from "./recovery.ts";
import type { Row } from "../journal.ts";
import type { Baseline, Conflict, Resolution } from "./types.ts";

const MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export async function syncWord() {
  const db = serviceDb(), owner = randomUUID();
  const connectionResult = await db.from("word_connections").select("*").maybeSingle();
  if (connectionResult.error) throw connectionResult.error;
  let connection = connectionResult.data;
  if (!connection) return { state: "authorization_required" };
  if (!connection.enabled || !connection.tested_at) return { state: "awaiting_test" };
  const acquired = await db.rpc("acquire_word_lease", { p_owner: owner });
  if (acquired.error) throw acquired.error;
  if (!acquired.data) return { state: "syncing" };
  const latest = await db.from("word_connections").select("*").eq("lease_owner", owner).single();
  if (latest.error || !latest.data) { await db.rpc("release_word_lease", { p_owner: owner }); throw new HttpError(503, "The Word connection could not be checked. Retry syncing."); }
  connection = latest.data;
  let intentId: string | null = null;
  let eventSeqs: number[] = [];
  const updateConnection = async (values: Record<string, unknown>) => {
    const result = await db.from("word_connections").update(values).eq("id", connection.id).eq("lease_owner", owner);
    if (result.error) throw result.error;
  };
  const assertLease = async () => {
    const lease = await db.from("word_connections").select("lease_until,enabled").eq("id", connection.id).eq("lease_owner", owner).maybeSingle();
    if (lease.error || !lease.data?.enabled || Date.parse(lease.data.lease_until) < Date.now() + 15000) throw new HttpError(409, "The sync lease expired. Changes are queued for a safe retry.");
  };
  const backup = async (path: string, bytes: Uint8Array) => {
    const result = await db.storage.from("word-recovery").upload(path, bytes, { contentType: MIME, upsert: false });
    if (result.error) throw new HttpError(503, "The document recovery copy could not be saved. No Word write was attempted.");
  };
  try {
    const events = await db.from("word_sync_events").select("seq,entry_id,status,attempts").in("status", ["pending", "failed", "syncing"]).lt("attempts", 3).order("seq").limit(25);
    if (events.error) throw events.error;
    const conflicts = await db.from("word_sync_conflicts").select("entry_id,resolution");
    if (conflicts.error) throw conflicts.error;
    const unresolved = new Set((conflicts.data || []).filter(c => !c.resolution).map(c => c.entry_id));
    const eligible = events.data || [];
    const prepared = await db.from("word_sync_intents").select("*").eq("connection_id", connection.id).eq("state", "prepared").maybeSingle();
    if (prepared.error) throw prepared.error;
    if (!eligible.length && !prepared.data) return { state: unresolved.size ? "conflict" : "idle" };
    eventSeqs = eligible.map(event => event.seq);
    await updateConnection({ state: "syncing", last_error: null });
    const token = await exchangeToken({ grant_type: "refresh_token", refresh_token: decrypt(connection.refresh_token_encrypted) });
    if (token.refresh_token) await updateConnection({ refresh_token_encrypted: encrypt(token.refresh_token) });
    const graph = new Graph(token.access_token);
    const document = await graph.read(connection.drive_id, connection.item_id);
    const inspection = inspectDocx(document.bytes, connection.id);
    if (prepared.data) {
      intentId = prepared.data.id; eventSeqs = prepared.data.event_seqs;
      const recovery = recoveryAction({ operation: inspection.operation, hash: hash(document.bytes), etag: document.item.eTag }, prepared.data);
      if (recovery === "review") throw new HttpError(409, "Word changed while a previous write was being confirmed. Sync is paused for recovery review; it will not overwrite the file.", "recovery_required");
      if (recovery === "retry") {
        const candidate = await db.storage.from("word-recovery").download(intentId + "-after.docx");
        if (candidate.error) throw new HttpError(503, "The saved sync candidate could not be recovered. No replacement was attempted.");
        const bytes = new Uint8Array(await candidate.data.arrayBuffer());
        if (hash(bytes) !== prepared.data.output_hash) throw new HttpError(409, "The recovery candidate does not match its saved fingerprint.", "recovery_required");
        await assertLease();
        await graph.write(connection.drive_id, connection.item_id, document.item.eTag, bytes);
      }
      const committed = await db.rpc("commit_word_intent", { p_id: intentId, p_owner: owner });
      if (committed.error) throw committed.error;
      return { state: prepared.data.conflicts.length ? "conflict" : "synced" };
    }
    if (eventSeqs.length) {
      const marking = await db.from("word_sync_events").update({ status: "syncing" }).in("seq", eventSeqs);
      if (marking.error) throw marking.error;
    }
    if (connection.inspection.region && !inspection.region) throw new HttpError(409, "The journal region was removed in Word. Sync paused for review; it will not be recreated.", "recovery_required");
    const desired = new Map<string, Row | null>();
    // Re-evaluate unresolved conflicts against the actual website state on every
    // merge; using their old baseline here could silently clear a queued conflict.
    const ids = [...new Set([...eligible.map(event => event.entry_id), ...(conflicts.data || []).map(conflict => conflict.entry_id)])];
    for (let offset = 0; offset < ids.length; offset += 500) {
      const batchIds = ids.slice(offset, offset + 500);
      const current = await db.from("entries").select("*").in("id", batchIds);
      if (current.error) throw current.error;
      for (const id of batchIds) desired.set(id, (current.data || []).find(row => row.id === id) || null);
    }
    const baselines: Baseline[] = [];
    for (let offset = 0; ; offset += 500) {
      const batch = await db.from("word_sync_baselines").select("entry_id,website,block_hash").order("entry_id").range(offset, offset + 499);
      if (batch.error) throw batch.error;
      baselines.push(...batch.data);
      if (batch.data.length < 500) break;
    }
    const resolutions = new Map<string, Resolution>((conflicts.data || []).filter(c => c.resolution).map(c => [c.entry_id, c.resolution]));
    const operation = randomUUID();
    const merged = await mergeDocx({ bytes: document.bytes, connection: connection.id, operation, desired, baselines, resolutions, allowCreateRegion: !connection.inspection.region,
      photo: async row => {
        const downloaded = await db.storage.from("photo-journal").download(row.image_key);
        if (downloaded.error) throw new HttpError(422, "A journal photo is unavailable. Its entry is preserved and the sync is paused.");
        const image = sharp(new Uint8Array(await downloaded.data.arrayBuffer()), { limitInputPixels: 40_000_000 }).rotate().resize({ width: 1600, height: 2000, fit: "inside", withoutEnlargement: true });
        const result = await image.png().toBuffer({ resolveWithObject: true });
        return { bytes: result.data, width: result.info.width, height: result.info.height };
      } });
    // The prepared intent is durable before the external write, so a process
    // crash can be recovered using the operation marker embedded in the region.
    if (merged.changed) {
      await backup(operation + "-before.docx", document.bytes);
      await backup(operation + "-after.docx", merged.bytes);
    }
    const stored = await db.from("word_sync_intents").insert({ id: operation, connection_id: connection.id, expected_etag: document.item.eTag, output_hash: hash(merged.bytes), baseline_after: merged.baselines, conflicts: merged.conflicts, event_seqs: eventSeqs, region_exists: inspectDocx(merged.bytes, connection.id).region });
    if (stored.error) throw stored.error;
    intentId = operation;
    if (merged.changed) { await assertLease(); await graph.write(connection.drive_id, connection.item_id, document.item.eTag, merged.bytes); }
    const committed = await db.rpc("commit_word_intent", { p_id: operation, p_owner: owner });
    if (committed.error) throw committed.error;
    return { state: merged.conflicts.length ? "conflict" : "synced" };
  } catch (error) {
    const message = error instanceof HttpError ? error.message : "Word syncing failed. Journal changes remain saved and queued.";
    if (intentId && error instanceof HttpError && error.code === "version_changed") {
      const abandoned = await db.from("word_sync_intents").update({ state: "abandoned" }).eq("id", intentId).eq("state", "prepared");
      if (abandoned.error) throw abandoned.error;
    }
    if (eventSeqs.length) {
      const rows = await db.from("word_sync_events").select("seq,attempts").in("seq", eventSeqs);
      for (const event of rows.data || []) {
        const saved = await db.from("word_sync_events").update({ status: "failed", error: message, attempts: event.attempts + 1 }).eq("seq", event.seq);
        if (saved.error) throw saved.error;
      }
    }
    await updateConnection({ state: error instanceof HttpError && error.code === "recovery_required" ? "recovery_required" : error instanceof HttpError && error.status === 401 ? "authorization_required" : "failed", last_error: message });
    throw error instanceof HttpError ? error : new HttpError(503, message);
  } finally {
    const released = await db.rpc("release_word_lease", { p_owner: owner });
    if (released.error) throw released.error;
  }
}
