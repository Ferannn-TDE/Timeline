// Operator-only activation; the browser cannot bypass acceptance or enable writes.
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
const report = JSON.parse(await readFile(".credentials/docs-acceptance/report.json", "utf8"));
if (report.automated !== "passed" || report.both_editor_permissions !== "passed" || report.actual_google_signins !== "passed" || report.rendered_layout !== "passed" || report.original_id !== "1gGFlT4q6OKSKakkEt25Wl5Yk78-VJCpIuUGuQ8qO8ws") throw Error("Live temporary-document, Google login, layout and sharing checks must pass before activation.");
const key = (await readFile(".credentials/SUPABASE_SERVICE_ROLE_KEY", "utf8")).trim();
const db = createClient("https://rnilakqmyanujehtqbuk.supabase.co", key, { auth: { persistSession: false } });
const updated = await db.from("docs_connections").update({ enabled: true, tested_at: report.tested_at, state: "connected", last_error: null }).eq("id", report.connection_id).eq("document_id", report.original_id).eq("enabled", false).select("id");
if (updated.error || updated.data?.length !== 1) throw Error("Connection changed; repeat its inspection before activation.");
console.log("Google Docs syncing enabled. A real production journal update must still be observed in the supplied document before claiming completion.");
