/**
 * Simulated provider for engineering verification of the runner and reports. It speaks the
 * same OpenAI-compatible SSE protocol as Bailian so the production client, validation and tool
 * workflow run unchanged, but every response, latency and usage figure is synthetic.
 * Results are labelled 模拟数据 and can never be merged with live reports.
 */
import { resolveAvailability } from "../../src/lib/ai/availability";
import { PROVIDERS } from "../../src/server/ai/models";
import type { EvalCase, WorkflowCase } from "../cases/current";
import { now } from "../cases/current";

export const MOCK_HOST = "https://dashscope.aliyuncs.com";
/** Deterministic fault plan used with --mock-faults (exercise retries, timeouts, schema errors). */
export const MOCK_FAULTS: Record<
  string,
  "http503-once" | "stall" | "bad-shape"
> = {
  CI02: "http503-once",
  HI03: "stall",
  PP05: "bad-shape",
};

/** Rough token estimate: CJK characters ≈ 1 token, other characters ≈ 3.6 per token. */
export function estimateTokens(text: string) {
  const cjk = text.match(/[㐀-鿿＀-￯　-〿]/g)?.length ?? 0;
  return Math.ceil(cjk + (text.length - cjk) / 3.6);
}
const hash = (s: string) =>
  [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);

type Msg = {
  role: string;
  content: string | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
};
type Reply = {
  content?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
};
type ToolResultMsg = { kind: string; rows?: { id: string }[]; code?: string };

function finalAnswer(results: ToolResultMsg[]): Reply {
  const ids = results
    .filter((r) => r.kind === "pets" || r.kind === "activities")
    .flatMap((r) => (r.rows ?? []).map((row) => row.id));
  const summary = results.some((r) => r.kind === "error")
    ? results.some((r) => r.code === "NEEDS_CLARIFICATION")
      ? "需要补充信息，请查看工具提示。"
      : "工具执行失败，请稍后重试。"
    : results.some((r) => r.kind === "activity-draft")
      ? "已生成活动草稿，请编辑并确认，尚未创建。"
      : ids.length
        ? "已查询，请查看实际结果卡片。"
        : "没有符合条件的结果，请调整条件。";
  return {
    content: JSON.stringify({
      summary,
      references: results.some((r) => r.kind === "activity-draft")
        ? []
        : ids.slice(0, 3),
    }),
  };
}

/** A scripted "ideal" agent for the companion workflow; it only reads the case and messages. */
function workflowReply(
  c: WorkflowCase,
  messages: Msg[],
  tools: boolean,
): Reply {
  const calls = messages.filter(
    (m) => m.role === "assistant" && m.tool_calls?.length,
  );
  const results = messages
    .filter((m) => m.role === "tool")
    .map((m) => JSON.parse(m.content ?? "{}") as ToolResultMsg);
  const latest = (() => {
    const last = calls.at(-1);
    if (!last) return [];
    const ids = new Set(last.tool_calls!.map((t) => t.id));
    return messages
      .filter(
        (m) =>
          m.role === "tool" &&
          ids.has((m as { tool_call_id?: string }).tool_call_id ?? ""),
      )
      .map((m) => JSON.parse(m.content ?? "{}") as ToolResultMsg);
  })();
  const m = c.intent.match;
  const known = Object.fromEntries(
    Object.entries({
      radiusKm: m.radiusKm,
      district: m.district,
      sizes: m.sizes,
      excludedSizes: m.excludedSizes,
      breeds: m.breeds,
      excludedBreeds: m.excludedBreeds,
    }).filter(([, v]) => v !== null && !(Array.isArray(v) && !v.length)),
  );
  if (
    !tools ||
    latest.some((r) => r.kind === "error" || r.kind === "activity-draft")
  )
    return finalAnswer(latest);
  if (c.stage === "search") {
    if (calls.length) return finalAnswer(latest);
    const w = resolveAvailability(c.intent, now).windows;
    return {
      toolCalls: [
        {
          name: "search_activities",
          args: {
            ...(m.radiusKm ? { radiusKm: m.radiusKm } : {}),
            ...(m.district ? { district: m.district } : {}),
            startAfter: w[0].startAt,
            startBefore: w.at(-1)!.endAt,
          },
        },
      ],
    };
  }
  if (!calls.length)
    return {
      toolCalls: [
        { name: "search_pets", args: known },
        {
          name: "search_places",
          args: {
            query: c.intent.placeQuery ?? c.intent.activityType ?? "公园",
          },
        },
      ],
    };
  const pets = results.find((r) => r.kind === "pets")?.rows ?? [];
  const petIds = pets.slice(0, 2).map((p) => p.id);
  if (petIds.length && !results.some((r) => r.kind === "compatibility"))
    return { toolCalls: [{ name: "check_compatibility", args: { petIds } }] };
  return {
    toolCalls: [
      {
        name: "create_activity_draft",
        args: { title: "周末散步约伴", description: "", petIds, placeIndex: 0 },
      },
    ],
  };
}

function sseBody(
  reply: Reply,
  usage: object,
  gaps: number[],
  signal?: AbortSignal | null,
) {
  const events: object[] = [
    { choices: [{ index: 0, delta: { role: "assistant" } }] },
  ];
  if (reply.content) {
    const third = Math.ceil(reply.content.length / 3);
    for (let i = 0; i < reply.content.length; i += third)
      events.push({
        choices: [
          { index: 0, delta: { content: reply.content.slice(i, i + third) } },
        ],
      });
  }
  reply.toolCalls?.forEach((t, index) => {
    const args = JSON.stringify(t.args);
    const half = Math.ceil(args.length / 2);
    events.push({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
                id: `call_${index}_${hash(args).toString(36)}`,
                type: "function",
                function: { name: t.name, arguments: args.slice(0, half) },
              },
            ],
          },
        },
      ],
    });
    events.push({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index, function: { arguments: args.slice(half) } }],
          },
        },
      ],
    });
  });
  events.push({
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: reply.toolCalls?.length ? "tool_calls" : "stop",
      },
    ],
  });
  events.push({ choices: [], usage });
  const lines = [
    ...events.map((e) => `data: ${JSON.stringify(e)}\n\n`),
    "data: [DONE]\n\n",
  ];
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal?.aborted)
        return controller.error(new DOMException("aborted", "AbortError"));
      if (i >= lines.length) return controller.close();
      await new Promise((r) => setTimeout(r, gaps[i % gaps.length]));
      controller.enqueue(encoder.encode(lines[i++]));
    },
  });
}

const wait = (ms: number, signal?: AbortSignal | null) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted)
      return reject(new DOMException("aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    });
  });

export type MockContext = { current: EvalCase | null; attempt: number };

/**
 * fetch-compatible simulated transport. Refuses any URL other than the configured Bailian
 * chat endpoint and never performs network I/O.
 */
export function createMockTransport(
  ctx: MockContext,
  faults: boolean,
): typeof fetch {
  const seen = new Map<string, number>();
  return async (input, init) => {
    const url = String(input);
    if (
      !url.startsWith(`${MOCK_HOST}/compatible-mode/v1/chat/completions`) &&
      url !== PROVIDERS.gemini.url
    )
      throw Error(`mock transport refuses ${url}`);
    const c = ctx.current;
    if (!c) throw Error("mock transport has no active case");
    const body = JSON.parse(String(init?.body)) as {
      messages: Msg[];
      tools?: unknown[];
      stream?: boolean;
    };
    const key = `${c.id}#${ctx.attempt}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    const fault = faults ? MOCK_FAULTS[c.id] : undefined;
    const signal = init?.signal;
    const h = hash(`${key}#${n}`);
    await wait(40 + (h % 160), signal);
    if (fault === "http503-once" && n === 1)
      return new Response(
        JSON.stringify({ error: { code: "ServiceUnavailable" } }),
        {
          status: 503,
          headers: { "content-type": "application/json" },
        },
      );
    if (fault === "stall") {
      await wait(3_600_000, signal);
      throw Error("unreachable");
    }
    const reply: Reply =
      c.scenario === "companion-tools"
        ? workflowReply(c, body.messages, !!body.tools?.length)
        : {
            content:
              fault === "bad-shape"
                ? JSON.stringify({ ...(c.mock as object), ageMonths: "两岁" })
                : JSON.stringify(c.mock),
          };
    const out = (reply.content ?? "") + JSON.stringify(reply.toolCalls ?? []);
    const prompt = estimateTokens(
      JSON.stringify(body.messages) + JSON.stringify(body.tools ?? []),
    );
    const completion = estimateTokens(out);
    const usage = {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
    };
    return new Response(
      sseBody(reply, usage, [5 + (h % 25), 3 + (h % 11)], signal),
      {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      },
    );
  };
}
