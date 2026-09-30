"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Row } from "@/lib/journal";

type Conflict = { entry_id: string; reason: string; website: Row | null; word_text: string; word_hash: string | null; desired_hash: string; resolution: unknown };
type Status = { state: string; pending: number; connection: { enabled: boolean; document_name: string; document_url: string; last_error: string | null; last_synced_at: string | null } | null; conflicts: Conflict[]; entries: { entry_id: string; status: string }[] };
const labels: Record<string, string> = {
  not_configured: "Word setup pending", authorization_required: "Microsoft authorization needed", awaiting_test: "Connected; document verification pending",
  connected: "Word connected", syncing: "Syncing with Word…", synced: "Word is up to date", conflict: "Word changes need review", failed: "Word sync failed", recovery_required: "Word recovery review needed", idle: "Word connected",
};

export default function WordSync({ db, revision, onState }: { db: SupabaseClient; revision: string; onState: (state: string) => void }) {
  const [status, setStatus] = useState<Status | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const running = useRef(false), active = useRef(true), version = useRef(0);
  const request = useCallback(async (path: string, body?: unknown) => {
    const session = await db.auth.getSession();
    if (!session.data.session) throw Error("Sign in again to access Word syncing.");
    const response = await fetch("/api/word/" + path, { method: body === undefined ? "GET" : "POST", headers: { Authorization: "Bearer " + session.data.session.access_token, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || "Word syncing is temporarily unavailable. Your journal entry is saved.");
    return data;
  }, [db]);
  const refresh = useCallback(async () => {
    const check = ++version.current;
    const current = () => active.current && version.current === check;
    try {
      const latest: Status = await request("status");
      if (!current()) return;
      setStatus(latest); setError("");
      onState(latest.pending && latest.state === "synced" ? "Word changes queued" : labels[latest.state] || "Word changes queued");
      const canRun = latest.connection?.enabled && !["syncing", "authorization_required", "recovery_required", "failed"].includes(latest.state) && latest.entries.some(entry => entry.status === "pending");
      if (canRun && !running.current) {
        running.current = true;
        try { await request("sync", {}); }
        catch (e) { if (active.current) setError(e instanceof Error ? e.message : "Word sync failed."); }
        finally { running.current = false; }
        const updated: Status = await request("status");
        if (current()) { setStatus(updated); onState(updated.pending && updated.state === "synced" ? "Word changes queued" : labels[updated.state] || "Word changes queued"); }
      }
    } catch (e) { if (current()) { setError(e instanceof Error ? e.message : "Could not check Word syncing."); onState("Word status unavailable"); } }
  }, [request, onState]);
  useEffect(() => { active.current = true; void refresh(); const timer = setInterval(() => void refresh(), 30000); return () => { active.current = false; ++version.current; clearInterval(timer); }; }, [refresh]);
  useEffect(() => { void refresh(); }, [revision, refresh]);
  async function connect() {
    setBusy(true); setError("");
    try { const data = await request("connect", {}); window.location.assign(data.url); }
    catch (e) { setError(e instanceof Error ? e.message : "Microsoft connection failed."); setBusy(false); }
  }
  async function retry() {
    setBusy(true); setError("");
    try { await request("sync", { retry: true }); }
    catch (e) { setError(e instanceof Error ? e.message : "Sync failed; changes remain queued."); }
    finally { setBusy(false); void refresh(); }
  }
  async function resolve(conflict: Conflict, choice: "word" | "website") {
    const question = choice === "word" ? "Keep this Word page exactly as it is? The website entry will remain unchanged." : conflict.website ? "Replace this Word page with the website date, photo, and caption? This replaces the manual edits on that page." : "Remove this Word page? The corresponding website entry has been deleted.";
    if (!confirm(question)) return;
    setBusy(true); setError("");
    try { await request("conflicts", { entry_id: conflict.entry_id, choice, word_hash: conflict.word_hash, desired_hash: conflict.desired_hash }); await request("sync", { retry: true }); }
    catch (e) { setError(e instanceof Error ? e.message : "The conflict could not be resolved."); }
    finally { setBusy(false); void refresh(); }
  }
  return <section className="word-panel" aria-label="Shared Word document">
    <h2>Shared Word journal</h2>
    <p className="word-state">{status ? status.pending && status.state === "synced" ? "Word changes queued" : labels[status.state] || "Word changes queued" : "Checking Word connection…"}</p>
    {status?.pending ? <p>{status.pending} {status.pending === 1 ? "change is" : "changes are"} waiting for Word.</p> : null}
    {status?.connection && <a href={status.connection.document_url} target="_blank" rel="noopener noreferrer">Open {status.connection.document_name}</a>}
    {(!status?.connection?.enabled || status.state === "authorization_required") && <button type="button" className="primary" disabled={busy} onClick={connect}>Connect Microsoft</button>}
    {status?.connection?.enabled && <button type="button" className="refresh" disabled={busy || status.state === "syncing"} onClick={retry}>{busy ? "Checking…" : "Sync / retry Word"}</button>}
    <p className="footnote">Your timeline saves separately. Word updates preserve manual edits and pause conflicting changes.</p>
    {(error || status?.connection?.last_error) && <p className="word-error" role="alert">{error || status?.connection?.last_error}</p>}
    {status?.conflicts.map(conflict => <div className="word-conflict" key={conflict.entry_id}>
      <h3>Choose a version</h3><p>{conflict.reason}</p>
      <strong>Website</strong><p>{conflict.website ? conflict.website.photo_date + "\n" + conflict.website.caption : "Entry deleted on the website"}</p>
      <strong>Word</strong><p>{conflict.word_text}</p>
      <button disabled={busy} onClick={() => resolve(conflict, "word")}>Keep Word page</button>
      <button disabled={busy} onClick={() => resolve(conflict, "website")}>{conflict.website ? "Use website version" : "Remove Word page"}</button>
    </div>)}
  </section>;
}
