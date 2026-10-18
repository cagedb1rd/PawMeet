import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const reserve = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/server/ai/quota", async (original) => ({
  ...(await original<typeof import("@/server/ai/quota")>()),
  reserveAiCall: reserve,
}));
import { aiConfig, callModel } from "@/server/ai/client";
import { assistantStep, generateTask } from "@/server/ai/service";
import { seal, unseal } from "@/server/ai/session";
import { POST } from "@/app/api/ai/[task]/route";
import { NextRequest } from "next/server";
import {
  executeTool,
  normalizeToolArguments,
  parseToolArguments,
} from "@/lib/ai/tools";
import { emptyMatch, ToolCall } from "@/lib/ai/contracts";
import { validateHelp, validateOutput } from "@/lib/ai/validation";
import { createSeed } from "@/data/seed";
import { DEFAULT_REFERENCE } from "@/domain/geo";
import { matchQuery, preferenceScore } from "@/domain/matching";
const now = new Date("2026-10-17T02:00:00Z");
const call = (name: string, args: unknown, id = "tc1"): ToolCall => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const assistant = (content: string | null, tool_calls?: ToolCall[]) => ({
  message: {
    role: "assistant" as const,
    content,
    ...(tool_calls ? { tool_calls } : {}),
  },
  usage: null,
  model: "qwen3.8-flash",
});
const envelope = (content: string, finish_reason = "stop") =>
  new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason,
          message: { role: "assistant", content, tool_calls: null },
        },
      ],
    }),
  );
const help = {
  type: "walk" as const,
  petId: null,
  title: "遛狗",
  details: "不能松绳",
  startAt: null,
  endAt: null,
  durationMinutes: 30,
  timeText: "明天下午",
  district: null,
  locationQuery: null,
  clarifications: [],
  warnings: [],
};
beforeEach(() => {
  vi.stubEnv("DASHSCOPE_API_KEY", "unit-secret-never-expose");
  vi.stubEnv("AI_ENABLED", "true");
  vi.stubEnv("AI_MODEL", "qwen3.8-flash");
  vi.stubEnv(
    "AI_BASE_URL",
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
  );
  vi.stubEnv("APP_ORIGIN", "https://paw.test");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  reserve.mockClear();
});
describe("Qwen transport (non-streaming path)", () => {
  beforeEach(() => vi.stubEnv("AI_STREAM", "false"));
  it("does not reuse a Zhipu credential when Qwen key is missing", () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "");
    vi.stubEnv("GLM_API_KEY", "old-zhipu-key");
    expect(aiConfig).toThrow("DASHSCOPE_API_KEY");
  });
  it("supports official regional/workspace endpoints and rejects suffix spoofing", () => {
    for (const base of [
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      "https://workspace-1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    ]) {
      vi.stubEnv("AI_BASE_URL", base);
      expect(aiConfig().url).toBe(base + "/chat/completions");
    }
    vi.stubEnv(
      "AI_BASE_URL",
      "https://dashscope.aliyuncs.com.evil.test/compatible-mode/v1",
    );
    expect(aiConfig).toThrow("兼容API地址");
  });
  it("uses server config, JSON mode, bounded tokens, no thinking", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(envelope("{}"));
    await callModel(
      [{ role: "user", content: "test" }],
      "s",
      "r",
      undefined,
      transport,
    );
    const [url, options] = transport.mock.calls[0];
    const body = JSON.parse(options!.body as string);
    expect(url).toBe(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.max_tokens).toBe(1400);
    expect(body.enable_thinking).toBe(false);
    expect(body.preserve_thinking).toBe(false);
    expect(body.thinking).toBeUndefined();
    expect(reserve).toHaveBeenCalledTimes(1);
  });
  it("retries a transient socket reset once and reserves both attempts", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(
        new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }),
      )
      .mockResolvedValueOnce(envelope("{}"));
    await callModel(
      [{ role: "user", content: "JSON" }],
      "s",
      "r",
      undefined,
      transport,
    );
    expect(transport).toHaveBeenCalledTimes(2);
    expect(reserve).toHaveBeenCalledTimes(2);
  });
  it("passes the requested strict output schema to Qwen", async () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    };
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(envelope('{"name":"豆包"}'));
    await callModel(
      [{ role: "user", content: "提取名字" }],
      "s",
      "r",
      undefined,
      transport,
      schema,
    );
    expect(
      JSON.parse(transport.mock.calls[0][1]!.body as string).response_format,
    ).toEqual({
      type: "json_schema",
      json_schema: { name: "pawmeet_result", strict: true, schema },
    });
  });
  it.each([401, 403, 400])("HTTP %i fails without retry", async (status) => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("private provider text", { status }));
    await expect(
      callModel(
        [{ role: "user", content: "test" }],
        "s",
        "r",
        undefined,
        transport,
      ),
    ).rejects.toMatchObject({ code: `AI_UPSTREAM_HTTP_${status}` });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("retries 429 once with a new quota reservation", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(envelope("{}"));
    await callModel(
      [{ role: "user", content: "test" }],
      "s",
      "r",
      undefined,
      transport,
    );
    expect(transport).toHaveBeenCalledTimes(2);
    expect(reserve).toHaveBeenCalledTimes(2);
  });
  it("rejects truncated response", async () => {
    await expect(
      callModel(
        [{ role: "user", content: "test" }],
        "s",
        "r",
        undefined,
        vi.fn<typeof fetch>().mockResolvedValue(envelope("{}", "length")),
      ),
    ).rejects.toMatchObject({ code: "AI_UPSTREAM_INCOMPLETE" });
  });
  it("rejects non JSON and oversized envelopes", async () => {
    await expect(
      callModel(
        [{ role: "user", content: "test" }],
        "s",
        "r",
        undefined,
        vi.fn<typeof fetch>().mockResolvedValue(new Response("html")),
      ),
    ).rejects.toMatchObject({ code: "AI_UPSTREAM_INVALID_RESPONSE" });
    await expect(
      callModel(
        [{ role: "user", content: "test" }],
        "s",
        "r",
        undefined,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response("x".repeat(64001))),
      ),
    ).rejects.toMatchObject({ code: "AI_UPSTREAM_RESPONSE_LIMIT" });
  });
  it("network exception is visible", async () => {
    await expect(
      callModel(
        [{ role: "user", content: "test" }],
        "s",
        "r",
        undefined,
        vi.fn<typeof fetch>().mockRejectedValue(Error("secret")),
      ),
    ).rejects.toMatchObject({ code: "AI_UPSTREAM_NETWORK" });
  });
  it("aborts at the configured total timeout", async () => {
    vi.stubEnv("AI_FIRST_BYTE_TIMEOUT_MS", "20000");
    vi.stubEnv("AI_TOTAL_TIMEOUT_MS", "20000");
    vi.useFakeTimers();
    const transport: typeof fetch = async (_url, options) =>
      new Promise((_resolve, reject) =>
        options!.signal!.addEventListener("abort", () =>
          reject(Error("abort")),
        ),
      );
    let settled = false;
    const pending = callModel(
      [{ role: "user", content: "test" }],
      "s",
      "r",
      undefined,
      transport,
      undefined,
      { retry: "none" },
    ).finally(() => (settled = true));
    const assertion = expect(pending).rejects.toMatchObject({
      code: "AI_UPSTREAM_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(19999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await assertion;
  });
  it("forbids paid model and alternate base URL", () => {
    vi.stubEnv("AI_MODEL", "glm-4.7");
    expect(aiConfig).toThrow("仅允许");
    vi.stubEnv("AI_MODEL", "qwen3.8-flash");
    vi.stubEnv("AI_BASE_URL", "https://attacker.test/v1");
    expect(aiConfig).toThrow("兼容API地址");
  });
  it("sends actual native tools and accepts tool_calls", async () => {
    const c = call("search_pets", emptyMatch);
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "tool_calls",
              message: { role: "assistant", content: null, tool_calls: [c] },
            },
          ],
        }),
      ),
    );
    const r = await callModel(
      [{ role: "user", content: "查宠友" }],
      "s",
      "r",
      [{ type: "function" }],
      transport,
    );
    expect(r.message.tool_calls).toEqual([c]);
    expect(
      JSON.parse(transport.mock.calls[0][1]!.body as string).response_format,
    ).toEqual({ type: "json_object" });
  });
});
describe("native continuation protocol", () => {
  it("repairs final JSON once through a real additional model round without tools", async () => {
    const mock = vi
      .fn<typeof callModel>()
      .mockResolvedValueOnce(assistant(null, [call("search_pets", emptyMatch)]))
      .mockResolvedValueOnce(assistant("已查询，请查看实际结果卡片。"))
      .mockResolvedValueOnce(
        assistant(
          JSON.stringify({
            summary: "没有符合条件的结果，请调整条件。",
            references: [],
          }),
        ),
      );
    const first = await assistantStep({ text: "查宠友" }, "s", "r", now, mock);
    const final = await assistantStep(
      {
        continuation: first.data.continuation,
        results: [{ toolCallId: "tc1", result: { kind: "pets", rows: [] } }],
      },
      "s",
      "r",
      now,
      mock,
    );
    expect(final.data.answer?.summary).toBe("没有符合条件的结果，请调整条件。");
    expect(mock).toHaveBeenCalledTimes(3);
    expect(mock.mock.calls[2][3]).toBeUndefined();
    expect(unseal(final.data.continuation)).toMatchObject({ round: 3 });
  });
  it("returns multiple calls and forwards matching real results to model", async () => {
    const calls = [
      call("search_pets", emptyMatch),
      call("search_activities", {}, "tc2"),
    ];
    const mock = vi
      .fn<typeof callModel>()
      .mockResolvedValueOnce(assistant(null, calls))
      .mockResolvedValueOnce(
        assistant(
          JSON.stringify({
            summary: "已查询，请查看实际结果卡片。",
            references: ["p1"],
          }),
        ),
      );
    const first = await assistantStep(
      { text: "查宠友和活动" },
      "s",
      "r",
      now,
      mock,
    );
    const final = await assistantStep(
      {
        continuation: first.data.continuation,
        results: [
          {
            toolCallId: "tc1",
            result: {
              kind: "pets",
              rows: [
                {
                  id: "p1",
                  name: "狗",
                  breed: "未知",
                  district: "滨江",
                  distanceM: 123,
                  score: 1,
                  reasons: [],
                },
              ],
            },
          },
          { toolCallId: "tc2", result: { kind: "activities", rows: [] } },
        ],
      },
      "s",
      "r",
      now,
      mock,
    );
    expect(final.data.answer?.references).toEqual(["p1"]);
    expect(mock.mock.calls[1][3]).toBeUndefined();
    expect(mock.mock.calls[1][5]).toMatchObject({ type: "object" });
    expect(mock.mock.calls[1][0].filter((m) => m.role === "tool")).toHaveLength(
      2,
    );
  });
  it("withholds tools after errors and rejects a false successful status", async () => {
    const mock = vi
      .fn<typeof callModel>()
      .mockResolvedValueOnce(assistant(null, [call("search_pets", emptyMatch)]))
      .mockResolvedValueOnce(
        assistant(
          JSON.stringify({
            summary: "已查询，请查看实际结果卡片。",
            references: [],
          }),
        ),
      );
    const first = await assistantStep({ text: "查宠友" }, "s", "r", now, mock);
    await expect(
      assistantStep(
        {
          continuation: first.data.continuation,
          results: [
            {
              toolCallId: "tc1",
              result: {
                kind: "error",
                code: "INVALID_ARGUMENTS",
                message: "参数错误",
              },
            },
          ],
        },
        "s",
        "r",
        now,
        mock,
      ),
    ).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT" });
    expect(mock.mock.calls[1][3]).toBeUndefined();
    expect(mock.mock.calls[1][5]).toMatchObject({ type: "object" });
  });
  it("rejects missing or fabricated tool result IDs", async () => {
    const mock = vi
      .fn<typeof callModel>()
      .mockResolvedValue(assistant(null, [call("search_pets", emptyMatch)]));
    const first = await assistantStep({ text: "查宠友" }, "s", "r", now, mock);
    for (const results of [
      [],
      [{ toolCallId: "fake", result: { kind: "pets" as const, rows: [] } }],
    ])
      await expect(
        assistantStep(
          { continuation: first.data.continuation, results },
          "s",
          "r",
          now,
          mock,
        ),
      ).rejects.toMatchObject({ code: "AI_PROTOCOL" });
  });
  it("rejects unknown final references", async () => {
    const mock = vi.fn<typeof callModel>().mockResolvedValue(
      assistant(
        JSON.stringify({
          summary: "已查询，请查看实际结果卡片。",
          references: ["invented"],
        }),
      ),
    );
    await expect(
      assistantStep({ text: "查宠友" }, "s", "r", now, mock),
    ).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT" });
  });
  it("supports follow-up questions after tools settle", async () => {
    const mock = vi.fn<typeof callModel>().mockResolvedValue(
      assistant(
        JSON.stringify({
          summary: "请说明要查询宠友、活动还是创建互助草稿。",
          references: [],
        }),
      ),
    );
    const first = await assistantStep({ text: "你好" }, "s", "r", now, mock);
    await assistantStep(
      { text: "查宠友", continuation: first.data.continuation },
      "s",
      "r",
      now,
      mock,
    );
    expect(mock.mock.calls[1][0].filter((m) => m.role === "user")).toHaveLength(
      2,
    );
  });
  it("rejects tampered/expired tokens, enforces session and round cap", async () => {
    const mock = vi
      .fn<typeof callModel>()
      .mockResolvedValue(assistant(null, [call("search_pets", emptyMatch)]));
    const first = await assistantStep({ text: "查宠友" }, "s", "r", now, mock);
    expect(() => unseal(first.data.continuation + "x")).toThrow();
    await expect(
      assistantStep(
        { continuation: first.data.continuation },
        "other",
        "r",
        now,
        mock,
      ),
    ).rejects.toMatchObject({ code: "AI_CONTINUATION" });
    const state = unseal(first.data.continuation) as Record<string, unknown>;
    await expect(
      assistantStep(
        { continuation: seal({ ...state, expires: 0 }) },
        "s",
        "r",
        now,
        mock,
      ),
    ).rejects.toMatchObject({ code: "AI_CONTINUATION" });
    await expect(
      assistantStep(
        {
          continuation: seal({ ...state, round: 4 }),
          results: [{ toolCallId: "tc1", result: { kind: "pets", rows: [] } }],
        },
        "s",
        "r",
        now,
        mock,
      ),
    ).rejects.toMatchObject({ code: "AI_TOOL_ROUND_LIMIT" });
  });
});
describe("browser tools and rules", () => {
  it("rejects extra match conditions that the user did not provide", () => {
    expect(() =>
      validateOutput(
        "match-intent",
        { ...emptyMatch, temperaments: ["温和", "慢热"] },
        { text: "找性格松弛的狗", context: {} },
        now,
      ),
    ).toThrow("筛选标签缺少");
    expect(() =>
      validateOutput(
        "match-intent",
        { ...emptyMatch, sizes: ["large"] },
        { text: "找宠友", context: {} },
        now,
      ),
    ).toThrow("筛选体型缺少");
    expect(() =>
      validateOutput(
        "match-intent",
        { ...emptyMatch, breeds: ["狗狗"] },
        { text: "找狗狗", context: {} },
        now,
      ),
    ).toThrow("犬种筛选缺少");
  });
  it("rejects invented quantities hidden in checklist headings", () => {
    expect(() =>
      validateOutput(
        "care-checklist",
        {
          items: [
            {
              title: "喂100克",
              detail: "请主人确认喂食品牌、份量及禁忌，未确认前不要自行喂食。",
              needsConfirmation: true,
            },
          ],
          clarifications: [],
          warnings: [],
        },
        { text: "主人未提供喂食量", context: {} },
        now,
      ),
    ).toThrow("不得生成剂量或份量");
  });
  it("validates sparse native conditions before filling business defaults", () => {
    expect(
      parseToolArguments("search_pets", { radiusKm: 3, sizes: ["small"] }),
    ).toEqual({ ...emptyMatch, radiusKm: 3, sizes: ["small"] });
    expect(() =>
      parseToolArguments("search_pets", { radiusKm: 1.5 }),
    ).toThrow();
    expect(() =>
      parseToolArguments("search_pets", { publish: null }),
    ).toThrow();
    const state = createSeed(now),
      before = JSON.stringify(state);
    const result = executeTool(
      call("search_pets", { radiusKm: 3, sizes: ["small"] }),
      state,
      DEFAULT_REFERENCE,
      undefined,
      now,
    );
    expect(result.kind).toBe("pets");
    if (result.kind === "pets")
      for (const row of result.rows) {
        expect(row.distanceM).toBeLessThanOrEqual(3000);
        expect(state.pets.find((p) => p.id === row.id)?.size).toBe("small");
      }
    expect(JSON.stringify(state)).toBe(before);
  });
  it("forces owner clarification for conflicting food instructions", () => {
    const result = validateOutput(
      "care-checklist",
      {
        items: [
          {
            title: "饮食",
            detail: "只能喂原粮；可以随意给零食。",
            needsConfirmation: false,
          },
        ],
        clarifications: [],
        warnings: [],
      },
      { text: "只能喂原粮；可以随意给零食。", context: {} },
      now,
    );
    expect(result).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ needsConfirmation: true }),
      ]),
      clarifications: expect.arrayContaining([expect.stringContaining("冲突")]),
    });
  });
  it("rejects inferred liking from lack of fear", () => {
    const raw = {
      name: null,
      breed: null,
      ageMonths: null,
      size: null,
      city: null,
      district: null,
      temperamentTags: [],
      activityTags: [],
      likes: ["不怕陌生狗"],
      dislikes: [],
      cautions: [],
      clarifications: [],
      warnings: [],
    };
    expect(() =>
      validateOutput(
        "pet-profile",
        raw,
        { text: "不怕陌生狗", context: {} },
        now,
      ),
    ).toThrow("不能推断为喜欢");
  });
  it("returns actionable errors for invented help prefixes without changing storage", () => {
    const state = createSeed(now),
      before = JSON.stringify(state);
    const result = executeTool(
      call("create_help_draft", {
        type: "walk",
        petId: "pet-1",
        title: "临时遛狗",
        details: "主人原文：明天下午遛狗",
        startAt: null,
        endAt: null,
        durationMinutes: 30,
        timeText: "明天下午",
        district: null,
        locationQuery: null,
        clarifications: [],
        warnings: [],
      }),
      state,
      DEFAULT_REFERENCE,
      "pet-1",
      now,
      "明天下午遛狗",
    );
    expect(result).toMatchObject({ kind: "error", code: "INVALID_ARGUMENTS" });
    expect(JSON.stringify(state)).toBe(before);
  });
  it("normalizes canonical native scalar encoding but never widens values", () => {
    expect(normalizeToolArguments({ radiusKm: "5", sort: "null" })).toEqual({
      radiusKm: 5,
      sort: null,
    });
    expect(normalizeToolArguments({ radiusKm: "1.5", sort: "other" })).toEqual({
      radiusKm: "1.5",
      sort: "other",
    });
    expect(
      executeTool(
        call("search_pets", { ...emptyMatch, radiusKm: "5", sort: "null" }),
        createSeed(now),
        DEFAULT_REFERENCE,
        undefined,
        now,
      ).kind,
    ).toBe("pets");
  });
  it("queries real local candidates, distances/scores without writing", () => {
    const state = createSeed(now),
      before = JSON.stringify(state);
    const own = state.pets.find((p) => p.ownerId === state.activeUserId)!;
    const r = executeTool(
      call("search_pets", { ...emptyMatch, radiusKm: 5, sort: "match" }),
      state,
      DEFAULT_REFERENCE,
      own.id,
      now,
    );
    expect(r.kind).toBe("pets");
    if (r.kind === "pets")
      for (const row of r.rows) {
        expect(
          state.pets.some(
            (p) => p.id === row.id && p.ownerId !== state.activeUserId,
          ),
        ).toBe(true);
        expect(row.distanceM).toBeLessThanOrEqual(5000);
      }
    expect(JSON.stringify(state)).toBe(before);
  });
  it("empty results do not expand query", () => {
    expect(
      executeTool(
        call("search_pets", { ...emptyMatch, breeds: ["不存在"] }),
        createSeed(now),
        DEFAULT_REFERENCE,
        undefined,
        now,
      ),
    ).toEqual({ kind: "pets", rows: [] });
  });
  it("excludes archived/self and applies negative filters", () => {
    const s = createSeed(now);
    s.pets[1].archivedAt = now.toISOString();
    expect(
      matchQuery(s, DEFAULT_REFERENCE, {
        ...emptyMatch,
        radiusKm: 10,
        excludedSizes: ["large"],
      }).every(
        (v) =>
          v.pet.ownerId !== s.activeUserId &&
          !v.pet.archivedAt &&
          v.pet.size !== "large",
      ),
    ).toBe(true);
    expect(preferenceScore(s, undefined, s.pets[1], 0).score).toBe(0);
  });
  it.each([
    call("delete_pet", {}),
    call("search_pets", { ...emptyMatch, radiusKm: 2 }),
    {
      ...call("search_pets", {}),
      function: { name: "search_pets", arguments: "{" },
    },
  ])("rejects bad tool or args %#", (c) => {
    expect(
      executeTool(c, createSeed(now), DEFAULT_REFERENCE, undefined, now),
    ).toMatchObject({ kind: "error", code: "INVALID_ARGUMENTS" });
  });
  it("activity query returns future local records; nonexistent area stays empty", () => {
    const s = createSeed(now);
    const r = executeTool(
      call("search_activities", {
        district: null,
        radiusKm: 5,
        startAfter: null,
        startBefore: null,
      }),
      s,
      DEFAULT_REFERENCE,
      undefined,
      now,
    );
    expect(r.kind).toBe("activities");
    if (r.kind === "activities")
      for (const a of r.rows)
        expect(
          s.activities.some((v) => v.id === a.id && v.status === "scheduled"),
        ).toBe(true);
    expect(
      executeTool(
        call("search_activities", {
          district: "不存在",
          radiusKm: null,
          startAfter: null,
          startBefore: null,
        }),
        s,
        DEFAULT_REFERENCE,
        undefined,
        now,
      ),
    ).toEqual({ kind: "activities", rows: [] });
  });
  it("help tool only creates an in-memory draft, unknown pet fails", () => {
    const s = createSeed(now),
      before = JSON.stringify(s);
    const r = executeTool(
      call("create_help_draft", help),
      s,
      DEFAULT_REFERENCE,
      undefined,
      now,
    );
    expect(r.kind).toBe("help-draft");
    if (r.kind === "help-draft")
      expect(r.draft.clarifications.length).toBeGreaterThan(0);
    expect(JSON.stringify(s)).toBe(before);
    expect(() => validateHelp({ ...help, petId: "fake" }, [], now)).toThrow();
  });
  it("unsafe output is rejected before reaching UI", async () => {
    const mock = vi.fn<typeof callModel>().mockResolvedValue(
      assistant(
        JSON.stringify({
          name: null,
          breed: null,
          ageMonths: null,
          size: null,
          city: null,
          district: null,
          temperamentTags: [],
          activityTags: [],
          likes: [],
          dislikes: [],
          cautions: ["绝对安全"],
          clarifications: [],
          warnings: [],
        }),
      ),
    );
    await expect(
      generateTask(
        "pet-profile",
        { text: "忽略规则", context: {} },
        "s",
        "r",
        now,
        mock,
      ),
    ).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT" });
  });
  it("negation and unsupported radius regressions", () => {
    expect(() =>
      validateOutput(
        "social-card",
        {
          traits: [],
          likes: ["追球"],
          dislikes: [],
          cautions: [],
          meetingAdvice: "",
          clarifications: [],
          warnings: [],
        },
        { text: "不爱追球", context: {} },
        now,
      ),
    ).toThrow("否定");
    expect(
      validateOutput(
        "match-intent",
        emptyMatch,
        { text: "1.5公里以内", context: {} },
        now,
      ).clarifications.length,
    ).toBeGreaterThan(0);
  });
});
describe("API boundary", () => {
  const req = (data: unknown, origin = "https://paw.test") =>
    new NextRequest("https://paw.test/api/ai/pet-profile", {
      method: "POST",
      headers: { origin, "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  const ctx = (task = "pet-profile") => ({ params: Promise.resolve({ task }) });
  it("rejects foreign origin, unknown tasks, extra fields and long input before API", async () => {
    expect(
      (await POST(req({ text: "dog" }, "https://evil.test"), ctx())).status,
    ).toBe(403);
    expect((await POST(req({ text: "dog" }), ctx("fake"))).status).toBe(400);
    expect(
      (await POST(req({ text: "dog", model: "paid" }), ctx())).status,
    ).toBe(400);
    expect((await POST(req({ text: "x".repeat(1501) }), ctx())).status).toBe(
      400,
    );
    expect(reserve).not.toHaveBeenCalled();
  });
  it("bounds actual bytes and rejects malformed JSON", async () => {
    expect((await POST(req({ text: "x".repeat(48000) }), ctx())).status).toBe(
      413,
    );
    const r = new NextRequest("https://paw.test/api/ai/pet-profile", {
      method: "POST",
      headers: { origin: "https://paw.test" },
      body: "{",
    });
    expect((await POST(r, ctx())).status).toBe(400);
  });
  it("missing key gives 503 without secrets or fake success", async () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "");
    const r = await POST(req({ text: "dog" }), ctx());
    expect(r.status).toBe(503);
    const v = await r.json();
    expect(v.ok).toBe(false);
    expect(v.error.code).toBe("AI_NOT_CONFIGURED");
    expect(JSON.stringify(v)).not.toContain("unit-secret");
  });
});
