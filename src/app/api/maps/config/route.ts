import "server-only";
export const dynamic = "force-dynamic";
export function GET() {
  const key = process.env.NEXT_PUBLIC_AMAP_JS_KEY;
  if (!key || !process.env.AMAP_SECURITY_JSCODE || !process.env.APP_ORIGIN)
    return Response.json({ error: "MAP_NOT_CONFIGURED" }, { status: 503 });
  return Response.json({ key }, { headers: { "Cache-Control": "no-store" } });
}
