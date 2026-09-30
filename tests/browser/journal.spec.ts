import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

type RecordRow = { id: string; photo_date: string; caption: string; image_key: string; author_email: string; created_at: string };
const image = readFileSync("tests/fixtures/portrait.png");
const initial: RecordRow = { id: "a", photo_date: "2025-06-15", caption: "Our recent memory", image_key: "recent.png", author_email: "feranmidyro@gmail.com", created_at: "2026-01-01T00:00:00Z" };

async function backend(page: Page, email: string | null = "feranmidyro@gmail.com", rows: RecordRow[] = [{ ...initial }]) {
  const user = { id: "11111111-1111-4111-8111-111111111111", email, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
  if (email) {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const token = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url") + "." + Buffer.from(JSON.stringify({ sub: user.id, email, exp: expires, role: "authenticated" })).toString("base64url") + ".test";
    await page.addInitScript(({ user, token, expires }) => localStorage.setItem("sb-fake-project-auth-token", JSON.stringify({ access_token: token, refresh_token: "test-refresh", expires_at: expires, expires_in: 3600, token_type: "bearer", user })), { user, token, expires });
  }
  const state = { rows, uploads: 0, deletes: 0, otps: 0, delayReads: false, cleanupError: false };
  await page.route("https://fake-project.supabase.co/**", async route => {
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
    if (method === "GET" && url.pathname.startsWith("/storage/v1/object/sign/")) return route.fulfill({ contentType: "image/png", body: image });
    if (method === "POST" && url.pathname.startsWith("/storage/v1/object/photo-journal/")) { state.uploads++; return reply({ Key: "photo-journal/new.png" }); }
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
