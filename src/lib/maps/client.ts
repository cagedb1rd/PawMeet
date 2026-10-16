import { z } from "zod";
import { locationSchema, placeSchema, PlaceRef } from "@/domain/schemas";
import type { AMapSDK, LngLat, MapPoint, ServiceCallback } from "./contracts";

let loading: Promise<AMapSDK> | undefined;
export function loadAMap(): Promise<AMapSDK> {
  if (loading) return loading;
  loading = (async () => {
    const config = await fetch("/api/maps/config", {
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    const value = z
      .object({ key: z.string().min(1) })
      .safeParse(await config.json());
    if (!config.ok || !value.success)
      throw new Error("地图未配置或不可用，可继续使用本地列表和文字地点。");
    window._AMapSecurityConfig = {
      serviceHost: `${location.origin}/_AMapService`,
    };
    if (window.AMap) return window.AMap;
    return new Promise<AMapSDK>((resolve, reject) => {
      const script = document.createElement("script");
      const fail = () => {
        script.remove();
        reject(new Error("高德地图加载失败或超时，请检查网络与 Key 配置。"));
      };
      const timer = setTimeout(fail, 15000);
      script.src = `https://webapi.amap.com/maps?${new URLSearchParams({ v: "2.0", key: value.data.key, plugin: "AMap.PlaceSearch,AMap.Geocoder" })}`;
      script.async = true;
      script.onload = () => {
        clearTimeout(timer);
        if (window.AMap) resolve(window.AMap);
        else fail();
      };
      script.onerror = () => {
        clearTimeout(timer);
        fail();
      };
      document.head.appendChild(script);
    });
  })().catch((error) => {
    loading = undefined;
    throw error;
  });
  return loading;
}
export function pointFromLngLat(point: LngLat): MapPoint {
  return locationSchema.parse({
    lng: point.getLng(),
    lat: point.getLat(),
    crs: "GCJ02",
  });
}
function service<T>(
  start: (cb: ServiceCallback) => void,
  parse: (value: unknown) => T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("高德服务超时，请手动重试。")),
      15000,
    );
    start((status, result) => {
      clearTimeout(timer);
      if (status === "no_data") {
        try {
          resolve(parse({}));
        } catch {
          reject(new Error("没有可用地点信息"));
        }
        return;
      }
      if (status !== "complete") {
        const detail = z
          .object({ info: z.string().regex(/^[A-Z_]{1,80}$/) })
          .safeParse(result);
        reject(
          new Error(
            `高德服务失败${detail.success ? `（${detail.data.info}）` : ""}，请检查 Key、配额或网络后重试。`,
          ),
        );
        return;
      }
      try {
        resolve(parse(result));
      } catch {
        reject(new Error("高德返回数据格式无效，未采用该结果。"));
      }
    });
  });
}
const rawPoi = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(60),
  address: z.union([z.string(), z.array(z.string())]).optional(),
  adname: z.string().optional(),
  location: z.unknown(),
});
export async function searchPlaces(
  keyword: string,
  center: MapPoint,
): Promise<PlaceRef[]> {
  const sdk = await loadAMap();
  const q = z.string().trim().min(1).max(60).parse(keyword);
  locationSchema.parse(center);
  return service(
    (cb) =>
      new sdk.PlaceSearch({
        pageSize: 20,
        pageIndex: 1,
        extensions: "base",
      }).searchNearBy(q, [center.lng, center.lat], 5000, cb),
    (value) => {
      const result = z
        .object({
          poiList: z.object({ pois: z.array(rawPoi).max(20) }).optional(),
        })
        .parse(value);
      return (result.poiList?.pois ?? []).map((p) =>
        placeSchema.parse({
          source: "amap",
          poiId: p.id,
          name: p.name,
          address: typeof p.address === "string" ? p.address : "",
          district: p.adname || "公共地点",
          location: pointFromLngLat(p.location as LngLat),
          petAccess: "unknown",
        }),
      );
    },
  );
}
export async function reversePlace(point: MapPoint): Promise<PlaceRef> {
  const sdk = await loadAMap();
  locationSchema.parse(point);
  return service(
    (cb) =>
      new sdk.Geocoder({ extensions: "base" }).getAddress(
        [point.lng, point.lat],
        cb,
      ),
    (value) => {
      const result = z
        .object({
          regeocode: z.object({ formattedAddress: z.string().min(1).max(200) }),
        })
        .parse(value);
      return placeSchema.parse({
        source: "amap",
        name: "地图所选公共约定点",
        district: "地图选点",
        address: result.regeocode.formattedAddress,
        location: point,
        petAccess: "unknown",
      });
    },
  );
}
export async function normalizeGps(point: {
  lng: number;
  lat: number;
  crs: "WGS84";
}): Promise<MapPoint> {
  z.object({
    lng: z.number().min(-180).max(180),
    lat: z.number().min(-90).max(90),
    crs: z.literal("WGS84"),
  }).parse(point);
  const sdk = await loadAMap();
  return service(
    (cb) => sdk.convertFrom([point.lng, point.lat], "gps", cb),
    (value) => {
      const result = z
        .object({ locations: z.array(z.unknown()).min(1).max(1) })
        .parse(value);
      return pointFromLngLat(result.locations[0] as LngLat);
    },
  );
}
export function currentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation)
      return reject(new Error("浏览器不支持定位，请手动选点。"));
    navigator.geolocation.getCurrentPosition(
      resolve,
      (e) =>
        reject(
          new Error(
            e.code === 1
              ? "定位权限已拒绝；参考位置保持不变，可手动选点。"
              : "定位失败或超时；参考位置保持不变。",
          ),
        ),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 0 },
    );
  });
}
