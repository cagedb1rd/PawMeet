import { locationSchema } from "./schemas";
import type { MapPoint } from "@/lib/maps/contracts";

export const DEFAULT_REFERENCE: MapPoint = {
  lng: 120.206,
  lat: 30.212,
  crs: "GCJ02",
};

/** Approximate great-circle distance on normalized GCJ-02 points, in meters. */
export function distanceMeters(a: MapPoint, b: MapPoint) {
  locationSchema.parse(a);
  locationSchema.parse(b);
  const rad = (n: number) => (n * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) *
      Math.cos(rad(b.lat)) *
      Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}
export function formatDistance(meters: number) {
  return meters < 100
    ? "约 100 米内"
    : meters < 1000
      ? `约 ${Math.round(meters / 100) * 100} 米`
      : `约 ${(meters / 1000).toFixed(1)} 公里`;
}
