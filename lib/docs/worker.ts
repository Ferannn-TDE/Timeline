import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { serviceDb, encrypt, decrypt, HttpError, DOCUMENT_ID } from "./server.ts";
import { exchangeToken, Google, ensurePrivateEditors } from "./google.ts";
import { inspectDocument, planDocument, finishBaselines } from "./merge.ts";
import { recoveryDecision } from "./recovery.ts";
import type { Row } from "../journal.ts";
import type { Baseline, Json, Plan, Resolution } from "./types.ts";

export async function syncDocs() {
  const db = serviceDb(), owner = randomUUID();
  const initial = await db.from("docs_connections").select("enabled,tested_at,inspected_at,state").maybeSingle();
  if (initial.error) throw initial.error;
  if (!initial.data) return { state: "authorization_required" };
  if (!initial.data.inspected_at || initial.data.state === "document_selection_required") return { state: "document_selection_required" };
  if (!initial.data.enabled || !initial.data.tested_at) return { state: "awaiting_test" };
  const acquired = await db.rpc("acquire_docs_lease", { p_owner: owner });
  if (acquired.error) throw acquired.error;
  if (!acquired.data) return { state: "syncing" };
  let connection: any, intentId: string | null = null, eventSeqs: number[] = [];
  const updateConnection = async (values: Json) => {
    const result = await db.from("docs_connections").update(values).eq("lease_owner", owner);
    if (result.error) throw result.error;
  };
  const assertLease = async () => {
    const result = await db.from("docs_connections").select("lease_until,enabled").eq("lease_owner", owner).maybeSingle();
    if (result.error || !result.data?.enabled || Date.parse(result.data.lease_until) < Date.now() + 25000) throw new HttpError(409, "The sync lease expired. Changes remain queued for a safe retry.");
  };
  const signedRequests = async (requests: Json[]) => {
    const output = structuredClone(requests);
    for (const request of output) if (request.insertInlineImage) {
      const key = request.insertInlineImage.uri;
      if (typeof key !== "string" || !key.startsWith("asset://")) throw new HttpError(409, "The saved image reference is invalid.", "recovery_required");
      const result = await db.storage.from("docs-images").createSignedUrl(key.slice(8), 600);
      if (result.error || !result.data.signedUrl || result.data.signedUrl.length > 2000) throw new HttpError(503, "A short-lived private image link could not be created. No document write was attempted.");
      request.insertInlineImage.uri = result.data.signedUrl;
    }
    return output;
  };
  try {
    const latest = await db.from("docs_connections").select("*").eq("lease_owner", owner).single();
    if (latest.error) throw latest.error;
    connection = latest.data;
    if (connection.document_id !== DOCUMENT_ID || !connection.enabled || !connection.tested_at) throw new HttpError(409, "The document connection changed; review it before syncing.");
    const events = await db.from("docs_sync_events").select("seq,entry_id,status,attempts").in("status", ["pending", "failed", "syncing"]).lt("attempts", 3).order("seq").limit(25);
    const conflicts = await db.from("docs_sync_conflicts").select("entry_id,resolution");
    const prepared = await db.from("docs_sync_intents").select("*").eq("connection_id", connection.id).eq("state", "prepared").maybeSingle();
    for (const result of [events, conflicts, prepared]) if (result.error) throw result.error;
    if (!events.data?.length && !prepared.data) return { state: conflicts.data?.length ? "conflict" : "idle" };
    eventSeqs = events.data!.map(event => event.seq);
    await updateConnection({ state: "syncing", last_error: null });
    const token = await exchangeToken({ grant_type: "refresh_token", refresh_token: decrypt(connection.refresh_token_encrypted) });
    if (token.refresh_token) await updateConnection({ refresh_token_encrypted: encrypt(token.refresh_token) });
    const google = new Google(token.access_token);
    ensurePrivateEditors(await google.permissions(connection.document_id));
    let document = await google.read(connection.document_id);
    const inspection = inspectDocument(document, connection.id);
    if (connection.inspection.region && !inspection.region) throw new HttpError(409, "The managed journal area was removed in Google Docs. It will not be recreated automatically.", "recovery_required");

    async function commitApplied(intent: any) {
      const plan: Plan = intent.plan;
      if (!intent.baseline_after) {
        if (!intent.applied_revision || document.revisionId !== intent.applied_revision) throw new HttpError(409, "A previous update may have succeeded, but its saved baseline is uncertain. Recovery review is required; no overwrite will be attempted.", "recovery_required");
        const baseline = finishBaselines(plan, document, connection.id);
        const stored = await db.from("docs_sync_intents").update({ baseline_after: baseline }).eq("id", intent.id).eq("state", "prepared");
        if (stored.error) throw stored.error;
      }
      const committed = await db.rpc("commit_docs_intent", { p_id: intent.id, p_owner: owner });
      if (committed.error) throw committed.error;
      return { state: plan.conflicts.length ? "conflict" : "synced" };
    }
    async function apply(intent: any) {
      if (!intent.plan.changed) return commitApplied(intent);
      const requests = await signedRequests(intent.plan.requests);
      await assertLease();
      const written = await google.write(connection.document_id, intent.expected_revision, requests);
      const revision = written.writeControl?.requiredRevisionId;
      if (!revision) throw new HttpError(409, "Google did not confirm the resulting revision. Sync paused for recovery review.", "recovery_required");
      const stored = await db.from("docs_sync_intents").update({ applied_revision: revision }).eq("id", intent.id).eq("state", "prepared");
      if (stored.error) throw stored.error;
      intent.applied_revision = revision;
      document = await google.read(connection.document_id);
      if (inspectDocument(document, connection.id).operation !== intent.id) throw new HttpError(409, "The saved update marker is missing. Review the document before retrying.", "recovery_required");
      return commitApplied(intent);
    }
    if (prepared.data) {
      intentId = prepared.data.id; eventSeqs = prepared.data.event_seqs;
      const recovery = recoveryDecision({ operation: inspection.operation, revision: document.revisionId }, prepared.data);
      if (recovery === "commit" || recovery === "capture") return await commitApplied(prepared.data);
      if (recovery === "retry") return await apply(prepared.data);
      throw new HttpError(409, "Google Docs changed while a previous write was being confirmed. Sync paused for recovery review.", "recovery_required");
    }
    const marking = await db.from("docs_sync_events").update({ status: "syncing" }).in("seq", eventSeqs);
    if (marking.error) throw marking.error;
    const desired = new Map<string, Row | null>();
    const ids = [...new Set([...events.data!.map(event => event.entry_id), ...(conflicts.data || []).map(conflict => conflict.entry_id)])];
    for (let offset = 0; offset < ids.length; offset += 500) {
      const batch = ids.slice(offset, offset + 500), current = await db.from("entries").select("*").in("id", batch);
      if (current.error) throw current.error;
      for (const id of batch) desired.set(id, current.data!.find(row => row.id === id) || null);
    }
    const baselines: Baseline[] = [];
    for (let offset = 0; ; offset += 500) {
      const batch = await db.from("docs_sync_baselines").select("entry_id,website,block_hash").order("entry_id").range(offset, offset + 499);
      if (batch.error) throw batch.error;
      baselines.push(...batch.data); if (batch.data.length < 500) break;
    }
    document.hasComments = await google.hasComments(connection.document_id);
    const operation = randomUUID();
    const resolutions = new Map<string, Resolution>((conflicts.data || []).filter(c => c.resolution).map(c => [c.entry_id, c.resolution]));
    const plan = await planDocument({ document, connection: connection.id, operation, desired, baselines, resolutions, allowCreateRegion: !connection.inspection.region,
      photo: async row => {
        const downloaded = await db.storage.from("photo-journal").download(row.image_key);
        if (downloaded.error) throw new HttpError(422, "A journal photo is unavailable. Its entry remains saved and queued.");
        const image = await sharp(new Uint8Array(await downloaded.data.arrayBuffer()), { limitInputPixels: 40_000_000 }).rotate().resize({ width: 1600, height: 2000, fit: "inside", withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
        const key = operation + "/" + row.id + ".png";
        const saved = await db.storage.from("docs-images").upload(key, image.data, { contentType: "image/png", upsert: false });
        if (saved.error) throw new HttpError(503, "The private document image could not be prepared.");
        return { key, width: image.info.width, height: image.info.height };
      } });
    if (plan.changed) {
      const recovery = await db.storage.from("docs-recovery").upload(operation + "-before.json", Buffer.from(JSON.stringify(document)), { contentType: "application/json", upsert: false });
      if (recovery.error) throw new HttpError(503, "The private document recovery snapshot could not be saved. No document write was attempted.");
    }
    const intent = { id: operation, connection_id: connection.id, expected_revision: document.revisionId, plan, conflicts: plan.conflicts, event_seqs: eventSeqs, region_exists: inspection.region || plan.changed, baseline_after: plan.changed ? null : plan.baselines };
    const stored = await db.from("docs_sync_intents").insert(intent);
    if (stored.error) throw stored.error;
    intentId = operation;
    return await apply(intent);
  } catch (error) {
    const message = error instanceof HttpError ? error.message : "Google Docs syncing failed. Journal changes remain saved and queued.";
    const lease = await db.from("docs_connections").select("id").eq("lease_owner", owner).maybeSingle();
    if (lease.data) {
      if (intentId && error instanceof HttpError && ["version_changed", "request_rejected"].includes(error.code || "")) {
        const abandoned = await db.from("docs_sync_intents").update({ state: "abandoned" }).eq("id", intentId).eq("state", "prepared");
        if (abandoned.error) throw abandoned.error;
      }
      if (eventSeqs.length) {
        const rows = await db.from("docs_sync_events").select("seq,attempts").in("seq", eventSeqs);
        for (const event of rows.data || []) await db.from("docs_sync_events").update({ status: "failed", error: message, attempts: event.attempts + 1 }).eq("seq", event.seq);
      }
      await updateConnection({ state: error instanceof HttpError && error.code === "recovery_required" ? "recovery_required" : error instanceof HttpError && (error.status === 401 || error.code === "access_required") ? "authorization_required" : "failed", last_error: message });
    }
    throw error instanceof HttpError ? error : new HttpError(503, message);
  } finally { await db.rpc("release_docs_lease", { p_owner: owner }); }
}
