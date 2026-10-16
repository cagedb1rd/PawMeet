import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const quota = vi.hoisted(() => vi.fn(async () => {}));
const upstream = vi.hoisted(() => vi.fn(async () => "cb({status:'1'})"));
vi.mock("@/server/maps/quota", () => ({ reserveMapCall: quota }));
vi.mock("@/server/maps/http", () => ({ requestAMap: upstream }));
import { GET } from "@/app/%5FAMapService/[...path]/route";
import { GET as config } from "@/app/api/maps/config/route";
const context = {
  params: Promise.resolve({ path: ["v3", "place", "around"] }),
};
function setup() {
  vi.stubEnv("NEXT_PUBLIC_AMAP_JS_KEY", "unit-public-key");
  vi.stubEnv("AMAP_SECURITY_JSCODE", "unit-private-code");
  vi.stubEnv("APP_ORIGIN", "https://paw.test");
  return new Request(
    "https://paw.test/_AMapService/v3/place/around?callback=cb",
    { headers: { referer: "https://paw.test/discover" } },
  );
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("unconfigured map is 503; config never exposes the security code", async () => {
  vi.stubEnv("AMAP_SECURITY_JSCODE", "");
  expect(config().status).toBe(503);
  const request = setup();
  expect(await config().json()).toEqual({ key: "unit-public-key" });
  upstream.mockResolvedValueOnce("cb({status:'1'})");
  const response = await GET(request, context);
  expect(await response.text()).toBe("cb({status:'1'})");
  expect(upstream.mock.calls.length).toBe(1);
  expect(response.headers.get("cache-control")).toBe("no-store");
});
it("rejects foreign origin and path before quota or network", async () => {
  setup();
  expect(
    (
      await GET(
        new Request("https://paw.test/_AMapService/v3/place/around"),
        context,
      )
    ).status,
  ).toBe(403);
  const req = setup();
  expect(
    (await GET(req, { params: Promise.resolve({ path: ["v3", "evil"] }) }))
      .status,
  ).toBe(400);
  expect(upstream).not.toHaveBeenCalled();
  expect(quota).not.toHaveBeenCalled();
});
it("rate limits fail before upstream; errors and echoed secret never reach browser", async () => {
  const req = setup();
  upstream.mockResolvedValueOnce("unit-private-code");
  quota.mockRejectedValueOnce(new Error("MAP_RATE_LIMIT"));
  expect((await GET(req, context)).status).toBe(429);
  expect(upstream).not.toHaveBeenCalled();
  const response = await GET(req, context);
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("unit-private-code");
  upstream.mockRejectedValueOnce(new Error("sensitive upstream URL"));
  expect(await (await GET(req, context)).json()).toEqual({
    error: "MAP_UPSTREAM_FAILED",
  });
});
