import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { deleteEntry } from "../../lib/journal";

test("real browser workflow shared by both approved editors", async ({ browser }) => {
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
    await kiera.locator("article").filter({ has: kiera.getByRole("button", { name: "Save", exact: true }) }).getByLabel("Caption", { exact: true }).fill(marker + " edited by Kiera");
    await kiera.getByRole("button", { name: "Save", exact: true }).click();
    await expect(kiera.locator(".entrycaption").filter({ hasText: marker + " edited by Kiera" })).toBeVisible();
    await feran.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(feran.locator(".entrycaption").filter({ hasText: marker + " edited by Kiera" })).toBeVisible();
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
