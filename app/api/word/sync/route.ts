import { editor, serviceDb, safeError } from "@/lib/word/server";
import { syncWord } from "@/lib/word/worker";

export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    await editor(request);
    const body = await request.json().catch(() => ({}));
    if (body.retry === true) {
      const result = await serviceDb().from("word_sync_events").update({ attempts: 0, status: "pending" }).eq("status", "failed");
      if (result.error) throw result.error;
    }
    return Response.json(await syncWord(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return safeError(error); }
}
