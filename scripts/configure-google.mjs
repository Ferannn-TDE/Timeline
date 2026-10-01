// Reads only ignored local credentials; configures Supabase Google sign-in.
// Google Cloud project/client creation and consent require the account owner.
import { readFile, writeFile, chmod } from "node:fs/promises";
const values = JSON.parse(await readFile(".credentials/google.json", "utf8"));
if (!/\.apps\.googleusercontent\.com$/.test(values.clientId || "") || !values.clientSecret) throw Error("A Web OAuth client ID and secret are required in .credentials/google.json.");
if (!/^\d+$/.test(String(values.projectNumber || "")) || typeof values.pickerApiKey !== "string" || !values.pickerApiKey.trim()) throw Error("A numeric Google project number and restricted Picker API key are required before changing configuration.");
await chmod(".credentials", 0o700);
await chmod(".credentials/google.json", 0o600);
let token = (await readFile(".credentials/supabase-management-token", "utf8")).trim();
if (token.startsWith("go-keyring-base64:")) token = Buffer.from(token.slice(18), "base64").toString();
const endpoint = "https://api.supabase.com/v1/projects/rnilakqmyanujehtqbuk/config/auth";
async function config(method = "GET", body) {
  const response = await fetch(endpoint, { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
  if (!response.ok) throw Error("Google provider configuration failed (" + response.status + "). No credentials printed.");
  return response.json();
}
const before = await config();
if (before.site_url !== "https://moments-timeline-rho.vercel.app") throw Error("Inspect the production redirect before configuring the provider.");
await config("PATCH", { external_google_enabled: true, external_google_client_id: values.clientId, external_google_secret: values.clientSecret, external_google_skip_nonce_check: false });
const after = await config();
if (!after.external_google_enabled || after.external_google_client_id !== values.clientId || after.site_url !== before.site_url) throw Error("Google provider read-back did not match.");
for (const [name, value] of Object.entries({ GOOGLE_CLIENT_ID: values.clientId, GOOGLE_CLIENT_SECRET: values.clientSecret, GOOGLE_PROJECT_NUMBER: values.projectNumber, GOOGLE_PICKER_API_KEY: values.pickerApiKey })) {
  if (!value) continue;
  await writeFile(".credentials/" + name, String(value), { mode: 0o600 });
  await chmod(".credentials/" + name, 0o600);
}
console.log("Supabase Google sign-in configured and read back. Server OAuth configuration prepared in ignored files. Real Google login and Docs consent must still be tested.");
