import { z } from "zod";
import { resolveAvailability } from "./availability";
import {
  DemoState,
  PlaceRef,
  placeSchema,
  activityInputSchema,
} from "@/domain/schemas";
import { matchQuery } from "@/domain/matching";
import { comparePets } from "@/domain/social";
import { distanceMeters } from "@/domain/geo";
import { MapPoint } from "@/lib/maps/contracts";
import { searchPlaces } from "@/lib/maps/client";
import {
  CompanionIntent,
  ToolCall,
  ToolResult,
  companionIntentSchema,
  activityDraftToolSchema,
  toolSchemas,
  toolResultSchema,
} from "./contracts";
import { parseToolArguments } from "./tools";
import { WALK_WORDS, isWalkingType } from "./synonyms";

export type WorkflowPhase =
  | "idle"
  | "extracting"
  | "clarifying"
  | "searching"
  | "recommendations"
  | "organizing"
  | "draft"
  | "error";
export const WORKFLOW_LIMITS = { rounds: 4, calls: 9, results: 5 } as const;
export function confirmedIntent(input: CompanionIntent, now = new Date()) {
  const i = companionIntentSchema.parse(input);
  if (!i.startAt || !i.endAt)
    throw Error("请确认具体日期及起止时间（北京时间）");
  if (
    Date.parse(i.startAt) <= now.getTime() ||
    Date.parse(i.endAt) <= Date.parse(i.startAt)
  )
    throw Error("起止时间无效或已经过去");
  if (i.match.clarifications.length || i.match.unmappedTerms.length)
    throw Error("请先澄清无法识别或冲突的筛选条件");
  return i;
}
export function queryIntent(input: CompanionIntent, now = new Date()) {
  const i = companionIntentSchema.parse(input);
  if (i.match.clarifications.length || i.match.unmappedTerms.length)
    throw Error("还有硬条件需要确认，请修改下方条件或需求描述");
  resolveAvailability(i, now);
  return i;
}
/** A radius-only edit is explicit consent; every other confirmed condition is retained. */
export function radiusEdit(
  text: string,
  intent: CompanionIntent,
): CompanionIntent | null {
  const m = text
    .trim()
    .match(
      /^(?:扩大到|缩小到|改为|改到|范围改为)\s*([135]|10|一|三|五|十)\s*公里[。！]?$/,
    );
  if (!m) return null;
  const n =
    ({ 一: 1, 三: 3, 五: 5, 十: 10 } as Record<string, number>)[m[1]] ??
    Number(m[1]);
  return companionIntentSchema.parse({
    ...intent,
    match: { ...intent.match, radiusKm: n },
  });
}
export function activityRecommendations(
  state: DemoState,
  reference: MapPoint,
  intent: CompanionIntent,
  now = new Date(),
): ToolResult {
  const i = queryIntent(intent, now),
    f = i.match;
  const availability = resolveAvailability(i, now);
  const rows = state.activities
    .filter(
      (a) => a.status === "scheduled" && Date.parse(a.startAt) > now.getTime(),
    )
    .flatMap((a) => {
      const joined = state.activitySignups.filter(
        (s) => s.activityId === a.id && s.status === "joined",
      );
      const remaining = Math.max(0, a.capacity - joined.length);
      const distanceM = a.place.location
        ? distanceMeters(reference, a.place.location)
        : null;
      const participants = joined
        .map((s) => state.pets.find((p) => p.id === s.petId))
        .filter((p) => !!p);
      if (
        !remaining ||
        distanceM === null ||
        distanceM > (f.radiusKm ?? 5) * 1000 ||
        !availability.windows.some(
          (w) =>
            Date.parse(a.startAt) >= Date.parse(w.startAt) &&
            Date.parse(a.endAt) <= Date.parse(w.endAt),
        ) ||
        (f.district && a.place.district !== f.district) ||
        participants.some(
          (p) =>
            f.excludedSizes.includes(p.size) ||
            (f.excludedSizes.length > 0 && p.size === "unknown") ||
            (f.excludedBreeds.length > 0 && p.breed === "未知") ||
            f.excludedBreeds.includes(p.breed) ||
            p.temperamentTags.some((t) => f.excludedTemperaments.includes(t)) ||
            p.activityTags.some((t) => f.excludedActivities.includes(t)),
        ) ||
        ((f.excludedSizes.length ||
          f.excludedBreeds.length ||
          f.excludedTemperaments.length ||
          f.excludedActivities.length) &&
          participants.length !== joined.length)
      )
        return [];
      const content = `${a.title}\n${a.description}`;
      const activityMatches =
        !i.activityType ||
        (isWalkingType(i.activityType)
          ? WALK_WORDS.test(content)
          : content.includes(i.activityType));
      // Unverifiable explicit hard constraints never become a partial recommendation.
      if (!activityMatches || i.hardRequirements.length > 0) return [];
      if (f.sizes.length && participants.some((p) => !f.sizes.includes(p.size)))
        return [];
      if (
        f.breeds.length &&
        participants.some((p) => !f.breeds.includes(p.breed))
      )
        return [];
      const differences = [
        ...i.preferences.map((t) => `偏好“${t}”未核实`),
        "场地宠物准入未核实",
      ];
      if (
        f.temperaments.length &&
        !participants.every((p) =>
          f.temperaments.every((t) => p.temperamentTags.includes(t)),
        )
      )
        differences.push("部分参与宠物性格偏好未满足");
      if (
        f.activities.length &&
        !participants.every((p) =>
          f.activities.some((t) => p.activityTags.includes(t)),
        )
      )
        differences.push("部分参与宠物活动偏好未满足");
      return [
        {
          id: a.id,
          title: a.title,
          district: a.place.district,
          startAt: a.startAt,
          endAt: a.endAt,
          distanceM,
          remaining,
          reasons: [
            "时间、距离及已知硬约束符合",
            "仍有报名名额；以详情当前状态为准",
          ],
          differences,
        },
      ];
    })
    .sort(
      (a, b) =>
        a.differences.length - b.differences.length ||
        a.distanceM - b.distanceM ||
        a.id.localeCompare(b.id),
    )
    .slice(0, 5);
  return toolResultSchema.parse({ kind: "activities", rows });
}
export type CompanionCache = {
  pets?: Extract<ToolResult, { kind: "pets" }>;
  places?: PlaceRef[];
  compatibility?: string[];
  draft?: z.infer<typeof activityDraftToolSchema>;
};
const failed = (
  code: "INVALID_ARGUMENTS" | "TOOL_FAILED" | "NEEDS_CLARIFICATION" | "TIMEOUT",
  message: string,
): ToolResult => ({ kind: "error", code, message: message.slice(0, 200) });
export async function executeCompanionTool(
  call: ToolCall,
  state: DemoState,
  reference: MapPoint,
  ownId: string,
  intent: CompanionIntent,
  stage: "search" | "organize",
  cache: CompanionCache,
  now = new Date(),
  places = searchPlaces,
): Promise<ToolResult> {
  try {
    queryIntent(intent, now);
    if (
      !state.pets.some(
        (p) =>
          p.id === ownId && p.ownerId === state.activeUserId && !p.archivedAt,
      )
    )
      return failed("NEEDS_CLARIFICATION", "请选择本人的有效宠物");
    const name = call.function.name;
    if (!Object.hasOwn(toolSchemas, name))
      return failed("INVALID_ARGUMENTS", "未知工具或禁止写入");
    const args = parseToolArguments(
      name as keyof typeof toolSchemas,
      JSON.parse(call.function.arguments),
    );
    if (stage === "search")
      return name === "search_activities"
        ? activityRecommendations(state, reference, intent, now)
        : failed("INVALID_ARGUMENTS", "请先查询已有活动，组局需要用户选择");
    if (name === "search_pets") {
      if (intent.hardRequirements.length)
        return failed(
          "NEEDS_CLARIFICATION",
          "存在无法按档案验证的硬约束，请先由主人核实；未放宽条件",
        );
      if (cache.pets) return cache.pets;
      const hard = { ...intent.match, temperaments: [], activities: [] };
      const candidates = matchQuery(state, reference, hard, ownId).filter(
        (r) => !intent.match.excludedSizes.length || r.pet.size !== "unknown",
      );
      const softScore = (p: (typeof state.pets)[number]) =>
        intent.match.temperaments.filter((t) => p.temperamentTags.includes(t))
          .length +
        intent.match.activities.filter((t) => p.activityTags.includes(t))
          .length;
      candidates.sort(
        (a, b) =>
          softScore(b.pet) - softScore(a.pet) ||
          b.score - a.score ||
          a.distanceM - b.distanceM ||
          a.pet.id.localeCompare(b.pet.id),
      );
      const result: ToolResult = {
        kind: "pets",
        rows: candidates.slice(0, 5).map((r) => ({
          id: r.pet.id,
          name: r.pet.name,
          breed: r.pet.breed,
          district: r.pet.district,
          distanceM: r.distanceM,
          score: r.score,
          reasons: [
            ...r.reasons.slice(0, 4),
            `已知性格偏好：${r.pet.temperamentTags.join("、") || "未知"}`,
            `活动偏好：${r.pet.activityTags.join("、") || "未知"}`,
          ],
        })),
      };
      if (result.kind === "pets") {
        result.rows = result.rows.map((r) => ({
          ...r,
          reasons: [
            ...r.reasons.slice(0, 5),
            ...intent.preferences.slice(0, 2).map((t) => `偏好“${t}”待核实`),
          ],
        }));
        cache.pets = result;
      }
      return result;
    }
    if (name === "search_places") {
      const { query } = toolSchemas.search_places.parse(args);
      if (!cache.places)
        cache.places = z
          .array(placeSchema)
          .max(20)
          .parse(await places(intent.placeQuery ?? query, reference))
          .filter(
            (p) =>
              p.location &&
              distanceMeters(reference, p.location) <=
                (intent.match.radiusKm ?? 5) * 1000,
          )
          .slice(0, 5);
      return toolResultSchema.parse({
        kind: "places",
        rows: cache.places.map((p, index) => ({
          index,
          name: p.name,
          source: p.source,
          distanceM: distanceMeters(reference, p.location!),
          petAccess: "unknown",
        })),
      });
    }
    if (name === "check_compatibility") {
      const { petIds } = toolSchemas.check_compatibility.parse(args);
      if (
        !cache.pets ||
        petIds.some((id) => !cache.pets!.rows.some((p) => p.id === id))
      )
        return failed("INVALID_ARGUMENTS", "只能比较本次实际查询到的宠友");
      const own = state.pets.find((p) => p.id === ownId)!;
      const rows = petIds
        .map((id) => ({
          id,
          ...comparePets(
            state,
            own,
            state.pets.find((p) => p.id === id && !p.archivedAt)!,
          ),
        }))
        .map(({ id, conflicts, advice, incomplete }) => ({
          id,
          conflicts,
          advice,
          incomplete,
        }));
      cache.compatibility = petIds;
      return toolResultSchema.parse({ kind: "compatibility", rows });
    }
    if (name === "create_activity_draft") {
      const draft = toolSchemas.create_activity_draft.parse(args);
      if (intent.hardRequirements.length)
        return failed(
          "NEEDS_CLARIFICATION",
          "尚有无法核实的硬约束，不能生成满足条件的草稿；请核实或修改需求",
        );
      if (
        !cache.places?.[draft.placeIndex] ||
        draft.petIds.some(
          (id) =>
            !cache.pets?.rows.some((p) => p.id === id) ||
            !cache.compatibility?.includes(id),
        )
      )
        return failed(
          "INVALID_ARGUMENTS",
          "请先查询宠友、候选地点并检查所选宠友偏好；不得编造ID或地点",
        );
      draft.title = "待确认约伴活动";
      draft.description = [
        ...intent.preferences.map((t) => `偏好：${t}（待核实）`),
        "公共地点宠物准入未知；不发送邀请，初见需双方主人确认。",
      ].join("；");
      cache.draft = draft;
      return { kind: "activity-draft", draft };
    }
    return failed("INVALID_ARGUMENTS", "当前阶段禁止此工具，不会写入业务");
  } catch (e) {
    return failed(
      e instanceof z.ZodError || e instanceof SyntaxError
        ? "INVALID_ARGUMENTS"
        : "TOOL_FAILED",
      e instanceof Error ? e.message : "工具执行失败",
    );
  }
}
export function activityInputFromDraft(
  cache: CompanionCache,
  intent: CompanionIntent,
  ownId: string,
) {
  queryIntent(intent);
  if (!cache.draft || !cache.places?.[cache.draft.placeIndex])
    throw Error("没有经过查询的活动草稿");
  const {
    startAt: _start,
    endAt: _end,
    ...draftShape
  } = activityInputSchema.shape;
  void _start;
  void _end;
  const base = z.strictObject(draftShape).parse({
    title: cache.draft.title,
    description: cache.draft.description,
    organizerPetId: ownId,
    recommendedPetIds: cache.draft.petIds,
    place: cache.places[cache.draft.placeIndex],
    capacity: 6,
  });
  return {
    ...base,
    ...(intent.startAt ? { startAt: intent.startAt } : {}),
    ...(intent.endAt ? { endAt: intent.endAt } : {}),
  };
}
