// Read-only production authorization checks; does not write Word or send email.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const origin = "https://moments-timeline-rho.vercel.app";
for (const [path, method] of [["status", "GET"], ["connect", "POST"], ["sync", "POST"], ["conflicts", "POST"]]) {
  const response = await fetch(origin + "/api/word/" + path, { method, headers: { "Content-Type": "application/json" }, body: method === "POST" ? "{}" : undefined });
  assert.equal(response.status, 401, "Unauthenticated route must be denied: " + path);
}
assert.equal((await fetch(origin + "/api/word/cron")).status, 401);
for (const email of ["feranmidyro@gmail.com", "kieragreen50@gmail.com"]) {
  const session = JSON.parse(await readFile(".credentials/sessions/" + email + ".json", "utf8"));
  const response = await fetch(origin + "/api/word/status", { headers: { Authorization: "Bearer " + session.access_token } });
  assert.equal(response.status, 200, "Approved editor status unavailable");
  const result = await response.json();
  assert.equal(result.state, "authorization_required");
  assert.equal(result.connection, null, "This check expects Word still disconnected");
  assert.ok(!JSON.stringify(result).includes("refresh_token") && !JSON.stringify(result).includes("clientSecret"));
  console.log("Approved editor can check Word connection safely: " + email);
}
console.log("Production checks passed: anonymous routes/cron denied; both editors have accurate disconnected status; no Microsoft credentials exposed.");
