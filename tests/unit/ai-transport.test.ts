import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
vi.mock("server-only", () => ({}));
// Pass-through spy: counts reservations while still writing the real temp ledger.
const { reserve, ledger } = vi.hoisted(() => ({
  reserve: vi.fn<(session: string, worst: number) => Promise<void>>(),
  ledger: { real: true },
}));
vi.mock("@/server/ai/quota", async (original) => {
  const real = await original<typeof import("@/server/ai/quota")>();
  reserve.mockImplementation(async (s, w) => {
    // Fake-timer tests skip disk I/O, which would otherwise run outside fake time.
    if (ledger.real) await real.reserveAiCall(s, w);
  });
  return { ...real, reserveAiCall: reserve };
});
import { aiConfig, callModel, imagePart, Message } from "@/server/ai/client";
import { MODEL_WHITELIST, PROVIDERS } from "@/server/ai/models";
import { assistantStep, generateTask } from "@/server/ai/service";
import { POST } from "@/app/api/ai/[task]/route";
import { NextRequest } from "next/server";
import { aiTask, readAiStream } from "@/lib/ai/client";
import { AI_STREAM_TYPE, AiProgress } from "@/lib/ai/contracts";

const user: Message[] = [{ role: "user", content: "测试" }];
const delta = (d: Record<string, unknown>, finish: string | null = null) => ({
  choices: [{ index: 0, delta: d, finish_reason: finish }],
});
const usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };
/** SSE body cut into `split`-byte chunks (splits multi-byte UTF-8 on purpose). */
function sse(
  events: (object | string)[],
  { done = true, split = 0, crlf = false } = {},
) {
  const nl = crlf ? "\r\n" : "\n";
  const text =
    events
      .map(
        (e) =>
          `data: ${typeof e === "string" ? e : JSON.stringify(e)}${nl}${nl}`,
      )
      .join("") + (done ? `data: [DONE]${nl}${nl}` : "");
  const bytes = new TextEncoder().encode(text);
  const size = split || bytes.length;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += size)
          c.enqueue(bytes.slice(i, i + size));
        c.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
const ok = (content: string) =>
  sse([
    delta({ role: "assistant", content }),
    delta({}, "stop"),
    { choices: [], usage },
  ]);
const bodyOf = (t: ReturnType<typeof vi.fn<typeof fetch>>, i = 0) =>
  JSON.parse(t.mock.calls[i][1]!.body as string);
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paw-transport-"));
  vi.stubEnv("QUOTA_STORE_PATH", path.join(dir, "quota.json"));
  vi.stubEnv("DASHSCOPE_API_KEY", "unit-secret-never-expose");
  vi.stubEnv("GEMINI_API_KEY", "unit-gemini-secret-never-expose");
  vi.stubEnv("AI_ENABLED", "true");
  vi.stubEnv("AI_MODEL", "");
  vi.stubEnv("AI_VISION_MODEL", "");
  vi.stubEnv("AI_STREAM", "");
  vi.stubEnv("AI_FIRST_BYTE_TIMEOUT_MS", "");
  vi.stubEnv("AI_TOTAL_TIMEOUT_MS", "");
  vi.stubEnv(
    "AI_BASE_URL",
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
  );
  vi.stubEnv("APP_ORIGIN", "https://paw.test");
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  reserve.mockClear();
  await rm(dir, { recursive: true, force: true });
});

describe("model whitelist", () => {
  it("defaults to qwen3.8-flash and accepts every whitelisted text model", async () => {
    expect(aiConfig().model).toBe("qwen3.8-flash");
    for (const { id } of MODEL_WHITELIST.text) {
      vi.stubEnv("AI_MODEL", id);
      const t = vi.fn<typeof fetch>().mockResolvedValue(ok("{}"));
      const r = await callModel(user, "s", "r", undefined, t);
      expect(bodyOf(t).model).toBe(id);
      expect(r.model).toBe(id);
    }
  });
  it("rejects names outside the matching group without calling upstream", async () => {
    const t = vi.fn<typeof fetch>();
    for (const [env, value] of [
      ["AI_MODEL", "qwen-plus"],
      ["AI_MODEL", "qwen3.8-omni-flash"],
      ["AI_MODEL", "QWEN3.8-FLASH"],
      ["AI_VISION_MODEL", "qwen3.8-flash"],
    ]) {
      vi.stubEnv(env, value);
      const kind = env === "AI_MODEL" ? "text" : "vision";
      expect(() => aiConfig(kind)).toThrow("仅允许白名单内");
      await expect(
        callModel(user, "s", "r", undefined, t, undefined, { kind }),
      ).rejects.toMatchObject({ code: "AI_MODEL_NOT_APPROVED" });
      vi.stubEnv(env, "");
    }
    expect(t).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });
  it("server/eval override must also be whitelisted", async () => {
    const t = vi.fn<typeof fetch>().mockResolvedValue(ok("{}"));
    await callModel(user, "s", "r", undefined, t, undefined, {
      model: "qwen3.8-max-0902",
    });
    expect(bodyOf(t).model).toBe("qwen3.8-max-0902");
    await expect(
      callModel(user, "s", "r", undefined, t, undefined, { model: "glm-4.7" }),
    ).rejects.toMatchObject({ code: "AI_MODEL_NOT_APPROVED" });
    expect(t).toHaveBeenCalledTimes(1);
  });
  it("validates stream and timeout configuration", () => {
    vi.stubEnv("AI_STREAM", "yes");
    expect(() => aiConfig()).toThrow("AI_STREAM");
    vi.stubEnv("AI_STREAM", "");
    vi.stubEnv("AI_TOTAL_TIMEOUT_MS", "abc");
    expect(() => aiConfig()).toThrow("AI_TOTAL_TIMEOUT_MS");
    vi.stubEnv("AI_TOTAL_TIMEOUT_MS", "5000");
    vi.stubEnv("AI_FIRST_BYTE_TIMEOUT_MS", "8000");
    expect(() => aiConfig()).toThrow("不能大于");
  });
});

describe("vision / omni compatibility", () => {
  const image = "data:image/jpeg;base64," + "A".repeat(80000);
  const visionMessages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: "看看这只狗" }, imagePart(image)],
    },
  ];
  it("forces streaming, omits text-only params and estimates images at a fixed cost", async () => {
    vi.stubEnv("AI_STREAM", "false");
    const t = vi.fn<typeof fetch>().mockResolvedValue(ok("一只柴犬"));
    const r = await callModel(
      visionMessages,
      "s",
      "r",
      undefined,
      t,
      undefined,
      { kind: "vision", stream: false },
    );
    const body = bodyOf(t);
    expect(body.model).toBe("qwen3.8-omni-flash");
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.enable_thinking).toBeUndefined();
    expect(body.response_format).toBeUndefined();
    expect(body.messages[0].content[1]).toEqual({
      type: "image_url",
      image_url: { url: image },
    });
    expect(r.message.content).toBe("一只柴犬");
    expect(r.usage).toEqual(usage);
    // 80KB of base64 is not counted as 80K tokens.
    expect(reserve.mock.calls[0][1]).toBeLessThan(5000);
  });
  it("rejects images for text models, tools / strict schema for omni, and non-thumbnail data", async () => {
    const t = vi.fn<typeof fetch>();
    await expect(
      callModel(visionMessages, "s", "r", undefined, t),
    ).rejects.toMatchObject({ code: "AI_MODEL_CAPABILITY" });
    await expect(
      callModel(user, "s", "r", [{ type: "function" }], t, undefined, {
        kind: "vision",
      }),
    ).rejects.toMatchObject({ code: "AI_MODEL_CAPABILITY" });
    await expect(
      callModel(
        user,
        "s",
        "r",
        undefined,
        t,
        { type: "object" },
        {
          kind: "vision",
        },
      ),
    ).rejects.toMatchObject({ code: "AI_MODEL_CAPABILITY" });
    expect(t).not.toHaveBeenCalled();
    for (const bad of [
      "https://example.test/dog.jpg",
      "data:image/svg+xml;base64,AAAA",
      "data:image/png;base64," + "A".repeat(400000),
    ])
      expect(() => imagePart(bad)).toThrow("缩略图");
  });
});

describe("Gemini provider", () => {
  const headersOf = (t: ReturnType<typeof vi.fn<typeof fetch>>) =>
    t.mock.calls[0][1]!.headers as Record<string, string>;
  it("sends Gemini models to the fixed Gemini endpoint with their own key and thinking level", async () => {
    for (const [id, effort] of [
      ["gemini-3.8-flash", "low"],
      ["gemini-3.5-flash-lite", "minimal"],
    ]) {
      vi.stubEnv("AI_MODEL", id);
      const t = vi.fn<typeof fetch>().mockResolvedValue(ok("{}"));
      await callModel(user, "s", "r", undefined, t);
      expect(t.mock.calls[0][0]).toBe(PROVIDERS.gemini.url);
      expect(headersOf(t).Authorization).toBe(
        "Bearer unit-gemini-secret-never-expose",
      );
      const body = bodyOf(t);
      expect(body.model).toBe(id);
      expect(body.reasoning_effort).toBe(effort);
      expect(body.max_tokens).toBe(4096);
      expect(body).not.toHaveProperty("temperature");
      expect(body).not.toHaveProperty("enable_thinking");
      expect(body).not.toHaveProperty("preserve_thinking");
    }
  });
  it("keeps Qwen requests unchanged and never sends the Gemini key to DashScope", async () => {
    const t = vi.fn<typeof fetch>().mockResolvedValue(ok("{}"));
    await callModel(user, "s", "r", undefined, t);
    expect(String(t.mock.calls[0][0])).toBe(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
    expect(headersOf(t).Authorization).toBe("Bearer unit-secret-never-expose");
    const body = bodyOf(t);
    expect(body.temperature).toBe(0.1);
    expect(body.max_tokens).toBe(1400);
    expect(body.enable_thinking).toBe(false);
    expect(body).not.toHaveProperty("reasoning_effort");
  });
  it("a missing provider key blocks only that provider, before any request", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("AI_MODEL", "gemini-3.8-flash");
    const t = vi.fn<typeof fetch>().mockResolvedValue(ok("{}"));
    await expect(callModel(user, "s", "r", undefined, t)).rejects.toMatchObject({
      code: "AI_NOT_CONFIGURED",
      message: expect.stringContaining("GEMINI_API_KEY"),
    });
    expect(t).not.toHaveBeenCalled();
    vi.stubEnv("AI_MODEL", "qwen3.8-flash");
    await callModel(user, "s", "r", undefined, t);
    expect(t).toHaveBeenCalledTimes(1);
  });
  it("keeps a streamed thought signature on its tool call", async () => {
    vi.stubEnv("AI_MODEL", "gemini-3.8-flash");
    const t = vi.fn<typeof fetch>().mockResolvedValue(
      sse([
        delta({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_g",
              type: "function",
              function: { name: "search_pets", arguments: '{"radius' },
              extra_content: { google: { thought_signature: "c2lnLWE=" } },
            },
          ],
        }),
        delta({
          tool_calls: [{ index: 0, function: { arguments: 'Km":3}' } }],
        }),
        delta({}, "tool_calls"),
        { choices: [], usage },
      ]),
    );
    const r = await callModel(user, "s", "r", [], t);
    expect(r.message.tool_calls).toEqual([
      {
        id: "call_g",
        type: "function",
        function: { name: "search_pets", arguments: '{"radiusKm":3}' },
        extra_content: { google: { thought_signature: "c2lnLWE=" } },
      },
    ]);
  });
  it("accepts Gemini tool-call chunks that omit index (one whole call per entry)", async () => {
    vi.stubEnv("AI_MODEL", "gemini-3.8-flash");
    const whole = (id: string, name: string, args: string, sig: string) => ({
      extra_content: { google: { thought_signature: sig } },
      function: { arguments: args, name },
      id,
      type: "function",
    });
    const t = vi.fn<typeof fetch>().mockResolvedValue(
      sse([
        {
          choices: [
            {
              delta: {
                role: "assistant",
                tool_calls: [
                  whole("call_1", "search_places", '{"query":"公园"}', "c2lnLTE="),
                  whole("call_2", "search_pets", "{}", "c2lnLTI="),
                ],
              },
              index: 0,
            },
          ],
          usage,
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }] },
      ]),
    );
    const r = await callModel(user, "s", "r", [], t);
    expect(r.message.tool_calls?.map((c) => [c.id, c.function.name])).toEqual([
      ["call_1", "search_places"],
      ["call_2", "search_pets"],
    ]);
    expect(r.message.tool_calls?.[1].extra_content).toEqual({
      google: { thought_signature: "c2lnLTI=" },
    });
    expect(r.usage).toEqual(usage);
    const four = vi.fn<typeof fetch>().mockResolvedValue(
      sse([
        delta({
          tool_calls: ["a", "b", "c", "d"].map((id) =>
            whole(id, "search_pets", "{}", "c2ln"),
          ),
        }),
        delta({}, "tool_calls"),
      ]),
    );
    await expect(
      callModel(user, "s", "r", [], four, undefined, { retry: "none" }),
    ).rejects.toMatchObject({ code: "AI_UPSTREAM_RESPONSE_LIMIT" });
  });
  it("echoes the thought signature unchanged on the continuation request", async () => {
    vi.stubEnv("AI_MODEL", "gemini-3.8-flash");
    const signature = { google: { thought_signature: "c2lnLWI=" } };
    const t = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sse([
          delta({
            tool_calls: [
              {
                index: 0,
                id: "tc1",
                type: "function",
                function: { name: "search_pets", arguments: "{}" },
                extra_content: signature,
              },
            ],
          }),
          delta({}, "tool_calls"),
        ]),
      )
      .mockResolvedValueOnce(
        ok(
          JSON.stringify({
            summary: "没有符合条件的结果，请调整条件。",
            references: [],
          }),
        ),
      );
    vi.stubGlobal("fetch", t);
    const first = await assistantStep({ text: "找宠友" }, "s", "r");
    const final = await assistantStep(
      {
        continuation: first.data.continuation,
        results: [{ toolCallId: "tc1", result: { kind: "pets", rows: [] } }],
      },
      "s",
      "r",
    );
    expect(final.data.answer?.summary).toBe("没有符合条件的结果，请调整条件。");
    const echoed = (bodyOf(t, 1).messages as Message[]).find(
      (m) => m.role === "assistant" && m.tool_calls,
    );
    expect(echoed?.tool_calls?.[0].extra_content).toEqual(signature);
  });
});

describe("SSE streaming", () => {
  it("reassembles UTF-8 content across byte splits and keeps trailing usage", async () => {
    const t = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        sse(
          [
            delta({ role: "assistant", content: "" }),
            delta({ content: '{"name":"' }),
            delta({ content: "豆包" }),
            delta({ content: '"}' }),
            delta({}, "stop"),
            { choices: [], usage },
          ],
          { split: 7 },
        ),
      );
    const r = await callModel(user, "s", "r", undefined, t);
    expect(r.message).toEqual({
      role: "assistant",
      content: '{"name":"豆包"}',
    });
    expect(r.usage).toEqual(usage);
    expect(r.streamed).toBe(true);
    const body = bodyOf(t);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.enable_thinking).toBe(false);
    expect((t.mock.calls[0][1]!.headers as Record<string, string>).Accept).toBe(
      "text/event-stream",
    );
  });
  it("stitches fragmented parallel tool_calls by index", async () => {
    const t = vi.fn<typeof fetch>().mockResolvedValue(
      sse(
        [
          delta({
            role: "assistant",
            content: null,
            tool_calls: [
              {
                index: 0,
                id: "call_a",
                type: "function",
                function: { name: "search_pets", arguments: '{"radi' },
              },
            ],
          }),
          delta({
            tool_calls: [
              {
                index: 1,
                id: "call_b",
                type: "function",
                function: { name: "search_places", arguments: "" },
              },
            ],
          }),
          delta({
            tool_calls: [
              { index: 0, id: "", function: { arguments: 'usKm":3}' } },
              { index: 1, function: { name: "", arguments: '{"q":"公园"}' } },
            ],
          }),
          delta({}, "tool_calls"),
          { choices: [], usage },
        ],
        { split: 13 },
      ),
    );
    const r = await callModel(user, "s", "r", [{ type: "function" }], t);
    expect(r.message.content).toBeNull();
    expect(r.message.tool_calls).toEqual([
      {
        id: "call_a",
        type: "function",
        function: { name: "search_pets", arguments: '{"radiusKm":3}' },
      },
      {
        id: "call_b",
        type: "function",
        function: { name: "search_places", arguments: '{"q":"公园"}' },
      },
    ]);
  });
  it("accepts CRLF framing, comments and event lines", async () => {
    const text =
      ": keep-alive\r\nevent: message\r\n" +
      `data: ${JSON.stringify(delta({ content: "{}" }, "stop"))}\r\n\r\n` +
      "data: [DONE]\r\n\r\n";
    const t = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(text, {
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const r = await callModel(user, "s", "r", undefined, t);
    expect(r.message.content).toBe("{}");
    expect(r.usage).toBeNull();
  });
  it("falls back to a JSON envelope when the provider ignores stream=true", async () => {
    const t = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "{}" },
          },
        ],
        usage,
      }),
    );
    const r = await callModel(user, "s", "r", undefined, t);
    expect(r).toMatchObject({ streamed: false, usage, attempts: 1 });
  });
  it("mid-stream disconnect is retried once for idempotent calls and reserves both attempts", async () => {
    const cut = () => sse([delta({ content: '{"na' })], { done: false });
    const t = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(cut())
      .mockResolvedValueOnce(ok("{}"));
    const progress: AiProgress[] = [];
    const r = await callModel(user, "s", "r", undefined, t, undefined, {
      backoffMs: 0,
      onProgress: (p) => progress.push(p),
    });
    expect(r.attempts).toBe(2);
    expect(t).toHaveBeenCalledTimes(2);
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(progress.map((p) => p.stage)).toEqual([
      "waiting",
      "receiving",
      "retrying",
      "receiving",
    ]);
    expect(progress[1].chars).toBe(4);
  });
  it("mid-stream disconnect is not retried after response bytes in pre-response mode", async () => {
    const t = vi
      .fn<typeof fetch>()
      .mockResolvedValue(sse([delta({ content: "{" })], { done: false }));
    await expect(
      callModel(user, "s", "r", undefined, t, undefined, {
        retry: "pre-response",
      }),
    ).rejects.toMatchObject({
      code: "AI_UPSTREAM_STREAM_INTERRUPTED",
      retryable: true,
    });
    expect(t).toHaveBeenCalledTimes(1);
  });
  it("reader error mid-stream is retried for idempotent and visible otherwise", async () => {
    const broken = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify(delta({ content: "{" }))}\n\n`,
              ),
            );
            c.error(new TypeError("terminated"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    const t = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(broken())
      .mockResolvedValueOnce(ok("{}"));
    await callModel(user, "s", "r", undefined, t, undefined, { backoffMs: 0 });
    expect(t).toHaveBeenCalledTimes(2);
    const once = vi.fn<typeof fetch>().mockResolvedValue(broken());
    await expect(
      callModel(user, "s", "r", undefined, once, undefined, { retry: "none" }),
    ).rejects.toMatchObject({ code: "AI_UPSTREAM_NETWORK" });
    expect(once).toHaveBeenCalledTimes(1);
  });
  it("length truncation, malformed chunks and provider errors are not retried", async () => {
    for (const [response, code] of [
      [sse([delta({ content: '{"a"' }, "length")]), "AI_UPSTREAM_INCOMPLETE"],
      [sse(["{not json"]), "AI_UPSTREAM_INVALID_RESPONSE"],
      [sse([{ error: { code: "x" } }]), "AI_UPSTREAM_STREAM_ERROR"],
      [sse([delta({ content: "" }, "stop")]), "AI_UPSTREAM_EMPTY"],
    ] as const) {
      const t = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(
        callModel(user, "s", "r", undefined, t),
      ).rejects.toMatchObject({ code });
      expect(t).toHaveBeenCalledTimes(1);
    }
  });
  it("rejects oversized streamed output", async () => {
    const t = vi
      .fn<typeof fetch>()
      .mockResolvedValue(sse([delta({ content: "x".repeat(16001) }, "stop")]));
    await expect(callModel(user, "s", "r", undefined, t)).rejects.toMatchObject(
      { code: "AI_UPSTREAM_RESPONSE_LIMIT" },
    );
  });
});

describe("timeouts", () => {
  beforeEach(() => {
    ledger.real = false;
  });
  afterEach(() => {
    ledger.real = true;
  });
  /** Sends headers, optionally one chunk, then stalls until aborted. */
  const stalled =
    (firstChunk?: string): typeof fetch =>
    async (_url, options) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            if (firstChunk) c.enqueue(new TextEncoder().encode(firstChunk));
            options!.signal!.addEventListener("abort", () =>
              c.error(new DOMException("aborted", "AbortError")),
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
  it("first-byte timeout fires at the configured value", async () => {
    vi.stubEnv("AI_FIRST_BYTE_TIMEOUT_MS", "3000");
    vi.useFakeTimers();
    let settled = false;
    const p = callModel(user, "s", "r", undefined, stalled(), undefined, {
      retry: "none",
    }).finally(() => (settled = true));
    const assertion = expect(p).rejects.toMatchObject({
      code: "AI_UPSTREAM_TIMEOUT",
      message: expect.stringContaining("未开始响应"),
    });
    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await assertion;
  });
  it("first-byte timeout is retried once even for continuation steps", async () => {
    vi.stubEnv("AI_FIRST_BYTE_TIMEOUT_MS", "3000");
    vi.useFakeTimers();
    const t = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(stalled())
      .mockResolvedValueOnce(ok("{}"));
    const p = callModel(user, "s", "r", undefined, t, undefined, {
      retry: "pre-response",
      backoffMs: 100,
    });
    await vi.advanceTimersByTimeAsync(3200);
    await expect(p).resolves.toMatchObject({ attempts: 2 });
    expect(reserve).toHaveBeenCalledTimes(2);
  });
  it("after the first chunk only the total timeout applies", async () => {
    vi.stubEnv("AI_FIRST_BYTE_TIMEOUT_MS", "2000");
    vi.stubEnv("AI_TOTAL_TIMEOUT_MS", "10000");
    vi.useFakeTimers();
    const t = vi
      .fn<typeof fetch>()
      .mockImplementation(
        stalled(`data: ${JSON.stringify(delta({ content: "{" }))}\n\n`),
      );
    let settled = false;
    const p = callModel(user, "s", "r", undefined, t, undefined, {
      retry: "pre-response",
    }).finally(() => (settled = true));
    const assertion = expect(p).rejects.toMatchObject({
      code: "AI_UPSTREAM_TIMEOUT",
      message: "模型请求超时，请手动重试",
    });
    await vi.advanceTimersByTimeAsync(9999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await assertion;
    // Response bytes were consumed, so a continuation step must not retry.
    expect(t).toHaveBeenCalledTimes(1);
  });
  it("client cancellation aborts upstream without retry", async () => {
    const controller = new AbortController();
    const t = vi.fn<typeof fetch>().mockImplementation(stalled());
    const p = callModel(user, "s", "r", undefined, t, undefined, {
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await expect(p).rejects.toMatchObject({ code: "AI_CANCELLED" });
    expect(t).toHaveBeenCalledTimes(1);
  });
});

describe("retry and quota accounting", () => {
  it.each([500, 502, 503, 504])(
    "HTTP %i is retried once and both attempts are reserved",
    async (status) => {
      const t = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response("", { status }))
        .mockResolvedValueOnce(ok("{}"));
      const r = await callModel(user, "s", "r", undefined, t, undefined, {
        backoffMs: 0,
      });
      expect(r.attempts).toBe(2);
      expect(reserve).toHaveBeenCalledTimes(2);
    },
  );
  it("stops after one retry and writes both attempts to the real ledger", async () => {
    const t = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("", { status: 429 }));
    await expect(
      callModel(user, "ledger", "r", undefined, t, undefined, {
        backoffMs: 0,
      }),
    ).rejects.toMatchObject({ code: "AI_UPSTREAM_HTTP_429", retryable: true });
    expect(t).toHaveBeenCalledTimes(2);
    const ledger = JSON.parse(
      await readFile(path.join(dir, "quota.json"), "utf8"),
    );
    expect(ledger.global.daily).toBe(2);
    expect(ledger.sessions.ledger.daily).toBe(2);
    expect(ledger.tokens).toBe(2 * reserve.mock.calls[0][1]);
  });
  it("honours a short Retry-After before the second attempt", async () => {
    ledger.real = false;
    vi.useFakeTimers();
    const t = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("", { status: 429, headers: { "retry-after": "2" } }),
      )
      .mockResolvedValueOnce(ok("{}"));
    const p = callModel(user, "s", "r", undefined, t, undefined, {
      backoffMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1990);
    expect(t).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20);
    await p;
    expect(t).toHaveBeenCalledTimes(2);
    ledger.real = true;
  });
  it("retry none and a quota refusal on the retry both stop further calls", async () => {
    const t = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("", { status: 503 }));
    await expect(
      callModel(user, "s", "r", undefined, t, undefined, { retry: "none" }),
    ).rejects.toMatchObject({ code: "AI_UPSTREAM_HTTP_503" });
    expect(t).toHaveBeenCalledTimes(1);
    t.mockClear();
    reserve.mockImplementationOnce(async () => {});
    reserve.mockImplementationOnce(async () => {
      const { AiError } = await import("@/server/ai/errors");
      throw new AiError("AI_QUOTA", "额度", 429, true);
    });
    await expect(
      callModel(user, "s", "r", undefined, t, undefined, { backoffMs: 0 }),
    ).rejects.toMatchObject({ code: "AI_QUOTA" });
    expect(t).toHaveBeenCalledTimes(1);
  });
  it("services choose idempotent retry for extraction and pre-response for continuation", async () => {
    const mock = vi.fn<typeof callModel>().mockResolvedValue({
      message: { role: "assistant", content: "{}" },
      usage: null,
      model: "qwen3.8-flash",
    });
    await generateTask(
      "pet-profile",
      { text: "狗", context: {} },
      "s",
      "r",
      new Date(),
      mock,
    ).catch(() => {});
    expect(mock.mock.calls[0][6]).toMatchObject({ retry: "idempotent" });
    mock.mockClear();
    await assistantStep({ text: "找宠友" }, "s", "r", new Date(), mock).catch(
      () => {},
    );
    expect(mock.mock.calls[0][6]).toMatchObject({ retry: "pre-response" });
  });
  it("a retried assistant step returns its tool calls once", async () => {
    const tool = {
      index: 0,
      id: "tc1",
      type: "function",
      function: { name: "search_pets", arguments: "{}" },
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response("", { status: 503 }))
        .mockResolvedValueOnce(
          sse([delta({ tool_calls: [tool] }), delta({}, "tool_calls")]),
        ),
    );
    const step = await assistantStep({ text: "找宠友" }, "s", "r");
    expect(step.data.toolCalls).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("route NDJSON progress and browser reader", () => {
  const profile = {
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
    cautions: [],
    clarifications: [],
    warnings: [],
  };
  const req = (accept?: string) =>
    new NextRequest("https://paw.test/api/ai/pet-profile", {
      method: "POST",
      headers: {
        origin: "https://paw.test",
        "Content-Type": "application/json",
        ...(accept ? { accept } : {}),
      },
      body: JSON.stringify({ text: "一只狗", context: {} }),
    });
  const ctx = { params: Promise.resolve({ task: "pet-profile" }) };
  it("streams progress then the validated result when the browser accepts NDJSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          sse(
            [
              delta({ content: JSON.stringify(profile).slice(0, 20) }),
              delta({ content: JSON.stringify(profile).slice(20) }, "stop"),
              { choices: [], usage },
            ],
            { split: 9 },
          ),
        ),
    );
    const r = await POST(req(AI_STREAM_TYPE), ctx);
    expect(r.headers.get("content-type")).toContain(AI_STREAM_TYPE);
    expect(r.headers.get("set-cookie")).toContain("pawmeet-ai=");
    const progress: AiProgress[] = [];
    const { status, result } = await readAiStream(r.body!, (p) =>
      progress.push(p),
    );
    expect(status).toBe(200);
    expect(result).toMatchObject({
      ok: true,
      // Business validation still runs on the reassembled output.
      data: {
        ...profile,
        clarifications: expect.arrayContaining(["请补充名字"]),
      },
      meta: { model: "qwen3.8-flash", usage },
    });
    // Buffered server "waiting" event, then one throttled "receiving" event.
    expect(progress.map((p) => p.stage)).toEqual(["waiting", "receiving"]);
  });
  it("keeps real HTTP status for failures before the model responds", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("", { status: 401 })),
    );
    const r = await POST(req(AI_STREAM_TYPE), ctx);
    expect(r.status).toBe(502);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect((await r.json()).error.code).toBe("AI_UPSTREAM_HTTP_401");
  });
  it("reports a failure after streaming started as an error event", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(sse([delta({ content: "{" }, "length")])),
    );
    const r = await POST(req(AI_STREAM_TYPE), ctx);
    const { status, result } = await readAiStream(r.body!);
    expect(status).toBe(502);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "AI_UPSTREAM_INCOMPLETE" },
    });
    expect(JSON.stringify(result)).not.toContain("unit-secret");
  });
  it("browser client parses NDJSON with split lines and still accepts plain JSON", async () => {
    const lines =
      `{"type":"progress","stage":"receiving","attempt":1,"chars":12}\n` +
      `{"type":"result","body":${JSON.stringify({ ok: true, requestId: "q", data: profile, meta: {} })}}\n`;
    const bytes = new TextEncoder().encode(lines);
    const stream = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            for (let i = 0; i < bytes.length; i += 5)
              c.enqueue(bytes.slice(i, i + 5));
            c.close();
          },
        }),
        { headers: { "content-type": `${AI_STREAM_TYPE}; charset=utf-8` } },
      );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(stream())
      .mockResolvedValueOnce(
        Response.json({ ok: true, requestId: "q", data: profile, meta: {} }),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            ok: false,
            requestId: "q",
            error: { code: "AI_QUOTA", message: "额度" },
          },
          { status: 429 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const progress: AiProgress[] = [];
    const a = await aiTask(
      "pet-profile",
      { text: "狗", context: {} },
      undefined,
      (p) => progress.push(p),
    );
    expect(a.data).toEqual(profile);
    expect(progress.map((p) => p.stage)).toEqual(["waiting", "receiving"]);
    expect(
      (fetchMock.mock.calls[0][1]!.headers as Record<string, string>).Accept,
    ).toContain(AI_STREAM_TYPE);
    expect(
      (await aiTask("pet-profile", { text: "狗", context: {} })).data,
    ).toEqual(profile);
    await expect(
      aiTask("pet-profile", { text: "狗", context: {} }),
    ).rejects.toThrow("AI_QUOTA");
  });
  it("browser reader rejects a stream that ends without a result", async () => {
    await expect(
      readAiStream(
        new Response(
          `{"type":"progress","stage":"receiving","attempt":1,"chars":3}\n`,
        ).body!,
      ),
    ).rejects.toThrow("中断");
  });
});
