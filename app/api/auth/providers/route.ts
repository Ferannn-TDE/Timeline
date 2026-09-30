export async function GET() {
  try {
    const response = await fetch(process.env.NEXT_PUBLIC_SUPABASE_URL + "/auth/v1/settings", { headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY! }, cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw Error("Provider status unavailable");
    const settings = await response.json();
    return Response.json({ google: settings.external?.google === true, available: true }, { headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ google: false, available: false }, { headers: { "Cache-Control": "no-store" } }); }
}
