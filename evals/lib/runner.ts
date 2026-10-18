import { randomUUID } from "node:crypto";
import { callModel } from "../../src/server/ai/client";
import { AiError } from "../../src/server/ai/errors";
import { generateTask, assistantStep } from "../../src/server/ai/service";
import { PROMPT_VERSION } from "../../src/server/ai/prompts";
import { VALIDATION_VERSION } from "../../src/lib/ai/validation";
import {
  assistantAnswerSchema,
  nativeToolSchemas,
  outputSchemas,
  ToolName,
  ToolResult,
} from "../../src/lib/ai/contracts";
import { resolveAvailability } from "../../src/lib/ai/availability";
import {
  CompanionCache,
  executeCompanionTool,
} from "../../src/lib/ai/companion";
import { createSeed, demoPlaces } from "../../src/data/seed";
import { DEFAULT_REFERENCE } from "../../src/domain/geo";
import type { PlaceRef } from "../../src/domain/schemas";
import {
  CASE_VERSION,
  now,
  retiredCases,
  type EvalCase,
  type ExtractionCase,
  type WorkflowCase,
} from "../cases/current";
import { scoreChecks } from "./checks";
import type { EvalBudget, Ticket } from "./budget";
import type { EvalConfig } from "./config";
import { summarize, type CallRecord, type CaseAttempt } from "./metrics";
import type { MockContext } from "./mock-transport";

export type RunDeps = {
  runId: string;
  transport: typeof fetch;
  budget: EvalBudget;
  git: { commit: string; dirty: boolean };
  mock?: MockContext;
  clock?: () => number;
  log?: (line: string) => void;
};
type StopReason = "budget" | "max_calls" | "circuit_open";
const STOP_CODES: Record<string, StopReason> = {
  AI_EVAL_BUDGET: "budget",
  AI_EVAL_MAX_CALLS: "max_calls",
};
class Stop extends Error {
  constructor(
    readonly reason: StopReason,
    readonly calls: CallRecord[],
  ) {
    super(reason);
  }
}
const SUMMARY = {
  failed: "工具执行失败，请稍后重试。",
  clarify: "需要补充信息，请查看工具提示。",
  draft: "已生成活动草稿，请编辑并确认，尚未创建。",
  empty: "没有符合条件的结果，请调整条件。",
  found: "已查询，请查看实际结果卡片。",
};
/** The only truthful summaries for the tool results the final answer was given. */
export function truthfulSummaries(results: ToolResult[]): string[] {
  if (!results.length) return [];
  if (results.some((r) => r.kind === "error"))
    return [SUMMARY.failed, SUMMARY.clarify];
  if (results.some((r) => r.kind === "activity-draft")) return [SUMMARY.draft];
  const rows = results.flatMap((r) =>
    "rows" in r ? (r.rows as unknown[]) : [],
  );
  return [rows.length ? SUMMARY.found : SUMMARY.empty];
}
const errorCode = (e: unknown) =>
  e instanceof AiError ? e.code : e instanceof Error ? e.name : "ERROR";
const parseJson = (s: string | null | undefined) => {
  try {
    return JSON.parse(s ?? "");
  } catch {
    return undefined;
  }
};

export async function runEval(config: EvalConfig, deps: RunDeps) {
  const clock = deps.clock ?? (() => performance.now());
  const log = deps.log ?? (() => {});
  const startedAt = new Date().toISOString();
  const budgetBefore = deps.budget.snapshot();
  let seq = 0,
    transmissions = 0,
    lastDispatch = -Infinity,
    consecutiveUpstream = 0;
  let stopped: StopReason | null = null;

  /** callModel with the eval budget, per-attempt timing and raw response capture. */
  const instrumented =
    (sink: CallRecord[], caseId: string, repeat: number): typeof callModel =>
    async (
      messages,
      session,
      requestId,
      tools,
      _transport,
      schema,
      options,
    ) => {
      const record: CallRecord = {
        seq: ++seq,
        caseId,
        repeat,
        step: sink.length + 1,
        model: config.model,
        promptVersion: PROMPT_VERSION,
        validationVersion: VALIDATION_VERSION,
        git: deps.git.commit,
        attempts: 0,
        retries: 0,
        firstByteMs: null,
        totalMs: 0,
        httpStatus: null,
        errorCode: null,
        usage: null,
        reservedTokens: 0,
        chargedTokens: 0,
        timedOutAttempts: 0,
        response: null,
        schemaValid: null,
        businessValid: null,
        keyFieldsCorrect: null,
      };
      sink.push(record);
      const tickets: Ticket[] = [];
      type Attempt = {
        start: number;
        firstByte: number | null;
        status: number | null;
        completed: boolean;
        signal?: AbortSignal | null;
        excerpt: Uint8Array[];
      };
      const attempts: Attempt[] = [];
      const start = clock();
      const transport: typeof fetch = async (url, init) => {
        const pause = config.minIntervalMs - (clock() - lastDispatch);
        if (pause > 0) await new Promise((r) => setTimeout(r, pause));
        lastDispatch = clock();
        const a: Attempt = {
          start: clock(),
          firstByte: null,
          status: null,
          completed: false,
          signal: init?.signal,
          excerpt: [],
        };
        attempts.push(a);
        const res = await deps.transport(url, init);
        a.status = res.status;
        if (!res.body) {
          a.completed = true;
          return res;
        }
        let size = 0;
        const tap = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            a.firstByte ??= clock();
            if (size < 8192) {
              a.excerpt.push(chunk.slice(0, 8192 - size));
              size += chunk.length;
            }
            controller.enqueue(chunk);
          },
          flush() {
            a.completed = true;
          },
        });
        return new Response(res.body.pipeThrough(tap), {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
      };
      const settleAll = async (usageTotal: number | null) => {
        for (const [i, t] of tickets.entries())
          if (!t.settled)
            record.chargedTokens += await deps.budget.settle(
              t,
              i === tickets.length - 1 ? usageTotal : null,
            );
      };
      try {
        const result = await callModel(
          messages,
          session,
          requestId,
          tools,
          transport,
          schema,
          {
            ...options,
            model: config.model,
            reserve: async (worst) => {
              if (config.maxCalls !== null && transmissions >= config.maxCalls)
                throw new AiError(
                  "AI_EVAL_MAX_CALLS",
                  `已达 --max-calls ${config.maxCalls}`,
                  429,
                );
              const ticket = await deps.budget.reserve(worst);
              tickets.push(ticket);
              record.reservedTokens += ticket.reserved;
              transmissions++;
            },
          },
        );
        record.usage = result.usage;
        record.response = {
          content: result.message.content,
          ...(result.message.tool_calls
            ? { toolCalls: result.message.tool_calls }
            : {}),
        };
        await settleAll(result.usage?.total_tokens ?? null);
        consecutiveUpstream = 0;
        return result;
      } catch (e) {
        await settleAll(null);
        record.errorCode = errorCode(e);
        const last = attempts.at(-1);
        if (last?.excerpt.length)
          record.rawBodyExcerpt = Buffer.concat(last.excerpt)
            .toString("utf8")
            .slice(0, 4000);
        if (STOP_CODES[record.errorCode])
          throw new Stop(STOP_CODES[record.errorCode], sink);
        if (record.errorCode.startsWith("AI_UPSTREAM")) consecutiveUpstream++;
        throw e;
      } finally {
        record.totalMs = Math.round(clock() - start);
        record.attempts = attempts.length;
        record.retries = Math.max(0, attempts.length - 1);
        record.timedOutAttempts = attempts.filter(
          (a) => a.signal?.aborted && !a.completed,
        ).length;
        const last = attempts.at(-1);
        record.httpStatus = last?.status ?? null;
        record.firstByteMs =
          last?.firstByte != null ? Math.round(last.firstByte - start) : null;
      }
    };

  async function extraction(c: ExtractionCase, repeat: number) {
    const calls: CallRecord[] = [];
    let data: unknown, error: string | undefined;
    let businessValid = false;
    try {
      data = (
        await generateTask(
          c.scenario,
          c.input,
          `eval-${deps.runId}-${c.id}-${repeat}`,
          randomUUID(),
          now,
          instrumented(calls, c.id, repeat),
        )
      ).data;
      businessValid = true;
    } catch (e) {
      if (e instanceof Stop) throw e;
      if (errorCode(e) !== "AI_INVALID_OUTPUT")
        error = `${errorCode(e)}:${(e as Error).message}`;
    }
    for (const call of calls)
      call.schemaValid = call.response
        ? outputSchemas[c.scenario].safeParse(parseJson(call.response.content))
            .success
        : null;
    const score = scoreChecks(c.checks, businessValid ? data : undefined);
    const responded = calls.some((call) => call.response);
    for (const call of calls)
      if (call.response) {
        call.businessValid = businessValid;
        call.keyFieldsCorrect = businessValid && score.correct === score.total;
      }
    return {
      status: (!responded
        ? "error"
        : businessValid && score.correct === score.total
          ? "pass"
          : "fail") as CaseAttempt["status"],
      businessValid,
      score,
      observed: businessValid ? data : undefined,
      error:
        error ??
        (responded && !businessValid ? "AI_INVALID_OUTPUT" : undefined),
      calls,
    };
  }

  async function workflow(c: WorkflowCase, repeat: number) {
    const calls: CallRecord[] = [];
    const call = instrumented(calls, c.id, repeat);
    const session = `eval-${deps.runId}-${c.id}-${repeat}`;
    const state = createSeed(now);
    const own = state.pets.find(
      (p) => p.ownerId === state.activeUserId && !p.archivedAt,
    )!;
    const cache: CompanionCache = {};
    const places = async () =>
      structuredClone(demoPlaces) as unknown as PlaceRef[];
    const rounds: {
      calls: { name: string; args: unknown }[];
      results: ToolResult[];
    }[] = [];
    let answer: { summary: string; references: string[] } | null = null;
    let error: string | undefined,
      thrown = false;
    try {
      let step = await assistantStep(
        {
          text: c.text,
          pets: [
            {
              id: own.id,
              name: own.name,
              revision: own.revision,
              temperamentTags: own.temperamentTags,
              activityTags: own.activityTags,
              socialNotes: own.socialNotes,
            },
          ],
          workflow: {
            stage: c.stage,
            intent: c.intent,
            availability: resolveAvailability(c.intent, now),
          },
        },
        session,
        randomUUID(),
        now,
        call,
      );
      while (step.data.toolCalls.length) {
        const results = [];
        const round = {
          calls: [] as { name: string; args: unknown }[],
          results: [] as ToolResult[],
        };
        for (const tc of step.data.toolCalls) {
          const result: ToolResult =
            c.toolFault === tc.function.name
              ? {
                  kind: "error",
                  code: "TOOL_FAILED",
                  message: "评测注入的工具故障",
                }
              : await executeCompanionTool(
                  tc,
                  state,
                  DEFAULT_REFERENCE,
                  own.id,
                  c.intent,
                  c.stage,
                  cache,
                  now,
                  places,
                );
          round.calls.push({
            name: tc.function.name,
            args: parseJson(tc.function.arguments) ?? null,
          });
          round.results.push(result);
          results.push({ toolCallId: tc.id, result });
        }
        rounds.push(round);
        step = await assistantStep(
          { continuation: step.data.continuation, results },
          session,
          randomUUID(),
          now,
          call,
        );
      }
      answer = step.data.answer;
    } catch (e) {
      if (e instanceof Stop) throw e;
      thrown = true;
      error = `${errorCode(e)}:${(e as Error).message}`;
    }
    for (const rec of calls) {
      if (!rec.response) continue;
      rec.schemaValid = rec.response.toolCalls?.length
        ? (
            rec.response.toolCalls as {
              function: { name: string; arguments: string };
            }[]
          ).every(
            (t) =>
              Object.hasOwn(nativeToolSchemas, t.function.name) &&
              nativeToolSchemas[t.function.name as ToolName].safeParse(
                parseJson(t.function.arguments),
              ).success,
          )
        : assistantAnswerSchema.safeParse(parseJson(rec.response.content))
            .success;
    }
    const names = (xs: { name: string }[]) =>
      [...new Set(xs.map((x) => x.name))].sort();
    const returned = rounds.flatMap((r) =>
      r.results.flatMap((x) =>
        "rows" in x
          ? (x.rows as { id?: string }[]).flatMap((row) =>
              row.id ? [row.id] : [],
            )
          : [],
      ),
    );
    const lastResults = rounds.at(-1)?.results ?? [];
    const observed = {
      first: {
        names: names(rounds[0]?.calls ?? []),
        args: Object.fromEntries(
          (rounds[0]?.calls ?? []).map((x) => [x.name, x.args]),
        ),
      },
      all: { names: names(rounds.flatMap((r) => r.calls)) },
      draft: {
        created: rounds.some((r) =>
          r.results.some((x) => x.kind === "activity-draft"),
        ),
      },
      final: answer
        ? {
            summary: answer.summary,
            references: answer.references,
            referencesValid: answer.references.every((id) =>
              returned.includes(id),
            ),
            truthful: truthfulSummaries(lastResults).includes(answer.summary),
          }
        : null,
      rounds: rounds.length,
    };
    const badArgs = rounds.some((r) =>
      r.results.some(
        (x) => x.kind === "error" && x.code === "INVALID_ARGUMENTS",
      ),
    );
    const businessValid = !thrown && !badArgs && !!answer;
    const score = scoreChecks(c.checks, observed);
    for (const rec of calls)
      if (rec.response) rec.businessValid = businessValid;
    const responded = calls.some((rec) => rec.response);
    const upstream = error?.startsWith("AI_UPSTREAM");
    return {
      status: (!responded || upstream
        ? "error"
        : businessValid && score.correct === score.total
          ? "pass"
          : "fail") as CaseAttempt["status"],
      businessValid,
      score,
      observed,
      error: error ?? (badArgs ? "INVALID_ARGUMENTS" : undefined),
      calls,
    };
  }

  const attempts: CaseAttempt[] = [];
  const notRun = (
    c: EvalCase,
    repeat: number,
    reason: string,
    calls: CallRecord[] = [],
  ): CaseAttempt => ({
    caseId: c.id,
    scenario: c.scenario,
    tags: c.tags,
    repeat,
    status: "not_run",
    reason,
    businessValid: false,
    fieldsCorrect: 0,
    fieldsTotal: c.checks.length,
    failedChecks: [],
    calls,
  });
  // Round-major order: a budget stop leaves whole earlier rounds, not a few cases run k times.
  for (let repeat = 1; repeat <= config.repeat; repeat++)
    for (const c of config.cases) {
      if (stopped) {
        attempts.push(notRun(c, repeat, stopped));
        continue;
      }
      if (consecutiveUpstream >= 3) {
        stopped = "circuit_open";
        attempts.push(notRun(c, repeat, stopped));
        continue;
      }
      if (deps.mock) {
        deps.mock.current = c;
        deps.mock.attempt = repeat;
      }
      try {
        const r =
          c.scenario === "companion-tools"
            ? await workflow(c, repeat)
            : await extraction(c, repeat);
        attempts.push({
          caseId: c.id,
          scenario: c.scenario,
          tags: c.tags,
          repeat,
          status: r.status,
          businessValid: r.businessValid,
          fieldsCorrect: r.score.correct,
          fieldsTotal: r.score.total,
          failedChecks: r.score.failed,
          ...(r.error ? { error: r.error } : {}),
          observed: r.observed,
          calls: r.calls,
        });
        log(
          `${c.id}#${repeat} ${r.status}${r.error ? ` ${r.error.slice(0, 80)}` : ""}`,
        );
      } catch (e) {
        if (!(e instanceof Stop)) throw e;
        stopped = e.reason;
        attempts.push(notRun(c, repeat, stopped, e.calls));
        log(`${c.id}#${repeat} not_run (${stopped})`);
      }
    }
  const budgetAfter = deps.budget.snapshot();
  const metrics = summarize(attempts);
  const scenarios = [...new Set(config.cases.map((c) => c.scenario))];
  return {
    kind: "pawmeet-eval-run" as const,
    schemaVersion: 2,
    simulated: config.mode !== "live",
    dataLabel:
      config.mode === "live"
        ? "真实模型调用"
        : "模拟数据（mock 传输，未调用真实模型）",
    runId: deps.runId,
    mode: config.mode,
    model: config.model,
    provider: config.mode === "live" ? "bailian" : "mock",
    promptVersion: PROMPT_VERSION,
    validationVersion: VALIDATION_VERSION,
    caseVersion: CASE_VERSION,
    git: deps.git.commit,
    gitDirty: deps.git.dirty,
    clock: now.toISOString(),
    startedAt,
    finishedAt: new Date().toISOString(),
    config: {
      repeat: config.repeat,
      cases: config.cases.map((c) => c.id),
      tokenLimit: config.tokenLimit,
      maxCalls: config.maxCalls,
      minIntervalMs: config.minIntervalMs,
      mockFaults: config.mockFaults,
      ledger: config.mode === "live" ? config.ledger : "memory",
    },
    budget: {
      model: config.model,
      limit: config.tokenLimit,
      chargedBefore: budgetBefore.chargedTokens,
      chargedAfter: budgetAfter.chargedTokens,
      chargedThisRun: budgetAfter.chargedTokens - budgetBefore.chargedTokens,
      knownThisRun: budgetAfter.knownTokens - budgetBefore.knownTokens,
      conservativeThisRun:
        budgetAfter.conservativeTokens - budgetBefore.conservativeTokens,
      transmissionsThisRun:
        budgetAfter.transmissions - budgetBefore.transmissions,
      stoppedBy: stopped,
    },
    retiredCases,
    metrics,
    byScenario: Object.fromEntries(
      scenarios.map((s) => [
        s,
        summarize(attempts.filter((a) => a.scenario === s)),
      ]),
    ),
    cases: attempts,
  };
}
export type RunReport = Awaited<ReturnType<typeof runEval>>;
