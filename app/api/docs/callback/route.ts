import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { serviceDb, encrypt, decrypt, tokenHash, PRODUCTION, DOCUMENT_URL, DOCUMENT_ID } from "@/lib/docs/server";
import { APPROVED_EMAILS } from "@/lib/journal";
import { exchangeToken, googleConfig, DOCS_SCOPE } from "@/lib/docs/google";

export const maxDuration = 60;
export async function GET(request: NextRequest) {
  let result = "authorization_failed", lease: string | null = null;
  try {
    const state = request.nextUrl.searchParams.get("state"), code = request.nextUrl.searchParams.get("code"), cookie = request.cookies.get("docs_oauth_nonce")?.value;
    if (!state || !code || !cookie || request.nextUrl.searchParams.has("error")) throw Error("Authorization incomplete");
    const db = serviceDb();
    const claimed = await db.from("docs_oauth_states").delete().eq("state_hash", tokenHash(state)).eq("cookie_hash", tokenHash(cookie)).gt("expires_at", new Date().toISOString()).select("user_id,email,verifier_encrypted").maybeSingle();
    if (claimed.error || !claimed.data || !APPROVED_EMAILS.includes(claimed.data.email)) throw Error("Invalid state");
    const member = await db.from("journal_members").select("email").eq("email", claimed.data.email).maybeSingle(), user = await db.auth.admin.getUserById(claimed.data.user_id);
    if (!member.data || user.data.user?.email?.toLowerCase() !== claimed.data.email) throw Error("Editor access changed");
    const token = await exchangeToken({ grant_type: "authorization_code", code, redirect_uri: googleConfig().callback, code_verifier: decrypt(claimed.data.verifier_encrypted) });
    if (!token.refresh_token || !token.scope?.split(" ").includes(DOCS_SCOPE)) throw Error("Per-file continuous access was not granted");
    const identityResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: "Bearer " + token.access_token }, signal: AbortSignal.timeout(15000) });
    if (!identityResponse.ok) throw Error("Google identity unavailable");
    const identity = await identityResponse.json();
    if (!identity.email_verified || identity.email?.toLowerCase() !== claimed.data.email) throw Error("Authorize with the same approved Google account used in the journal");
    const existing = await db.from("docs_connections").select("id,document_id,enabled,lease_until").maybeSingle();
    if (existing.error || existing.data && existing.data.document_id !== DOCUMENT_ID) throw Error("Connection identity changed");
    if (existing.data) {
      lease = randomUUID();
      const locked = await db.rpc("acquire_docs_lease", { p_owner: lease });
      if (locked.error || !locked.data) { lease = null; throw Error("A sync operation is active"); }
    }
    const values = { document_id: DOCUMENT_ID, document_url: DOCUMENT_URL, document_name: "Shared photo journal", refresh_token_encrypted: encrypt(token.refresh_token), connected_by: claimed.data.email, state: "document_selection_required", last_error: null };
    const saved = existing.data ? await db.from("docs_connections").update(values).eq("id", existing.data.id).eq("lease_owner", lease!).select("id").single() : await db.from("docs_connections").insert({ ...values, id: randomUUID(), singleton: true });
    if (saved.error) throw saved.error;
    // Picker grants access to this existing file. OAuth alone never writes it.
    result = "authorized";
  } catch { /* No provider bodies, tokens or internal errors in redirects. */ }
  finally { if (lease) await serviceDb().rpc("release_docs_lease", { p_owner: lease }); }
  const response = NextResponse.redirect(PRODUCTION + "/?docs=" + result);
  response.cookies.set("docs_oauth_nonce", "", { path: "/api/docs/callback", maxAge: 0, httpOnly: true, secure: true, sameSite: "lax" });
  return response;
}
