import { afterEach, describe, expect, it, vi } from "vitest";
import { createSeed, demoPlaces } from "@/data/seed";
import {
  DEFAULT_REFERENCE,
  distanceMeters,
  formatDistance,
} from "@/domain/geo";
import { defaultFilters, discoverQuery } from "@/domain/discover";
import {
  activityInputSchema,
  placeSchema,
  stateSchema,
} from "@/domain/schemas";
import { navigationUrl } from "@/lib/maps/navigation";
import { proxyTarget, sameMapOrigin } from "@/lib/maps/proxy";
import type { MapPoint } from "@/lib/maps/contracts";

describe("Phase 3 distance and shared discovery", () => {
  const point = (lng: number, lat: number): MapPoint => ({
    lng,
    lat,
    crs: "GCJ02",
  });
  it("zero, symmetry, known great-circle distance and date-line", () => {
    expect(distanceMeters(DEFAULT_REFERENCE, DEFAULT_REFERENCE)).toBe(0);
    const a = point(0, 0),
      b = point(1, 0);
    expect(distanceMeters(a, b)).toBeCloseTo(111195.08, 1);
    expect(distanceMeters(a, b)).toBe(distanceMeters(b, a));
    expect(distanceMeters(point(179, 0), point(-179, 0))).toBeCloseTo(
      222390.16,
      1,
    );
  });
  it("rejects WGS84, NaN and out-of-range instead of mixing systems", () => {
    expect(() =>
      distanceMeters(
        { ...DEFAULT_REFERENCE, crs: "WGS84" } as unknown as MapPoint,
        DEFAULT_REFERENCE,
      ),
    ).toThrow();
    expect(() => distanceMeters(point(NaN, 30), DEFAULT_REFERENCE)).toThrow();
    expect(() => distanceMeters(point(190, 30), DEFAULT_REFERENCE)).toThrow();
  });
  it("inclusive radius uses unrounded distance; ties sort by ID", () => {
    const state = createSeed();
    const offset = ((1000 / 6371008.8) * 180) / Math.PI;
    state.pets[1].demoLocation = point(0, offset - 1e-10);
    state.pets[2].demoLocation = point(0, offset + 1e-10);
    state.pets[3].demoLocation = point(0, offset - 1e-10);
    const found = discoverQuery(state, point(0, 0), {
      ...defaultFilters,
      radiusKm: 1,
    });
    expect(found.map((r) => r.pet.id)).toEqual(["pet-2", "pet-4"]);
    state.pets[1].demoLocation = point(0, 0);
    expect(
      discoverQuery(state, point(0, 0), { ...defaultFilters, radiusKm: 1 })[0]
        .distanceM,
    ).toBe(0);
  });
  it("all four radii are nested; excludes own and archived pets", () => {
    const state = createSeed();
    state.pets[3].archivedAt = new Date().toISOString();
    const groups = ([1, 3, 5, 10] as const).map((radiusKm) =>
      discoverQuery(state, DEFAULT_REFERENCE, { ...defaultFilters, radiusKm }),
    );
    expect(groups[0].length).toBeGreaterThan(0);
    expect(new Set(groups.map((g) => g.length)).size).toBe(4);
    for (let i = 0; i < groups.length; i++) {
      expect(
        groups[i].every(
          (r) => r.pet.ownerId !== state.activeUserId && !r.pet.archivedAt,
        ),
      ).toBe(true);
      if (i)
        expect(
          groups[i - 1].every((r) =>
            groups[i].some((v) => v.pet.id === r.pet.id),
          ),
        ).toBe(true);
      expect(groups[i].map((r) => r.distanceM)).toEqual(
        groups[i].map((r) => r.distanceM).sort((a, b) => a - b),
      );
    }
  });
  it("OR within category and AND across categories; no invented unknown preferences", () => {
    const state = createSeed();
    const f = {
      ...defaultFilters,
      radiusKm: 10 as const,
      breeds: ["柯基", "金毛"],
      temperaments: ["温和" as const],
      activities: ["散步" as const],
    };
    const result = discoverQuery(state, DEFAULT_REFERENCE, f);
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((r) => r.pet.breed === "金毛")).toBe(true);
    expect(
      discoverQuery(state, DEFAULT_REFERENCE, { ...f, activities: ["接飞盘"] }),
    ).toEqual([]);
    expect(
      discoverQuery(state, DEFAULT_REFERENCE, { ...f, sizes: ["small"] }),
    ).toEqual([]);
    expect(() =>
      discoverQuery(state, DEFAULT_REFERENCE, { ...f, radiusKm: 2 } as never),
    ).toThrow();
    expect(
      discoverQuery(state, DEFAULT_REFERENCE, {
        ...defaultFilters,
        search: "不存在",
      }),
    ).toEqual([]);
  });
  it("seed coordinates match fictional areas; queries do not mutate persisted state", () => {
    const state = createSeed(),
      original = structuredClone(state);
    expect(state.pets).toHaveLength(25);
    discoverQuery(state, DEFAULT_REFERENCE, defaultFilters);
    expect(state).toEqual(original);
    expect(formatDistance(20)).toBe("约 100 米内");
    expect(formatDistance(1320)).toBe("约 1.3 公里");
  });
});
describe("Place contract and navigation", () => {
  it("old v2 snapshots still parse without rewriting places", () => {
    expect(stateSchema.parse(createSeed()).activities[0].place).toEqual(
      demoPlaces[0],
    );
  });
  it("manual text has no invented coordinates and cannot navigate", () => {
    const p = placeSchema.parse({
      source: "manual",
      name: "公园南门",
      district: "手动约定",
      location: null,
      petAccess: "unknown",
    });
    expect(navigationUrl(p)).toBeNull();
    expect(placeSchema.safeParse({ ...p, source: "amap" }).success).toBe(false);
    expect(placeSchema.safeParse({ ...p, petAccess: "verified" }).success).toBe(
      false,
    );
  });
  it("navigation encodes destination only, including Chinese and special characters", () => {
    const url = new URL(
      navigationUrl({ ...demoPlaces[0], name: "草地 & 咖啡,公共门" })!,
    );
    expect(url.origin + url.pathname).toBe("https://uri.amap.com/navigation");
    expect(url.searchParams.get("to")).toBe(
      "120.189,30.174,草地 & 咖啡,公共门",
    );
    expect(url.searchParams.has("from")).toBe(false);
    expect(url.searchParams.get("mode")).toBe("walk");
    const input = createSeed().activities[0];
    const {
      title,
      description,
      organizerPetId,
      recommendedPetIds,
      startAt,
      endAt,
      capacity,
    } = input;
    expect(
      activityInputSchema.parse({
        title,
        description,
        organizerPetId,
        recommendedPetIds,
        startAt,
        endAt,
        capacity,
        place: { ...input.place, source: "amap", poiId: "B01" },
      }).place.source,
    ).toBe("amap");
  });
});
describe("Map proxy boundary", () => {
  it("retains exactly two SDK s parameters, denies a third", () => {
    const path = ["v3", "place", "around"];
    expect(
      proxyTarget(
        path,
        new URLSearchParams("s=a&s=b&children=1&antiCrab=x&type_="),
        "k",
        "c",
      ).searchParams.getAll("s"),
    ).toEqual(["a", "b"]);
    expect(() =>
      proxyTarget(path, new URLSearchParams("s=a&s=b&s=c"), "k", "c"),
    ).toThrow();
  });
  it("fixed host/path and server credentials override untrusted query", () => {
    const url = proxyTarget(
      ["v3", "place", "around"],
      new URLSearchParams(
        "key=client&key=again&jscode=bad&callback=AMap._cb1&offset=20",
      ),
      "server-key",
      "server-code",
    );
    expect(url.origin).toBe("https://restapi.amap.com");
    expect(url.searchParams.get("jscode")).toBe("server-code");
    expect(url.searchParams.get("key")).toBe("server-key");
  });
  it.each([
    "https://evil.test",
    "v3/place/text",
    "v3/../place/around",
    "v4/map/styles",
  ])("denies unexpected path %s", (path) => {
    expect(() =>
      proxyTarget(path.split("/"), new URLSearchParams(), "k", "c"),
    ).toThrow();
  });
  it.each([
    "url=https://evil.test",
    "callback=x);alert(1)",
    "offset=21",
    "page=2",
    "radius=5001",
    "keywords=a&keywords=b",
    "batch=true",
  ])("denies excessive/unsafe parameters %s", (params) => {
    expect(() =>
      proxyTarget(
        ["v3", "place", "around"],
        new URLSearchParams(params),
        "k",
        "c",
      ),
    ).toThrow();
  });
  it("requires exact configured source; forged client IP gives no trust", () => {
    const request = (headers: Record<string, string>) =>
      new Request("https://paw.test/_AMapService/v3/place/around", { headers });
    expect(
      sameMapOrigin(
        request({ referer: "https://paw.test/discover" }),
        "https://paw.test",
      ),
    ).toBe(true);
    expect(
      sameMapOrigin(
        request({
          referer: "https://evil.test/",
          "x-forwarded-for": "127.0.0.1",
        }),
        "https://paw.test",
      ),
    ).toBe(false);
    expect(sameMapOrigin(request({}), "https://paw.test")).toBe(false);
    expect(
      sameMapOrigin(
        request({ origin: "https://paw.test", "sec-fetch-site": "cross-site" }),
        "https://paw.test",
      ),
    ).toBe(false);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
it("GPS conversion uses official gps converter exactly once; failed conversion is visible", async () => {
  const convert = vi.fn((_point, _type, cb) =>
    cb("complete", {
      locations: [{ getLng: () => 120.21, getLat: () => 30.21 }],
    }),
  );
  vi.stubGlobal("window", { AMap: { convertFrom: convert } });
  vi.stubGlobal("location", { origin: "http://localhost:3103" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ key: "unit-test-only" })),
  );
  const { normalizeGps } = await import("@/lib/maps/client");
  expect(await normalizeGps({ lng: 120.2, lat: 30.2, crs: "WGS84" })).toEqual({
    lng: 120.21,
    lat: 30.21,
    crs: "GCJ02",
  });
  expect(convert).toHaveBeenCalledWith(
    [120.2, 30.2],
    "gps",
    expect.any(Function),
  );
  expect(convert).toHaveBeenCalledTimes(1);
  convert.mockImplementationOnce((_p, _t, cb) => cb("error", {}));
  await expect(
    normalizeGps({ lng: 120.2, lat: 30.2, crs: "WGS84" }),
  ).rejects.toThrow("高德服务失败");
});
