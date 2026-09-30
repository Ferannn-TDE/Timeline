import { randomUUID } from "node:crypto";
import { editor, serviceDb, decrypt, encrypt, HttpError, safeError, PRODUCTION, DOCUMENT_ID } from "@/lib/docs/server";
import { exchangeToken, googleConfig, Google } from "@/lib/docs/google";
import { inspectDocument } from "@/lib/docs/merge";

export const maxDuration = 60;
export async function POST(request: Request) {
  let owner: string | null = null;
  try {
    await editor(request);
    if (request.headers.get("origin") !== PRODUCTION) throw new HttpError(403, "Select the document from the production journal.");
    const body = await request.json();
    if (body.document_id && body.document_id !== DOCUMENT_ID) throw new HttpError(400, "Select the supplied Moments Timeline Google Doc.");
    const db = serviceDb(); owner = randomUUID();
    const acquired = await db.rpc("acquire_docs_lease", { p_owner: owner });
    if (acquired.error || !acquired.data) { owner = null; throw new HttpError(409, "Connect Google Docs first, or wait for the current sync to finish."); }
    const connection = await db.from("docs_connections").select("*").eq("lease_owner", owner).single();
    if (connection.error || connection.data.document_id !== DOCUMENT_ID) throw new HttpError(409, "The document connection could not be checked.");
    const token = await exchangeToken({ grant_type: "refresh_token", refresh_token: decrypt(connection.data.refresh_token_encrypted) });
    if (token.refresh_token) {
      const saved = await db.from("docs_connections").update({ refresh_token_encrypted: encrypt(token.refresh_token) }).eq("lease_owner", owner);
      if (saved.error) throw saved.error;
    }
    if (!body.document_id) {
      const config = googleConfig();
      // Only Picker's short-lived access token reaches browser memory. Never send
      // refresh tokens/client secrets; no token is stored in browser storage.
      return Response.json({ access_token: token.access_token, project_number: config.project, picker_key: config.pickerKey, document_id: DOCUMENT_ID }, { headers: { "Cache-Control": "no-store" } });
    }
    const google = new Google(token.access_token), file = await google.file(DOCUMENT_ID);
    if (file.id !== DOCUMENT_ID || file.mimeType !== "application/vnd.google-apps.document" || !file.capabilities?.canEdit) throw new HttpError(403, "The selected Google Doc must grant this account edit permission.");
    const document = await google.read(DOCUMENT_ID), inspection = inspectDocument(document, connection.data.id);
    if (connection.data.inspection.region && !inspection.region || connection.data.tab_id && connection.data.tab_id !== inspection.tab_id) throw new HttpError(409, "The journal region or document tab changed. Review it before reconnecting.", "recovery_required");
    const saved = await db.from("docs_connections").update({ inspected_at: new Date().toISOString(), inspection, tab_id: inspection.tab_id, document_name: file.name, state: connection.data.enabled && connection.data.tested_at ? "connected" : "awaiting_test", last_error: null }).eq("lease_owner", owner);
    if (saved.error) throw saved.error;
    return Response.json({ state: "inspected" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (owner && error instanceof HttpError && error.status === 401) await serviceDb().from("docs_connections").update({ state: "authorization_required", last_error: error.message }).eq("lease_owner", owner);
    return safeError(error);
  }
  finally { if (owner) await serviceDb().rpc("release_docs_lease", { p_owner: owner }); }
}
