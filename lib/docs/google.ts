import { HttpError, PRODUCTION } from "./server.ts";
import type { GoogleDocument, Json } from "./types.ts";
import { APPROVED_EMAILS } from "../journal.ts";

export const DOCS_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const SCOPES = "openid email " + DOCS_SCOPE;
export function ensurePrivateEditors(permissions: Json[]) {
  const current = permissions.filter(permission => !permission.deleted);
  if (current.some(permission => permission.type !== "user" || !APPROVED_EMAILS.includes(permission.emailAddress?.toLowerCase())) || APPROVED_EMAILS.some(email => !current.some(permission => permission.emailAddress?.toLowerCase() === email && ["owner", "writer"].includes(permission.role)))) {
    throw new HttpError(403, "Before inserting private photos, the Google Doc must be restricted to the two approved Google accounts with Editor access. Review its Share settings, then retry.", "privacy_review");
  }
}
export function googleConfig() {
  const client = process.env.GOOGLE_CLIENT_ID, secret = process.env.GOOGLE_CLIENT_SECRET;
  const project = process.env.GOOGLE_PROJECT_NUMBER, pickerKey = process.env.GOOGLE_PICKER_API_KEY;
  if (!client || !secret || !project || !/^\d+$/.test(project) || !pickerKey) throw new HttpError(503, "Google Cloud OAuth and Picker configuration are required before connecting Google Docs.");
  return { client, secret, project, pickerKey, callback: PRODUCTION + "/api/docs/callback" };
}
export async function exchangeToken(values: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in: number; scope?: string }> {
  const config = googleConfig();
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: config.client, client_secret: config.secret, ...values }), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new HttpError(response.status === 400 || response.status === 401 ? 401 : 503, "Google authorization expired or was denied. Reconnect Google Docs.");
  return response.json();
}
export class Google {
  constructor(private accessToken: string, private transport: typeof fetch = fetch) {}
  async request(service: "docs" | "drive", path: string, init: RequestInit = {}): Promise<Response> {
    if (!path.startsWith("/")) throw Error("Invalid Google API path");
    const base = service === "docs" ? "https://docs.googleapis.com/v1" : "https://www.googleapis.com/drive/v3";
    const headers = new Headers(init.headers); headers.set("Authorization", "Bearer " + this.accessToken);
    const response = await this.transport(base + path, { ...init, headers, signal: AbortSignal.timeout(20000), redirect: "error" });
    if (response.status === 401) throw new HttpError(401, "Google authorization expired. Reconnect Google Docs.");
    if (response.status === 403 || response.status === 404) throw new HttpError(403, "Google denied access. Select the supplied document in Google Picker and confirm edit permission and enabled APIs.", "access_required");
    if (response.status === 429 || response.status >= 500) throw new HttpError(503, "Google is temporarily unavailable or limiting requests. Changes remain queued.");
    if (response.status === 400) {
      const body = await response.json().catch(() => ({}));
      if (/revision/i.test(body.error?.message || "")) throw new HttpError(409, "The document changed while syncing. Its latest version must be read before retrying.", "version_changed");
      throw new HttpError(422, "Google rejected the document update. No unconditional replacement will be attempted; changes remain queued.", "request_rejected");
    }
    if (!response.ok) throw new HttpError(503, "Google Docs could not complete the request. Changes remain queued.");
    return response;
  }
  async read(id: string): Promise<GoogleDocument> {
    const document = await (await this.request("docs", `/documents/${encodeURIComponent(id)}?includeTabsContent=true&suggestionsViewMode=SUGGESTIONS_INLINE`)).json();
    if (document.documentId !== id || !document.revisionId) throw new HttpError(422, "Google did not return the document identity and revision needed for safe updates.");
    return document;
  }
  async write(id: string, revision: string, requests: Json[]) {
    if (!revision) throw Error("A revision condition is mandatory for every document update.");
    return (await this.request("docs", `/documents/${encodeURIComponent(id)}:batchUpdate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requests, writeControl: { requiredRevisionId: revision } }) })).json();
  }
  async file(id: string) { return (await this.request("drive", `/files/${encodeURIComponent(id)}?fields=id,name,mimeType,capabilities(canEdit,canCopy),webViewLink&supportsAllDrives=true`)).json(); }
  async hasComments(id: string) {
    const result = await (await this.request("drive", `/files/${encodeURIComponent(id)}/comments?fields=comments(id)&pageSize=1&includeDeleted=false`)).json();
    return !!result.comments?.length;
  }
  async permissions(id: string) {
    const all: Json[] = []; let next = "";
    do {
      const result = await (await this.request("drive", `/files/${encodeURIComponent(id)}/permissions?fields=nextPageToken,permissions(id,type,role,emailAddress,domain,deleted)&supportsAllDrives=true&pageSize=100` + (next ? "&pageToken=" + encodeURIComponent(next) : ""))).json();
      all.push(...result.permissions || []); next = result.nextPageToken || "";
    } while (next);
    return all;
  }
}
