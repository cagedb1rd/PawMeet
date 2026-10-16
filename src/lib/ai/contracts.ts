import { z } from "zod";
import {
  interests,
  temperaments,
  socialCardInputSchema,
  checklistInputSchema,
} from "@/domain/schemas";
const short = (n: number) => z.string().trim().max(n);
const nullable = (n: number) => short(n).min(1).nullable();
const strings = (n = 60, count = 6) => z.array(short(n).min(1)).max(count);
export const sizes = ["small", "medium", "large", "unknown"] as const;
export const radiusSchema = z.union([
  z.literal(1),
  z.literal(3),
  z.literal(5),
  z.literal(10),
]);
export const notesSchema = z.strictObject({
  clarifications: strings(150, 12),
  warnings: strings(150, 8),
});
export const profileSchema = z.strictObject({
  name: nullable(20),
  breed: nullable(30),
  ageMonths: z.number().int().min(0).max(360).nullable(),
  size: z.enum(sizes).nullable(),
  city: nullable(20),
  district: nullable(30),
  temperamentTags: z
    .array(
      z.strictObject({
        value: z.enum(temperaments),
        evidence: short(80).min(1),
      }),
    )
    .max(8),
  activityTags: z
    .array(
      z.strictObject({ value: z.enum(interests), evidence: short(80).min(1) }),
    )
    .max(8),
  likes: strings(),
  dislikes: strings(),
  cautions: strings(),
  ...notesSchema.shape,
});
export const cardDraftSchema = socialCardInputSchema.extend(notesSchema.shape);
export const matchIntentSchema = z.strictObject({
  radiusKm: radiusSchema.nullable(),
  district: nullable(30),
  breeds: strings(30, 8),
  sizes: z.array(z.enum(sizes)).max(4),
  temperaments: z.array(z.enum(temperaments)).max(8),
  activities: z.array(z.enum(interests)).max(8),
  excludedSizes: z.array(z.enum(sizes)).max(4),
  excludedBreeds: strings(30, 8),
  excludedTemperaments: z.array(z.enum(temperaments)).max(8),
  excludedActivities: z.array(z.enum(interests)).max(8),
  sort: z.enum(["distance", "match"]).nullable(),
  unmappedTerms: strings(60, 8),
  ...notesSchema.shape,
});
export const helpDraftSchema = z.strictObject({
  type: z.enum(["walk", "feed"]).nullable(),
  petId: nullable(100),
  title: short(40),
  details: short(1000),
  startAt: z.iso.datetime({ offset: true }).nullable(),
  endAt: z.iso.datetime({ offset: true }).nullable(),
  durationMinutes: z.number().int().min(1).max(1440).nullable(),
  timeText: nullable(100),
  district: nullable(30),
  locationQuery: nullable(100),
  ...notesSchema.shape,
});
export const checklistDraftSchema = checklistInputSchema.extend(
  notesSchema.shape,
);
export const comparisonSchema = z.strictObject({
  evidenceCodes: strings(40, 20),
  explanation: short(1000).min(1),
  ...notesSchema.shape,
});
export const postCopySchema = z.strictObject({
  text: short(1000).min(1),
  ...notesSchema.shape,
});
export const companionIntentSchema = z.strictObject({
  mode: z.enum(["search", "create"]),
  match: matchIntentSchema,
  startAt: z.iso.datetime({ offset: true }).nullable(),
  endAt: z.iso.datetime({ offset: true }).nullable(),
  timeText: nullable(100),
  activityType: nullable(40),
  placeQuery: nullable(60),
  preferences: strings(80, 8),
  hardRequirements: strings(80, 8),
  ...notesSchema.shape,
});
export type CompanionIntent = z.infer<typeof companionIntentSchema>;
export const companionContextSchema = z.strictObject({
  stage: z.enum(["search", "organize"]),
  intent: companionIntentSchema,
});
export const placeSearchSchema = z.strictObject({ query: short(60).min(1) });
export const compatibilityToolSchema = z.strictObject({
  petIds: strings(100, 5),
});
export const activityDraftToolSchema = z.strictObject({
  title: short(40).min(1),
  description: short(500),
  petIds: strings(100, 5),
  placeIndex: z.number().int().min(0).max(4),
});
export const outputSchemas = {
  "companion-intent": companionIntentSchema,
  "pet-profile": profileSchema,
  "social-card": cardDraftSchema,
  "match-intent": matchIntentSchema,
  "help-intent": helpDraftSchema,
  "care-checklist": checklistDraftSchema,
  "social-analysis": comparisonSchema,
  "post-copy": postCopySchema,
};
export type AiTask = keyof typeof outputSchemas;
export type AiData<T extends AiTask> = z.infer<(typeof outputSchemas)[T]>;
export type MatchIntent = z.infer<typeof matchIntentSchema>;
export type HelpDraft = z.infer<typeof helpDraftSchema>;
export const petSummarySchema = z.strictObject({
  id: short(100).min(1),
  name: short(20).min(1),
  revision: z.number().int().positive(),
  temperamentTags: z.array(z.enum(temperaments)).max(8),
  activityTags: z.array(z.enum(interests)).max(8),
  socialNotes: short(500),
});
export const toolCallSchema = z.strictObject({
  id: short(100).min(1),
  type: z.literal("function"),
  function: z.strictObject({ name: short(50).min(1), arguments: short(7000) }),
});
export type ToolCall = z.infer<typeof toolCallSchema>;
export const activitySearchSchema = z.strictObject({
  district: nullable(30),
  radiusKm: radiusSchema.nullable(),
  startAfter: z.iso.datetime({ offset: true }).nullable(),
  startBefore: z.iso.datetime({ offset: true }).nullable(),
});
export const toolSchemas = {
  search_places: placeSearchSchema,
  check_compatibility: compatibilityToolSchema,
  create_activity_draft: activityDraftToolSchema,
  search_pets: matchIntentSchema,
  search_activities: activitySearchSchema,
  create_help_draft: helpDraftSchema,
};
// Native tools accept only supplied conditions; full business drafts remain strict.
export const nativeToolSchemas = {
  search_places: placeSearchSchema,
  check_compatibility: compatibilityToolSchema,
  create_activity_draft: activityDraftToolSchema,
  search_pets: matchIntentSchema.partial().extend({
    radiusKm: radiusSchema.optional(),
    district: nullable(30).unwrap().optional(),
    sort: z.enum(["distance", "match"]).optional(),
  }),
  search_activities: activitySearchSchema.partial().extend({
    radiusKm: radiusSchema.optional(),
    district: nullable(30).unwrap().optional(),
    startAfter: z.iso.datetime({ offset: true }).optional(),
    startBefore: z.iso.datetime({ offset: true }).optional(),
  }),
  create_help_draft: helpDraftSchema.partial().extend({
    type: z.enum(["walk", "feed"]).optional(),
    petId: short(100).min(1).optional(),
    details: short(1000),
    startAt: z.iso.datetime({ offset: true }).optional(),
    endAt: z.iso.datetime({ offset: true }).optional(),
    durationMinutes: z.number().int().min(1).max(1440).optional(),
    timeText: short(100).min(1).optional(),
    district: short(30).min(1).optional(),
    locationQuery: short(100).min(1).optional(),
  }),
};
export type ToolName = keyof typeof toolSchemas;
const petRowSchema = z.strictObject({
  id: short(100),
  name: short(20),
  breed: short(30),
  district: short(30),
  distanceM: z.number().nonnegative(),
  score: z.number().min(0).max(100),
  reasons: strings(150, 8),
});
const activityRowSchema = z.strictObject({
  remaining: z.number().int().nonnegative().optional(),
  reasons: strings(150, 8).optional(),
  differences: strings(150, 12).optional(),
  id: short(100),
  title: short(40),
  district: short(30),
  startAt: z.iso.datetime(),
  endAt: z.iso.datetime(),
  distanceM: z.number().nonnegative().nullable(),
});
export const toolResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("places"),
    rows: z
      .array(
        z.strictObject({
          index: z.number().int().min(0).max(4),
          name: short(60),
          source: z.enum(["amap", "demo", "manual"]),
          distanceM: z.number().nonnegative(),
          petAccess: z.literal("unknown"),
        }),
      )
      .max(5),
  }),
  z.strictObject({
    kind: z.literal("compatibility"),
    rows: z
      .array(
        z.strictObject({
          id: short(100),
          conflicts: strings(150, 8),
          advice: strings(150, 8),
          incomplete: z.boolean(),
        }),
      )
      .max(5),
  }),
  z.strictObject({
    kind: z.literal("activity-draft"),
    draft: activityDraftToolSchema,
  }),
  z.strictObject({
    kind: z.literal("pets"),
    rows: z.array(petRowSchema).max(5),
  }),
  z.strictObject({
    kind: z.literal("activities"),
    rows: z.array(activityRowSchema).max(5),
  }),
  z.strictObject({ kind: z.literal("help-draft"), draft: helpDraftSchema }),
  z.strictObject({
    kind: z.literal("error"),
    code: z.enum([
      "INVALID_ARGUMENTS",
      "TOOL_FAILED",
      "TIMEOUT",
      "NEEDS_CLARIFICATION",
    ]),
    message: short(200),
  }),
]);
export type ToolResult = z.infer<typeof toolResultSchema>;
export const taskRequestSchema = z.strictObject({
  text: short(1500).min(1),
  context: z
    .strictObject({
      pets: z.array(petSummarySchema).max(3).optional(),
      facts: short(3500).optional(),
      evidence: z
        .array(
          z.strictObject({ code: short(40).min(1), fact: short(300).min(1) }),
        )
        .max(20)
        .optional(),
    })
    .default({}),
});
export type TaskRequest = z.infer<typeof taskRequestSchema>;
export const assistantRequestSchema = z.strictObject({
  workflow: companionContextSchema.optional(),
  text: short(1500).optional(),
  pets: z.array(petSummarySchema).max(3).optional(),
  continuation: short(40000).optional(),
  results: z
    .array(
      z.strictObject({
        toolCallId: short(100).min(1),
        result: toolResultSchema,
      }),
    )
    .max(3)
    .optional(),
});
export type AssistantRequest = z.infer<typeof assistantRequestSchema>;
export const assistantSummaries = [
  "已查询，请查看实际结果卡片。",
  "已生成活动草稿，请编辑并确认，尚未创建。",
  "已生成互助草稿，请编辑并确认，尚未发布。",
  "没有符合条件的结果，请调整条件。",
  "需要补充信息，请查看工具提示。",
  "工具执行失败，请稍后重试。",
  "请说明要查询宠友、活动还是创建互助草稿。",
] as const;
export const assistantAnswerSchema = z.strictObject({
  summary: z.enum(assistantSummaries),
  references: z.array(z.string().max(100)).max(15),
});
export type AssistantStep = {
  continuation: string;
  toolCalls: ToolCall[];
  answer: z.infer<typeof assistantAnswerSchema> | null;
};
export type AiSuccess<T> = {
  ok: true;
  requestId: string;
  data: T;
  meta: {
    provider: "qwen";
    model: string;
    promptVersion: string;
    latencyMs: number;
    usage: unknown;
  };
};
export type AiFailure = {
  ok: false;
  requestId: string;
  error: { code: string; message: string; retryable: boolean };
};
export const emptyMatch: MatchIntent = {
  radiusKm: null,
  district: null,
  breeds: [],
  sizes: [],
  temperaments: [],
  activities: [],
  excludedSizes: [],
  excludedBreeds: [],
  excludedTemperaments: [],
  excludedActivities: [],
  sort: null,
  unmappedTerms: [],
  clarifications: [],
  warnings: [],
};
