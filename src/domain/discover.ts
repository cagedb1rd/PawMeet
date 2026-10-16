import { z } from "zod";
import { DemoState, interests, temperaments } from "./schemas";
import { distanceMeters } from "./geo";
import type { MapPoint } from "@/lib/maps/contracts";

export const discoverFilterSchema = z.strictObject({
  radiusKm: z.union([z.literal(1), z.literal(3), z.literal(5), z.literal(10)]),
  search: z.string().trim().max(100),
  breeds: z.array(z.string().max(30)).max(8),
  sizes: z.array(z.enum(["small", "medium", "large", "unknown"])).max(4),
  temperaments: z.array(z.enum(temperaments)).max(8),
  activities: z.array(z.enum(interests)).max(8),
});
export type DiscoverFilters = z.infer<typeof discoverFilterSchema>;
export const defaultFilters: DiscoverFilters = {
  radiusKm: 5,
  search: "",
  breeds: [],
  sizes: [],
  temperaments: [],
  activities: [],
};
/** The sole candidate query for map, list, and future AI query intents. */
export function discoverQuery(
  state: DemoState,
  reference: MapPoint,
  input: DiscoverFilters,
) {
  const f = discoverFilterSchema.parse(input);
  return state.pets
    .filter((p) => !p.archivedAt && p.ownerId !== state.activeUserId)
    .map((pet) => ({
      pet,
      distanceM: distanceMeters(reference, pet.demoLocation),
    }))
    .filter(
      ({ pet: p, distanceM }) =>
        distanceM <= f.radiusKm * 1000 &&
        `${p.name} ${p.breed} ${p.district}`.includes(f.search) &&
        (!f.breeds.length || f.breeds.includes(p.breed)) &&
        (!f.sizes.length || f.sizes.includes(p.size)) &&
        (!f.temperaments.length ||
          p.temperamentTags.some((t) => f.temperaments.includes(t))) &&
        (!f.activities.length ||
          p.activityTags.some((t) => f.activities.includes(t))),
    )
    .sort(
      (a, b) => a.distanceM - b.distanceM || a.pet.id.localeCompare(b.pet.id),
    );
}
