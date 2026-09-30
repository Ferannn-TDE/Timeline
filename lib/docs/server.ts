import { createClient } from "@supabase/supabase-js";
import { createCipheriv, createDecipheriv, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { APPROVED_EMAILS } from "../journal.ts";

export const PRODUCTION = "https://moments-timeline-rho.vercel.app";
export const DOCUMENT_ID = "1gGFlT4q6OKSKakkEt25Wl5Yk78-VJCpIuUGuQ8qO8ws";
export const DOCUMENT_URL = "https://docs.google.com/document/d/" + DOCUMENT_ID + "/edit";
export const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");
export class HttpError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }
export function serviceDb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new HttpError(503, "Google Docs synchronization is awaiting secure server configuration.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
export async function editor(request: Request) {
  const bearer = request.headers.get("authorization");
  if (!bearer?.startsWith("Bearer ")) throw new HttpError(401, "Sign in to access Google Docs syncing.");
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false }, global: { headers: { Authorization: bearer } } });
  const { data, error } = await db.auth.getUser(bearer.slice(7));
  const email = data.user?.email?.toLowerCase();
  if (error || !email) throw new HttpError(401, "Your sign-in has expired. Please sign in again.");
  if (!APPROVED_EMAILS.includes(email)) throw new HttpError(403, "This journal is restricted to its approved editors.");
  const membership = await db.from("journal_members").select("email").eq("email", email).maybeSingle();
  if (membership.error || !membership.data) throw new HttpError(403, "Journal access is not enabled for this account.");
  return { id: data.user!.id, email };
}
export function encrypt(value: string): string {
  const key = Buffer.from(process.env.DOCS_TOKEN_ENCRYPTION_KEY || "", "base64");
  if (key.length !== 32) throw new HttpError(503, "Google Docs token protection has not been configured.");
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from("moments-google-docs-v1"));
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [nonce, cipher.getAuthTag(), data].map(part => part.toString("base64url")).join(".");
}
export function decrypt(value: string): string {
  const key = Buffer.from(process.env.DOCS_TOKEN_ENCRYPTION_KEY || "", "base64");
  if (key.length !== 32) throw new HttpError(503, "Google Docs token protection has not been configured.");
  const [nonce, tag, data] = value.split(".").map(part => Buffer.from(part, "base64url"));
  const cipher = createDecipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from("moments-google-docs-v1")); cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data), cipher.final()]).toString("utf8");
}
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function safeError(error: unknown): Response {
  // Never return provider response bodies, tokens, or raw internal database errors.
  const known = error instanceof HttpError;
  return Response.json({ error: known ? error.message : "Google Docs syncing could not complete. The journal is saved; please retry." }, { status: known ? error.status : 500, headers: { "Cache-Control": "no-store" } });
}
