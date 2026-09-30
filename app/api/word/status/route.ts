import { editor, serviceDb, safeError } from "@/lib/word/server";

export async function GET(request: Request) {
  try {
    await editor(request);
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return Response.json({ state: "not_configured", connection: null, pending: 0, conflicts: [], entries: [] }, { headers: { "Cache-Control": "no-store" } });
    const db = serviceDb();
    const results = await Promise.all([
      db.from("word_connections").select("document_name,document_url,enabled,state,last_error,last_synced_at,lease_until,inspected_at,tested_at").maybeSingle(),
      db.from("word_sync_events").select("seq", { count: "exact", head: true }).neq("status", "synced"),
      db.from("word_sync_conflicts").select("entry_id,reason,website,word_text,word_hash,desired_hash,resolution").limit(100),
      db.from("word_sync_events").select("entry_id,status,seq,error").order("seq", { ascending: false }).limit(500),
    ]);
    for (const result of results) if (result.error) throw result.error;
    const connection = results[0].data;
    const state = connection && connection.lease_until && Date.parse(connection.lease_until) > Date.now() ? "syncing" : connection?.state || "authorization_required";
    const seen = new Set<string>();
    const events = (results[3].data || []).filter(row => !seen.has(row.entry_id) && !!seen.add(row.entry_id));
    return Response.json({ state, connection, pending: results[1].count || 0, conflicts: results[2].data || [], entries: events }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return safeError(error); }
}
