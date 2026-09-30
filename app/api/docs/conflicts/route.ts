import { editor, serviceDb, safeError, HttpError } from "@/lib/docs/server";

export async function POST(request: Request) {
  try {
    await editor(request);
    const body = await request.json();
    if (!/^[0-9a-f-]{36}$/i.test(body.entry_id || "") || !["document", "website"].includes(body.choice)) throw new HttpError(400, "Choose an entry and the version you want to keep.");
    const db = serviceDb();
    const current = await db.from("docs_sync_conflicts").select("document_hash,desired_hash").eq("entry_id", body.entry_id).maybeSingle();
    if (current.error) throw current.error;
    if (!current.data || current.data.document_hash !== body.document_hash || current.data.desired_hash !== body.desired_hash) throw new HttpError(409, "This conflict changed. Reload it before choosing a version.");
    let query = db.from("docs_sync_conflicts").update({ resolution: { choice: body.choice, document_hash: current.data.document_hash, desired_hash: current.data.desired_hash } }).eq("entry_id", body.entry_id).eq("desired_hash", body.desired_hash);
    query = current.data.document_hash === null ? query.is("document_hash", null) : query.eq("document_hash", current.data.document_hash);
    const resolution = await query.select("entry_id");
    if (resolution.error || resolution.data?.length !== 1) throw new HttpError(409, "The conflict changed while you were reviewing it. Reload and retry.");
    // Some conflicts originate from unknown tagged pages and have no outbox event.
    const event = await db.from("docs_sync_events").insert({ entry_id: body.entry_id, operation: "upsert" });
    if (event.error) throw event.error;
    return Response.json({ state: "pending" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return safeError(error); }
}
