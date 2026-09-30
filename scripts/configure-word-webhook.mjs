// Transport the webhook credential directly to Supabase Vault; never print SQL.
import { readFile } from "node:fs/promises";
let token = (await readFile(".credentials/supabase-management-token", "utf8")).trim();
if (token.startsWith("go-keyring-base64:")) token = Buffer.from(token.slice(18), "base64").toString();
const credential = (await readFile(".credentials/CRON_SECRET", "utf8")).trim();
if (credential.length < 32) throw Error("A strong webhook credential is required.");
const quote = value => "'" + value.replace(/'/g, "''") + "'";
const values = { moments_word_sync_url: "https://moments-timeline-rho.vercel.app/api/word/cron", moments_word_sync_secret: credential };
const operations = Object.entries(values).map(([name, value]) => `select id into secret_id from vault.secrets where name=${quote(name)}; if secret_id is null then perform vault.create_secret(${quote(value)},${quote(name)}); else perform vault.update_secret(secret_id,${quote(value)}); end if;`).join("\n");
const response = await fetch("https://api.supabase.com/v1/projects/rnilakqmyanujehtqbuk/database/query", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ query: "begin; set local log_statement='none'; do $$ declare secret_id uuid; begin " + operations + " end $$; commit;" }) });
if (!response.ok) throw Error("Vault configuration failed (" + response.status + "). No response or credentials printed.");
console.log("Word job URL and credential configured in Supabase Vault.");
