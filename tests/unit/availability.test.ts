import { describe, expect, it } from "vitest";
import { resolveAvailability } from "@/lib/ai/availability";
import {
  activityRecommendations,
  activityInputFromDraft,
  executeCompanionTool,
  queryIntent,
} from "@/lib/ai/companion";
import { validateOutput } from "@/lib/ai/validation";
import { CompanionIntent, emptyMatch } from "@/lib/ai/contracts";
import { createSeed, demoPlaces } from "@/data/seed";
import { activityInputSchema } from "@/domain/schemas";
import { CompanionCache } from "@/lib/ai/companion";
import { DEFAULT_REFERENCE } from "@/domain/geo";
const now = new Date("2026-10-17T02:00:00Z");
const input = (timeText: string | null): CompanionIntent => ({
  mode: "search",
  match: { ...emptyMatch },
  startAt: null,
  endAt: null,
  timeText,
  activityType: "散步",
  placeQuery: null,
  preferences: [],
  hardRequirements: [],
  clarifications: [],
  warnings: [],
});
describe("coarse availability is a query range, not an activity schedule", () => {
  it.each([
    ["周六下午", ["2026-10-17T04:00:00.000Z", "2026-10-17T10:00:00.000Z"]],
    [
      "周六下午或晚上",
      ["2026-10-17T04:00:00.000Z", "2026-10-17T16:00:00.000Z"],
    ],
    ["周六晚上", ["2026-10-17T10:00:00.000Z", "2026-10-17T16:00:00.000Z"]],
    ["明天下午", ["2026-10-18T04:00:00.000Z", "2026-10-18T10:00:00.000Z"]],
    ["后天晚上", ["2026-10-19T10:00:00.000Z", "2026-10-19T16:00:00.000Z"]],
    ["下周六下午", ["2026-10-24T04:00:00.000Z", "2026-10-24T10:00:00.000Z"]],
    ["周日下午", ["2026-10-18T04:00:00.000Z", "2026-10-18T10:00:00.000Z"]],
    [
      "2026-10-20 下午",
      ["2026-10-20T04:00:00.000Z", "2026-10-20T10:00:00.000Z"],
    ],
    [
      "2026年10月20日晚上",
      ["2026-10-20T10:00:00.000Z", "2026-10-20T16:00:00.000Z"],
    ],
    ["2026-10-20", ["2026-10-19T16:00:00.000Z", "2026-10-20T16:00:00.000Z"]],
  ])("%s resolves disclosed Shanghai query bounds", (text, bounds) => {
    const i = input(text as string),
      a = resolveAvailability(i, now);
    expect(a.windows).toEqual([{ startAt: bounds[0], endAt: bounds[1] }]);
    expect(a.broad).toBe(true);
    expect(a.label).toContain("查询范围");
    expect(i.startAt).toBeNull();
    expect(i.endAt).toBeNull();
  });
  it("morning OR evening keeps the afternoon gap", () => {
    const a = resolveAvailability(input("周六上午或晚上"), now);
    expect(a.windows).toHaveLength(2);
    expect(a.windows[0].endAt).toBe("2026-10-17T04:00:00.000Z");
    expect(a.windows[1].startAt).toBe("2026-10-17T10:00:00.000Z");
  });
  it("weekend keeps both dates visible", () => {
    const a = resolveAvailability(input("周末下午"), now);
    expect(a.windows).toHaveLength(2);
    expect(a.label).toContain("10月17日");
    expect(a.label).toContain("10月18日");
  });
  it("whole weekend merged range still names both days", () => {
    const a = resolveAvailability(input("周末"), now);
    expect(a.windows).toHaveLength(1);
    expect(a.label).toContain("10月18日");
  });
  it.each([null, "下午或晚上", "改天散步"])(
    "asks only for a date when none exists: %s",
    (text) =>
      expect(() => resolveAvailability(input(text), now)).toThrow("哪天"),
  );
  it.each(["上周六下午", "本周五下午", "2026-02-30下午", "今天上午"])(
    "does not silently move past or invalid dates: %s",
    (text) => {
      const clock =
        text === "今天上午" ? new Date("2026-10-17T07:00:00Z") : now;
      expect(() => resolveAvailability(input(text), clock)).toThrow();
    },
  );
  it("does not add an excluded evening window", () =>
    expect(
      resolveAvailability(input("周六下午，不要晚上"), now).windows[0].endAt,
    ).toBe("2026-10-17T10:00:00.000Z"));
  it("respects explicit exact bounds when provided", () => {
    const i = {
      ...input(null),
      startAt: "2026-10-20T06:00:00Z",
      endAt: "2026-10-20T07:00:00Z",
    };
    expect(resolveAvailability(i, now).broad).toBe(false);
  });
  it("query accepts coarse time but still rejects unsupported hard radius", () => {
    expect(queryIntent(input("周六下午"), now).startAt).toBeNull();
    expect(() =>
      queryIntent(
        {
          ...input("周六下午"),
          match: { ...emptyMatch, clarifications: ["2公里不支持"] },
        },
        now,
      ),
    ).toThrow("硬条件");
  });
  it("activity recommendations match both afternoon and evening, not morning", () => {
    const state = createSeed(now),
      base = state.activities[0];
    state.activitySignups = [];
    state.activities = [6, 11, 2].map((h, index) => ({
      ...base,
      id: `coarse-${index}`,
      title: "一起散步",
      startAt: `2026-10-17T${String(h).padStart(2, "0")}:00:00Z`,
      endAt: `2026-10-17T${String(h + 1).padStart(2, "0")}:00:00Z`,
      place: { ...demoPlaces[1] },
    }));
    const result = activityRecommendations(
      state,
      DEFAULT_REFERENCE,
      input("周六下午或晚上"),
      now,
    );
    expect(result.kind).toBe("activities");
    if (result.kind === "activities")
      expect(result.rows.map((r) => r.id).sort()).toEqual([
        "coarse-0",
        "coarse-1",
      ]);
  });
});
describe("reported natural-language preference regression", () => {
  const text = "周六下午或晚上带我的狗散散步 希望有一起玩的狗狗 最好性格好些";
  const model = () => ({
    ...input("周六下午"),
    match: {
      ...emptyMatch,
      temperaments: ["温和"],
      activities: ["草地撒欢"],
      unmappedTerms: ["一起玩", "性格好些"],
      clarifications: ["请先填写精确起止时间"],
    },
    preferences: ["性格温和", "找一起玩的宠友"],
    clarifications: ["请填写具体到分钟的起止时间"],
  });
  it("keeps the user's soft words and does not reject the whole request", () => {
    const r = validateOutput(
      "companion-intent",
      model(),
      { text, context: {} },
      now,
    ) as CompanionIntent;
    expect(r.match.temperaments).toEqual(["温和"]);
    expect(r.match.activities).toEqual([]);
    expect(r.match.unmappedTerms).toEqual([]);
    expect(r.match.clarifications).toEqual([]);
    expect(r.clarifications).toEqual([]);
    expect(r.preferences).toContain("最好性格好些");
    expect(r.preferences).not.toContain("性格温和");
    expect(r.warnings.join("；")).toContain("需向主人核实");
    expect(resolveAvailability(r, now).windows[0].endAt).toBe(
      "2026-10-17T16:00:00.000Z",
    );
  });
  it("does not copy guessed exact model times into an activity draft", () => {
    const r = validateOutput(
      "companion-intent",
      {
        ...model(),
        startAt: "2026-10-17T04:00:00Z",
        endAt: "2026-10-17T10:00:00Z",
      },
      { text, context: {} },
      now,
    ) as CompanionIntent;
    expect(r.startAt).toBeNull();
    expect(r.endAt).toBeNull();
    expect(r.warnings.join("；")).toContain("未采用模型猜测");
  });
  it("an explicit hard exclusion without source evidence is still rejected", () => {
    expect(() =>
      validateOutput(
        "companion-intent",
        { ...model(), match: { ...emptyMatch, excludedSizes: ["large"] } },
        { text, context: {} },
        now,
      ),
    ).toThrow("体型缺少用户描述依据");
  });
  it("unknown hard conditions remain blocking instead of being downgraded to soft preferences", () => {
    const source = "周六下午散步，必须犬类X认证";
    const r = validateOutput(
      "companion-intent",
      {
        ...input("周六下午"),
        match: { ...emptyMatch, unmappedTerms: ["必须犬类X认证"] },
      },
      { text: source, context: {} },
      now,
    ) as CompanionIntent;
    expect(() => queryIntent(r, now)).toThrow("硬条件");
  });
  it("a proposed admission guarantee still cannot enter the UI as a soft preference", () =>
    expect(() =>
      validateOutput(
        "companion-intent",
        { ...model(), preferences: ["保证允许携犬"] },
        { text, context: {} },
        now,
      ),
    ).toThrow("无原文依据"));
});

describe("general availability and hard-bound regressions", () => {
  it.each([
    ["周末不要周六", "2026-10-17T16:00:00.000Z", "2026-10-18T16:00:00.000Z"],
    ["周六不要晚上", "2026-10-16T16:00:00.000Z", "2026-10-17T10:00:00.000Z"],
    [
      "周六上午或晚上，不要上午",
      "2026-10-17T10:00:00.000Z",
      "2026-10-17T16:00:00.000Z",
    ],
  ])("subtracts exclusions: %s", (text, startAt, endAt) => {
    expect(resolveAvailability(input(text), now).windows).toEqual([
      { startAt, endAt },
    ]);
  });
  it.each(["周六下午不要下午", "不要周六下午"])(
    "does not query fully excluded dates/times: %s",
    (text) => {
      expect(() => resolveAvailability(input(text), now)).toThrow();
    },
  );
  it.each(["3公里内", "三公里以内", "1公里以内", "10km内"])(
    "preserves explicit upper limit: %s",
    (distance) => {
      const source = `下周六下午散步，${distance}`;
      const r = validateOutput(
        "companion-intent",
        input("下周六下午"),
        { text: source, context: {} },
        now,
      ) as CompanionIntent;
      expect(r.match.radiusKm).toBe(
        distance.startsWith("1") ? (distance.startsWith("10") ? 10 : 1) : 3,
      );
      expect(r.match.clarifications).toEqual([]);
    },
  );
  it.each(["2公里内", "1.5公里内", "3公里以外", "3公里或者5公里"])(
    "unsupported or conflicting bound asks rather than widens: %s",
    (distance) => {
      const r = validateOutput(
        "companion-intent",
        input("周六下午"),
        { text: `周六下午散步，${distance}`, context: {} },
        now,
      ) as CompanionIntent;
      expect(() => queryIntent(r, now)).toThrow("硬条件");
    },
  );
  it.each(["好相处一点", "随和一点", "脾气好", "友好"])(
    "ordinary soft paraphrase remains searchable: %s",
    (soft) => {
      const r = validateOutput(
        "companion-intent",
        {
          ...input("下周六下午"),
          match: { ...emptyMatch, temperaments: ["温和"] },
          preferences: ["性格温和"],
        },
        { text: `下周六下午散步，最好${soft}`, context: {} },
        now,
      ) as CompanionIntent;
      expect(r.clarifications).toEqual([]);
      expect(r.match.temperaments).toEqual(["温和"]);
      expect(r.warnings.length).toBeGreaterThan(0);
    },
  );
  it("coarse organize draft never invents a publication schedule", async () => {
    const state = createSeed(now),
      own = state.pets.find((p) => p.ownerId === state.activeUserId)!;
    const cache: CompanionCache = { places: [demoPlaces[1]] };
    const before = JSON.stringify(state);
    const result = await executeCompanionTool(
      {
        id: "draft",
        type: "function",
        function: {
          name: "create_activity_draft",
          arguments: JSON.stringify({
            title: "散步",
            description: "",
            petIds: [],
            placeIndex: 0,
          }),
        },
      },
      state,
      DEFAULT_REFERENCE,
      own.id,
      input("下周六下午"),
      "organize",
      cache,
      now,
    );
    expect(result.kind).toBe("activity-draft");
    const draft = activityInputFromDraft(cache, input("下周六下午"), own.id);
    expect(draft.startAt).toBeUndefined();
    expect(draft.endAt).toBeUndefined();
    expect(activityInputSchema.safeParse(draft).success).toBe(false);
    expect(JSON.stringify(state)).toBe(before);
  });
});

it.each(["遛弯", "遛狗"])(
  "equivalent walking types match actual walking activities: %s",
  (activityType) => {
    const state = createSeed(now),
      base = state.activities[0];
    state.activitySignups = [];
    state.activities = [
      {
        ...base,
        title: "一起散步",
        description: "散步",
        startAt: "2026-10-17T06:00:00Z",
        endAt: "2026-10-17T07:00:00Z",
        place: { ...demoPlaces[1] },
      },
    ];
    const r = activityRecommendations(
      state,
      DEFAULT_REFERENCE,
      { ...input("周六下午"), activityType },
      now,
    );
    expect(r.kind).toBe("activities");
    if (r.kind === "activities")
      expect(r.rows.map((row) => row.id)).toEqual([base.id]);
  },
);

it.each([
  "周六下午或周日晚上",
  "明天上午，后天下午",
  "2026-10-20上午或2026-10-21晚上",
])(
  "does not combine day-specific alternatives into invented cross-product: %s",
  (timeText) => {
    expect(() => resolveAvailability(input(timeText), now)).toThrow("不同日期");
  },
);
