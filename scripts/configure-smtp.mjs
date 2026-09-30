// Run locally after placing provider details in ignored .credentials/smtp.json.
// Never print credentials or the full Supabase authentication configuration.
import { readFile } from "node:fs/promises";

let token = (await readFile(".credentials/supabase-management-token", "utf8")).trim();
if (token.startsWith("go-keyring-base64:")) token = Buffer.from(token.slice(18), "base64").toString();
const endpoint = "https://api.supabase.com/v1/projects/rnilakqmyanujehtqbuk/config/auth";
async function config(method = "GET", body) {
  const response = await fetch(endpoint, { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
  if (!response.ok) throw Error("Supabase configuration request failed (" + response.status + "). Credentials were not printed.");
  return response.json();
}
const before = await config();
console.log("Existing custom SMTP:", !!before.smtp_host, "Production redirect:", before.site_url === "https://moments-timeline-rho.vercel.app");
if (process.argv.includes("--inspect")) process.exit(0);
const smtp = JSON.parse(await readFile(".credentials/smtp.json", "utf8"));
for (const field of ["host", "user", "password", "senderEmail", "senderName"]) {
  if (typeof smtp[field] !== "string" || !smtp[field].trim()) throw Error("Missing SMTP field: " + field);
}
if (![465, 587, 2465, 2587].includes(Number(smtp.port))) throw Error("Use a supported secure SMTP port.");
await config("PATCH", { smtp_host: smtp.host, smtp_port: Number(smtp.port), smtp_user: smtp.user, smtp_pass: smtp.password, smtp_admin_email: smtp.senderEmail, smtp_sender_name: smtp.senderName, rate_limit_email_sent: Math.max(30, before.rate_limit_email_sent || 0) });
const after = await config();
if (after.smtp_host !== smtp.host || after.smtp_admin_email !== smtp.senderEmail || after.site_url !== before.site_url) throw Error("SMTP read-back did not match; review the secure dashboard configuration.");
console.log("Custom SMTP configured and read back. Real inbox delivery and production link verification are still required for both editors.");
