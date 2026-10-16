import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const reserve = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/server/ai/quota", async (original) => ({
  ...(await original<typeof import("@/server/ai/quota")>()),
  reserveAiCall: reserve,
}));
import { aiConfig, callGlm } from "@/server/ai/client";
import { assistantStep, generateTask } from "@/server/ai/service";
import { seal, unseal } from "@/server/ai/session";
import { POST } from "@/app/api/ai/[task]/route";
import { NextRequest } from "next/server";
import { executeTool, normalizeToolArguments } from "@/lib/ai/tools";
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
  model: "glm-4.7-flash",
});
const envelope = (content: string, finish_reason = "stop") =>
  new Response(
    JSON.stringify({
      choices: [{ finish_reason, message: { role: "assistant", content } }],
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
  vi.stubEnv("GLM_API_KEY", "unit-secret-never-expose");
  vi.stubEnv("AI_ENABLED", "true");
  vi.stubEnv("GLM_MODEL", "glm-4.7-flash");
  vi.stubEnv("GLM_BASE_URL", "https://open.bigmodel.cn/api/paas/v4");
  vi.stubEnv("APP_ORIGIN", "https://paw.test");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  reserve.mockClear();
});
describe("GLM transport", () => {
  it("uses server config, JSON mode, bounded tokens, no thinking", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(envelope("{}"));
    await callGlm(
      [{ role: "user", content: "test" }],
      "s",
      "r",
      undefined,
      transport,
    );
    const [url, options] = transport.mock.calls[0];
    const body = JSON.parse(options!.body as string);
    expect(url).toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.max_tokens).toBe(1400);
    expect(body.thinking.type).toBe("disabled");
    expect(reserve).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 400, 500])(
    "HTTP %i fails without retry",
    async (status) => {
      const transport = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("private provider text", { status }));
      await expect(
        callGlm(
          [{ role: "user", content: "test" }],
          "s",
          "r",
          undefined,
          transport,
        ),
      ).rejects.toMatchObject({ code: `GLM_HTTP_${status}` });
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
  it("retries 429 once with a new quota reservation", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(envelope("{}"));
    await callGlm(
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
      callGlm(
        [{ role: "user", content: "test" }],
        "s",
        "r",
        undefined,
        vi.fn<typeof fetch>().mockResolvedValue(envelope("{}", "length")),
      ),
    ).rejects.toMatchObject({ code: "GLM_INCOMPLETE" });
  });
  it("rejects non JSON and oversized envelopes", async () => {
    await expect(
      callGlm(
        [{ role: "user", content: "test" }],
        "s",
        "r",
        undefined,
        vi.fn<typeof fetch>().mockResolvedValue(new Response("html")),
      ),
    ).rejects.toMatchObject({ code: "GLM_INVALID_RESPONSE" });
    await expect(
      callGlm(
        [{ role: "user", content: "test" }],
        "s",
        "r",
        undefined,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response("x".repeat(64001))),
      ),
    ).rejects.toMatchObject({ code: "GLM_RESPONSE_LIMIT" });
  });
  it("network exception is visible", async () => {
    await expect(
      callGlm(
        [{ role: "user", content: "test" }],
        "s",
        "r",
        undefined,
        vi.fn<typeof fetch>().mockRejectedValue(Error("secret")),
      ),
    ).rejects.toMatchObject({ code: "GLM_NETWORK" });
  });
  it("aborts after 20 seconds", async () => {
    vi.useFakeTimers();
    const transport: typeof fetch = async (_url, options) =>
      new Promise((_resolve, reject) =>
        options!.signal!.addEventListener("abort", () =>
          reject(Error("abort")),
        ),
      );
    const assertion = expect(
      callGlm(
        [{ role: "user", content: "test" }],
        "s",
        "r",
        undefined,
        transport,
      ),
    ).rejects.toMatchObject({ code: "GLM_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(20001);
    await assertion;
  });
  it("forbids paid model and alternate base URL", () => {
    vi.stubEnv("GLM_MODEL", "glm-4.7");
    expect(aiConfig).toThrow("仅允许");
    vi.stubEnv("GLM_MODEL", "glm-4.7-flash");
    vi.stubEnv("GLM_BASE_URL", "https://attacker.test/v1");
    expect(aiConfig).toThrow("普通API地址");
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
    const r = await callGlm(
      [{ role: "user", content: "查宠友" }],
      "s",
      "r",
      [{ type: "function" }],
      transport,
    );
    expect(r.message.tool_calls).toEqual([c]);
    expect(
      JSON.parse(transport.mock.calls[0][1]!.body as string).response_format,
    ).toBeUndefined();
  });
});
describe("native continuation protocol", () => {
  it("returns multiple calls and forwards matching real results to model", async () => {
    const calls = [
      call("search_pets", emptyMatch),
      call("search_activities", {}, "tc2"),
    ];
    const mock = vi
      .fn<typeof callGlm>()
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
    expect(mock.mock.calls[1][0].filter((m) => m.role === "tool")).toHaveLength(
      2,
    );
  });
  it("rejects missing or fabricated tool result IDs", async () => {
    const mock = vi
      .fn<typeof callGlm>()
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
    const mock = vi.fn<typeof callGlm>().mockResolvedValue(
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
    const mock = vi.fn<typeof callGlm>().mockResolvedValue(
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
      .fn<typeof callGlm>()
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
    const mock = vi.fn<typeof callGlm>().mockResolvedValue(
      assistant(
        JSON.stringify({
          traits: ["绝对安全"],
          likes: [],
          dislikes: [],
          cautions: [],
          meetingAdvice: "",
          clarifications: [],
          warnings: [],
        }),
      ),
    );
    await expect(
      generateTask(
        "social-card",
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
    vi.stubEnv("GLM_API_KEY", "");
    const r = await POST(req({ text: "dog" }), ctx());
    expect(r.status).toBe(503);
    const v = await r.json();
    expect(v.ok).toBe(false);
    expect(v.error.code).toBe("AI_NOT_CONFIGURED");
    expect(JSON.stringify(v)).not.toContain("unit-secret");
  });
});
