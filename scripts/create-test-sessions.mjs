// Local verification utility. Elevated keys never enter the website environment.
import { createClient } from "@supabase/supabase-js";
import { readFile, writeFile, mkdir } from "node:fs/promises";

const url = "https://rnilakqmyanujehtqbuk.supabase.co";
const keys = JSON.parse(await readFile(".credentials/supabase-keys.json", "utf8"));
const publicKey = keys.find(key => key.type === "publishable").api_key;
const serviceKey = keys.find(key => key.name === "service_role").api_key;
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
await mkdir(".credentials/sessions", { recursive: true, mode: 0o700 });
for (const email of ["feranmidyro@gmail.com", "kieragreen50@gmail.com"]) {
  const { data: link, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw Error("Could not create a test sign-in: " + error.message);
  const client = createClient(url, publicKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error: signInError } = await client.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: link.properties.verification_type });
  if (signInError || !data.session) throw Error("Test sign-in failed: " + (signInError?.message || "No session"));
  await writeFile(`.credentials/sessions/${email}.json`, JSON.stringify(data.session), { mode: 0o600 });
  console.log("Verified an admin-issued magic-link sign-in for " + email);
}
console.log("Sessions are stored only in protected, ignored local files. This does not verify inbox delivery.");
