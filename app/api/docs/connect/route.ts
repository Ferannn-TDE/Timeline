import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { editor, encrypt, tokenHash, serviceDb, safeError, PRODUCTION, HttpError } from "@/lib/docs/server";
import { googleConfig, SCOPES } from "@/lib/docs/google";

export async function POST(request: Request) {
  try {
    const account = await editor(request);
    if (request.headers.get("origin") !== PRODUCTION) throw new HttpError(403, "Start Google Docs authorization from the production journal.");
    const config = googleConfig(), db = serviceDb();
    const state = randomBytes(32).toString("base64url"), cookie = randomBytes(32).toString("base64url"), verifier = randomBytes(48).toString("base64url");
    const { error } = await db.from("docs_oauth_states").insert({ state_hash: tokenHash(state), cookie_hash: tokenHash(cookie), verifier_encrypted: encrypt(verifier), user_id: account.id, email: account.email, expires_at: new Date(Date.now() + 600000).toISOString() });
    if (error) throw error;
    const url = new URL(`https://accounts.google.com/o/oauth2/v2/auth`);
    url.search = new URLSearchParams({ client_id: config.client, response_type: "code", redirect_uri: config.callback, response_mode: "query", scope: SCOPES, access_type: "offline", include_granted_scopes: "false", state, code_challenge: Buffer.from(tokenHash(verifier), "hex").toString("base64url"), code_challenge_method: "S256", prompt: "consent select_account" }).toString();
    const response = NextResponse.json({ url: url.toString() }, { headers: { "Cache-Control": "no-store" } });
    response.cookies.set("docs_oauth_nonce", cookie, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600, path: "/api/docs/callback" });
    return response;
  } catch (error) { return safeError(error); }
}
