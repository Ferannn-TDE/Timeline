import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { deleteEntry } from "../../lib/journal";

test("production sign-in form uses the correct redirect and reports email service limits", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to Moments" })).toBeVisible();
  for (const email of ["feranmidyro@gmail.com", "kieragreen50@gmail.com"]) {
    await page.getByLabel("Email address").fill(email);
    const sent = page.waitForResponse(response => response.url().includes("/auth/v1/otp"));
    await page.getByRole("button", { name: "Send sign-in link" }).click();
    const response = await sent;
    expect(new URL(response.url()).searchParams.get("redirect_to")).toBe(process.env.LIVE_BASE_URL);
    if (response.status() === 429) {
      const error = await response.json();
      expect(error.code).toBe("over_email_send_rate_limit");
      await expect(page.locator(".notice[role=alert]")).toHaveText(error.msg || error.message);
      console.log("LIMITATION: Sign-in email throttled for " + email + ": " + (error.msg || error.message));
    } else {
      expect(response.status()).toBe(200);
      await expect(page.getByRole("status")).toHaveText("Check your email for a sign-in link.");
    }
    await expect(page.getByRole("button", { name: "Send sign-in link" })).toBeEnabled();
  }
});

test("real browser workflow shared by both approved editors", async ({ browser }) => {
  // Signing out revokes the prior fixture session; every run needs a fresh one.
  execFileSync(process.execPath, ["scripts/create-test-sessions.mjs"], { stdio: "inherit" });
  const first = JSON.parse(readFileSync(".credentials/sessions/feranmidyro@gmail.com.json", "utf8"));
  const second = JSON.parse(readFileSync(".credentials/sessions/kieragreen50@gmail.com.json", "utf8"));
  const marker = "Browser verification " + crypto.randomUUID();
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  await contextA.addInitScript(session => localStorage.setItem("sb-rnilakqmyanujehtqbuk-auth-token", JSON.stringify(session)), first);
  await contextB.addInitScript(session => localStorage.setItem("sb-rnilakqmyanujehtqbuk-auth-token", JSON.stringify(session)), second);
  const feran = await contextA.newPage();
  const kiera = await contextB.newPage();
  const errors: string[] = [];
  for (const page of [feran, kiera]) page.on("pageerror", error => errors.push(error.message));
  const keys = JSON.parse(readFileSync(".credentials/supabase-keys.json", "utf8"));
  const db = createClient("https://rnilakqmyanujehtqbuk.supabase.co", keys.find((item: { type: string }) => item.type === "publishable").api_key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: sessionError } = await db.auth.setSession(first);
  if (sessionError) throw sessionError;
  try {
    await feran.goto("/");
    await expect(feran.getByRole("heading", { name: "Add a memory" })).toBeVisible();
    for (const [date, caption] of [["2026-09-01", marker + " recent"], ["2010-05-12", marker + " older"]]) {
      await feran.locator('input[type="file"]').setInputFiles("tests/fixtures/portrait.png");
      await feran.getByLabel("Date of photo").fill(date);
      await feran.getByLabel("Caption", { exact: true }).fill(caption);
      await feran.getByRole("button", { name: "Add to timeline" }).click();
      await expect(feran.locator(".entrycaption").filter({ hasText: caption })).toBeVisible();
    }
    const captions = await feran.locator(".entrycaption").allTextContents();
    expect(captions.filter(caption => caption.startsWith(marker))).toEqual([marker + " recent", marker + " older"]);
    await kiera.goto("/");
    await expect(kiera.locator(".entrycaption").filter({ hasText: marker })).toHaveCount(2);
    const older = kiera.locator("article").filter({ hasText: marker + " older" });
    const image = older.locator("img");
    await expect(image).toHaveJSProperty("naturalHeight", 600);
    expect(await image.evaluate(node => getComputedStyle(node).objectFit)).toBe("contain");
    await older.getByRole("button", { name: "Edit", exact: true }).click();
    await kiera.locator("article").filter({ has: kiera.getByRole("button", { name: "Save", exact: true }) }).getByLabel("Date", { exact: true }).fill("2026-09-02");
    await kiera.locator("article").filter({ has: kiera.getByRole("button", { name: "Save", exact: true }) }).getByLabel("Caption", { exact: true }).fill(marker + " edited by Kiera");
    await kiera.getByRole("button", { name: "Save", exact: true }).click();
    await expect(kiera.locator(".entrycaption").filter({ hasText: marker + " edited by Kiera" })).toBeVisible();
    await feran.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(feran.locator(".entrycaption").filter({ hasText: marker + " edited by Kiera" })).toBeVisible();
    expect((await feran.locator(".entrycaption").allTextContents()).filter(caption => caption.startsWith(marker))).toEqual([marker + " edited by Kiera", marker + " recent"]);
    feran.on("dialog", dialog => dialog.accept());
    for (const caption of [marker + " recent", marker + " edited by Kiera"]) {
      await feran.locator("article").filter({ hasText: caption }).getByRole("button", { name: "Remove", exact: true }).click();
      await expect(feran.locator(".entrycaption").filter({ hasText: caption })).toHaveCount(0);
    }
    await kiera.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(kiera.locator(".entrycaption").filter({ hasText: marker })).toHaveCount(0);
    await feran.getByRole("button", { name: "Sign out" }).click();
    await expect(feran.getByRole("heading", { name: "Sign in to Moments" })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    const { data: remaining, error } = await db.from("entries").select("*").like("caption", marker + "%");
    if (error) throw error;
    for (const row of remaining || []) {
      const warning = await deleteEntry(db, row);
      if (warning) throw Error(warning);
    }
    await contextA.close();
    await contextB.close();
  }
});
