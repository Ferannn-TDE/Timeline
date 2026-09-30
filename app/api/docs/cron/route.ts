import { safeError, sameSecret, HttpError } from "@/lib/docs/server";
import { syncDocs } from "@/lib/docs/worker";

export const maxDuration = 60;
async function run(request: Request) {
  try {
    const expected = process.env.CRON_SECRET;
    if (!expected || !sameSecret(request.headers.get("authorization") || "", "Bearer " + expected)) throw new HttpError(401, "Invalid synchronization authorization.");
    return Response.json(await syncDocs(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return safeError(error); }
}
export const GET = run;
export const POST = run;
