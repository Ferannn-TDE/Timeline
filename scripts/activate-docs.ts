// Read-only Google preflight followed by fenced database activation. No Doc writes.
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { validateActivationReport, validateActivationConnection } from "../lib/docs/activation.ts";
import { serviceDb, decrypt, encrypt, DOCUMENT_ID } from "../lib/docs/server.ts";
import { Google, exchangeToken, ensurePrivateEditors, DOCS_SCOPE } from "../lib/docs/google.ts";
import { inspectDocument } from "../lib/docs/merge.ts";

async function activate() {
  const report = JSON.parse(await readFile(".credentials/docs-acceptance/report.json", "utf8"));
  validateActivationReport(report);
  const credentials = JSON.parse(await readFile(".credentials/google.json", "utf8"));
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "https://rnilakqmyanujehtqbuk.supabase.co", GOOGLE_CLIENT_ID: credentials.clientId, GOOGLE_CLIENT_SECRET: credentials.clientSecret, GOOGLE_PROJECT_NUMBER: String(credentials.projectNumber), GOOGLE_PICKER_API_KEY: credentials.pickerApiKey });
  for (const name of ["SUPABASE_SERVICE_ROLE_KEY", "DOCS_TOKEN_ENCRYPTION_KEY"]) process.env[name] = (await readFile(".credentials/" + name, "utf8")).trim();
  const db = serviceDb(), owner = randomUUID();
  const locked = await db.rpc("acquire_docs_lease", { p_owner: owner });
  if (locked.error || !locked.data) throw Error("A worker owns the connection or consent is missing; activation was not performed.");
  try {
    const result = await db.from("docs_connections").select("*").eq("lease_owner", owner).single();
    if (result.error) throw Error("Could not read the protected connection.");
    const connection = result.data;
    validateActivationConnection(report, connection, report.original_revision);
    const token = await exchangeToken({ grant_type: "refresh_token", refresh_token: decrypt(connection.refresh_token_encrypted) });
    if (token.scope && !token.scope.split(" ").includes(DOCS_SCOPE)) throw Error("Google per-file consent is missing; reconnect Google Docs.");
    if (token.refresh_token) {
      const saved = await db.from("docs_connections").update({ refresh_token_encrypted: encrypt(token.refresh_token) }).eq("lease_owner", owner).gt("lease_until", new Date().toISOString()).select("id");
      if (saved.error || saved.data?.length !== 1) throw Error("Could not safely save renewed authorization.");
    }
    const google = new Google(token.access_token);
    const file = await google.file(DOCUMENT_ID);
    if (file.id !== DOCUMENT_ID || file.mimeType !== "application/vnd.google-apps.document" || !file.capabilities?.canEdit) throw Error("Google did not confirm edit access to the exact target document.");
    ensurePrivateEditors(await google.permissions(DOCUMENT_ID));
    const document = await google.read(DOCUMENT_ID);
    validateActivationConnection(report, connection, document.revisionId);
    const inspection = inspectDocument(document, connection.id);
    if (inspection.region || inspection.tab_id !== connection.tab_id) throw Error("Original document structure changed; repeat acceptance before activation.");
    const pending = await db.from("docs_sync_intents").select("id", { count: "exact", head: true }).eq("connection_id", connection.id).eq("state", "prepared");
    if (pending.error || pending.count !== 0) throw Error("A prepared update requires recovery before activation.");
    const updated = await db.from("docs_connections").update({ enabled: true, tested_at: report.tested_at, state: "connected", last_error: null }).eq("id", connection.id).eq("document_id", DOCUMENT_ID).eq("enabled", false).eq("state", "awaiting_test").eq("inspected_at", connection.inspected_at).eq("lease_owner", owner).gt("lease_until", new Date().toISOString()).select("id");
    if (updated.error || updated.data?.length !== 1) throw Error("Connection changed or the lock expired; activation was not performed.");
    console.log("Google Docs syncing enabled after fresh read-only checks. A genuine production update must still be observed before claiming completion.");
  } finally { await db.rpc("release_docs_lease", { p_owner: owner }); }
}
activate().catch(error => {
  // Provider bodies, tokens and credentials must never reach console output.
  console.error(error instanceof Error && error.message.startsWith("ENOENT") ? "Required protected configuration or acceptance report is missing. Syncing was not enabled." : "Activation failed its protected preflight. Syncing was not enabled; inspect consent, sharing, revision, acceptance and connection status.");
  process.exitCode = 1;
});
