import { DemoState } from "@/domain/schemas";
import { matchQuery } from "@/domain/matching";
import { distanceMeters } from "@/domain/geo";
import { MapPoint } from "@/lib/maps/contracts";
import {
  ToolCall,
  ToolResult,
  toolSchemas,
  ToolName,
  toolResultSchema,
  nativeToolSchemas,
  emptyMatch,
} from "./contracts";
import { validateHelp, validateMatch, validateOutput } from "./validation";
/** Normalize only canonical provider encodings, then apply strict Zod ranges/enums. */
export function normalizeToolArguments(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const value = { ...raw } as Record<string, unknown>;
  for (const key of [
    "radiusKm",
    "district",
    "sort",
    "startAfter",
    "startBefore",
    "type",
    "petId",
    "startAt",
    "endAt",
    "durationMinutes",
    "timeText",
    "locationQuery",
  ])
    if (value[key] === "null") value[key] = null;
  if (typeof value.radiusKm === "string" && /^(1|3|5|10)$/.test(value.radiusKm))
    value.radiusKm = Number(value.radiusKm);
  if (
    typeof value.durationMinutes === "string" &&
    /^[1-9]\d{0,3}$/.test(value.durationMinutes)
  )
    value.durationMinutes = Number(value.durationMinutes);
  return value;
}
export function parseToolArguments(name: ToolName, raw: unknown) {
  const normalized = normalizeToolArguments(raw);
  const legacy = toolSchemas[name].safeParse(normalized);
  if (legacy.success) return legacy.data;
  if (
    !normalized ||
    typeof normalized !== "object" ||
    Array.isArray(normalized)
  )
    throw Error("Invalid arguments");
  const sparse = Object.fromEntries(
    Object.entries(normalized).filter(
      ([key, value]) =>
        !(value === null && Object.hasOwn(nativeToolSchemas[name].shape, key)),
    ),
  );
  const provided = nativeToolSchemas[name].parse(sparse);
  const defaults =
    name === "search_pets"
      ? emptyMatch
      : name === "search_activities"
        ? {
            district: null,
            radiusKm: null,
            startAfter: null,
            startBefore: null,
          }
        : {
            type: null,
            petId: null,
            title: "临时互助草稿",
            details: "",
            startAt: null,
            endAt: null,
            durationMinutes: null,
            timeText: null,
            district: null,
            locationQuery: null,
            clarifications: [],
            warnings: [],
          };
  return toolSchemas[name].parse({ ...defaults, ...provided });
}
/** Read-only browser executor. No Repository or business command imports. */
export function executeTool(
  call: ToolCall,
  state: DemoState,
  reference: MapPoint,
  ownId?: string,
  now = new Date(),
  taskText?: string,
): ToolResult {
  if (!Object.hasOwn(toolSchemas, call.function.name))
    return {
      kind: "error",
      code: "INVALID_ARGUMENTS",
      message: "未知工具，不能执行",
    };
  const name = call.function.name as ToolName;
  let raw: unknown;
  try {
    raw = JSON.parse(call.function.arguments);
  } catch {
    return {
      kind: "error",
      code: "INVALID_ARGUMENTS",
      message: "工具参数不是JSON",
    };
  }
  let parsed: { data: ReturnType<typeof parseToolArguments> };
  try {
    parsed = { data: parseToolArguments(name, raw) };
  } catch {
    return {
      kind: "error",
      code: "INVALID_ARGUMENTS",
      message: "工具参数未通过Zod校验，请修正参数",
    };
  }
  try {
    if (name === "search_pets") {
      const f = taskText
        ? toolSchemas.search_pets.parse(
            validateOutput(
              "match-intent",
              parsed.data,
              { text: taskText, context: {} },
              now,
            ),
          )
        : validateMatch(toolSchemas.search_pets.parse(parsed.data));
      if (f.clarifications.length || f.unmappedTerms.length)
        return {
          kind: "error",
          code: "NEEDS_CLARIFICATION",
          message: f.clarifications.join("；").slice(0, 200),
        };
      return toolResultSchema.parse({
        kind: "pets",
        rows: matchQuery(state, reference, f, ownId)
          .slice(0, 5)
          .map((r) => ({
            id: r.pet.id,
            name: r.pet.name,
            breed: r.pet.breed,
            district: r.pet.district,
            distanceM: r.distanceM,
            score: r.score,
            reasons: r.reasons.slice(0, 8),
          })),
      });
    }
    if (name === "search_activities") {
      const f = toolSchemas.search_activities.parse(parsed.data);
      if (
        f.startAfter &&
        f.startBefore &&
        Date.parse(f.startBefore) < Date.parse(f.startAfter)
      )
        return {
          kind: "error",
          code: "INVALID_ARGUMENTS",
          message: "活动时间范围冲突",
        };
      const rows = state.activities
        .filter(
          (a) =>
            a.status === "scheduled" && Date.parse(a.startAt) > now.getTime(),
        )
        .map((a) => ({
          id: a.id,
          title: a.title,
          district: a.place.district,
          startAt: a.startAt,
          endAt: a.endAt,
          distanceM: a.place.location
            ? distanceMeters(reference, a.place.location)
            : null,
        }))
        .filter(
          (a) =>
            (!f.district || a.district === f.district) &&
            (!f.radiusKm ||
              (a.distanceM !== null && a.distanceM <= f.radiusKm * 1000)) &&
            (!f.startAfter ||
              Date.parse(a.startAt) >= Date.parse(f.startAfter)) &&
            (!f.startBefore ||
              Date.parse(a.startAt) <= Date.parse(f.startBefore)),
        )
        .sort(
          (a, b) =>
            (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity) ||
            a.startAt.localeCompare(b.startAt) ||
            a.id.localeCompare(b.id),
        )
        .slice(0, 5);
      return toolResultSchema.parse({ kind: "activities", rows });
    }
    const ownPets = state.pets.filter(
      (p) => p.ownerId === state.activeUserId && !p.archivedAt,
    );
    const draft = taskText
      ? toolSchemas.create_help_draft.parse(
          validateOutput(
            "help-intent",
            parsed.data,
            {
              text: taskText,
              context: {
                pets: ownPets.slice(0, 3).map((p) => ({
                  id: p.id,
                  name: p.name,
                  revision: p.revision,
                  temperamentTags: p.temperamentTags,
                  activityTags: p.activityTags,
                  socialNotes: p.socialNotes,
                })),
              },
            },
            now,
          ),
        )
      : validateHelp(
          toolSchemas.create_help_draft.parse(parsed.data),
          state.pets.filter(
            (p) => p.ownerId === state.activeUserId && !p.archivedAt,
          ),
          now,
        );
    return { kind: "help-draft", draft };
  } catch {
    if (name === "create_help_draft")
      return {
        kind: "error",
        code: "INVALID_ARGUMENTS",
        message:
          "互助草稿校验失败：details、地点须为用户原文连续片段，不添加前缀或标点；petId须为本人宠物；模糊时段的startAt/endAt应为null。请修正后重试。",
      };
    return {
      kind: "error",
      code: "TOOL_FAILED",
      message: "本地工具执行失败，未产生业务写入",
    };
  }
}
