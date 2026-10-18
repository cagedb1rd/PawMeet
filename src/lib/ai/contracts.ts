import { z } from "zod";
import { availabilitySchema } from "./availability";
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
  availability: availabilitySchema.optional(),
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
const confidence = z.number().min(0).max(1);
/**
 * Raw output of the pet-photo vision task (validated before business review). Only visible
 * appearance: no health, age, temperament or pedigree fields exist to be filled.
 */
export const petPhotoOutputSchema = z.strictObject({
  dog: z.strictObject({
    value: z.enum(["yes", "no", "unsure"]),
    confidence,
  }),
  multipleDogs: z.boolean(),
  breed: z.strictObject({ value: nullable(30), confidence }),
  size: z.strictObject({ value: z.enum(sizes), confidence }),
  coatColor: z.strictObject({ value: nullable(20), confidence }),
  features: z
    .array(z.strictObject({ value: short(30).min(1), confidence }))
    .max(5),
});
export type PetPhotoOutput = z.infer<typeof petPhotoOutputSchema>;
/** Thumbnail produced in the browser: re-encoded JPEG, longest edge ≤512px. */
export const PHOTO_MAX_EDGE = 512;
export const petPhotoRequestSchema = z.strictObject({
  image: z
    .string()
    .max(160000)
    .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/),
});
export type PetPhotoRequest = z.infer<typeof petPhotoRequestSchema>;
const reviewedField = <T extends z.ZodType>(value: T) =>
  z.strictObject({
    value,
    confidence,
    /** Passed the confidence threshold, content rules and cross-checks: filled automatically. */
    accepted: z.boolean(),
    /** A usable guess the owner may adopt with one click; never filled without that click. */
    suggested: z.boolean().default(false),
  });
/** What the browser receives: program-reviewed draft, never the raw model text. */
export const petPhotoDraftSchema = z.strictObject({
  status: z.enum(["recognized", "uncertain", "not_dog", "multiple"]),
  dogConfidence: confidence,
  breed: reviewedField(nullable(30)),
  size: reviewedField(z.enum(sizes)).extend({
    /** Breed table sizes when the model's size conflicts with the recognised breed. */
    typical: z.array(z.enum(sizes)).max(3).optional(),
    hint: short(120).optional(),
  }),
  coatColor: reviewedField(nullable(20)),
  features: z.array(reviewedField(short(30).min(1))).max(5),
  /** Items the program removed because they looked like diagnosis / age / temperament claims. */
  removed: z.number().int().min(0).max(10),
  messages: z.array(short(120)).max(8),
});
export type PetPhotoDraft = z.infer<typeof petPhotoDraftSchema>;
const thumbnailDataUrl = z
  .string()
  .max(160000)
  .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/);
/**
 * Community AI (post title / tags draft). Input is the post body; the optional image is the
 * same ≤512px re-encoded thumbnail as pet-photo, sent only when the user ticks it and clicks.
 */
export const postMetaRequestSchema = z.strictObject({
  text: short(1000).min(1),
  image: thumbnailDataUrl.optional(),
});
export type PostMetaRequest = z.infer<typeof postMetaRequestSchema>;
/** Raw model output; limits are reviewed by the program (src/lib/ai/community.ts). */
export const postMetaOutputSchema = z.strictObject({
  title: short(40).min(1),
  tags: z.array(short(30).min(1)).max(8),
  note: short(80).nullable(),
});
export type PostMetaOutput = z.infer<typeof postMetaOutputSchema>;
export const POST_META_LIMITS = {
  titleMax: 20,
  tagsMin: 3,
  tagsMax: 5,
} as const;
/** What the browser receives: program-reviewed draft. */
export const postMetaDraftSchema = z.strictObject({
  title: short(POST_META_LIMITS.titleMax).min(1),
  tags: z
    .array(z.string().regex(/^[一-鿿A-Za-z0-9_]{1,12}$/))
    .min(POST_META_LIMITS.tagsMin)
    .max(POST_META_LIMITS.tagsMax),
  note: short(80).nullable(),
  /** Tags the program dropped (format, ungrounded health / identity claims, extras). */
  removed: z.number().int().min(0).max(10),
});
export type PostMetaDraft = z.infer<typeof postMetaDraftSchema>;

const precheckCategory = z.enum([
  "personal_info",
  "ad_redirect",
  "abuse",
  "animal_cruelty",
  "dangerous_advice",
  "other",
]);
/** Only the user's own title / text / tags of this post; no images, no other data. */
export const postSafetyRequestSchema = z.strictObject({
  title: short(60),
  text: short(1000).min(1),
  tags: z.array(short(12).min(1)).max(5),
});
export type PostSafetyRequest = z.infer<typeof postSafetyRequestSchema>;
export const postSafetyOutputSchema = z.strictObject({
  verdict: z.enum(["pass", "revise"]),
  issues: z
    .array(
      z.strictObject({
        category: precheckCategory,
        excerpt: short(60),
        reason: short(80).min(1),
      }),
    )
    .max(5),
});
export type PostSafetyOutput = z.infer<typeof postSafetyOutputSchema>;
export const postSafetyResultSchema = z.strictObject({
  verdict: z.enum(["pass", "revise"]),
  issues: z
    .array(
      z.strictObject({
        category: precheckCategory,
        field: z.enum(["title", "text", "tags"]).nullable(),
        excerpt: short(60).nullable(),
        reason: short(80).min(1),
      }),
    )
    .max(5),
});
export type PostSafetyResult = z.infer<typeof postSafetyResultSchema>;
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
/**
 * Opaque provider metadata on a tool call that must be sent back unchanged on the next turn.
 * Gemini 3 rejects a follow-up request whose function calls lack their thought signature.
 */
export const toolCallExtraSchema = z.strictObject({
  google: z.strictObject({ thought_signature: short(8000).min(1) }),
});
export const toolCallSchema = z.strictObject({
  id: short(100).min(1),
  type: z.literal("function"),
  function: z.strictObject({ name: short(50).min(1), arguments: short(7000) }),
  extra_content: toolCallExtraSchema.optional(),
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
/** Without tool results in this step, only clarification summaries are truthful. */
export const noResultSummaries: readonly AssistantSummary[] = [
  "需要补充信息，请查看工具提示。",
  "请说明要查询宠友、活动还是创建互助草稿。",
];
export type AssistantSummary = (typeof assistantSummaries)[number];
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
    provider: string;
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
/** Progress of one server-side model call; streamed to the browser as NDJSON. */
export const aiProgressSchema = z.strictObject({
  stage: z.enum(["waiting", "receiving", "retrying"]),
  attempt: z.number().int().min(1).max(2),
  chars: z.number().int().nonnegative().max(20000),
});
export type AiProgress = z.infer<typeof aiProgressSchema>;
/** application/x-ndjson lines of /api/ai/{task} when the browser accepts it. */
export const AI_STREAM_TYPE = "application/x-ndjson";
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
