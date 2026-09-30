// Real Supabase workflow check. Uses real editor sessions; cleans only its own fixtures.
import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { addEntry, editEntry, deleteEntry, loadEntries, type Row } from "../lib/journal.ts";

const keys = JSON.parse(await readFile(".credentials/supabase-keys.json", "utf8"));
const key = keys.find((item: { type: string }) => item.type === "publishable").api_key;
const url = "https://rnilakqmyanujehtqbuk.supabase.co";
const clients = [];
for (const email of ["feranmidyro@gmail.com", "kieragreen50@gmail.com"]) {
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const session = JSON.parse(await readFile(`.credentials/sessions/${email}.json`, "utf8"));
  const { error } = await client.auth.setSession(session);
  if (error) throw error;
  const { data: account, error: accountError } = await client.auth.getUser();
  if (accountError) throw accountError;
  assert.equal(account.user?.email, email);
  const { data: membership, error: membershipError } = await client.from("journal_members").select("email");
  if (membershipError) throw membershipError;
  assert.deepEqual(membership, [{ email }]);
  clients.push(client);
}
const [feran, kiera] = clients;
const marker = "Moments automated verification " + crypto.randomUUID();
const file = new File([new Uint8Array(await readFile("tests/fixtures/portrait.png"))], "portrait.png", { type: "image/png" });
const created: Row[] = [];
try {
  await addEntry(feran, "feranmidyro@gmail.com", file, "2026-09-01", marker + " recent");
  await addEntry(feran, "feranmidyro@gmail.com", file, "2010-05-12", marker + " older");
  const { data, error } = await feran.from("entries").select("*").like("caption", marker + "%").order("photo_date", { ascending: false });
  if (error) throw error;
  created.push(...data);
  assert.equal(created.length, 2);
  const visible = (await loadEntries(kiera)).filter(row => row.caption.startsWith(marker));
  assert.deepEqual(visible.map(row => row.photo_date), ["2026-09-01", "2010-05-12"]);
  for (const row of visible) { const response = await fetch(row.imageUrl); assert.equal(response.status, 200); }
  const publicPhoto = await fetch(url + "/storage/v1/object/public/photo-journal/" + created[0].image_key);
  assert.notEqual(publicPhoto.status, 200);
  const anon = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const denied = await anon.from("entries").select("id");
  assert.ok(denied.error || denied.data?.length === 0);
  const deniedPhoto = await anon.storage.from("photo-journal").createSignedUrl(created[0].image_key, 60);
  assert.ok(deniedPhoto.error);
  await editEntry(kiera, created[1], "2010-05-13", marker + " edited by Kiera");
  const shared = (await loadEntries(feran)).find(row => row.id === created[1].id)!;
  assert.equal(shared.caption, marker + " edited by Kiera");
  assert.equal(shared.photo_date, "2010-05-13");
  assert.equal(await deleteEntry(kiera, shared), null);
  assert.equal((await loadEntries(feran)).some(row => row.id === shared.id), false);
  assert.ok((await feran.storage.from("photo-journal").download(shared.image_key)).error);
  console.log("PASS: real editor sign-ins, own membership, upload, older-date ordering, shared visibility, signed-photo reads, cross-editor edit/delete, and anonymous/public-photo denial.");
} finally {
  const { data: remaining, error } = await feran.from("entries").select("*").like("caption", marker + "%");
  if (error) throw error;
  for (const row of remaining || []) {
    const warning = await deleteEntry(feran, row);
    if (warning) throw Error(warning);
  }
  console.log("Cleaned only this check's temporary journal entries and photos.");
}
