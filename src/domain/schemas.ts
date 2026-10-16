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
  lng: z.number().min(119).max(121),
  lat: z.number().min(29).max(31),
  crs: z.literal("GCJ02"),
});
export const placeSchema = z.strictObject({
  source: z.literal("demo"),
  name: text(60),
  district: text(30),
  location: locationSchema,
  petAccess: z.literal("unknown"),
});
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
const helpSchema = z.strictObject({
  ...base,
  requesterId: id,
  petId: id,
  type: z.enum(["walk", "feed"]),
  title: text(40),
  details: text(1000),
  startAt: iso,
  endAt: iso,
  place: placeSchema,
  status: z.literal("open"),
});
export const stateSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
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
    socialCards: z.array(z.never()).max(0),
    helpApplications: z.array(z.never()).max(0),
    helpEvents: z.array(z.never()).max(0),
    careChecklists: z.array(z.never()).max(0),
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
    ])
      if (!unique(list.map((v) => v.id))) fail("实体 ID 重复");
    const user = (uid: string) => s.users.some((u) => u.id === uid);
    const pet = (pid: string) => s.pets.find((p) => p.id === pid);
    if (!s.users.some((u) => u.id === s.activeUserId && u.isSwitchable))
      fail("演示身份无效");
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
    for (const h of s.helpRequests)
      if (
        pet(h.petId)?.ownerId !== h.requesterId ||
        Date.parse(h.endAt) <= Date.parse(h.startAt)
      )
        fail("互助引用无效");
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
