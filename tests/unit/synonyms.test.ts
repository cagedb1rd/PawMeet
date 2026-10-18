import { describe, expect, it } from "vitest";
import {
  activityRecommendations,
  executeCompanionTool,
  queryIntent,
} from "@/lib/ai/companion";
import { validateOutput } from "@/lib/ai/validation";
import { CompanionIntent, emptyMatch } from "@/lib/ai/contracts";
import { positiveEvidence, softTagsIn, tagEvidence } from "@/lib/ai/synonyms";
import { createSeed, demoPlaces } from "@/data/seed";
import { DEFAULT_REFERENCE } from "@/domain/geo";
const now = new Date("2026-10-17T02:00:00Z");
const intent = (patch: Partial<CompanionIntent> = {}): CompanionIntent => ({
  mode: "search",
  match: { ...emptyMatch },
  startAt: null,
  endAt: null,
  timeText: "下周六下午",
  activityType: "散步",
  placeQuery: null,
  preferences: [],
  hardRequirements: [],
  clarifications: [],
  warnings: [],
  ...patch,
});
const extract = (text: string, raw: CompanionIntent) =>
  validateOutput(
    "companion-intent",
    raw,
    { text, context: {} },
    now,
  ) as CompanionIntent;

describe("program-owned synonym table", () => {
  it.each([
    ["性格随和", "温和"],
    ["好相处一点", "温和"],
    ["脾气好", "温和"],
    ["友善", "温和"],
    ["遛弯", "散步"],
    ["溜达溜达", "散步"],
    ["好动", "活泼"],
    ["精力旺盛", "活泼"],
    ["黏人", "亲人"],
    ["认生", "慢热"],
    ["夜跑", "一起慢跑"],
    ["晒晒太阳", "晒太阳"],
    ["非常温和", "温和"],
  ])("maps %s to %s", (phrase, tag) => {
    expect(softTagsIn(phrase).map((h) => h.tag)).toContain(tag);
  });
  it("prefers the longer word: 不黏人 is 独立, never 亲人", () => {
    expect(softTagsIn("希望不黏人").map((h) => h.tag)).toEqual(["独立"]);
  });
  it.each(["不要太活泼", "别太好动", "没那么黏人", "不太好相处也行"])(
    "negated wording is not a positive wish: %s",
    (phrase) => {
      expect(softTagsIn(phrase)).toEqual([]);
    },
  );
  it("a place wish such as 草地 is evidence only, never mapped to an activity", () => {
    expect(softTagsIn("最好附近有草地")).toEqual([]);
    expect(tagEvidence["草地撒欢"].test("最好附近有草地")).toBe(true);
  });
  it("怕追逐 keeps its built-in negation", () => {
    expect(positiveEvidence("怕追逐", "它怕被追赶")).toBe(true);
    expect(softTagsIn("它怕被追赶")).toEqual([]);
  });
});

describe("companion intent synonym mapping keeps hard guards", () => {
  it("maps paraphrased preferences to soft tags and stays searchable", () => {
    const text = "下周六下午想溜达一圈，希望对方性格随和";
    const r = extract(
      text,
      intent({ activityType: "溜达", preferences: ["希望对方性格随和"] }),
    );
    expect(r.match.temperaments).toEqual(["温和"]);
    expect(r.match.clarifications).toEqual([]);
    expect(r.match.unmappedTerms).toEqual([]);
    expect(r.warnings.join("")).toContain("“随和”→温和");
    expect(() => queryIntent(r, now)).not.toThrow();
    expect(r.match.sizes).toEqual([]);
    expect(r.match.excludedSizes).toEqual([]);
  });
  it("maps soft unmapped terms instead of leaving them for the model", () => {
    const r = extract(
      "下周六下午散步，想找好动、爱跑步的狗",
      intent({ match: { ...emptyMatch, unmappedTerms: ["好动", "爱跑步"] } }),
    );
    expect(r.match.temperaments).toEqual(["活泼"]);
    expect(r.match.activities).toContain("一起慢跑");
    expect(r.match.unmappedTerms).toEqual([]);
    expect(() => queryIntent(r, now)).not.toThrow();
  });
  it("unmappable soft wording still only warns", () => {
    const r = extract(
      "下周六下午散步，想找能一起玩的",
      intent({ match: { ...emptyMatch, unmappedTerms: ["一起玩"] } }),
    );
    expect(r.match.unmappedTerms).toEqual([]);
    expect(r.warnings.join("")).toContain("自由偏好");
    expect(() => queryIntent(r, now)).not.toThrow();
  });
  it("hard wording is never softened by the synonym table", () => {
    const r = extract(
      "下周六下午散步，必须随和",
      intent({ match: { ...emptyMatch, unmappedTerms: ["随和"] } }),
    );
    expect(r.match.unmappedTerms).toEqual(["随和"]);
    expect(r.match.temperaments).toEqual([]);
    expect(() => queryIntent(r, now)).toThrow("硬条件");
  });
  it("不要大型犬 never becomes a size whitelist even with mapped synonyms", () => {
    const text = "下周六下午遛弯，希望好相处，不要大型犬";
    const raw = intent({
      activityType: "遛弯",
      preferences: ["希望好相处"],
      match: {
        ...emptyMatch,
        sizes: ["small", "medium"],
        excludedSizes: ["large"],
      },
    });
    expect(() => extract(text, raw)).toThrow("体型缺少用户描述依据");
    const ok = extract(text, { ...raw, match: { ...raw.match, sizes: [] } });
    expect(ok.match.sizes).toEqual([]);
    expect(ok.match.excludedSizes).toEqual(["large"]);
    expect(ok.match.temperaments).toEqual(["温和"]);
  });
  it("a temperament exclusion is not turned into its complement", () => {
    const r = extract(
      "下周六下午散步，不要活泼的狗",
      intent({
        match: {
          ...emptyMatch,
          temperaments: ["温和", "慢热", "独立"],
          excludedTemperaments: ["活泼"],
        },
      }),
    );
    expect(r.match.temperaments).toEqual([]);
    expect(r.match.excludedTemperaments).toEqual(["活泼"]);
  });
  it("an explicit exclusion wins over a mapped soft wish", () => {
    const r = extract(
      "下周六下午散步，最好好动，但不要活泼过头的",
      intent({
        preferences: ["最好好动"],
        match: { ...emptyMatch, excludedTemperaments: ["活泼"] },
      }),
    );
    expect(r.match.temperaments).not.toContain("活泼");
    expect(r.match.excludedTemperaments).toEqual(["活泼"]);
  });
  it("describing the user's own pet is not a companion wish", () => {
    const r = extract(
      "下周六下午散步，我家狗很黏人，希望对方温和",
      intent({ preferences: ["我家狗很黏人", "希望对方温和"] }),
    );
    expect(r.match.temperaments).toEqual(["温和"]);
  });
  it("unsupported distance still asks rather than widens with synonyms present", () => {
    const r = extract(
      "下周六下午溜达，好相处的，2公里内",
      intent({ activityType: "溜达" }),
    );
    expect(() => queryIntent(r, now)).toThrow("硬条件");
  });
  it("model-invented positive tag without evidence is still dropped", () => {
    const r = extract(
      "下周六下午散步",
      intent({ match: { ...emptyMatch, temperaments: ["亲人"] } }),
    );
    expect(r.match.temperaments).toEqual([]);
  });
  it("match-intent accepts synonym evidence but still rejects extra tags", () => {
    const accepted = validateOutput(
      "match-intent",
      { ...emptyMatch, temperaments: ["温和"] },
      { text: "找性格随和的狗", context: {} },
      now,
    ) as typeof emptyMatch;
    expect(accepted.temperaments).toEqual(["温和"]);
    expect(() =>
      validateOutput(
        "match-intent",
        { ...emptyMatch, temperaments: ["温和", "慢热"] },
        { text: "找性格随和的狗", context: {} },
        now,
      ),
    ).toThrow("筛选标签缺少");
  });
});

describe("synonym-derived intents in deterministic tools", () => {
  it.each(["溜达", "溜弯", "遛遛"])(
    "walking synonym %s matches walking activities",
    (activityType) => {
      const state = createSeed(now),
        base = state.activities[0];
      state.activitySignups = [];
      state.activities = [
        {
          ...base,
          title: "一起散步",
          description: "散步",
          startAt: "2026-10-24T06:00:00Z",
          endAt: "2026-10-24T07:00:00Z",
          place: { ...demoPlaces[1] },
        },
      ];
      const r = activityRecommendations(
        state,
        DEFAULT_REFERENCE,
        intent({ activityType, match: { ...emptyMatch, radiusKm: 10 } }),
        now,
      );
      expect(r.kind === "activities" && r.rows.length).toBe(1);
    },
  );
  it("search_pets keeps size exclusion and unknown-size exclusion after synonym mapping", async () => {
    const state = createSeed(now);
    const own = state.pets.find((p) => p.ownerId === state.activeUserId)!;
    const r = extract(
      "下周六下午遛弯，希望好相处，不要大型犬，10公里内",
      intent({
        activityType: "遛弯",
        preferences: ["希望好相处"],
        match: { ...emptyMatch, radiusKm: 10, excludedSizes: ["large"] },
      }),
    );
    const result = await executeCompanionTool(
      {
        id: "pets",
        type: "function",
        function: { name: "search_pets", arguments: "{}" },
      },
      state,
      DEFAULT_REFERENCE,
      own.id,
      r,
      "organize",
      {},
      now,
    );
    expect(result.kind).toBe("pets");
    const ids = result.kind === "pets" ? result.rows.map((p) => p.id) : [];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const pet = state.pets.find((p) => p.id === id)!;
      expect(["large", "unknown"]).not.toContain(pet.size);
    }
  });
});
