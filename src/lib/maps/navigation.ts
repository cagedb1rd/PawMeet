import { PlaceRef, placeSchema } from "@/domain/schemas";

export function navigationUrl(input: PlaceRef): string | null {
  const p = placeSchema.parse(input);
  if (!p.location) return null;
  const url = new URL("https://uri.amap.com/navigation");
  url.search = new URLSearchParams({
    to: `${p.location.lng},${p.location.lat},${p.name}`,
    mode: "walk",
    src: "PawMeet",
    callnative: "1",
  }).toString();
  return url.href;
}
