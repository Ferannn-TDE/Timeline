import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

type RecordRow = { id: string; photo_date: string; caption: string; image_key: string; author_email: string; created_at: string };
const image = readFileSync("tests/fixtures/portrait.png");
const initial: RecordRow = { id: "a", photo_date: "2025-06-15", caption: "Our recent memory", image_key: "recent.png", author_email: "feranmidyro@gmail.com", created_at: "2026-01-01T00:00:00Z" };

async function backend(page: Page, email: string | null = "feranmidyro@gmail.com", rows: RecordRow[] = [{ ...initial }]) {
  // Production-assets verification still intercepts EVERY Supabase request.
  // It never creates a real journal fixture or bypasses tests/live's guard.
  const project=process.env.HEIF_PRODUCTION_ASSETS_ONLY==='1'?'rnilakqmyanujehtqbuk':'fake-project';
  const user = { id: "11111111-1111-4111-8111-111111111111", email, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
  if (email) {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const token = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url") + "." + Buffer.from(JSON.stringify({ sub: user.id, email, exp: expires, role: "authenticated" })).toString("base64url") + ".test";
    await page.addInitScript(({ user, token, expires,project }) => localStorage.setItem("sb-"+project+"-auth-token", JSON.stringify({ access_token: token, refresh_token: "test-refresh", expires_at: expires, expires_in: 3600, token_type: "bearer", user })), { user, token, expires,project });
  }
  await page.route("**/api/auth/providers", route => route.fulfill({json:{google:true,available:true}}));
  await page.route("**/api/docs/status", route => route.fulfill({contentType:"application/json",body:JSON.stringify({state:"authorization_required",pending:0,connection:null,conflicts:[],entries:[]})}));
  const state = { rows, uploads: 0, deletes: 0, otps: 0, delayReads: false, cleanupError: false, stored: new Map<string,{bytes:Buffer,type:string}>() };
  await page.route("https://"+project+".supabase.co/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const reply = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname.endsWith("/auth/v1/user")) return reply(user);
    if (url.pathname.endsWith("/auth/v1/logout")) return reply({});
    if (url.pathname.endsWith("/auth/v1/otp")) { state.otps++; return reply({}); }
    if (url.pathname.endsWith("/rest/v1/journal_members")) return reply(email ? { email } : null);
    if (url.pathname.endsWith("/rest/v1/entries")) {
      if (method === "GET") {
        if (state.delayReads) await new Promise(resolve => setTimeout(resolve, 700));
        return reply([...state.rows].sort((a, b) => b.photo_date.localeCompare(a.photo_date) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)));
      }
      if (method === "POST") { state.rows.push({ ...request.postDataJSON(), id: "new", created_at: new Date().toISOString() }); return reply(null, 201); }
      const target = state.rows.find(row => ["id", "caption", "photo_date"].every(field => url.searchParams.get(field) === "eq." + row[field as keyof RecordRow]));
      if (!target) return reply([]);
      if (method === "PATCH") { Object.assign(target, request.postDataJSON()); return reply([{ id: target.id }]); }
      if (method === "DELETE") { state.rows = state.rows.filter(row => row !== target); return reply([{ id: target.id }]); }
    }
    if (url.pathname === "/storage/v1/object/sign/photo-journal") return reply(request.postDataJSON().paths.map((path: string) => ({ path, signedURL: "/object/sign/photo-journal/" + path, error: null })));
    if (method === "GET" && url.pathname.startsWith("/storage/v1/object/sign/")) {const stored=state.stored.get(url.pathname.split('/photo-journal/')[1]);return route.fulfill({ contentType: stored?.type||"image/png", body: stored?.bytes||image });}
    if (method === "POST" && url.pathname.startsWith("/storage/v1/object/photo-journal/")) {
      state.uploads++;
      const form=await new Request(url,{method:'POST',headers:request.headers(),body:new Uint8Array(request.postDataBuffer()!)}).formData();
      const file=[...form.values()].find(value=>value instanceof Blob) as File;
      state.stored.set(url.pathname.split('/photo-journal/')[1],{bytes:Buffer.from(await file.arrayBuffer()),type:file.type});
      return reply({ Key: "photo-journal/new.png" });
    }
    if (method === "DELETE" && url.pathname === "/storage/v1/object/photo-journal") { state.deletes++; return state.cleanupError ? reply({ message: "Cleanup failed" }, 500) : reply([]); }
    return reply({ message: "Unexpected mock request: " + method + " " + url.pathname }, 400);
  });
  return state;
}

test("approved editor uploads an older portrait, edits date and caption, and removes it", async ({ page }) => {
  const state = await backend(page);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByText("Our recent memory", { exact: true })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({ name: "portrait.png", mimeType: "image/png", buffer: image });
  await page.getByLabel("Date of photo").fill("2010-05-12");
  await page.getByLabel("Caption", { exact: true }).fill("An older portrait memory");
  await page.getByRole("button", { name: "Add to timeline" }).click();
  await expect(page.locator(".entrycaption")).toHaveText(["Our recent memory", "An older portrait memory"]);
  expect(state.uploads).toBe(1);
  const photo = page.locator(".entry > img").last();
  await expect(photo).toHaveJSProperty("naturalHeight", 600);
  expect(await photo.evaluate(node => getComputedStyle(node).objectFit)).toBe("contain");
  const older = page.locator("article").last();
  await older.getByRole("button", { name: "Edit", exact: true }).click();
  await older.getByLabel("Date", { exact: true }).fill("2026-09-01");
  await older.getByLabel("Caption", { exact: true }).fill("Updated memory");
  await older.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".entrycaption")).toHaveText(["Updated memory", "Our recent memory"]);
  page.on("dialog", dialog => dialog.accept());
  await page.locator("article").filter({ hasText: "Updated memory" }).getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.locator(".entrycaption")).toHaveText(["Our recent memory"]);
  expect(state.deletes).toBe(1);
  expect(errors).toEqual([]);
});

test("second editor sees the same shared entries and can edit them", async ({ page }) => {
  const state = await backend(page, "kieragreen50@gmail.com");
  await page.goto("/");
  await expect(page.locator(".entrycaption")).toHaveText(["Our recent memory"]);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator("article").getByLabel("Caption", { exact: true }).fill("Edited by Kiera");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".entrycaption")).toHaveText(["Edited by Kiera"]);
  expect(state.rows[0].author_email).toBe("feranmidyro@gmail.com");
});

for(const format of ['jpeg','png','webp'] as const)test(`${format} upload and preview remain supported`,async({page})=>{
  const sharp=(await import('sharp')).default;
  const bytes=await sharp(image).toFormat(format).toBuffer();const state=await backend(page);await page.goto('/');
  await page.locator('input[type=file]').setInputFiles({name:'photo.'+format,mimeType:'image/'+format,buffer:bytes});
  await expect(page.getByAltText('Selected photo')).toHaveJSProperty('naturalHeight',600);
  await page.getByLabel('Date of photo').fill('2000-01-01');await page.getByLabel('Caption',{exact:true}).fill('Format test '+format);await page.getByRole('button',{name:'Add to timeline'}).click();
  await expect(page.locator('article').filter({hasText:'Format test '+format}).locator('img')).toHaveJSProperty('naturalHeight',600);expect(state.uploads).toBe(1);
});

for(const fixture of [{file:'0003.heic',width:924},{file:'iphone_13_pro_max.HEIC',width:1500}])test(`real HEIC ${fixture.file} conversion displays a portrait and saves original plus JPEG; corrupt files save nothing`,async({page})=>{
  test.setTimeout(120000);
  const state=await backend(page);
  await page.goto("/");
  await expect(page.locator('input[type=file]')).toHaveAttribute('accept',/\.heic,.heif/);
  await page.locator('input[type=file]').setInputFiles({name:'iphone.HEIF',mimeType:'application/octet-stream',buffer:readFileSync('tests/fixtures/'+fixture.file)});
  const preview=page.getByAltText('Selected photo');await expect(preview).toBeVisible({timeout:90000});
  await expect(preview).toHaveJSProperty('naturalHeight',2000);await expect(preview).toHaveJSProperty('naturalWidth',fixture.width);
  // Save the actual decoder output for the independent live temporary-Doc test.
  const bytes=await preview.evaluate(async node=>Array.from(new Uint8Array(await(await fetch((node as HTMLImageElement).src)).arrayBuffer())));
  const {mkdirSync,writeFileSync}=await import('node:fs');mkdirSync('artifacts/heif',{recursive:true});writeFileSync('artifacts/heif/'+fixture.file+'.jpg',Buffer.from(bytes));
  await page.getByLabel('Date of photo').fill('2001-01-01');await page.getByLabel('Caption',{exact:true}).fill('Temporary HEIF browser test');await page.getByRole('button',{name:'Add to timeline'}).click();
  await expect(page.locator('.entrycaption').filter({hasText:'Temporary HEIF browser test'})).toBeVisible();expect(state.uploads).toBe(2);const saved=state.rows.find(row=>row.caption==='Temporary HEIF browser test')!;expect(saved.image_key).toMatch(/\.heif$/);
  expect(state.stored.get(saved.image_key)!.bytes).toEqual(readFileSync('tests/fixtures/'+fixture.file));
  await expect(page.locator('article').filter({hasText:'Temporary HEIF browser test'}).locator('img')).toHaveJSProperty('naturalHeight',2000);
  const before=state.rows.length;
  await page.locator('input[type=file]').setInputFiles({name:'broken.heic',mimeType:'',buffer:Buffer.from('not an image')});
  await expect(page.locator('.notice[role=alert]')).toContainText(/decoded|readable|corrupt|unsupported/,{timeout:90000});
  await expect(page.getByRole('button',{name:'Add to timeline'})).toBeDisabled();expect(state.uploads).toBe(2);expect(state.rows.length).toBe(before);
});

test("sign-in form rejects an unapproved address and sends OTP for an editor", async ({ page }) => {
  const state = await backend(page, null);
  await page.goto("/");
  await page.getByLabel("Email address").fill("someone@example.com");
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.locator(".notice[role=alert]")).toContainText("two approved editors");
  expect(state.otps).toBe(0);
  await page.getByLabel("Email address").fill("feranmidyro@gmail.com");
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.getByRole("status")).toHaveText("Check your email for a sign-in link.");
  expect(state.otps).toBe(1);
});

test("an unapproved authenticated user sees no journal", async ({ page }) => {
  await backend(page, "someone@example.com");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Access not enabled yet" })).toBeVisible();
  await expect(page.locator("article")).toHaveCount(0);
});

test("concurrent edits are preserved and the stale editor gets a conflict", async ({ page }) => {
  const state = await backend(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  state.rows[0].caption = "Saved by the other editor";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
  await page.locator("article").getByLabel("Caption", { exact: true }).fill("My stale edit");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".notice[role=alert]")).toContainText("changed or was removed");
  expect(state.rows[0].caption).toBe("Saved by the other editor");
});

test("a late refresh cannot restore entries after sign-out", async ({ page }) => {
  const state = await backend(page);
  await page.goto("/");
  await expect(page.locator("article")).toHaveCount(1);
  state.delayReads = true;
  const pending = page.waitForRequest(request => request.url().includes("/rest/v1/entries"));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await pending;
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Moments" })).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(page.locator("article")).toHaveCount(0);
});

test("mobile portrait photo is visible without cropping", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await backend(page);
  await page.goto("/");
  const photo = page.locator(".entry > img");
  await expect(photo).toHaveJSProperty("naturalWidth", 300);
  expect(await photo.evaluate(node => getComputedStyle(node).objectFit)).toBe("contain");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("Google Docs conflicts show reviewed versions and bind the editor's resolution", async ({ page }) => {
  await backend(page);
  const conflict = { entry_id: "22222222-2222-4222-8222-222222222222", reason: "This entry changed in both places.", website: { ...initial, caption: "Website caption" }, document_text: "Manual Google Docs caption", document_hash: "reviewed-document", desired_hash: "reviewed-website" };
  await page.route("**/api/docs/status", route => route.fulfill({ json: { state: "conflict", pending: 1, connection: { enabled: true, document_name: "Moments Google Doc", document_url: "https://docs.google.com/document/d/test/edit" }, conflicts: [conflict], entries: [{ entry_id: conflict.entry_id, status: "conflict" }] } }));
  let resolution: unknown;
  await page.route("**/api/docs/conflicts", route => { resolution = route.request().postDataJSON(); return route.fulfill({ json: { state: "pending" } }); });
  await page.route("**/api/docs/sync", route => route.fulfill({ json: { state: "synced" } }));
  await page.goto("/");
  const panel = page.getByRole("region", { name: "Shared Google Docs document" });
  await expect(panel.getByText("Google Docs changes need review")).toBeVisible();
  await expect(panel.getByText("Manual Google Docs caption")).toBeVisible();
  await expect(panel.getByText(/Website caption/)).toBeVisible();
  page.once("dialog", dialog => dialog.accept());
  await panel.getByRole("button", { name: "Keep Google Docs page" }).click();
  await expect.poll(() => resolution).toEqual({ entry_id: conflict.entry_id, choice: "document", document_hash: "reviewed-document", desired_hash: "reviewed-website" });
  await expect(page.locator(".entrycaption")).toHaveText(["Our recent memory"]);
});

test("a connected but unverified Google Docs document cannot start syncing", async ({ page }) => {
  await backend(page);
  let syncCalls = 0;
  await page.route("**/api/docs/status", route => route.fulfill({ json: { state: "awaiting_test", pending: 3, connection: { enabled: false, document_name: "Moments Google Doc", document_url: "https://docs.google.com/document/d/test/edit" }, conflicts: [], entries: [{ entry_id: initial.id, status: "pending" }] } }));
  await page.route("**/api/docs/sync", route => { syncCalls++; return route.fulfill({ json: {} }); });
  await page.goto("/");
  const panel = page.getByRole("region", { name: "Shared Google Docs document" });
  await expect(panel.getByText("Connected; document verification pending")).toBeVisible();
  await expect(panel.getByText("3 changes are waiting for Google Docs.")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Sync / retry Google Docs" })).toHaveCount(0);
  expect(syncCalls).toBe(0);
});

test("Google Docs failure remains separate from successfully saved journal entries", async ({ page }) => {
  await backend(page);
  await page.route("**/api/docs/status", route => route.fulfill({ json: { state: "failed", pending: 1, connection: { enabled: true, document_name: "Moments Google Doc", document_url: "https://docs.google.com/document/d/test/edit", last_error: "Google is temporarily unavailable." }, conflicts: [], entries: [{ entry_id: initial.id, status: "failed" }] } }));
  await page.goto("/");
  const panel = page.getByRole("region", { name: "Shared Google Docs document" });
  await expect(panel.getByText("Google Docs sync failed", { exact: true })).toBeVisible();
  await expect(panel.getByRole("alert")).toHaveText("Google is temporarily unavailable.");
  await expect(page.locator(".entrycaption")).toHaveText(["Our recent memory"]);
});

test("missing document selection explains queued uploads and Picker errors allow retry", async ({ page }) => {
  await backend(page);
  let syncCalls = 0;
  await page.route("**/api/docs/status", route => route.fulfill({ json: { state: "document_selection_required", pending: 1, connection: { enabled: false, document_name: "Moments Google Doc", document_url: "https://docs.google.com/document/d/test/edit" }, conflicts: [], entries: [{ entry_id: initial.id, status: "pending" }] } }));
  await page.route("**/api/docs/sync", route => { syncCalls++; return route.fulfill({ json: { state: "document_selection_required" } }); });
  await page.route("**/api/docs/picker", route => route.fulfill({ json: { access_token: "temporary-test-only", picker_key: "test-only", project_number: "123", document_id: "test" } }));
  await page.addInitScript(() => {
    class View { setMimeTypes() { return this; } }
    class Builder {
      callback: (data: { action: string }) => void = () => {};
      addView() { return this; } setAppId() { return this; } setDeveloperKey() { return this; }
      setOAuthToken() { return this; } setOrigin() { return this; } setTitle() { return this; }
      setCallback(callback: typeof this.callback) { this.callback = callback; return this; }
      build() { return { dispose() {}, setVisible: () => setTimeout(() => this.callback({ action: "error" }), 0) }; }
    }
    (window as any).google = { picker: { DocsView: View, ViewId: { DOCS: "docs" }, PickerBuilder: Builder, Action: { ERROR: "error", PICKED: "picked", CANCEL: "cancel" } } };
  });
  await page.goto("/");
  const panel = page.getByRole("region", { name: "Shared Google Docs document" });
  await expect(panel.getByText(/this app does not yet have access to the shared document/)).toBeVisible();
  const select = panel.getByRole("button", { name: "Select shared Google Doc" });
  await select.click();
  await expect(panel.getByRole("alert")).toContainText("Google Picker could not authorize file selection");
  await expect(select).toBeEnabled();
  await expect(panel.getByRole("button", { name: "Sync / retry Google Docs" })).toHaveCount(0);
  expect(syncCalls).toBe(0);
});

test("blank Google Picker has independent close controls and uploader CSS cannot collapse its iframe", async ({ page }) => {
  await backend(page);
  await page.route("**/api/docs/status", route => route.fulfill({ json: { state: "document_selection_required", pending: 1, connection: { enabled: false, document_name: "Shared doc", document_url: "https://docs.google.com/document/d/test/edit" }, conflicts: [], entries: [] } }));
  await page.route("**/api/docs/picker", route => route.fulfill({ json: { access_token: "temporary-test-only", picker_key: "test-only", project_number: "123", document_id: "test" } }));
  await page.addInitScript(() => {
    class View { setMimeTypes() { return this; } }
    class Builder {
      addView() { return this; } setAppId() { return this; } setDeveloperKey() { return this; }
      setOAuthToken() { return this; } setOrigin() { return this; } setTitle() { return this; } setCallback() { return this; }
      build() {
        const dialog = document.createElement("div"); dialog.className = "picker picker-dialog"; dialog.style.width = "800px";
        const frame = document.createElement("iframe"); frame.style.width = "100%"; dialog.append(frame);
        const outside = [...document.body.children];
        const hidden = outside.map(element => element.getAttribute("aria-hidden"));
        return {
          dispose: () => { dialog.remove(); outside.forEach((element, i) => hidden[i] === null ? element.removeAttribute("aria-hidden") : element.setAttribute("aria-hidden", hidden[i]!)); },
          setVisible: () => { outside.forEach(element => element.setAttribute("aria-hidden", "true")); document.body.append(dialog); },
        };
      }
    }
    (window as any).google = { picker: { DocsView: View, ViewId: { DOCS: "docs" }, PickerBuilder: Builder, Action: { ERROR: "error", PICKED: "picked", CANCEL: "cancel" } } };
  });
  await page.goto("/");
  const select = page.getByRole("button", { name: "Select shared Google Doc" });
  await select.click();
  const frame = page.locator(".picker-dialog iframe"); await expect(frame).toBeVisible();
  expect((await frame.boundingBox())!.width).toBeGreaterThan(750);
  await page.getByRole("button", { name: "Close Google Doc selection" }).click();
  await expect(frame).toHaveCount(0); await expect(select).toBeEnabled();
  await select.click(); await expect(frame).toBeVisible();
  await page.getByRole("button", { name: "Close Google Doc selection" }).click();
  await expect(select).toBeEnabled();
  await page.clock.install();
  await select.click(); await expect(frame).toBeVisible();
  await page.clock.fastForward(121000);
  const alert = page.getByRole("region", { name: "Shared Google Docs document" }).getByRole("alert");
  await expect(alert).toContainText("did not finish within two minutes");
  await expect(frame).toHaveCount(0); await expect(select).toBeEnabled();
  await page.clock.fastForward(31000);
  await expect(alert).toContainText("did not finish within two minutes");
});

test("a stalled Google script times out with a visible error and allows retry", async ({ page }) => {
  await backend(page);
  await page.clock.install();
  await page.route("**/api/docs/status", route => route.fulfill({ json: { state: "document_selection_required", pending: 1, connection: { enabled: false, document_name: "Shared doc", document_url: "https://docs.google.com/document/d/test/edit" }, conflicts: [], entries: [] } }));
  await page.route("**/api/docs/picker", route => route.fulfill({ json: { access_token: "temporary-test-only", picker_key: "test-only", project_number: "123", document_id: "test" } }));
  await page.route("https://apis.google.com/js/api.js", () => {});
  await page.goto("/");
  const select = page.getByRole("button", { name: "Select shared Google Doc" });
  await select.click(); await expect(page.getByRole("button", { name: "Close Google Doc selection" })).toBeVisible();
  await page.clock.fastForward(16000);
  await expect(page.getByRole("region", { name: "Shared Google Docs document" }).getByRole("alert")).toContainText("script did not load within 15 seconds");
  await expect(page.getByRole("button", { name: "Close Google Doc selection" })).toHaveCount(0);
  await expect(select).toBeEnabled();
});

test("Google sign-in starts Supabase OAuth with the production return origin and no document scopes", async ({ page }) => {
  await backend(page, null);
  let requested = "";
  await page.route("https://fake-project.supabase.co/auth/v1/authorize**", route => { requested = route.request().url(); return route.fulfill({contentType:"text/html",body:"<h1>Google authentication handoff</h1>"}); });
  await page.goto("/");
  await expect(page.getByRole("button", {name:"Sign in with Google"})).toBeEnabled();
  await page.getByRole("button", {name:"Sign in with Google"}).click();
  await expect.poll(() => requested).not.toBe("");
  const url = new URL(requested);
  expect(url.searchParams.get("provider")).toBe("google");
  expect(url.searchParams.get("redirect_to")).toBe("http://127.0.0.1:3000");
  expect(url.searchParams.get("prompt")).toBe("select_account");
  expect(url.searchParams.get("scopes")).toBeNull();
});

test("Google sign-in accurately shows missing provider configuration", async ({ page }) => {
  await backend(page, null);
  await page.route("**/api/auth/providers", route => route.fulfill({json:{google:false,available:true}}));
  await page.goto("/");
  await expect(page.getByRole("button", {name:"Sign in with Google"})).toBeDisabled();
  await expect(page.getByText("Google sign-in setup is pending.")).toBeVisible();
});

test("Google Docs consent failure is shown without exposing provider details", async ({ page }) => {
  await backend(page);
  await page.goto("/?docs=authorization_failed");
  const panel = page.getByRole("region", {name:"Shared Google Docs document"});
  await expect(panel.getByRole("status")).toContainText("authorization was not completed");
  await expect(panel.getByRole("button", {name:"Connect Google Docs"})).toBeVisible();
  await expect(page).toHaveURL("http://127.0.0.1:3000/");
});

test("Google sign-in distinguishes provider outage from missing configuration", async ({ page }) => {
  await backend(page, null);
  await page.route("**/api/auth/providers", route => route.fulfill({json:{google:false,available:false}}));
  await page.goto("/");
  await expect(page.getByText("Google sign-in is temporarily unavailable.")).toBeVisible();
  await expect(page.getByRole("button", {name:"Sign in with Google"})).toBeDisabled();
});
