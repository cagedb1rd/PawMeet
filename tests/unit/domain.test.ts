import { describe, expect, it } from "vitest";
import { createSeed, demoPlaces } from "@/data/seed";
import { execute } from "@/domain/commands";
import { stateSchema } from "@/domain/schemas";

const now = new Date("2026-10-17T08:00:00Z");
const seed = () => createSeed(now);
const input = () => {
  const {
    name,
    species,
    breed,
    ageMonths,
    size,
    city,
    district,
    photo,
    temperamentTags,
    activityTags,
    socialNotes,
    demoLocation,
    isFictional,
  } = seed().pets[0];
  return {
    name,
    species,
    breed,
    ageMonths,
    size,
    city,
    district,
    photo,
    temperamentTags,
    activityTags,
    socialNotes,
    demoLocation,
    isFictional,
  };
};
const activity = {
  title: "测试活动",
  description: "虚构",
  organizerPetId: "pet-1",
  recommendedPetIds: [],
  place: demoPlaces[0],
  startAt: "2026-10-20T08:00:00Z",
  endAt: "2026-10-20T10:00:00Z",
  capacity: 2,
};
describe("种子与引用完整性", () => {
  it("25 主人 / 25 宠物、5 可切换身份与默认内容有效", () => {
    const s = seed();
    expect(s.users).toHaveLength(25);
    expect(s.users.filter((u) => u.isSwitchable)).toHaveLength(5);
    expect(s.pets).toHaveLength(25);
    expect(s.posts).toHaveLength(12);
    expect(s.activities).toHaveLength(6);
    expect(s.helpRequests).toHaveLength(8);
    expect(stateSchema.safeParse(s).success).toBe(true);
  });
  it("拒绝孤儿、重复 ID 和越权身份", () => {
    const s = seed();
    s.pets[0].ownerId = "missing";
    expect(stateSchema.safeParse(s).success).toBe(false);
    const t = seed();
    t.pets[1].id = t.pets[0].id;
    expect(stateSchema.safeParse(t).success).toBe(false);
    expect(() =>
      execute(seed(), { type: "switch-user", userId: "user-6" }, now),
    ).toThrow("不可切换");
  });
});
describe("档案和社区命令", () => {
  it("新增、更新、软删除与源状态不可变", () => {
    const s = seed();
    const added = execute(
      s,
      { type: "save-pet", input: { ...input(), name: "测试小狗" } },
      now,
    );
    const p = added.pets.at(-1)!;
    expect(s.pets).toHaveLength(25);
    expect(added.pets).toHaveLength(26);
    expect(p.ownerId).toBe("user-1");
    const edited = execute(
      added,
      { type: "save-pet", petId: p.id, input: { ...input(), name: "新名字" } },
      now,
    );
    expect(edited.pets.at(-1)?.name).toBe("新名字");
    const deleted = execute(edited, { type: "delete-pet", petId: p.id }, now);
    expect(deleted.pets.at(-1)?.archivedAt).toBe(now.toISOString());
    expect(() =>
      execute(deleted, { type: "save-pet", petId: p.id, input: input() }, now),
    ).toThrow();
  });
  it("拒绝修改他人、过长输入、删除关联宠物", () => {
    expect(() =>
      execute(
        seed(),
        { type: "save-pet", petId: "pet-2", input: input() },
        now,
      ),
    ).toThrow("当前身份");
    expect(() =>
      execute(
        seed(),
        { type: "save-pet", input: { ...input(), name: "x".repeat(21) } },
        now,
      ),
    ).toThrow();
    expect(() =>
      execute(seed(), { type: "delete-pet", petId: "pet-2" }, now),
    ).toThrow();
    expect(() =>
      execute(seed(), { type: "delete-pet", petId: "pet-1" }, now),
    ).toThrow("互助");
  });
  it("发帖校验本人宠物、点赞去重和身份隔离", () => {
    let s = execute(
      seed(),
      {
        type: "publish-post",
        input: { text: "今天很开心", petIds: ["pet-1"], images: [] },
      },
      now,
    );
    const postId = s.posts[0].id;
    expect(s.posts[0].authorId).toBe("user-1");
    s = execute(s, { type: "toggle-like", postId }, now);
    expect(s.posts[0].likedByUserIds).toEqual(["user-1"]);
    s = execute(s, { type: "switch-user", userId: "user-2" }, now);
    s = execute(s, { type: "toggle-like", postId }, now);
    expect(s.posts[0].likedByUserIds).toEqual(["user-1", "user-2"]);
    s = execute(s, { type: "toggle-like", postId }, now);
    expect(s.posts[0].likedByUserIds).toEqual(["user-1"]);
    expect(() =>
      execute(
        s,
        {
          type: "publish-post",
          input: { text: "越权", petIds: ["pet-1"], images: [] },
        },
        now,
      ),
    ).toThrow("当前身份");
  });
  it("历史帖子保留已归档宠物引用", () => {
    let s = execute(seed(), { type: "save-pet", input: input() }, now);
    const pid = s.pets.at(-1)!.id;
    s = execute(
      s,
      {
        type: "publish-post",
        input: { text: "历史", petIds: [pid], images: [] },
      },
      now,
    );
    s = execute(s, { type: "delete-pet", petId: pid }, now);
    expect(s.posts[0].petIds).toEqual([pid]);
    expect(stateSchema.safeParse(s).success).toBe(true);
  });
});
describe("活动规则", () => {
  it("主办人自动报名；唯一报名、满额、取消释放与重新报名", () => {
    let s = execute(seed(), { type: "create-activity", input: activity }, now);
    const aid = s.activities[0].id;
    expect(
      s.activitySignups.filter(
        (v) => v.activityId === aid && v.status === "joined",
      ),
    ).toHaveLength(1);
    expect(() =>
      execute(s, { type: "leave-activity", activityId: aid }, now),
    ).toThrow("组织者");
    s = execute(s, { type: "switch-user", userId: "user-2" }, now);
    s = execute(
      s,
      { type: "join-activity", activityId: aid, petId: "pet-2" },
      now,
    );
    expect(() =>
      execute(
        s,
        { type: "join-activity", activityId: aid, petId: "pet-2" },
        now,
      ),
    ).toThrow("已报名");
    const full = execute(s, { type: "switch-user", userId: "user-3" }, now);
    expect(() =>
      execute(
        full,
        { type: "join-activity", activityId: aid, petId: "pet-3" },
        now,
      ),
    ).toThrow("名额已满");
    s = execute(s, { type: "leave-activity", activityId: aid }, now);
    s = execute(
      s,
      { type: "join-activity", activityId: aid, petId: "pet-2" },
      now,
    );
    expect(s.activitySignups.filter((v) => v.activityId === aid)).toHaveLength(
      2,
    );
  });
  it("禁止越权取消、他人宠物报名、过去时间、结束早于开始", () => {
    let s = execute(seed(), { type: "create-activity", input: activity }, now);
    const aid = s.activities[0].id;
    s = execute(s, { type: "switch-user", userId: "user-2" }, now);
    expect(() =>
      execute(s, { type: "cancel-activity", activityId: aid }, now),
    ).toThrow("组织者");
    expect(() =>
      execute(
        s,
        { type: "join-activity", activityId: aid, petId: "pet-1" },
        now,
      ),
    ).toThrow("当前身份");
    expect(() =>
      execute(
        seed(),
        {
          type: "create-activity",
          input: { ...activity, startAt: "2020-01-01T00:00:00Z" },
        },
        now,
      ),
    ).toThrow("未来");
    expect(() =>
      execute(
        seed(),
        {
          type: "create-activity",
          input: { ...activity, endAt: activity.startAt },
        },
        now,
      ),
    ).toThrow();
  });
  it("取消活动保留报名；已取消或开始不可变更；有活动宠物不可删", () => {
    let s = execute(seed(), { type: "create-activity", input: activity }, now);
    const aid = s.activities[0].id;
    expect(() =>
      execute(s, { type: "delete-pet", petId: "pet-1" }, now),
    ).toThrow("活动");
    expect(() =>
      execute(
        s,
        { type: "cancel-activity", activityId: aid },
        new Date(activity.startAt),
      ),
    ).toThrow("已开始");
    s = execute(s, { type: "cancel-activity", activityId: aid }, now);
    expect(s.activitySignups.some((v) => v.activityId === aid)).toBe(true);
    s = execute(s, { type: "switch-user", userId: "user-2" }, now);
    expect(() =>
      execute(
        s,
        { type: "join-activity", activityId: aid, petId: "pet-2" },
        now,
      ),
    ).toThrow("已取消");
  });
});
