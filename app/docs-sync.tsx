"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { openGooglePicker } from "@/lib/docs/picker";
import type { Row } from "@/lib/journal";

type Conflict = { entry_id: string; reason: string; website: Row | null; document_text: string; document_hash: string | null; desired_hash: string; resolution: unknown };
type Status = { state: string; pending: number; connection: { enabled: boolean; document_name: string; document_url: string; last_error: string | null; last_synced_at: string | null } | null; conflicts: Conflict[]; entries: { entry_id: string; status: string }[] };
const labels: Record<string, string> = {
  not_configured: "Google Docs setup pending", authorization_required: "Google Docs authorization needed", awaiting_test: "Connected; document verification pending",
  document_selection_required: "Select the shared Google Doc",
  connected: "Google Docs connected", syncing: "Syncing with Google Docs…", synced: "Google Docs is up to date", conflict: "Google Docs changes need review", failed: "Google Docs sync failed", recovery_required: "Google Docs recovery review needed", idle: "Google Docs connected",
};

export default function DocsSync({ db, revision, onState }: { db: SupabaseClient; revision: string; onState: (state: string) => void }) {
  const [status, setStatus] = useState<Status | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [authorizationNotice, setAuthorizationNotice] = useState("");
  const running = useRef(false), active = useRef(true), version = useRef(0);
  const request = useCallback(async (path: string, body?: unknown) => {
    const session = await db.auth.getSession();
    if (!session.data.session) throw Error("Sign in again to access Google Docs syncing.");
    const response = await fetch("/api/docs/" + path, { method: body === undefined ? "GET" : "POST", headers: { Authorization: "Bearer " + session.data.session.access_token, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || "Google Docs syncing is temporarily unavailable. Your journal entry is saved.");
    return data;
  }, [db]);
  const refresh = useCallback(async () => {
    const check = ++version.current;
    const current = () => active.current && version.current === check;
    try {
      const latest: Status = await request("status");
      if (!current()) return;
      setStatus(latest); setError("");
      onState(latest.pending && latest.state === "synced" ? "Google Docs changes queued" : labels[latest.state] || "Google Docs changes queued");
      const canRun = latest.connection?.enabled && !["syncing", "authorization_required", "recovery_required", "failed"].includes(latest.state) && latest.entries.some(entry => entry.status === "pending");
      if (canRun && !running.current) {
        running.current = true;
        try { await request("sync", {}); }
        catch (e) { if (active.current) setError(e instanceof Error ? e.message : "Google Docs sync failed."); }
        finally { running.current = false; }
        const updated: Status = await request("status");
        if (current()) { setStatus(updated); onState(updated.pending && updated.state === "synced" ? "Google Docs changes queued" : labels[updated.state] || "Google Docs changes queued"); }
      }
    } catch (e) { if (current()) { setError(e instanceof Error ? e.message : "Could not check Google Docs syncing."); onState("Google Docs status unavailable"); } }
  }, [request, onState]);
  useEffect(() => { active.current = true; void refresh(); const timer = setInterval(() => void refresh(), 30000); return () => { active.current = false; ++version.current; clearInterval(timer); }; }, [refresh]);
  useEffect(() => { void refresh(); }, [revision, refresh]);
  useEffect(() => {
    const url = new URL(window.location.href), result = url.searchParams.get("docs");
    if (result === "authorization_failed") setAuthorizationNotice("Google Docs authorization was not completed. Reconnect with the same approved Google account and confirm consent.");
    if (result === "authorized") setAuthorizationNotice("Google authorized. Select the shared Google Doc to grant per-file access.");
    if (result) { url.searchParams.delete("docs"); window.history.replaceState(null, "", url); }
  }, []);
  async function connect() {
    setBusy(true); setError(""); setAuthorizationNotice("");
    try { const data = await request("connect", {}); window.location.assign(data.url); }
    catch (e) { setError(e instanceof Error ? e.message : "Google Docs connection failed."); setBusy(false); }
  }
  async function pickDocument() {
    setBusy(true); setError("");
    try {
      const config = await request("picker", {});
      await openGooglePicker(config, async id => {
        if(id !== config.document_id) throw Error("Select the supplied Moments Timeline document.");
        await request("picker", { document_id: id });
        await refresh();
      });
    } catch(e) {setError(e instanceof Error ? e.message : "The document could not be selected.");}
    finally {setBusy(false);}
  }
  async function retry() {
    setBusy(true); setError("");
    try { await request("sync", { retry: true }); }
    catch (e) { setError(e instanceof Error ? e.message : "Sync failed; changes remain queued."); }
    finally { setBusy(false); void refresh(); }
  }
  async function resolve(conflict: Conflict, choice: "document" | "website") {
    const question = choice === "document" ? "Keep this Google Docs page exactly as it is? The website entry will remain unchanged." : conflict.website ? "Replace this Google Docs page with the website date, photo, and caption? This replaces the manual edits on that page." : "Remove this Google Docs page? The corresponding website entry has been deleted.";
    if (!confirm(question)) return;
    setBusy(true); setError("");
    try { await request("conflicts", { entry_id: conflict.entry_id, choice, document_hash: conflict.document_hash, desired_hash: conflict.desired_hash }); await request("sync", { retry: true }); }
    catch (e) { setError(e instanceof Error ? e.message : "The conflict could not be resolved."); }
    finally { setBusy(false); void refresh(); }
  }
  return <section className="docs-panel" aria-label="Shared Google Docs document">
    <h2>Shared Google Docs journal</h2>
    <p className="docs-state">{status ? status.pending && status.state === "synced" ? "Google Docs changes queued" : labels[status.state] || "Google Docs changes queued" : "Checking Google Docs connection…"}</p>
    {status?.state === "document_selection_required" && <p role="status">Google sign-in and consent are complete, but this app does not yet have access to the shared document. Click Select shared Google Doc and choose the Moments Timeline document. Photos and captions are saved on the website and will remain queued until document access and verification are complete.</p>}
    {status?.state === "awaiting_test" && <p role="status">Document access is connected, but live syncing is disabled until temporary-document tests and layout review pass. Your queued photos and captions have not been sent to the shared document yet.</p>}
    {authorizationNotice && <p role="status">{authorizationNotice}</p>}
    {status?.pending ? <p>{status.pending} {status.pending === 1 ? "change is" : "changes are"} waiting for Google Docs.</p> : null}
    {status?.connection && <a href={status.connection.document_url} target="_blank" rel="noopener noreferrer">Open {status.connection.document_name}</a>}
    {status?.connection && <button type="button" className="refresh" disabled={busy || status.state === "syncing"} onClick={pickDocument}>Select shared Google Doc</button>}
    {(!status?.connection || status.state === "authorization_required") && <button type="button" className="primary" disabled={busy} onClick={connect}>Connect Google Docs</button>}
    {status?.connection?.enabled && <button type="button" className="refresh" disabled={busy || status.state === "syncing"} onClick={retry}>{busy ? "Checking…" : "Sync / retry Google Docs"}</button>}
    <p className="footnote">Your timeline saves separately. Google Docs updates preserve manual edits and pause conflicting changes.</p>
    {(error || status?.connection?.last_error) && <p className="docs-error" role="alert">{error || status?.connection?.last_error}</p>}
    {status?.conflicts.map(conflict => <div className="docs-conflict" key={conflict.entry_id}>
      <h3>Choose a version</h3><p>{conflict.reason}</p>
      <strong>Website</strong><p>{conflict.website ? conflict.website.photo_date + "\n" + conflict.website.caption : "Entry deleted on the website"}</p>
      <strong>Google Docs</strong><p>{conflict.document_text}</p>
      <button disabled={busy} onClick={() => resolve(conflict, "document")}>Keep Google Docs page</button>
      <button disabled={busy} onClick={() => resolve(conflict, "website")}>{conflict.website ? "Use website version" : "Remove Google Docs page"}</button>
    </div>)}
  </section>;
}
