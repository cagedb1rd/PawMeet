import { z } from "zod";

const id = z.string().min(1).max(100);
const text = (max: number) => z.string().trim().min(1).max(max);
const iso = z.iso.datetime();
const base = {
  id,
  createdAt: iso,
  updatedAt: iso,
  revision: z.number().int().positive(),
};
export const imageSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("static"),
    path: z.string().regex(/^\/images\/[a-z0-9-]+\.(jpg|webp|svg)$/),
  }),
  z.strictObject({ kind: z.literal("upload"), imageId: id }),
]);
export const locationSchema = z.strictObject({
  lng: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
  crs: z.literal("GCJ02"),
});
const placeFields = {
  name: text(60),
  district: text(30),
  address: z.string().trim().max(200).optional(),
  petAccess: z.literal("unknown"),
};
export const placeSchema = z.discriminatedUnion("source", [
  z.strictObject({
    ...placeFields,
    source: z.literal("demo"),
    location: locationSchema,
  }),
  z.strictObject({
    ...placeFields,
    source: z.literal("amap"),
    poiId: id.optional(),
    location: locationSchema,
  }),
  z.strictObject({
    ...placeFields,
    source: z.literal("manual"),
    location: locationSchema.nullable(),
  }),
]);
export type PlaceRef = z.infer<typeof placeSchema>;
export const userSchema = z.strictObject({
  ...base,
  displayName: text(30),
  avatar: imageSchema,
  isSwitchable: z.boolean(),
});
export const temperaments = [
  "温和",
  "慢热",
  "活泼",
  "亲人",
  "独立",
  "怕追逐",
  "喜欢追逐",
] as const;
export const interests = [
  "散步",
  "闻闻探索",
  "接飞盘",
  "晒太阳",
  "草地撒欢",
  "一起慢跑",
] as const;
export const petInputSchema = z.strictObject({
  name: text(20),
  species: z.literal("dog"),
  breed: text(30),
  ageMonths: z.number().int().min(0).max(360).nullable(),
  size: z.enum(["small", "medium", "large", "unknown"]),
  city: text(20),
  district: text(30),
  photo: imageSchema,
  temperamentTags: z.array(z.enum(temperaments)).max(8),
  activityTags: z.array(z.enum(interests)).max(8),
  socialNotes: z.string().trim().max(500),
  demoLocation: locationSchema,
  isFictional: z.literal(true),
});
export const petSchema = petInputSchema.extend({
  ...base,
  ownerId: id,
  archivedAt: iso.nullable(),
});
export const postInputSchema = z.strictObject({
  title: z.string().trim().max(60).default(""),
  text: text(1000),
  petIds: z.array(id).max(3),
  images: z.array(imageSchema).max(3),
});
const postSchema = postInputSchema.extend({
  ...base,
  authorId: id,
  likedByUserIds: z.array(id).max(100),
});
export const activityInputSchema = z
  .strictObject({
    title: text(40),
    description: z.string().trim().max(500),
    organizerPetId: id,
    recommendedPetIds: z.array(id).max(5),
    place: placeSchema,
    startAt: iso,
    endAt: iso,
    capacity: z.number().int().min(2).max(12),
  })
  .refine((v) => Date.parse(v.endAt) > Date.parse(v.startAt), {
    message: "结束时间必须晚于开始时间",
    path: ["endAt"],
  });
const activitySchema = activityInputSchema.safeExtend({
  ...base,
  organizerId: id,
  status: z.enum(["scheduled", "cancelled"]),
});
const signupSchema = z.strictObject({
  ...base,
  activityId: id,
  userId: id,
  petId: id,
  status: z.enum(["joined", "cancelled"]),
});
export const socialCardInputSchema = z.strictObject({
  traits: z.array(text(60)).max(6),
  likes: z.array(text(60)).max(6),
  dislikes: z.array(text(60)).max(6),
  cautions: z.array(text(60)).max(6),
  meetingAdvice: z.string().trim().max(300),
});
export const socialCardSchema = socialCardInputSchema.extend({
  ...base,
  petId: id,
  petRevision: z.number().int().positive(),
  source: z.literal("manual"),
  confirmedAt: iso,
  confirmedBy: id,
});
export const helpStatusSchema = z.enum([
  "open",
  "assigned",
  "helper_done",
  "completed",
  "cancelled",
]);
export const helpInputSchema = z
  .strictObject({
    petId: id,
    type: z.enum(["walk", "feed"]),
    title: text(40),
    details: text(1000),
    startAt: iso,
    endAt: iso,
    place: placeSchema,
  })
  .refine((v) => Date.parse(v.endAt) > Date.parse(v.startAt), {
    message: "结束时间必须晚于开始时间",
    path: ["endAt"],
  });
export const helpSchema = helpInputSchema.safeExtend({
  ...base,
  requesterId: id,
  status: helpStatusSchema,
  contentRevision: z.number().int().positive(),
  helperId: id.nullable(),
  acceptedApplicationId: id.nullable(),
});
export const applicationSchema = z.strictObject({
  ...base,
  helpId: id,
  applicantId: id,
  message: z.string().trim().max(200),
  status: z.enum(["pending", "accepted", "rejected", "withdrawn"]),
});
export const helpEventSchema = z.strictObject({
  ...base,
  helpId: id,
  actorId: id,
  action: z.enum([
    "publish",
    "edit",
    "apply",
    "withdraw",
    "assign",
    "helper-done",
    "complete",
    "cancel",
    "checklist",
  ]),
  fromState: helpStatusSchema,
  toState: helpStatusSchema,
});
export const checklistInputSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        title: text(60),
        detail: z.string().trim().max(300),
        needsConfirmation: z.boolean(),
      }),
    )
    .min(1)
    .max(12),
});
export const checklistSchema = checklistInputSchema.extend({
  ...base,
  helpId: id,
  petRevision: z.number().int().positive(),
  requestRevision: z.number().int().positive(),
  source: z.literal("manual"),
  confirmedBy: id,
  confirmedAt: iso,
});
export const stateSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    seedVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    seededAt: iso,
    activeUserId: id,
    users: z.array(userSchema).min(5).max(100),
    pets: z.array(petSchema).max(150),
    posts: z.array(postSchema).max(100),
    activities: z.array(activitySchema).max(100),
    activitySignups: z.array(signupSchema).max(1200),
    helpRequests: z.array(helpSchema).max(100),
    socialCards: z.array(socialCardSchema).max(150),
    helpApplications: z.array(applicationSchema).max(500),
    helpEvents: z.array(helpEventSchema).max(3000),
    careChecklists: z.array(checklistSchema).max(100),
    follows: z
      .array(z.strictObject({ followerId: id, followingId: id }))
      .max(9900)
      .default([]),
    settings: z.strictObject({ timezone: z.literal("Asia/Shanghai") }),
  })
  .superRefine((s, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    const unique = (ids: string[]) => new Set(ids).size === ids.length;
    for (const list of [
      s.users,
      s.pets,
      s.posts,
      s.activities,
      s.activitySignups,
      s.helpRequests,
      s.socialCards,
      s.helpApplications,
      s.helpEvents,
      s.careChecklists,
    ])
      if (!unique(list.map((v) => v.id))) fail("实体 ID 重复");
    const user = (uid: string) => s.users.some((u) => u.id === uid);
    const pet = (pid: string) => s.pets.find((p) => p.id === pid);
    if (!s.users.some((u) => u.id === s.activeUserId && u.isSwitchable))
      fail("演示身份无效");
    if (
      !unique(
        s.follows.map((f) => JSON.stringify([f.followerId, f.followingId])),
      )
    )
      fail("关注关系重复");
    for (const f of s.follows)
      if (
        !user(f.followerId) ||
        !user(f.followingId) ||
        f.followerId === f.followingId ||
        !s.users.some((u) => u.id === f.followerId && u.isSwitchable)
      )
        fail("关注关系无效");
    for (const p of s.pets) if (!user(p.ownerId)) fail("宠物主人不存在");
    for (const p of s.posts)
      if (
        !user(p.authorId) ||
        !unique(p.likedByUserIds) ||
        !unique(p.petIds) ||
        p.likedByUserIds.some((u) => !user(u)) ||
        p.petIds.some((pid) => pet(pid)?.ownerId !== p.authorId)
      )
        fail("动态引用无效");
    for (const a of s.activities) {
      if (
        !user(a.organizerId) ||
        pet(a.organizerPetId)?.ownerId !== a.organizerId ||
        a.recommendedPetIds.some((pid) => !pet(pid))
      )
        fail("活动引用无效");
      const joined = s.activitySignups.filter(
        (v) => v.activityId === a.id && v.status === "joined",
      );
      if (
        joined.length > a.capacity ||
        !unique(joined.map((v) => v.userId)) ||
        !joined.some(
          (v) => v.userId === a.organizerId && v.petId === a.organizerPetId,
        )
      )
        fail("报名名额或组织者无效");
    }
    for (const v of s.activitySignups) {
      const a = s.activities.find((a) => a.id === v.activityId),
        p = pet(v.petId);
      if (
        !a ||
        p?.ownerId !== v.userId ||
        (v.status === "joined" &&
          p?.archivedAt &&
          a.status === "scheduled" &&
          Date.parse(a.endAt) > Date.parse(p.archivedAt))
      )
        fail("报名引用无效");
    }
    if (
      !unique(s.socialCards.map((c) => c.petId)) ||
      !unique(s.careChecklists.map((c) => c.helpId))
    )
      fail("名片或清单重复");
    for (const c of s.socialCards)
      if (
        pet(c.petId)?.ownerId !== c.confirmedBy ||
        c.petRevision > (pet(c.petId)?.revision ?? 0)
      )
        fail("名片引用无效");
    for (const h of s.helpRequests) {
      if (pet(h.petId)?.ownerId !== h.requesterId) fail("互助引用无效");
      const apps = s.helpApplications.filter((a) => a.helpId === h.id);
      const active = apps.filter((a) =>
        ["pending", "accepted"].includes(a.status),
      );
      if (!unique(active.map((a) => a.applicantId))) fail("申请重复");
      const accepted = apps.filter((a) => a.status === "accepted");
      if (h.helperId !== null) {
        if (
          !user(h.helperId) ||
          h.helperId === h.requesterId ||
          accepted.length !== 1 ||
          accepted[0].id !== h.acceptedApplicationId ||
          accepted[0].applicantId !== h.helperId ||
          h.status === "open"
        )
          fail("帮助者引用无效");
      } else if (
        h.acceptedApplicationId !== null ||
        accepted.length ||
        ["assigned", "helper_done", "completed"].includes(h.status)
      )
        fail("缺少帮助者");
      if (h.status !== "open" && apps.some((a) => a.status === "pending"))
        fail("关闭需求仍有待选申请");
    }
    for (const a of s.helpApplications) {
      const h = s.helpRequests.find((h) => h.id === a.helpId);
      if (
        !h ||
        !s.users.some((u) => u.id === a.applicantId && u.isSwitchable) ||
        h.requesterId === a.applicantId
      )
        fail("申请引用无效");
    }
    for (const e of s.helpEvents)
      if (!user(e.actorId) || !s.helpRequests.some((h) => h.id === e.helpId))
        fail("事件引用无效");
    for (const c of s.careChecklists) {
      const h = s.helpRequests.find((h) => h.id === c.helpId);
      if (
        !h ||
        c.confirmedBy !== h.requesterId ||
        c.requestRevision > h.contentRevision ||
        c.petRevision > (pet(h.petId)?.revision ?? 0)
      )
        fail("清单引用无效");
    }
  });

export type ImageRef = z.infer<typeof imageSchema>;
export type PetInput = z.infer<typeof petInputSchema>;
export type Pet = z.infer<typeof petSchema>;
export type DemoState = z.infer<typeof stateSchema>;
export type Post = DemoState["posts"][number];
export type Activity = DemoState["activities"][number];
export type ActivityInput = z.infer<typeof activityInputSchema>;
export const sizeLabels = {
  small: "小型犬",
  medium: "中型犬",
  large: "大型犬",
  unknown: "体型未知",
};

export type SocialCardInput = z.infer<typeof socialCardInputSchema>;
export type SocialCard = z.infer<typeof socialCardSchema>;
export type HelpInput = z.infer<typeof helpInputSchema>;
export type HelpRequest = z.infer<typeof helpSchema>;
export type ChecklistInput = z.infer<typeof checklistInputSchema>;
