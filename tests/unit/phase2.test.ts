import { describe, expect, it } from "vitest";
import { createSeed, demoPlaces } from "@/data/seed";
import { Command, execute } from "@/domain/commands";
import { checklistCurrent } from "@/domain/phase2";
import { cardFor, comparePets } from "@/domain/social";
import { DemoState, petInputSchema, stateSchema } from "@/domain/schemas";
import { readState, commit } from "@/lib/storage/repository";

const now = new Date("2026-10-17T08:00:00Z");
const input = {
  title: "测试临时遛狗",
  details: "仅演示",
  petId: "pet-1",
  type: "walk",
  startAt: "2026-10-20T08:00:00Z",
  endAt: "2026-10-20T09:00:00Z",
  place: demoPlaces[0],
};
const card = {
  traits: ["慢热"],
  likes: ["追逐"],
  dislikes: [],
  cautions: ["先确认"],
  meetingAdvice: "先保持距离",
};
const checklist = {
  items: [
    { title: "交接物品", detail: "请主人现场核对", needsConfirmation: true },
  ],
};
const run = (s: DemoState, c: Command) => execute(s, c, now);
const user = (s: DemoState, n: number) =>
  run(s, { type: "switch-user", userId: `user-${n}` });
function prepared() {
  let s = run(createSeed(now), { type: "save-help", input });
  const h = s.helpRequests[0];
  s = run(s, {
    type: "save-checklist",
    helpId: h.id,
    petRevision: 1,
    requestRevision: 1,
    input: checklist,
  });
  return { s, id: h.id };
}
function assigned() {
  const { s: initial, id } = prepared();
  let s = initial;
  s = run(user(s, 2), { type: "apply-help", helpId: id, message: "我可以" });
  s = run(user(s, 1), {
    type: "assign-help",
    helpId: id,
    applicationId: s.helpApplications[0].id,
  });
  return { s, id };
}
describe("互助状态机与权限", () => {
  it("逐项检查五种任务状态 × 三身份的禁止边与幂等边", () => {
    const { s: initial, id } = prepared();
    const open = run(user(initial, 2), {
      type: "apply-help",
      helpId: id,
      message: "",
    });
    const applicationId = open.helpApplications[0].id;
    const assigned = run(user(open, 1), {
      type: "assign-help",
      helpId: id,
      applicationId,
    });
    const helperDone = run(user(assigned, 2), {
      type: "helper-done",
      helpId: id,
    });
    const completed = run(user(helperDone, 1), {
      type: "complete-help",
      helpId: id,
    });
    const cancelled = run(user(assigned, 1), {
      type: "cancel-help",
      helpId: id,
    });
    const states = [open, assigned, helperDone, completed, cancelled];
    // Allowed (state index, actor) pairs include explicit retries of the same action.
    const cases: { command: Command; allowed: string[] }[] = [
      {
        command: { type: "assign-help", helpId: id, applicationId },
        allowed: ["0:1", "1:1", "2:1", "3:1"],
      },
      {
        command: { type: "helper-done", helpId: id },
        allowed: ["1:2", "2:2", "3:2"],
      },
      {
        command: { type: "complete-help", helpId: id },
        allowed: ["2:1", "3:1"],
      },
      {
        command: { type: "cancel-help", helpId: id },
        allowed: ["0:1", "1:1", "4:1"],
      },
      {
        command: { type: "apply-help", helpId: id, message: "" },
        allowed: ["0:3"],
      },
    ];
    states.forEach((state, index) => {
      for (const actor of [1, 2, 3]) {
        const s = user(state, actor),
          before = JSON.stringify(s);
        for (const c of cases) {
          if (c.allowed.includes(`${index}:${actor}`))
            expect(() => run(s, c.command)).not.toThrow();
          else expect(() => run(s, c.command)).toThrow();
          expect(JSON.stringify(s)).toBe(before);
        }
      }
    });
  });

  it("接受操作写失败时任务、所有申请和事件一起保持原状", () => {
    const { s: initial, id } = prepared();
    let s = run(user(initial, 2), {
      type: "apply-help",
      helpId: id,
      message: "B",
    });
    s = run(user(s, 3), { type: "apply-help", helpId: id, message: "C" });
    s = user(s, 1);
    const raw = JSON.stringify(s);
    const store = {
      getItem: () => raw,
      setItem: () => {
        throw Error("quota");
      },
    };
    expect(() =>
      commit(store, s, {
        type: "assign-help",
        helpId: id,
        applicationId: s.helpApplications[0].id,
      }),
    ).toThrow("保存失败");
    expect(JSON.stringify(s)).toBe(raw);
    expect(
      readState(store).helpApplications.every((a) => a.status === "pending"),
    ).toBe(true);
    expect(readState(store).helpRequests[0].status).toBe("open");
  });
  it("A 发布、B/C 申请、A 选 B、B 完成、A 确认，原子拒绝 C 并保留事件", () => {
    const { s: initial, id } = prepared();
    let s = initial;
    s = run(user(s, 2), { type: "apply-help", helpId: id, message: "B" });
    const app = s.helpApplications[0].id;
    s = run(user(s, 3), { type: "apply-help", helpId: id, message: "C" });
    s = run(user(s, 1), {
      type: "assign-help",
      helpId: id,
      applicationId: app,
    });
    expect(s.helpApplications.map((a) => a.status)).toEqual([
      "accepted",
      "rejected",
    ]);
    expect(() => run(user(s, 3), { type: "helper-done", helpId: id })).toThrow(
      "被选帮助者",
    );
    s = run(user(s, 2), { type: "helper-done", helpId: id });
    expect(s.helpRequests[0].status).toBe("helper_done");
    expect(() => run(s, { type: "complete-help", helpId: id })).toThrow(
      "求助人",
    );
    s = run(user(s, 1), { type: "complete-help", helpId: id });
    expect(s.helpRequests[0]).toMatchObject({
      status: "completed",
      helperId: "user-2",
      acceptedApplicationId: app,
    });
    expect(s.helpEvents.map((e) => e.action)).toEqual([
      "publish",
      "checklist",
      "apply",
      "apply",
      "assign",
      "helper-done",
      "complete",
    ]);
  });
  it("拒绝自助、重复申请、他人接受、提前完成、缺少清单", () => {
    const { s, id } = prepared();
    expect(() =>
      run(s, { type: "apply-help", helpId: id, message: "" }),
    ).toThrow("自己");
    expect(() => run(s, { type: "complete-help", helpId: id })).toThrow("跳过");
    const b = run(user(s, 2), { type: "apply-help", helpId: id, message: "" });
    expect(() =>
      run(b, { type: "apply-help", helpId: id, message: "" }),
    ).toThrow("重复");
    const aid = b.helpApplications[0].id;
    expect(() =>
      run(b, { type: "assign-help", helpId: id, applicationId: aid }),
    ).toThrow("求助人");
    const missing = user(b, 1);
    missing.careChecklists = [];
    expect(() =>
      run(missing, { type: "assign-help", helpId: id, applicationId: aid }),
    ).toThrow("清单");
    expect(() => run(s, { type: "helper-done", helpId: id })).toThrow("帮助者");
    expect(() => run(b, { type: "cancel-help", helpId: id })).toThrow("求助人");
  });
  it("申请可撤回再申请；不能撤回他人或已接受的申请", () => {
    const { s: initial, id } = prepared();
    let s = initial;
    s = run(user(s, 2), { type: "apply-help", helpId: id, message: "" });
    expect(() =>
      run(user(s, 3), { type: "withdraw-help", helpId: id }),
    ).toThrow("本人");
    s = run(s, { type: "withdraw-help", helpId: id });
    expect(s.helpApplications[0].status).toBe("withdrawn");
    s = run(s, { type: "apply-help", helpId: id, message: "再次申请" });
    expect(s.helpApplications).toHaveLength(2);
    s = run(user(s, 1), {
      type: "assign-help",
      helpId: id,
      applicationId: s.helpApplications[1].id,
    });
    expect(() =>
      run(user(s, 2), { type: "withdraw-help", helpId: id }),
    ).toThrow("待确认");
  });
  it("选择与双方完成重复点击幂等，不重复记录事件", () => {
    const { s: initial, id } = assigned();
    let s = initial;
    const count = s.helpEvents.length;
    s = run(s, {
      type: "assign-help",
      helpId: id,
      applicationId: s.helpApplications[0].id,
    });
    expect(s.helpEvents).toHaveLength(count);
    s = run(user(s, 2), { type: "helper-done", helpId: id });
    s = run(s, { type: "helper-done", helpId: id });
    s = run(user(s, 1), { type: "complete-help", helpId: id });
    s = run(s, { type: "complete-help", helpId: id });
    expect(s.helpEvents).toHaveLength(count + 2);
  });
  it("open 取消拒绝 pending；assigned 取消保留 accepted；取消后不能继续操作", () => {
    const { s: initial, id } = prepared();
    let s = initial;
    s = run(user(s, 2), { type: "apply-help", helpId: id, message: "" });
    s = run(user(s, 1), { type: "cancel-help", helpId: id });
    expect(s.helpApplications[0].status).toBe("rejected");
    expect(() =>
      run(user(s, 3), { type: "apply-help", helpId: id, message: "" }),
    ).toThrow("关闭");
    const second = assigned();
    const cancelled = run(second.s, { type: "cancel-help", helpId: second.id });
    expect(cancelled.helpApplications[0].status).toBe("accepted");
    expect(() =>
      run(user(cancelled, 2), { type: "helper-done", helpId: second.id }),
    ).toThrow("状态");
    expect(() =>
      run(cancelled, {
        type: "assign-help",
        helpId: second.id,
        applicationId: cancelled.helpApplications[0].id,
      }),
    ).toThrow("关闭");
  });
  it("开始时间边界禁止申请、接受和取消，assigned 可事后完成", () => {
    const { s, id } = prepared();
    const start = new Date(s.helpRequests[0].startAt);
    expect(() =>
      execute(
        user(s, 2),
        { type: "apply-help", helpId: id, message: "" },
        start,
      ),
    ).toThrow("过期");
    let applied = run(user(s, 2), {
      type: "apply-help",
      helpId: id,
      message: "",
    });
    applied = user(applied, 1);
    expect(() =>
      execute(
        applied,
        {
          type: "assign-help",
          helpId: id,
          applicationId: applied.helpApplications[0].id,
        },
        start,
      ),
    ).toThrow("过期");
    const a = assigned();
    expect(() =>
      execute(a.s, { type: "cancel-help", helpId: a.id }, start),
    ).toThrow("未开始");
    const done = execute(
      user(a.s, 2),
      { type: "helper-done", helpId: a.id },
      start,
    );
    expect(done.helpRequests[0].status).toBe("helper_done");
    expect(() =>
      run(user(done, 1), { type: "cancel-help", helpId: a.id }),
    ).toThrow("未开始");
  });
  it("只允许无有效申请的 open 编辑；校验归属、时间、长度与 revision", () => {
    const { s, id } = prepared();
    expect(() =>
      run(user(s, 2), {
        type: "save-help",
        helpId: id,
        expectedRevision: 1,
        input,
      }),
    ).toThrow("求助人");
    expect(() =>
      run(s, { type: "save-help", helpId: id, expectedRevision: 0, input }),
    ).toThrow("更新");
    expect(() =>
      run(s, { type: "save-help", input: { ...input, petId: "pet-2" } }),
    ).toThrow("本人");
    expect(() =>
      run(s, { type: "save-help", input: { ...input, endAt: input.startAt } }),
    ).toThrow();
    expect(() =>
      run(s, {
        type: "save-help",
        input: { ...input, startAt: now.toISOString() },
      }),
    ).toThrow("未来");
    expect(() =>
      run(s, {
        type: "save-help",
        input: { ...input, details: "x".repeat(1001) },
      }),
    ).toThrow();
    const edited = run(s, {
      type: "save-help",
      helpId: id,
      expectedRevision: 1,
      input: { ...input, type: "feed" },
    });
    expect(edited.helpRequests[0].type).toBe("feed");
    expect(checklistCurrent(edited, edited.helpRequests[0])).toBe(false);
    const applied = user(
      run(user(s, 2), { type: "apply-help", helpId: id, message: "" }),
      1,
    );
    expect(() =>
      run(applied, {
        type: "save-help",
        helpId: id,
        expectedRevision: 1,
        input,
      }),
    ).toThrow("有效申请");
    const a = assigned();
    expect(() =>
      run(a.s, {
        type: "save-help",
        helpId: a.id,
        expectedRevision: 2,
        input,
      }),
    ).toThrow();
  });
  it("清单来源变更失效、越权与过期草稿拒绝；重新确认后可继续", () => {
    const { s: initial, id } = assigned();
    let s = initial;
    const originalPet = s.pets[0];
    s = run(s, {
      type: "save-pet",
      petId: originalPet.id,
      input: petInputSchema.parse(
        Object.fromEntries(
          Object.entries(originalPet).filter(
            ([k]) =>
              ![
                "id",
                "ownerId",
                "archivedAt",
                "createdAt",
                "updatedAt",
                "revision",
              ].includes(k),
          ),
        ),
      ),
    });
    expect(checklistCurrent(s, s.helpRequests[0])).toBe(false);
    expect(() => run(user(s, 2), { type: "helper-done", helpId: id })).toThrow(
      "失效",
    );
    expect(() =>
      run(s, {
        type: "save-checklist",
        helpId: id,
        petRevision: 1,
        requestRevision: 1,
        input: checklist,
      }),
    ).toThrow("来源");
    expect(() =>
      run(user(s, 2), {
        type: "save-checklist",
        helpId: id,
        petRevision: 2,
        requestRevision: 1,
        input: checklist,
      }),
    ).toThrow("求助人");
    s = run(s, {
      type: "save-checklist",
      helpId: id,
      petRevision: 2,
      requestRevision: 1,
      input: checklist,
    });
    s = run(user(s, 2), { type: "helper-done", helpId: id });
    expect(s.helpRequests[0].status).toBe("helper_done");
  });
  it("帮助中或等待双方确认时保护宠物，不能提前归档", () => {
    const { s, id } = assigned();
    expect(() => run(s, { type: "delete-pet", petId: "pet-1" })).toThrow(
      "互助",
    );
    const done = run(user(s, 2), { type: "helper-done", helpId: id });
    expect(() =>
      run(user(done, 1), { type: "delete-pet", petId: "pet-1" }),
    ).toThrow("互助");
  });
  it("拒绝损坏的帮助者、清单、申请、事件引用", () => {
    const { s } = assigned();
    const invalid = [
      () => {
        const t = structuredClone(s);
        t.helpRequests[0].helperId = "user-3";
        return t;
      },
      () => {
        const t = structuredClone(s);
        t.helpApplications[0].helpId = "missing";
        return t;
      },
      () => {
        const t = structuredClone(s);
        t.careChecklists[0].confirmedBy = "user-2";
        return t;
      },
      () => {
        const t = structuredClone(s);
        t.helpEvents[0].actorId = "missing";
        return t;
      },
    ];
    invalid.forEach((make) =>
      expect(stateSchema.safeParse(make()).success).toBe(false),
    );
  });
});
describe("主人名片与确定性偏好", () => {
  it("只有主人确认，校验版本与长度，档案变更后名片失效", () => {
    let s = createSeed(now);
    expect(() =>
      run(user(s, 2), {
        type: "save-card",
        petId: "pet-1",
        petRevision: 1,
        input: card,
      }),
    ).toThrow("主人");
    expect(() =>
      run(s, {
        type: "save-card",
        petId: "pet-1",
        petRevision: 2,
        input: card,
      }),
    ).toThrow("复核");
    expect(() =>
      run(s, {
        type: "save-card",
        petId: "pet-1",
        petRevision: 1,
        input: { ...card, likes: Array(7).fill("追逐") },
      }),
    ).toThrow();
    s = run(s, {
      type: "save-card",
      petId: "pet-1",
      petRevision: 1,
      input: card,
    });
    expect(cardFor(s, s.pets[0])).toBeDefined();
    const changed = structuredClone(s);
    changed.pets[0].revision++;
    expect(cardFor(changed, changed.pets[0])).toBeUndefined();
  });
  it("双向精确冲突、未知不推断、旧名片不参与规则，没有安全分", () => {
    let s = createSeed(now);
    s.pets[0].temperamentTags = [];
    s.pets[1].temperamentTags = [];
    s = run(s, {
      type: "save-card",
      petId: "pet-1",
      petRevision: 1,
      input: { ...card, dislikes: ["分享玩具"] },
    });
    s = run(user(s, 2), {
      type: "save-card",
      petId: "pet-2",
      petRevision: 1,
      input: { ...card, likes: ["分享玩具"], dislikes: ["追逐"] },
    });
    expect(comparePets(s, s.pets[0], s.pets[1]).conflicts).toHaveLength(2);
    s.pets[0].revision++;
    expect(comparePets(s, s.pets[0], s.pets[1]).conflicts).toHaveLength(0);
    expect(comparePets(s, s.pets[0], s.pets[1]).incomplete).toBe(true);
    s.pets[0].temperamentTags = ["喜欢追逐"];
    s.pets[1].temperamentTags = ["怕追逐"];
    expect(comparePets(s, s.pets[0], s.pets[1]).conflicts).toHaveLength(1);
  });
});
describe("v1 → v2 无损迁移", () => {
  it("纯读取不改原文，下一次成功命令原子保存新版本", () => {
    const seed = createSeed(now);
    const legacy = {
      ...seed,
      schemaVersion: 1,
      helpRequests: seed.helpRequests.map((h) =>
        Object.fromEntries(
          Object.entries(h).filter(
            ([k]) =>
              ![
                "helperId",
                "acceptedApplicationId",
                "contentRevision",
              ].includes(k),
          ),
        ),
      ),
    };
    let raw = JSON.stringify(legacy);
    const original = raw;
    const store = {
      getItem: () => raw,
      setItem: (_: string, value: string) => {
        raw = value;
      },
    };
    const migrated = readState(store);
    expect(raw).toBe(original);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.posts).toEqual(seed.posts);
    expect(migrated.helpRequests[0]).toMatchObject({
      helperId: null,
      acceptedApplicationId: null,
      contentRevision: 1,
    });
    commit(store, migrated, { type: "switch-user", userId: "user-2" });
    expect(JSON.parse(store.getItem()).schemaVersion).toBe(2);
  });
  it("损坏旧数据不被迁移；迁移后的保存失败保留原文", () => {
    let raw = JSON.stringify({ ...createSeed(now), schemaVersion: 1 });
    const store = {
      getItem: () => raw,
      setItem: () => {
        throw Error("quota");
      },
    };
    expect(() => readState(store)).toThrow("损坏");
    const seed = createSeed(now);
    raw = JSON.stringify({
      ...seed,
      schemaVersion: 1,
      helpRequests: seed.helpRequests.map(
        ({ helperId, acceptedApplicationId, contentRevision, ...h }) => {
          void helperId;
          void acceptedApplicationId;
          void contentRevision;
          return h;
        },
      ),
    });
    const original = raw;
    expect(() =>
      commit(store, readState(store), {
        type: "switch-user",
        userId: "user-2",
      }),
    ).toThrow("保存失败");
    expect(raw).toBe(original);
  });
});
