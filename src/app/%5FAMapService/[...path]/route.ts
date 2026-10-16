import "server-only";
import { proxyTarget, sameMapOrigin } from "@/lib/maps/proxy";
import { reserveMapCall } from "@/server/maps/quota";
import { requestAMap } from "@/server/maps/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const key = process.env.NEXT_PUBLIC_AMAP_JS_KEY,
    code = process.env.AMAP_SECURITY_JSCODE,
    origin = process.env.APP_ORIGIN;
  const fail = (error: string, status: number) =>
    Response.json(
      { error },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  if (!key || !code || !origin) return fail("MAP_NOT_CONFIGURED", 503);
  if (!sameMapOrigin(request, origin)) return fail("MAP_ORIGIN_DENIED", 403);
  let target: URL;
  try {
    target = proxyTarget(
      (await context.params).path,
      new URL(request.url).searchParams,
      key,
      code,
    );
  } catch {
    return fail("MAP_REQUEST_DENIED", 400);
  }
  try {
    await reserveMapCall();
  } catch (e) {
    return fail(
      e instanceof Error && e.message === "MAP_RATE_LIMIT"
        ? "MAP_RATE_LIMIT"
        : "MAP_QUOTA_UNAVAILABLE",
      e instanceof Error && e.message === "MAP_RATE_LIMIT" ? 429 : 503,
    );
  }
  try {
    const body = await requestAMap(target, origin);
    if (body.includes(code)) return fail("MAP_RESPONSE_REJECTED", 502);
    return new Response(body, {
      headers: {
        "Content-Type": target.searchParams.has("callback")
          ? "application/javascript; charset=utf-8"
          : "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "MAP_UPSTREAM_TIMEOUT")
      return fail(error.message, 504);
    if (
      error instanceof Error &&
      /^MAP_UPSTREAM_HTTP_\d{3}$/.test(error.message)
    )
      return fail(error.message, 502);
    return fail("MAP_UPSTREAM_FAILED", 502);
  }
}
