import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createSeed, demoPlaces } from "@/data/seed";
import { DEFAULT_REFERENCE } from "@/domain/geo";
import {
  CompanionIntent,
  ToolCall,
  ToolResult,
  companionIntentSchema,
  emptyMatch,
  nativeToolSchemas,
  toolResultSchema,
} from "@/lib/ai/contracts";
import {
  activityRecommendations,
  confirmedIntent,
  radiusEdit,
  executeCompanionTool,
  CompanionCache,
  activityInputFromDraft,
} from "@/lib/ai/companion";
import { checklistTemplate } from "@/lib/ai/templates";
import { validateOutput } from "@/lib/ai/validation";
import { assistantStep } from "@/server/ai/service";
import { callModel } from "@/server/ai/client";
import { unseal, seal } from "@/server/ai/session";
import { aiAssistant } from "@/lib/ai/client";
const now = new Date("2026-10-17T02:00:00Z");
function setup() {
  const state = createSeed(now);
  const own = state.pets.find((p) => p.ownerId === state.activeUserId)!;
  const other = state.pets.find((p) => p.ownerId !== state.activeUserId)!;
  const a = state.activities[0];
  a.startAt = "2026-10-20T06:00:00Z";
  a.endAt = "2026-10-20T07:00:00Z";
  a.title = "一起散步";
  a.description = "一起散步";
  a.place = { ...demoPlaces[1] };
  a.capacity = 12;
  state.activities = [a];
  other.demoLocation = { ...DEFAULT_REFERENCE };
  const intent: CompanionIntent = {
    mode: "search",
    match: { ...emptyMatch, radiusKm: 3 },
    startAt: "2026-10-20T05:00:00Z",
    endAt: "2026-10-20T09:00:00Z",
    timeText: "周二下午",
    activityType: "散步",
    placeQuery: null,
    preferences: [],
    hardRequirements: [],
    clarifications: [],
    warnings: [],
  };
  return { state, own, other, a, intent };
}
const tc = (name: string, args: unknown = {}, id = name): ToolCall => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
function rows(result: ToolResult) {
  expect(result.kind).toBe("activities");
  return result.kind === "activities" ? result.rows : [];
}
beforeEach(() => vi.stubEnv("DEMO_SESSION_SECRET", "offline-unit-only"));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("Phase 4.5 deterministic constraints", () => {
  it("recommends actual available activity with remaining capacity and uncertainty", () => {
    const { state, intent, a } = setup();
    const r = rows(
      activityRecommendations(state, DEFAULT_REFERENCE, intent, now),
    );
    expect(r[0].id).toBe(a.id);
    expect(r[0].remaining).toBeGreaterThan(0);
    expect(r[0].differences).toContain("场地宠物准入未核实");
  });
  it.each([
    "cancelled",
    "past",
    "full",
    "outside",
    "unknown-location",
    "early",
    "late",
    "district",
    "type",
    "hard-unknown",
  ])("excludes activity: %s", (kind) => {
    const { state, intent, a } = setup();
    if (kind === "cancelled") a.status = "cancelled";
    if (kind === "past") a.startAt = "2026-10-16T06:00:00Z";
    if (kind === "full") a.capacity = 0;
    if (kind === "outside")
      a.place.location = { ...DEFAULT_REFERENCE, lng: 121 };
    if (kind === "unknown-location") a.place.location = null;
    if (kind === "early") a.startAt = "2026-10-20T04:00:00Z";
    if (kind === "late") a.endAt = "2026-10-20T10:00:00Z";
    if (kind === "district") intent.match.district = "不存在区";
    if (kind === "type") intent.activityType = "飞盘";
    if (kind === "hard-unknown") intent.hardRequirements = ["必须允许携犬"];
    expect(
      rows(activityRecommendations(state, DEFAULT_REFERENCE, intent, now)),
    ).toEqual([]);
  });
  it("soft preferences remain partial and visible", () => {
    const { state, intent } = setup();
    intent.preferences = ["希望有草坪"];
    intent.match.temperaments = ["慢热"];
    const r = rows(
      activityRecommendations(state, DEFAULT_REFERENCE, intent, now),
    );
    expect(r).toHaveLength(1);
    expect(r[0].differences).toContain("偏好“希望有草坪”未核实");
  });
  it.each(["sizes", "breeds", "temperaments", "activities"])(
    "checks explicit exclusion %s against participants",
    (field) => {
      const { state, intent, a, other } = setup();
      state.activitySignups = [
        {
          ...state.activitySignups[0],
          activityId: a.id,
          petId: other.id,
          status: "joined",
        },
      ];
      if (field === "sizes") intent.match.excludedSizes = [other.size];
      if (field === "breeds") intent.match.excludedBreeds = [other.breed];
      if (field === "temperaments") {
        other.temperamentTags = ["怕追逐"];
        intent.match.excludedTemperaments = ["怕追逐"];
      }
      if (field === "activities") {
        other.activityTags = ["散步"];
        intent.match.excludedActivities = ["散步"];
      }
      expect(
        rows(activityRecommendations(state, DEFAULT_REFERENCE, intent, now)),
      ).toEqual([]);
    },
  );
  it.each([
    "missing-start",
    "missing-end",
    "reversed",
    "past",
    "unmapped",
    "clarification",
  ])("clarifies invalid condition %s", (kind) => {
    const { intent } = setup();
    if (kind === "missing-start") intent.startAt = null;
    if (kind === "missing-end") intent.endAt = null;
    if (kind === "reversed") intent.endAt = intent.startAt;
    if (kind === "past") intent.startAt = "2020-01-01T00:00:00Z";
    if (kind === "unmapped") intent.match.unmappedTerms = ["不明确"];
    if (kind === "clarification") intent.match.clarifications = ["冲突距离"];
    expect(() => confirmedIntent(intent, now)).toThrow();
  });
  it.each([
    ["扩大到5公里", 5],
    ["缩小到一公里", 1],
    ["改为10公里", 10],
    ["改到三公里", 3],
  ] as const)("radius edit %s preserves all other conditions", (text, n) => {
    const { intent } = setup();
    intent.match.excludedBreeds = ["柯基"];
    const edited = radiusEdit(text, intent)!;
    expect(edited.match.radiusKm).toBe(n);
    expect({ ...edited, match: { ...edited.match, radiusKm: 3 } }).toEqual(
      intent,
    );
    expect(intent.match.radiusKm).toBe(3);
  });
  it.each([
    "扩大到2公里",
    "随便放宽",
    "扩大到50公里",
    "扩大到5公里并去掉排斥条件",
  ])("does not silently apply unsupported edit %s", (text) =>
    expect(radiusEdit(text, setup().intent)).toBeNull(),
  );
  it("strict intent rejects model fabricated entities", () =>
    expect(
      companionIntentSchema.safeParse({
        ...setup().intent,
        petIds: ["made-up"],
      }).success,
    ).toBe(false));
  it("schema rejects fractional and coerced radius", () => {
    expect(
      nativeToolSchemas.search_pets.safeParse({ radiusKm: 1.5 }).success,
    ).toBe(false);
    expect(
      nativeToolSchemas.search_pets.safeParse({ radiusKm: "5" }).success,
    ).toBe(false);
  });
  it("schema rejects illegal draft write fields", () =>
    expect(
      nativeToolSchemas.create_activity_draft.safeParse({
        title: "x",
        description: "",
        petIds: [],
        placeIndex: 0,
        publish: true,
      }).success,
    ).toBe(false));
  it("extractive intent rejects invented preference", () => {
    const { intent } = setup();
    intent.preferences = ["允许携犬"];
    expect(() =>
      validateOutput(
        "companion-intent",
        intent,
        { text: "散步", context: {} },
        now,
      ),
    ).toThrow("原文");
  });
  it("care template reads existing notes and leaves confirmation items", () => {
    const r = checklistTemplate("不能松绳\n只吃原粮");
    expect(r.items.some((i) => i.detail === "只吃原粮")).toBe(true);
    expect(r.items.every((i) => i.needsConfirmation)).toBe(true);
    expect(r.items.length).toBeLessThanOrEqual(12);
  });
});
describe("Phase 4.5 browser tool execution", () => {
  it.each([
    "search_pets",
    "search_places",
    "create_activity_draft",
    "publish_activity",
    "join_activity",
  ])("search stage blocks %s", async (name) => {
    const { state, own, intent } = setup();
    const args =
      name === "search_places"
        ? { query: "公园" }
        : name === "create_activity_draft"
          ? { title: "x", description: "", petIds: [], placeIndex: 0 }
          : {};
    expect(
      (
        await executeCompanionTool(
          tc(name, args),
          state,
          DEFAULT_REFERENCE,
          own.id,
          intent,
          "search",
          {},
          now,
        )
      ).kind,
    ).toBe("error");
  });
  it("single activity tool overrides model widening with confirmed constraints", async () => {
    const { state, own, intent, a } = setup();
    a.place.location = { ...DEFAULT_REFERENCE, lng: 120.25 };
    expect(
      rows(
        await executeCompanionTool(
          tc("search_activities", { radiusKm: 10 }),
          state,
          DEFAULT_REFERENCE,
          own.id,
          intent,
          "search",
          {},
          now,
        ),
      ),
    ).toEqual([]);
  });
  it("direct create skips existing activity search", async () => {
    const { state, own, intent } = setup();
    intent.mode = "create";
    expect(
      (
        await executeCompanionTool(
          tc("search_activities"),
          state,
          DEFAULT_REFERENCE,
          own.id,
          intent,
          "organize",
          {},
          now,
        )
      ).kind,
    ).toBe("error");
  });
  it("rejects someone else's pet as organizer", async () => {
    const { state, other, intent } = setup();
    expect(
      (
        await executeCompanionTool(
          tc("search_activities"),
          state,
          DEFAULT_REFERENCE,
          other.id,
          intent,
          "search",
          {},
          now,
        )
      ).kind,
    ).toBe("error");
  });
  it("empty pets is a successful result without relaxing exclusion", async () => {
    const { state, own, intent } = setup();
    state.pets = state.pets.filter((p) => p.ownerId === state.activeUserId);
    const r = await executeCompanionTool(
      tc("search_pets"),
      state,
      DEFAULT_REFERENCE,
      own.id,
      intent,
      "organize",
      {},
      now,
    );
    expect(r).toEqual({ kind: "pets", rows: [] });
  });
  it.each(["empty", "failure", "timeout", "malformed"])(
    "place query distinguishes %s",
    async (kind) => {
      const { state, own, intent } = setup();
      const lookup = vi.fn().mockImplementation(async () => {
        if (kind === "failure") throw Error("429 配额错误");
        if (kind === "timeout") throw Error("高德服务超时");
        if (kind === "malformed") return [{}];
        return [];
      });
      const r = await executeCompanionTool(
        tc("search_places", { query: "公园" }),
        state,
        DEFAULT_REFERENCE,
        own.id,
        intent,
        "organize",
        {},
        now,
        lookup,
      );
      expect(r.kind).toBe(kind === "empty" ? "places" : "error");
      if (r.kind === "places") expect(r.rows).toEqual([]);
      expect(lookup).toHaveBeenCalledTimes(1);
    },
  );
  it("filters places with missing coordinates or out of radius", async () => {
    const { state, own, intent } = setup();
    const r = await executeCompanionTool(
      tc("search_places", { query: "公园" }),
      state,
      DEFAULT_REFERENCE,
      own.id,
      intent,
      "organize",
      {},
      now,
      async () => [
        { ...demoPlaces[0], source: "manual", location: null },
        { ...demoPlaces[1], location: { ...DEFAULT_REFERENCE, lng: 121 } },
        demoPlaces[1],
      ],
    );
    expect(r.kind).toBe("places");
    if (r.kind === "places") {
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].petAccess).toBe("unknown");
    }
  });
  it("parallel tools, compatibility, draft execute actual rules without writes", async () => {
    const { state, own, intent } = setup();
    const before = JSON.stringify(state),
      cache: CompanionCache = {};
    const exec = (call: ToolCall) =>
      executeCompanionTool(
        call,
        state,
        DEFAULT_REFERENCE,
        own.id,
        intent,
        "organize",
        cache,
        now,
        async () => [demoPlaces[1]],
      );
    const results = await Promise.all([
      exec(tc("search_pets")),
      exec(tc("search_places", { query: "公园" })),
    ]);
    expect(results.map((r) => r.kind)).toEqual(["pets", "places"]);
    const ids = cache.pets!.rows.slice(0, 2).map((p) => p.id);
    expect((await exec(tc("check_compatibility", { petIds: ids }))).kind).toBe(
      "compatibility",
    );
    expect(
      (
        await exec(
          tc("create_activity_draft", {
            title: "假装宠物友好",
            description: "自动发布",
            petIds: ids,
            placeIndex: 0,
          }),
        )
      ).kind,
    ).toBe("activity-draft");
    expect(cache.draft!.description).not.toContain("自动发布");
    expect(JSON.stringify(state)).toBe(before);
    vi.setSystemTime(now);
    const input = activityInputFromDraft(cache, intent, own.id);
    expect(input.place).toEqual(demoPlaces[1]);
    expect(input.recommendedPetIds).toEqual(ids);
    expect(input.capacity).toBe(6);
  });
  it.each(["unknown-id", "unknown-place", "unchecked-pet", "no-query"])(
    "draft blocks %s",
    async (kind) => {
      const { state, own, other, intent } = setup();
      const cache: CompanionCache =
        kind === "no-query"
          ? {}
          : {
              pets: {
                kind: "pets",
                rows: [
                  {
                    id: other.id,
                    name: other.name,
                    breed: other.breed,
                    district: other.district,
                    distanceM: 0,
                    score: 0,
                    reasons: [],
                  },
                ],
              },
              places: [demoPlaces[1]],
              compatibility: kind === "unchecked-pet" ? [] : [other.id],
            };
      const r = await executeCompanionTool(
        tc("create_activity_draft", {
          title: "x",
          description: "",
          petIds: [kind === "unknown-id" ? "fake" : other.id],
          placeIndex: kind === "unknown-place" ? 4 : 0,
        }),
        state,
        DEFAULT_REFERENCE,
        own.id,
        intent,
        "organize",
        cache,
        now,
      );
      expect(r.kind).toBe("error");
      expect(cache.draft).toBeUndefined();
    },
  );
  it("cached places avoid duplicate map request", async () => {
    const { state, own, intent } = setup();
    const cache: CompanionCache = {},
      lookup = vi.fn(async () => [demoPlaces[1]]);
    for (let n = 0; n < 2; n++)
      await executeCompanionTool(
        tc("search_places", { query: "公园" }),
        state,
        DEFAULT_REFERENCE,
        own.id,
        intent,
        "organize",
        cache,
        now,
        lookup,
      );
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it("invalid JSON is a tool error", async () => {
    const { state, own, intent } = setup();
    const call = tc("search_pets");
    call.function.arguments = "{";
    expect(
      (
        await executeCompanionTool(
          call,
          state,
          DEFAULT_REFERENCE,
          own.id,
          intent,
          "organize",
          {},
          now,
        )
      ).kind,
    ).toBe("error");
  });
});
const response = (calls: ToolCall[] = []) => ({
  message: {
    role: "assistant" as const,
    content: calls.length
      ? null
      : JSON.stringify({
          summary: "已查询，请查看实际结果卡片。",
          references: [],
        }),
    tool_calls: calls,
  },
  usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 },
  model: "offline-mock",
});
describe("Phase 4.5 signed native protocol offline", () => {
  it("search publishes only native activity tool and returns actual tool result to model", async () => {
    const { intent } = setup(),
      model = vi
        .fn<typeof callModel>()
        .mockResolvedValueOnce(response([tc("search_activities")]))
        .mockResolvedValueOnce(response());
    const first = await assistantStep(
      { text: "约伴", workflow: { intent, stage: "search" } },
      "session",
      "request",
      now,
      model,
    );
    const tools = model.mock.calls[0][3] as { function: { name: string } }[];
    expect(tools.map((t) => t.function.name)).toEqual(["search_activities"]);
    await assistantStep(
      {
        continuation: first.data.continuation,
        results: [
          {
            toolCallId: "search_activities",
            result: { kind: "activities", rows: [] },
          },
        ],
      },
      "session",
      "r2",
      now,
      model,
    );
    expect(
      model.mock.calls[1][0].some(
        (m) => m.role === "tool" && m.tool_call_id === "search_activities",
      ),
    ).toBe(true);
    expect(model.mock.calls[1][3]).toBeUndefined();
  });
  it("organization preserves native tools across successful intermediate result", async () => {
    const { intent } = setup(),
      model = vi
        .fn<typeof callModel>()
        .mockResolvedValueOnce(
          response([tc("search_pets"), tc("search_places", { query: "公园" })]),
        )
        .mockResolvedValueOnce(
          response([
            tc("create_activity_draft", {
              title: "x",
              description: "",
              petIds: [],
              placeIndex: 0,
            }),
          ]),
        );
    const a = await assistantStep(
      { text: "自己组局", workflow: { intent, stage: "organize" } },
      "s",
      "r",
      now,
      model,
    );
    await assistantStep(
      {
        continuation: a.data.continuation,
        results: [
          { toolCallId: "search_pets", result: { kind: "pets", rows: [] } },
          { toolCallId: "search_places", result: { kind: "places", rows: [] } },
        ],
      },
      "s",
      "r",
      now,
      model,
    );
    expect(model.mock.calls[1][3]).toBeDefined();
    expect(JSON.stringify(model.mock.calls[1][3])).not.toContain(
      '"name":"search_activities"',
    );
  });
  it("cannot replace signed workflow during continuation", async () => {
    const { intent } = setup(),
      model = vi
        .fn<typeof callModel>()
        .mockResolvedValue(response([tc("search_activities")]));
    const a = await assistantStep(
      { text: "约伴", workflow: { intent, stage: "search" } },
      "s",
      "r",
      now,
      model,
    );
    await expect(
      assistantStep(
        {
          continuation: a.data.continuation,
          workflow: { intent, stage: "organize" },
        },
        "s",
        "r",
        now,
        model,
      ),
    ).rejects.toMatchObject({ code: "AI_PROTOCOL" });
  });
  it("enforces signed round limit before model invocation", async () => {
    const { intent } = setup(),
      model = vi.fn<typeof callModel>().mockResolvedValue(response());
    const a = await assistantStep(
      { text: "约伴", workflow: { intent, stage: "search" } },
      "s",
      "r",
      now,
      model,
    );
    const st = unseal(a.data.continuation) as Record<string, unknown>;
    st.round = 4;
    st.pending = [tc("search_activities")];
    const bounded = vi.fn<typeof callModel>();
    await expect(
      assistantStep(
        {
          continuation: seal(st),
          results: [
            {
              toolCallId: "search_activities",
              result: { kind: "activities", rows: [] },
            },
          ],
        },
        "s",
        "r",
        now,
        bounded,
      ),
    ).rejects.toMatchObject({ code: "AI_TOOL_ROUND_LIMIT" });
    expect(bounded).not.toHaveBeenCalled();
  });
  it.each([429, 503, 504])(
    "UI client reports HTTP %s without successful fallback",
    async (status) => {
      const fetcher = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              requestId: "offline",
              error: { code: `HTTP_${status}`, message: "离线故障" },
            }),
            { status },
          ),
      );
      vi.stubGlobal("fetch", fetcher);
      await expect(aiAssistant({ text: "x" })).rejects.toThrow(
        `HTTP_${status}`,
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("result schema refuses invented success fields", () =>
    expect(
      toolResultSchema.safeParse({
        kind: "activities",
        rows: [],
        published: true,
      }).success,
    ).toBe(false));
});

describe("Phase 4.5 review regressions", () => {
  it("does not accept an activity description as proof of pet admission", () => {
    const { state, intent, a } = setup();
    intent.hardRequirements = ["必须允许携犬"];
    a.description = "散步，必须允许携犬";
    expect(
      rows(activityRecommendations(state, DEFAULT_REFERENCE, intent, now)),
    ).toEqual([]);
  });
  it("excludes unknown size when an explicit size exclusion must hold", () => {
    const { state, intent, a, other } = setup();
    other.size = "unknown";
    intent.match.excludedSizes = ["large"];
    state.activitySignups = [
      {
        ...state.activitySignups[0],
        activityId: a.id,
        petId: other.id,
        status: "joined",
      },
    ];
    expect(
      rows(activityRecommendations(state, DEFAULT_REFERENCE, intent, now)),
    ).toEqual([]);
  });
  it("can create an empty recommended-pet draft when only a place is needed", async () => {
    const { state, own, intent } = setup(),
      cache: CompanionCache = {};
    await executeCompanionTool(
      tc("search_places", { query: "公园" }),
      state,
      DEFAULT_REFERENCE,
      own.id,
      intent,
      "organize",
      cache,
      now,
      async () => [demoPlaces[1]],
    );
    const r = await executeCompanionTool(
      tc("create_activity_draft", {
        title: "x",
        description: "",
        petIds: [],
        placeIndex: 0,
      }),
      state,
      DEFAULT_REFERENCE,
      own.id,
      intent,
      "organize",
      cache,
      now,
    );
    expect(r.kind).toBe("activity-draft");
    expect(cache.pets).toBeUndefined();
  });
  it("service refuses a provider-selected tool outside the confirmed stage", async () => {
    const { intent } = setup(),
      model = vi
        .fn<typeof callModel>()
        .mockResolvedValue(response([tc("search_pets")]));
    await expect(
      assistantStep(
        { text: "约伴", workflow: { intent, stage: "search" } },
        "s",
        "r",
        now,
        model,
      ),
    ).rejects.toMatchObject({ code: "AI_TOOL_PROTOCOL" });
  });
  it("signed context enforces nine tool calls even if a client attempts more", async () => {
    const { intent } = setup(),
      model = vi.fn<typeof callModel>().mockResolvedValue(response());
    const first = await assistantStep(
      { text: "约伴", workflow: { intent, stage: "organize" } },
      "s",
      "r",
      now,
      model,
    );
    const st = unseal(first.data.continuation) as Record<string, unknown>;
    st.toolCount = 9;
    st.round = 1;
    st.pending = [tc("search_pets")];
    const more = vi
      .fn<typeof callModel>()
      .mockResolvedValue(response([tc("search_places", { query: "公园" })]));
    await expect(
      assistantStep(
        {
          continuation: seal(st),
          results: [
            { toolCallId: "search_pets", result: { kind: "pets", rows: [] } },
          ],
        },
        "s",
        "r",
        now,
        more,
      ),
    ).rejects.toMatchObject({ code: "AI_TOOL_CALL_LIMIT" });
  });
  it.each(["周六下午", "周末", "改天", "下班后"])(
    "ambiguous time %s cannot start a query",
    (timeText) => {
      const { intent } = setup();
      intent.timeText = timeText;
      intent.startAt = null;
      intent.endAt = null;
      expect(() => confirmedIntent(intent, now)).toThrow("具体日期");
    },
  );
});
