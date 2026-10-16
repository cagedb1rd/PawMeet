import { DemoState, Pet } from "./schemas";
import { defaultFilters, discoverQuery } from "./discover";
import { comparePets } from "./social";
import { MatchIntent, matchIntentSchema } from "@/lib/ai/contracts";
import { MapPoint } from "@/lib/maps/contracts";
export function preferenceScore(
  state: DemoState,
  own: Pet | undefined,
  pet: Pet,
  distanceM: number,
) {
  const reasons: string[] = [];
  if (!own) return { score: 0, reasons: ["请先选择本人宠物，偏好信息不足"] };
  const shared = own.activityTags.filter((t) => pet.activityTags.includes(t));
  const union = new Set([...own.activityTags, ...pet.activityTags]).size;
  const activity = union ? (shared.length / union) * 45 : 0;
  if (shared.length)
    reasons.push(`共同活动：${shared.join("、")}（${Math.round(activity)}分）`);
  const conflicts = comparePets(state, own, pet).conflicts;
  const known =
    own.temperamentTags.length > 0 && pet.temperamentTags.length > 0;
  const temperament =
    known &&
    !conflicts.length &&
    own.temperamentTags.some((t) => pet.temperamentTags.includes(t))
      ? 30
      : 0;
  if (temperament) reasons.push("有相同性格标签，未识别完整词条冲突（30分）");
  reasons.push(...conflicts);
  const size = own.size !== "unknown" && own.size === pet.size ? 15 : 0;
  if (size) reasons.push("体型相同（15分）");
  const proximity = Math.max(0, 1 - distanceM / 10000) * 10;
  reasons.push(`距离项（${Math.round(proximity)}分）`);
  if (!known || !union || own.size === "unknown" || pet.size === "unknown")
    reasons.push("部分偏好信息不足，未知项计0分");
  return {
    score: Math.round(activity + temperament + size + proximity),
    reasons,
  };
}
export function matchQuery(
  state: DemoState,
  reference: MapPoint,
  input: MatchIntent,
  ownId?: string,
) {
  const f = matchIntentSchema.parse(input);
  if (f.clarifications.length || f.unmappedTerms.length)
    throw Error("筛选条件需要澄清，请修改描述后重试");
  const own = state.pets.find(
    (p) => p.id === ownId && p.ownerId === state.activeUserId && !p.archivedAt,
  );
  return discoverQuery(state, reference, {
    ...defaultFilters,
    radiusKm: f.radiusKm ?? 5,
    search: f.district ?? "",
    breeds: f.breeds,
    sizes: f.sizes,
    temperaments: f.temperaments,
    activities: f.activities,
  })
    .filter(
      ({ pet }) =>
        !f.excludedSizes.includes(pet.size) &&
        !f.excludedBreeds.includes(pet.breed) &&
        !pet.temperamentTags.some((t) => f.excludedTemperaments.includes(t)) &&
        !pet.activityTags.some((t) => f.excludedActivities.includes(t)),
    )
    .map((row) => ({
      ...row,
      ...preferenceScore(state, own, row.pet, row.distanceM),
    }))
    .sort(
      (a, b) =>
        (f.sort === "match" ? b.score - a.score : 0) ||
        a.distanceM - b.distanceM ||
        a.pet.id.localeCompare(b.pet.id),
    );
}
export function comparisonEvidence(state: DemoState, a: Pet, b: Pet) {
  const rule = comparePets(state, a, b);
  const facts = [
    ...a.activityTags
      .filter((t) => b.activityTags.includes(t))
      .map((t) => `共同活动：${t}`),
    ...rule.conflicts,
    `性格：${a.name} ${a.temperamentTags.join("、") || "未知"}；${b.name} ${b.temperamentTags.join("、") || "未知"}`,
    `体型：${a.size} / ${b.size}`,
    ...rule.advice,
    ...(rule.incomplete ? ["至少一份有效名片缺失，信息不足"] : []),
  ];
  return facts.map((fact, i) => ({ code: `E${i + 1}`, fact }));
}
