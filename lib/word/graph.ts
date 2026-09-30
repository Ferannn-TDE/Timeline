import { HttpError, PRODUCTION } from "./server.ts";

export type DriveItem = { id: string; name: string; eTag: string; size: number; webUrl: string; parentReference: { driveId: string; id: string } };
const GRAPH = "https://graph.microsoft.com/v1.0";
export const SCOPES = "openid offline_access https://graph.microsoft.com/Files.ReadWrite";
export function microsoftConfig() {
  const client = process.env.MICROSOFT_CLIENT_ID, secret = process.env.MICROSOFT_CLIENT_SECRET;
  const tenant = process.env.MICROSOFT_TENANT_ID;
  if (!client || !secret || !tenant || !/^[a-zA-Z0-9.-]+$/.test(tenant)) throw new HttpError(503, "Microsoft app registration and university consent are required before connecting Word.");
  return { client, secret, tenant, callback: PRODUCTION + "/api/word/callback" };
}
export async function exchangeToken(values: Record<string, string>): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const config = microsoftConfig();
  const response = await fetch(`https://login.microsoftonline.com/${config.tenant}/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.client, client_secret: config.secret, scope: SCOPES, ...values }), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new HttpError(response.status === 400 || response.status === 401 ? 401 : 503, "Microsoft authorization expired or was denied. Reconnect Microsoft; university approval may be required.");
  return response.json();
}
export class Graph {
  constructor(private accessToken: string, private transport: typeof fetch = fetch) {}
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    if (!path.startsWith("/")) throw Error("Invalid Graph path");
    const headers = new Headers(init.headers); headers.set("Authorization", "Bearer " + this.accessToken);
    const response = await this.transport(GRAPH + path, { ...init, headers, signal: AbortSignal.timeout(15000), redirect: "manual" });
    if (response.status === 401 || response.status === 403) throw new HttpError(401, "Microsoft access expired or the university denied access. Reconnect Microsoft or request university consent.");
    if (response.status === 412) throw new HttpError(409, "The document changed while syncing. Download its latest version and retry.", "version_changed");
    if (response.status === 423 || response.status === 409) throw new HttpError(409, "The document is locked or has a version conflict. Changes remain queued; retry when it is available.");
    if (response.status === 429 || response.status >= 500) throw new HttpError(503, "Microsoft is temporarily unavailable or limiting requests. Changes remain queued.");
    if (!response.ok && response.status !== 302) throw new HttpError(422, "Microsoft could not access this document. Verify permission and the document location.");
    return response;
  }
  path(drive: string, item: string) { return `/drives/${encodeURIComponent(drive)}/items/${encodeURIComponent(item)}`; }
  async resolve(url: string): Promise<DriveItem> {
    const token = "u!" + Buffer.from(url).toString("base64url");
    return (await this.request(`/shares/${token}/driveItem`, { headers: { Prefer: "redeemSharingLinkIfNecessary" } })).json();
  }
  async metadata(drive: string, item: string): Promise<DriveItem> { return (await this.request(this.path(drive, item))).json(); }
  async read(drive: string, item: string): Promise<{ item: DriveItem; bytes: Uint8Array }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = await this.metadata(drive, item);
      if (!before.name.toLowerCase().endsWith(".docx") || before.size > 25_000_000 || !before.eTag) throw new HttpError(422, "Choose a .docx document under 25 MB with version information.");
      let response = await this.request(this.path(drive, item) + "/content");
      if (response.status === 302) {
        const location = new URL(response.headers.get("location") || "");
        if (location.protocol !== "https:" || !/(^|\.)(sharepoint\.com|1drv\.com|onedrive\.com|microsoftusercontent\.com)$/.test(location.hostname)) throw new HttpError(422, "Microsoft returned an unsupported download location.");
        // Signed download URL: no OAuth token is forwarded to the storage host.
        response = await this.transport(location, { signal: AbortSignal.timeout(15000), redirect: "error" });
      }
      if (!response.ok) throw new HttpError(503, "The document could not be downloaded. No Word changes were made.");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > 25_000_000) throw new HttpError(422, "The document exceeds the sync size limit.");
      const after = await this.metadata(drive, item);
      if (before.eTag === after.eTag) return { item: after, bytes };
    }
    throw new HttpError(409, "Word changed during inspection. Retry after its current edit is saved.");
  }
  async write(drive: string, item: string, etag: string, bytes: Uint8Array): Promise<DriveItem> {
    if (!etag) throw Error("A version condition is required for every Word write.");
    // Must pass a live stale-ETag rejection test on a disposable document before
    // enabling the connection. Never fall back to an unconditional upload.
    return (await this.request(this.path(drive, item) + "/content", {
      method: "PUT", headers: { "If-Match": etag, "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      body: new Uint8Array(bytes),
    })).json();
  }
}
