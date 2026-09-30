// Production route/private-storage checks. No document writes or Google login claim.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
const origin = "https://moments-timeline-rho.vercel.app";
for (const [path, method] of [["status", "GET"], ["connect", "POST"], ["picker", "POST"], ["sync", "POST"], ["conflicts", "POST"]]) {
  const response = await fetch(origin + "/api/docs/" + path, { method, headers: { "Content-Type": "application/json" }, body: method === "POST" ? "{}" : undefined });
  assert.equal(response.status, 401, "Anonymous route must be denied: " + path);
}
assert.equal((await fetch(origin + "/api/docs/cron")).status, 401);
assert.equal((await fetch(origin + "/api/word/status")).status, 404);
const providerResponse = await fetch(origin + "/api/auth/providers");
assert.equal(providerResponse.status, 200);
const providers = await providerResponse.json(); assert.equal(providers.available, true);
console.log("Production Google provider enabled:", providers.google);
const keys = JSON.parse(await readFile(".credentials/supabase-keys.json", "utf8"));
const url = "https://rnilakqmyanujehtqbuk.supabase.co", publicKey = keys.find(key => key.type === "publishable").api_key;
const admin = createClient(url, keys.find(key => key.name === "service_role").api_key, { auth: { persistSession: false, autoRefreshToken: false } });
const imageKey = "verification/" + randomUUID() + ".png";
const uploaded = await admin.storage.from("docs-images").upload(imageKey, await readFile("tests/fixtures/portrait.png"), {contentType:"image/png",upsert:false});
assert.equal(uploaded.error, null);
try {
  for (const email of ["feranmidyro@gmail.com", "kieragreen50@gmail.com"]) {
    const session = JSON.parse(await readFile(".credentials/sessions/" + email + ".json", "utf8"));
    const response = await fetch(origin + "/api/docs/status", { headers: { Authorization: "Bearer " + session.access_token } });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.state, "authorization_required"); assert.equal(result.connection, null);
    assert.ok(!JSON.stringify(result).includes("refresh_token"));
    const editor = createClient(url, publicKey, { auth: { persistSession: false, autoRefreshToken: false } });
    assert.equal((await editor.auth.setSession(session)).error, null);
    assert.ok((await editor.storage.from("docs-images").createSignedUrl(imageKey, 600)).error, "Browser editor must not sign server-only staging images");
    console.log("Approved editor has accurate Docs status; private staging access denied:", email);
  }
  const unsigned = await fetch(url + "/storage/v1/object/public/docs-images/" + imageKey); assert.notEqual(unsigned.status, 200);
  const signed = await admin.storage.from("docs-images").createSignedUrl(imageKey, 600); assert.equal(signed.error, null);
  const token = new URL(signed.data.signedUrl).searchParams.get("token");
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  assert.equal(claims.exp - claims.iat, 600);
  assert.equal((await fetch(signed.data.signedUrl)).status, 200);
  console.log("Actual private staging image: unsigned access denied; 600-second signed access verified.");
} finally {
  const removed = await admin.storage.from("docs-images").remove([imageKey]); assert.equal(removed.error, null);
}
console.log("Production checks passed. This does not verify Google login or document synchronization.");
