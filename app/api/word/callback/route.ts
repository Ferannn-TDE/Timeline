import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { serviceDb, encrypt, decrypt, tokenHash, PRODUCTION, DOCUMENT_URL } from "@/lib/word/server";
import { APPROVED_EMAILS } from "@/lib/journal";
import { exchangeToken, Graph, microsoftConfig } from "@/lib/word/graph";
import { inspectDocx } from "@/lib/word/docx";

export const maxDuration = 60;
export async function GET(request: NextRequest) {
  let result = "authorization_failed";
  let lease: string | null = null;
  try {
    const state = request.nextUrl.searchParams.get("state"), code = request.nextUrl.searchParams.get("code");
    const cookie = request.cookies.get("word_oauth_nonce")?.value;
    if (!state || !code || !cookie || request.nextUrl.searchParams.has("error")) throw Error("Authorization was not completed");
    const db = serviceDb();
    // Atomic single-use state consumption, bound to the initiating browser cookie.
    const claimed = await db.from("word_oauth_states").delete().eq("state_hash", tokenHash(state)).eq("cookie_hash", tokenHash(cookie)).gt("expires_at", new Date().toISOString()).select("user_id,email,verifier_encrypted").maybeSingle();
    if (claimed.error || !claimed.data || !APPROVED_EMAILS.includes(claimed.data.email)) throw Error("Invalid authorization state");
    const member = await db.from("journal_members").select("email").eq("email", claimed.data.email).maybeSingle();
    const user = await db.auth.admin.getUserById(claimed.data.user_id);
    if (!member.data || user.data.user?.email?.toLowerCase() !== claimed.data.email) throw Error("Editor access changed");
    const token = await exchangeToken({ grant_type: "authorization_code", code, redirect_uri: microsoftConfig().callback, code_verifier: decrypt(claimed.data.verifier_encrypted) });
    if (!token.refresh_token) throw Error("Continuous access was not granted");
    const graph = new Graph(token.access_token), item = await graph.resolve(DOCUMENT_URL);
    if (item.name.toLowerCase() !== "photo evidence.docx") throw Error("The sharing link resolved to a different document");
    const existing = await db.from("word_connections").select("id,drive_id,item_id,enabled,tested_at,lease_until,inspection").maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data && (existing.data.drive_id !== item.parentReference.driveId || existing.data.item_id !== item.id || existing.data.lease_until && Date.parse(existing.data.lease_until) > Date.now())) throw Error("Reconnect was blocked while another document or sync operation is active");
    if (existing.data) {
      lease = randomUUID();
      const locked = await db.rpc("acquire_word_lease", { p_owner: lease });
      if (locked.error || !locked.data) { lease = null; throw Error("A sync operation is active"); }
    }
    const id = existing.data?.id || randomUUID();
    const document = await graph.read(item.parentReference.driveId, item.id);
    const inspection = inspectDocx(document.bytes, id);
    const values = { id, singleton: true, drive_id: item.parentReference.driveId, item_id: item.id, document_url: DOCUMENT_URL, document_name: item.name, refresh_token_encrypted: encrypt(token.refresh_token), connected_by: claimed.data.email,
      enabled: !!existing.data?.enabled, tested_at: existing.data?.tested_at || null, inspected_at: new Date().toISOString(), inspection: { ...inspection, region: !!existing.data?.inspection?.region || inspection.region }, state: existing.data?.enabled ? "connected" : "awaiting_test", last_error: null };
    const saved = existing.data ? await db.from("word_connections").update(values).eq("id", id).eq("lease_owner", lease!).select("id").single() : await db.from("word_connections").insert(values);
    if (saved.error) throw saved.error;
    // First connection is deliberately read-only until the disposable-document
    // acceptance suite and conditional-write checks have passed.
    result = "connected";
  } catch { /* No provider bodies or credentials in URLs, logs or browser errors. */ }
  finally { if (lease) await serviceDb().rpc("release_word_lease", { p_owner: lease }); }
  const response = NextResponse.redirect(PRODUCTION + "/?word=" + result);
  response.cookies.set("word_oauth_nonce", "", { path: "/api/word/callback", maxAge: 0, httpOnly: true, secure: true, sameSite: "lax" });
  return response;
}
