import { it, vi, expect } from "vitest";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";

vi.mock("server-only", () => ({}));
import { coreCases, now, EvalCase } from "../cases/core";
import { validateOutput, VALIDATION_VERSION } from "@/lib/ai/validation";
import {
  outputSchemas,
  emptyMatch,
  assistantSummaries,
  toolSchemas,
  nativeToolSchemas,
  ToolName,
} from "@/lib/ai/contracts";
import {
  taskPrompt,
  assistantPrompt,
  nativeTools,
  PROMPT_VERSION,
  calendarContext,
  taskOutputSchema,
  finalAnswerSchema,
} from "@/server/ai/prompts";
import { callModel, Message } from "@/server/ai/client";
import { AiError } from "@/server/ai/errors";
import { checkedAnswer, answerRepairInstruction } from "@/server/ai/answer";
import { executeTool, parseToolArguments } from "@/lib/ai/tools";
import { createSeed } from "@/data/seed";
import { DEFAULT_REFERENCE } from "@/domain/geo";
const mode = process.env.AI_EVAL_MODE ?? "mock";
type Row = {
  id: string;
  status: string;
  schema: boolean;
  fieldsCorrect: number;
  fieldsTotal: number;
  taskSuccess: boolean;
  error?: string;
  raw?: unknown;
  trace?: Message[];
  usage?: unknown;
  latencyMs: number;
  toolsExpected?: string[];
  toolsActual?: string[];
  toolsOk?: number;
  toolsTotal?: number;
  parameterFieldsCorrect?: number;
  parameterFieldsTotal?: number;
};
const equal = (a: unknown, b: unknown) =>
  typeof a === "string" &&
  typeof b === "string" &&
  /^\d{4}-\d\d-\d\dT/.test(a) &&
  /^\d{4}-\d\d-\d\dT/.test(b)
    ? Date.parse(a) === Date.parse(b)
    : JSON.stringify(a) === JSON.stringify(b);
function assess(c: EvalCase, raw: unknown) {
  const schema = outputSchemas[c.task].safeParse(raw).success;
  let data: Record<string, unknown> | undefined;
  let rejected = false;
  let validationError: string | undefined;
  try {
    data = validateOutput(c.task, raw, c.input, now) as Record<string, unknown>;
  } catch (e) {
    rejected = true;
    validationError =
      e instanceof Error ? e.message.slice(0, 500) : "Validation failed";
  }
  const fields = Object.entries(c.expect);
  const fieldsCorrect = fields.filter(([k, v]) =>
    ["likes", "dislikes", "cautions"].includes(k) &&
    Array.isArray(v) &&
    Array.isArray(data?.[k])
      ? v.length === 0
        ? (data![k] as unknown[]).length === 0
        : v.every((expected) =>
            (data![k] as string[]).some((actual) => actual.includes(expected)),
          )
      : equal(data?.[k], v),
  ).length;
  const clarified =
    !c.clarify || !!(data?.clarifications as string[] | undefined)?.length;
  const taskSuccess = c.reject
    ? rejected
    : !rejected && clarified && fieldsCorrect === fields.length;
  return {
    schema,
    fieldsCorrect,
    fieldsTotal: fields.length,
    taskSuccess,
    ...(!taskSuccess
      ? {
          error:
            validationError ??
            (!clarified
              ? "Missing clarification"
              : `Expected fields failed: ${fields
                  .filter(([k, v]) => !equal(data?.[k], v))
                  .map(([k]) => k)
                  .join(",")}`),
        }
      : {}),
  };
}
const nativeCases = [
  {
    id: "TC01",
    text: "找5公里内温和喜欢散步的狗狗",
    names: ["search_pets"],
    args: [
      {
        ...emptyMatch,
        radiusKm: 5,
        temperaments: ["温和"],
        activities: ["散步"],
      },
    ],
  },
  {
    id: "TC02",
    text: "查找滨江区未来活动",
    names: ["search_activities"],
    args: [
      {
        district: "滨江区",
        radiusKm: null,
        startAfter: null,
        startBefore: null,
      },
    ],
  },
  {
    id: "TC03",
    text: "明天下午想找人帮我遛一下年糕，大概30分钟，不能松牵引绳，请整理草稿",
    names: ["create_help_draft"],
    args: [
      {
        type: "walk",
        petId: null,
        title: "临时遛狗",
        details: "不能松牵引绳",
        startAt: null,
        endAt: null,
        durationMinutes: 30,
        timeText: "明天下午",
        district: null,
        locationQuery: null,
        clarifications: [],
        warnings: [],
      },
    ],
  },
  {
    id: "TC04",
    text: "找5公里内温和的狗狗，也查一下滨江区已有活动",
    names: ["search_pets", "search_activities"],
    args: [
      { ...emptyMatch, radiusKm: 5, temperaments: ["温和"] },
      {
        district: "滨江区",
        radiusKm: null,
        startAfter: null,
        startBefore: null,
      },
    ],
  },
  {
    id: "TC05",
    text: "找1公里内不含大型犬的宠友",
    names: ["search_pets"],
    args: [{ ...emptyMatch, radiusKm: 1, excludedSizes: ["large"] }],
  },
  {
    id: "TC06",
    text: "查找杭州不存在区的已有活动，不要编造",
    names: ["search_activities"],
    args: [
      {
        district: "不存在区",
        radiusKm: null,
        startAfter: null,
        startBefore: null,
      },
    ],
  },
  {
    id: "TC07",
    text: "查找3公里内小型犬，也帮我草拟明天下午遛年糕30分钟的互助",
    names: ["search_pets", "create_help_draft"],
    args: [
      { ...emptyMatch, radiusKm: 3, sizes: ["small"] },
      {
        type: "walk",
        petId: null,
        title: "临时遛狗",
        details: "明天下午遛年糕30分钟",
        startAt: null,
        endAt: null,
        durationMinutes: 30,
        timeText: "明天下午",
        district: null,
        locationQuery: null,
        clarifications: [],
        warnings: [],
      },
    ],
  },
  {
    id: "TC08",
    text: "找10公里内喜欢散步的宠友和5公里内已有活动",
    names: ["search_pets", "search_activities"],
    args: [
      { ...emptyMatch, radiusKm: 10, activities: ["散步"] },
      { district: null, radiusKm: 5, startAfter: null, startBefore: null },
    ],
  },
];
function assessParameters(
  name: string,
  raw: unknown,
  expected: Record<string, unknown>,
) {
  let actual: Record<string, unknown> | null = null;
  try {
    actual = parseToolArguments(name as ToolName, raw);
  } catch {
    /* Invalid parameters score zero. */
  }
  const fields = Object.entries(expected).filter(([key, value]) =>
    name === "create_help_draft"
      ? [
          "type",
          "petId",
          "durationMinutes",
          "startAt",
          "endAt",
          "district",
          "locationQuery",
        ].includes(key)
      : !["clarifications", "warnings", "unmappedTerms"].includes(key) &&
        (key !== "sort" || value !== null),
  );
  return {
    correct: fields.filter(([key, value]) => equal(actual?.[key], value))
      .length,
    total: fields.length,
  };
}
it("工具参数评测拒绝错误地区、通称犬种和遗漏排除条件", () => {
  expect(
    assessParameters(
      "search_activities",
      { district: "西湖区" },
      { district: "滨江区" },
    ).correct,
  ).toBe(0);
  expect(
    assessParameters(
      "search_pets",
      { ...emptyMatch, breeds: ["狗狗"] },
      emptyMatch,
    ).correct,
  ).toBeLessThan(12);
  expect(
    assessParameters("search_pets", emptyMatch, { excludedSizes: ["large"] })
      .correct,
  ).toBe(0);
  expect(
    assessParameters("search_pets", { radiusKm: "5" }, { radiusKm: 5 }),
  ).toEqual({ correct: 1, total: 1 });
});
it("执行并保存分离的AI评测报告", async () => {
  // Legacy core.v2 regression is mock-only; real calls go through the budgeted runner.
  if ((process.env.AI_EVAL_MODE ?? "mock") !== "mock")
    throw Error(
      "旧版 core.v2 评测只保留 mock 回归；真实评测请用 npm run eval:ai -- --mode live",
    );
  const rows: Row[] = [];
  const suite = process.env.AI_EVAL_SUITE || "all";
  let actualCalls = 0;
  const max = Number(process.env.AI_EVAL_MAX_CALLS ?? 55);
  const report = process.env.AI_EVAL_REPORT ?? "evals/reports/manual-mock.json";
  const resume = process.env.AI_EVAL_RESUME;
  if (resume) {
    const old = JSON.parse(await readFile(resume, "utf8"));
    if (
      old.mode !== mode ||
      old.suite !== suite ||
      (mode === "live" &&
        old.model !== (process.env.AI_MODEL || "qwen3.8-flash")) ||
      old.promptVersion !== PROMPT_VERSION ||
      old.validationVersion !== VALIDATION_VERSION ||
      old.caseVersion !== "core.v2+validation.v2+tools.v5"
    )
      throw Error(
        "resume模式、套件、模型或Prompt/校验/用例版本不匹配，需独立重跑",
      );
    rows.push(...old.cases.filter((c: Row) => c.status === "pass"));
  }
  const selected = process.env.AI_EVAL_CASE;
  const planned = selected
    ? 1
    : suite === "risk"
      ? 20
      : suite === "tools"
        ? 8
        : suite === "core"
          ? mode === "live"
            ? 35
            : 46
          : mode === "live"
            ? 43
            : 54;
  const wanted = (id: string) =>
    !rows.some((r) => r.id === id) &&
    (!selected || id === selected) &&
    (suite === "all" || (suite === "tools") === id.startsWith("TC"));
  const usage: unknown[] = [];
  let upstreamFailures = 0;
  process.env.AI_MODEL = process.env.AI_MODEL || "qwen3.8-flash";
  if (mode === "live") {
    process.env.AI_ENABLED = "true";
    process.env.QUOTA_STORE_PATH = `.local/ai-eval/${process.env.AI_EVAL_RUN_ID ?? "manual"}.quota.json`;
  }
  let lastDispatch = 0;
  const liveCall = async (
    messages: Message[],
    tools?: unknown[],
    jsonSchema?: Record<string, unknown>,
  ) => {
    if (upstreamFailures >= 3) throw Error("CIRCUIT_OPEN");
    if (actualCalls >= max) throw Error("MAX_CALLS");
    const r = await callModel(
      messages,
      `eval-${actualCalls}`,
      crypto.randomUUID(),
      tools,
      async (url, options) => {
        if (actualCalls >= max)
          throw new AiError("MAX_CALLS", "MAX_CALLS", 429);
        const delay = Math.max(0, 6500 - (Date.now() - lastDispatch));
        if (delay) await new Promise((r) => setTimeout(r, delay));
        actualCalls++;
        lastDispatch = Date.now();
        const response = await fetch(url, options);
        const captured = await response
          .clone()
          .json()
          .catch(() => null);
        await mkdir(".local/ai-eval", { recursive: true });
        await writeFile(
          `.local/ai-eval/${process.env.AI_EVAL_RUN_ID}-${actualCalls}.json`,
          JSON.stringify(
            {
              status: response.status,
              error: captured?.error
                ? { code: captured.error.code }
                : undefined,
              choices: captured?.choices?.map(
                (v: {
                  finish_reason: string;
                  message: {
                    role: string;
                    content: string;
                    tool_calls: unknown;
                  };
                }) => ({
                  finish_reason: v.finish_reason,
                  message: {
                    role: v.message.role,
                    content: v.message.content,
                    tool_calls: v.message.tool_calls,
                  },
                }),
              ),
              usage: captured?.usage,
            },
            null,
            2,
          ),
        );
        if (!response.ok) upstreamFailures++;
        else upstreamFailures = 0;
        return response;
      },
      jsonSchema,
    );
    usage.push(r.usage);
    return r;
  };
  const riskIds = [
    "C03",
    "C05",
    "M03",
    "M05",
    "M07",
    "H03",
    "H04",
    "H06",
    "L03",
    "L06",
  ];
  const taskCases =
    suite === "risk"
      ? coreCases
          .filter((c) => riskIds.includes(c.id))
          .flatMap((c) =>
            [1, 2].map((round) => ({ ...c, id: `${c.id}-R${round}` })),
          )
      : coreCases;
  for (const c of taskCases.filter(
    (c) => mode === "mock" || !c.id.startsWith("V"),
  )) {
    if (!wanted(c.id)) continue;
    const start = Date.now();
    try {
      let raw: unknown = c.mock,
        used: unknown = null;
      if (mode === "live") {
        const r = await liveCall(
          [
            { role: "system", content: taskPrompt(c.task) },
            {
              role: "user",
              content: JSON.stringify({
                input: c.input,
                now: now.toISOString(),
                timezone: "Asia/Shanghai",
                calendar: calendarContext(now),
              }),
            },
          ],
          undefined,
          taskOutputSchema(c.task),
        );
        used = r.usage;
        try {
          raw = JSON.parse(r.message.content ?? "");
        } catch {
          raw = r.message.content;
        }
      }
      const result = assess(c, raw);
      rows.push({
        id: c.id,
        status: result.taskSuccess ? "pass" : "fail",
        ...result,
        raw,
        usage: used,
        latencyMs: Date.now() - start,
      });
    } catch (e) {
      rows.push({
        id: c.id,
        status: ["MAX_CALLS", "CIRCUIT_OPEN"].includes((e as Error).message)
          ? "not_run"
          : "error",
        schema: false,
        fieldsCorrect: 0,
        fieldsTotal: Object.keys(c.expect).length,
        taskSuccess: false,
        error: `${(e as AiError).code ?? "ERROR"}:${(e as Error).message}`,
        latencyMs: Date.now() - start,
      });
    }
    // Avoid per-minute API demo guard exhaustion; local eval still observes same global budgets.
  }
  const state = createSeed(now);
  const own = state.pets.find((p) => p.ownerId === state.activeUserId)!;
  for (const c of nativeCases) {
    if (!wanted(c.id)) continue;
    const start = Date.now();
    const toolsActual: string[] = [];
    let toolsOk = 0,
      toolsTotal = 0;
    let parameterFieldsCorrect = 0,
      parameterFieldsTotal = 0;
    let rawToolSchema = true;
    let nativeTrace: Message[] = [];
    try {
      const messages: Message[] = [
        {
          role: "system",
          content: `${assistantPrompt}\nsummary只允许${JSON.stringify(assistantSummaries)}\ncalendar=${JSON.stringify(calendarContext(now))} now=${now.toISOString()} 本人宠物=${JSON.stringify([{ id: own.id, name: own.name }])}`,
        },
        { role: "user", content: c.text },
      ];
      nativeTrace = messages;
      let final = false;
      let finalize = false;
      const refs: string[] = [];
      let raw: unknown;
      for (let round = 0; round < 4; round++) {
        const message =
          mode === "live"
            ? (
                await liveCall(
                  messages,
                  finalize ? undefined : nativeTools,
                  finalize ? finalAnswerSchema : undefined,
                )
              ).message
            : round === 0
              ? {
                  role: "assistant" as const,
                  content: null,
                  tool_calls: c.names.map((name, i) => ({
                    id: `call-${i}`,
                    type: "function" as const,
                    function: {
                      name,
                      arguments: JSON.stringify(
                        Object.fromEntries(
                          Object.entries(
                            name === "create_help_draft"
                              ? { ...c.args[i], petId: own.id }
                              : c.args[i],
                          ).filter(([, value]) => value !== null),
                        ),
                      ),
                    },
                  })),
                }
              : {
                  role: "assistant" as const,
                  content: JSON.stringify({
                    summary: "已查询，请查看实际结果卡片。",
                    references: [],
                  }),
                };
        messages.push(message);
        raw = message;
        const calls = message.tool_calls ?? [];
        if (finalize && calls.length)
          throw Error("Unexpected tool call during final response");
        if (!calls.length) {
          const checked = await checkedAnswer(
            message,
            refs,
            mode === "live" && round < 3
              ? () =>
                  liveCall(
                    [...messages, answerRepairInstruction(refs)],
                    undefined,
                    finalAnswerSchema,
                  )
              : undefined,
          );
          if (checked.repaired) {
            messages.push(checked.message);
            raw = checked.message;
            rawToolSchema = false;
            round++;
          }
          final = true;
          break;
        }
        let allToolsOk = true;
        for (const call of calls) {
          const expectedIndex = c.names.indexOf(call.function.name);
          if (expectedIndex >= 0) {
            const expected = c.args[expectedIndex];
            const score = assessParameters(
              call.function.name,
              (() => {
                try {
                  return JSON.parse(call.function.arguments);
                } catch {
                  return null;
                }
              })(),
              call.function.name === "create_help_draft"
                ? { ...expected, petId: own.id }
                : expected,
            );
            parameterFieldsCorrect += score.correct;
            parameterFieldsTotal += score.total;
          }
          try {
            if (
              !Object.hasOwn(toolSchemas, call.function.name) ||
              !nativeToolSchemas[call.function.name as ToolName].safeParse(
                JSON.parse(call.function.arguments),
              ).success
            )
              rawToolSchema = false;
          } catch {
            rawToolSchema = false;
          }
          toolsActual.push(call.function.name);
          toolsTotal++;
          const result = executeTool(
            call,
            state,
            DEFAULT_REFERENCE,
            own.id,
            now,
            c.text,
          );
          if (result.kind !== "error") toolsOk++;
          else allToolsOk = false;
          if (result.kind === "pets" || result.kind === "activities")
            refs.push(...result.rows.map((r) => r.id));
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(result),
          });
        }
        finalize = allToolsOk;
      }
      const choice = equal(
        [...new Set(toolsActual)].sort(),
        [...c.names].sort(),
      );
      const success =
        final &&
        choice &&
        toolsOk === toolsTotal &&
        toolsTotal > 0 &&
        parameterFieldsCorrect === parameterFieldsTotal;
      rows.push({
        id: c.id,
        status: success ? "pass" : "fail",
        schema: rawToolSchema && toolsTotal > 0,
        fieldsCorrect: choice ? 1 : 0,
        fieldsTotal: 1,
        taskSuccess: success,
        toolsExpected: c.names,
        trace: nativeTrace.filter((m) => m.role !== "system"),
        toolsActual,
        toolsOk,
        toolsTotal,
        parameterFieldsCorrect,
        parameterFieldsTotal,
        raw,
        latencyMs: Date.now() - start,
      });
    } catch (e) {
      rows.push({
        id: c.id,
        status: ["MAX_CALLS", "CIRCUIT_OPEN"].includes((e as Error).message)
          ? "not_run"
          : "error",
        schema: false,
        fieldsCorrect: 0,
        fieldsTotal: 1,
        taskSuccess: false,
        error: `${(e as AiError).code ?? "ERROR"}:${(e as Error).message}`,
        toolsExpected: c.names,
        trace: nativeTrace.filter((m) => m.role !== "system"),
        toolsActual,
        toolsOk,
        toolsTotal,
        parameterFieldsCorrect,
        parameterFieldsTotal,
        latencyMs: Date.now() - start,
      });
    }
  }
  const executed = rows.filter((r) => r.status !== "not_run");
  const valid = executed.filter((r) => !r.id.startsWith("V"));
  const toolRows = valid.filter((r) => r.id.startsWith("TC"));
  const ratio = (n: number, d: number) => (d ? n / d : null);
  const result = {
    runId: process.env.AI_EVAL_RUN_ID,
    mode,
    suite,
    model:
      mode === "live" ? process.env.AI_MODEL : "synthetic fixtures; no Qwen",
    provider: mode === "live" ? "qwen" : "mock",
    promptVersion: PROMPT_VERSION,
    schemaVersion: 1,
    caseVersion: "core.v2+validation.v2+tools.v5",
    validationVersion: VALIDATION_VERSION,
    gitDirty:
      execFileSync("git", ["status", "--porcelain"], {
        encoding: "utf8",
      }).trim().length > 0,
    coverage: {
      planned,
      attempted: executed.length,
      notRun: rows.filter((r) => r.status === "not_run").length,
    },
    git: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    clock: now.toISOString(),
    actualProviderCalls: actualCalls,
    maxCalls: max,
    usage,
    metrics: {
      schemaPassRate: ratio(valid.filter((r) => r.schema).length, valid.length),
      keyFieldAccuracy: ratio(
        valid.reduce((s, r) => s + r.fieldsCorrect, 0),
        valid.reduce((s, r) => s + r.fieldsTotal, 0),
      ),
      toolSelectionAccuracy: ratio(
        toolRows.filter((r) =>
          equal(
            [...new Set(r.toolsActual)].sort(),
            r.toolsExpected?.toSorted(),
          ),
        ).length,
        toolRows.length,
      ),
      toolExecutionSuccessRate: ratio(
        toolRows.reduce((s, r) => s + (r.toolsOk ?? 0), 0),
        toolRows.reduce((s, r) => s + (r.toolsTotal ?? 0), 0),
      ),
      toolParameterAccuracy: ratio(
        toolRows.reduce((s, r) => s + (r.parameterFieldsCorrect ?? 0), 0),
        toolRows.reduce((s, r) => s + (r.parameterFieldsTotal ?? 0), 0),
      ),
      completeTaskSuccessRate: ratio(
        valid.filter((r) => r.taskSuccess).length,
        valid.length,
      ),
      adversarialValidationSuccessRate: ratio(
        executed.filter((r) => r.id.startsWith("V") && r.taskSuccess).length,
        executed.filter((r) => r.id.startsWith("V")).length,
      ),
    },
    cases: rows,
  };
  await mkdir("evals/reports", { recursive: true });
  await writeFile(report, JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify(
      {
        report,
        mode,
        metrics: result.metrics,
        counts: {
          planned,
          executed: executed.length,
          passed: executed.filter((r) => r.taskSuccess).length,
          notRun: rows.filter((r) => r.status === "not_run").length,
        },
        failures: rows
          .filter((r) => !r.taskSuccess)
          .map((r) => ({ id: r.id, status: r.status, error: r.error })),
      },
      null,
      2,
    ),
  );
  expect(rows.every((r) => r.taskSuccess)).toBe(true);
});
