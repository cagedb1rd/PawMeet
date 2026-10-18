import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
vi.mock("server-only", () => ({}));
const { productReserve } = vi.hoisted(() => ({ productReserve: vi.fn() }));
vi.mock("@/server/ai/quota", async (original) => ({
  ...(await original<typeof import("@/server/ai/quota")>()),
  reserveAiCall: productReserve,
}));
import { callModel } from "@/server/ai/client";
import {
  EvalBudget,
  fileStore,
  memoryStore,
  MODEL_TOKEN_CAPS,
} from "../../evals/lib/budget";
import { parseConfig, selectCases } from "../../evals/lib/config";
import {
  percentile,
  summarize,
  type CaseAttempt,
} from "../../evals/lib/metrics";
import { runEval, truthfulSummaries } from "../../evals/lib/runner";
import {
  createMockTransport,
  type MockContext,
} from "../../evals/lib/mock-transport";
import {
  assertMergeable,
  compareMarkdown,
  reportStem,
  runMarkdown,
} from "../../evals/lib/report";
import { currentCases, retiredCases } from "../../evals/cases/current";
import { runCheck } from "../../evals/lib/checks";

beforeEach(() => {
  vi.stubEnv("AI_ENABLED", "true");
  vi.stubEnv("DASHSCOPE_API_KEY", "unit-test-key");
  vi.stubEnv("DEMO_SESSION_SECRET", "unit-test-secret");
  vi.stubEnv("AI_BASE_URL", "");
  vi.stubEnv("AI_MODEL", "");
  vi.stubEnv("AI_STREAM", "true");
  vi.stubEnv("AI_FIRST_BYTE_TIMEOUT_MS", "1000");
  vi.stubEnv("AI_TOTAL_TIMEOUT_MS", "4000");
  productReserve.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

const git = { commit: "0000000", dirty: false };
async function simulate(argv: string[], budgetLimit = Infinity) {
  const config = parseConfig(["--mode", "simulated", ...argv]);
  const mock: MockContext = { current: null, attempt: 0 };
  const inner = createMockTransport(mock, config.mockFaults);
  const fetched = vi.fn(inner);
  const budget = await EvalBudget.open({
    model: config.model,
    limit: config.tokenLimit ?? budgetLimit,
    store: memoryStore(),
    runId: "unit",
  });
  const report = await runEval(config, {
    runId: "unit",
    transport: fetched as typeof fetch,
    budget,
    mock,
    git,
  });
  return { report, fetched, budget };
}

describe("case set", () => {
  it("has ~40 current cases with unique ids and checks, retired ids excluded", () => {
    expect(currentCases.length).toBeGreaterThanOrEqual(38);
    expect(new Set(currentCases.map((c) => c.id)).size).toBe(
      currentCases.length,
    );
    expect(currentCases.every((c) => c.checks.length > 0)).toBe(true);
    const retired = new Set(retiredCases.map((r) => r.id));
    expect(currentCases.some((c) => retired.has(c.id))).toBe(false);
    for (const tag of [
      "normal",
      "colloquial",
      "exclusion",
      "clarify",
      "injection",
      "distance-boundary",
      "multi-tool",
      "tool-error",
    ])
      expect(currentCases.some((c) => c.tags.includes(tag as never))).toBe(
        true,
      );
    expect(() => selectCases("M03")).toThrow(/已停用/);
    expect(selectCases("tag:injection").map((c) => c.id)).toContain("CI12");
  });
  it("checks are strict: wrong values, missing paths and negation fail", () => {
    expect(
      runCheck({ label: "", path: "a", op: "eq", value: 3 }, { a: 5 }),
    ).toBe(false);
    expect(runCheck({ label: "", path: "a.b", op: "nonEmpty" }, {})).toBe(
      false,
    );
    expect(
      runCheck(
        { label: "", path: "t", op: "excludes", value: "活泼" },
        { t: ["活泼"] },
      ),
    ).toBe(false);
    expect(
      runCheck(
        { label: "", path: "s", op: "eq", value: "2026-10-18T19:00:00+08:00" },
        { s: "2026-10-18T11:00:00.000Z" },
      ),
    ).toBe(true);
  });
});

describe("whitelist and config", () => {
  it("rejects models outside the text whitelist, including vision models", () => {
    expect(() => parseConfig(["--model", "qwen-max"])).toThrow(/白名单/);
    expect(() => parseConfig(["--model", "qwen3.8-omni-flash"])).toThrow(
      /白名单/,
    );
    expect(parseConfig(["--model", "qwen3.8-max-0902"]).model).toBe(
      "qwen3.8-max-0902",
    );
  });
  it("live defaults to 0 tokens and caps the limit at the approved per-model budget", () => {
    expect(() => parseConfig(["--mode", "live"])).toThrow(
      /默认 0 不允许真实调用/,
    );
    expect(() =>
      parseConfig([
        "--mode",
        "live",
        "--token-limit",
        String(MODEL_TOKEN_CAPS["qwen3.8-flash"] + 1),
      ]),
    ).toThrow(`0–${MODEL_TOKEN_CAPS["qwen3.8-flash"]}`);
    expect(MODEL_TOKEN_CAPS["gemini-3.8-flash"]).toBe(300000);
    expect(MODEL_TOKEN_CAPS["gemini-3.5-flash-lite"]).toBe(300000);
    expect(
      parseConfig([
        "--mode",
        "live",
        "--model",
        "qwen3.8-max-0902",
        "--token-limit",
        "300000",
      ]).tokenLimit,
    ).toBe(300000);
    expect(() =>
      parseConfig(["--mode", "live", "--token-limit", "10", "--mock-faults"]),
    ).toThrow();
    expect(() =>
      parseConfig(["--mode", "simulated", "--ledger", "x.json"]),
    ).toThrow(/内存账本/);
    expect(() => parseConfig(["--repeat", "9"])).toThrow();
  });
});

describe("eval budget", () => {
  it("refuses a reservation that would cross the limit; limit 0 refuses everything", async () => {
    const zero = await EvalBudget.open({
      model: "m",
      limit: 0,
      store: memoryStore(),
      runId: "r",
    });
    await expect(zero.reserve(1)).rejects.toMatchObject({
      code: "AI_EVAL_BUDGET",
    });
    const b = await EvalBudget.open({
      model: "m",
      limit: 1000,
      store: memoryStore(),
      runId: "r",
    });
    const t = await b.reserve(600);
    await expect(b.reserve(500)).rejects.toMatchObject({
      code: "AI_EVAL_BUDGET",
    });
    expect(await b.settle(t, 120)).toBe(120);
    expect(b.charged).toBe(120);
    const unknown = await b.reserve(800);
    // Unknown usage (timeout) keeps the full conservative reservation.
    expect(await b.settle(unknown, null)).toBe(800);
    expect(b.snapshot()).toMatchObject({
      chargedTokens: 920,
      knownTokens: 120,
      conservativeTokens: 800,
      transmissions: 2,
    });
    await expect(b.reserve(81)).rejects.toMatchObject({
      code: "AI_EVAL_BUDGET",
    });
  });
  it("persists cumulatively per model and never overwrites a corrupt ledger", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pawmeet-eval-"));
    try {
      const file = path.join(dir, "ledger.json");
      const a = await EvalBudget.open({
        model: "m",
        limit: 1000,
        store: fileStore(file),
        runId: "r1",
      });
      await a.settle(await a.reserve(700), 400);
      const b = await EvalBudget.open({
        model: "m",
        limit: 1000,
        store: fileStore(file),
        runId: "r2",
      });
      expect(b.charged).toBe(400);
      await expect(b.reserve(601)).rejects.toMatchObject({
        code: "AI_EVAL_BUDGET",
      });
      const other = await EvalBudget.open({
        model: "n",
        limit: 1000,
        store: fileStore(file),
        runId: "r2",
      });
      expect(other.charged).toBe(0);
      await writeFile(file, "{broken");
      await expect(
        EvalBudget.open({
          model: "m",
          limit: 1000,
          store: fileStore(file),
          runId: "r3",
        }),
      ).rejects.toMatchObject({ code: "AI_EVAL_LEDGER" });
      expect(await readFile(file, "utf8")).toBe("{broken");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("callModel uses the eval reserve hook per attempt instead of the product ledger", async () => {
    const reserve = vi.fn(async () => {});
    let calls = 0;
    const transport = (async () => {
      calls++;
      return calls === 1
        ? new Response("{}", {
            status: 503,
            headers: { "content-type": "application/json" },
          })
        : new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: "stop",
                  message: { role: "assistant", content: "{}" },
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          );
    }) as typeof fetch;
    await callModel(
      [{ role: "user", content: "x" }],
      "s",
      "r",
      undefined,
      transport,
      undefined,
      {
        reserve,
        backoffMs: 1,
      },
    );
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(productReserve).not.toHaveBeenCalled();
    const refuse = vi.fn(async () => {
      throw Object.assign(new Error("no budget"), { code: "AI_EVAL_BUDGET" });
    });
    const never = vi.fn();
    await expect(
      callModel(
        [{ role: "user", content: "x" }],
        "s",
        "r",
        undefined,
        never as never,
        undefined,
        { reserve: refuse },
      ),
    ).rejects.toThrow("no budget");
    expect(never).not.toHaveBeenCalled();
  });
});

describe("runner", () => {
  it("simulated run passes the scripted fixtures and is labelled simulated", async () => {
    const { report } = await simulate(["--cases", "CI05,CT01,CT04,PP08,HI09"]);
    expect(report.simulated).toBe(true);
    expect(report.cases.map((c) => c.status)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
    const call = report.cases[0].calls[0];
    expect(call).toMatchObject({
      model: "qwen3.8-flash",
      attempts: 1,
      retries: 0,
      errorCode: null,
      schemaValid: true,
      businessValid: true,
    });
    expect(call.response?.content).toContain("excludedSizes");
    expect(call.usage?.total_tokens).toBeGreaterThan(0);
    expect(call.firstByteMs).not.toBeNull();
    expect(reportStem(report)).toMatch(/-simulated$/);
    expect(runMarkdown(report)).toContain("【模拟数据】汇总");
  });
  it("stops at the token limit before the next upstream call and marks the rest not_run", async () => {
    const { report, fetched, budget } = await simulate([
      "--cases",
      "companion-intent",
      "--repeat",
      "2",
      "--token-limit",
      "25000",
    ]);
    expect(report.budget.stoppedBy).toBe("budget");
    const run = report.cases.filter((c) => c.status !== "not_run");
    const skipped = report.cases.filter((c) => c.status === "not_run");
    expect(run.length).toBeGreaterThan(0);
    expect(skipped.length).toBe(32 - run.length);
    expect(
      skipped.every((c) => c.reason === "budget" && c.fieldsCorrect === 0),
    ).toBe(true);
    // Every transport call was reserved first; the refused attempt never reached the transport.
    expect(fetched).toHaveBeenCalledTimes(report.budget.transmissionsThisRun);
    expect(budget.charged).toBeLessThanOrEqual(25000);
    expect(report.metrics.attempts).toMatchObject({
      planned: 32,
      executed: run.length,
      notRun: skipped.length,
    });
    expect(report.metrics.passRate).toBe(1);
  });
  it("max-calls stops the same way", async () => {
    const { report, fetched } = await simulate([
      "--cases",
      "help-intent",
      "--max-calls",
      "3",
    ]);
    expect(fetched).toHaveBeenCalledTimes(3);
    expect(report.budget.stoppedBy).toBe("max_calls");
    expect(report.cases.filter((c) => c.status === "not_run")).toHaveLength(6);
  });
  it("records retries, timeouts with conservative charges, and schema failures", async () => {
    const { report } = await simulate([
      "--cases",
      "CI02,HI03,PP05",
      "--mock-faults",
    ]);
    const byId = (id: string) => report.cases.find((c) => c.caseId === id)!;
    const [retry, timeout, bad] = [byId("CI02"), byId("HI03"), byId("PP05")];
    expect(retry.status).toBe("pass");
    expect(retry.calls[0]).toMatchObject({
      attempts: 2,
      retries: 1,
      httpStatus: 200,
    });
    expect(timeout.status).toBe("error");
    expect(timeout.calls[0]).toMatchObject({
      errorCode: "AI_UPSTREAM_TIMEOUT",
      usage: null,
      timedOutAttempts: 2,
    });
    expect(timeout.calls[0].chargedTokens).toBe(
      timeout.calls[0].reservedTokens,
    );
    expect(bad).toMatchObject({ status: "fail", businessValid: false });
    expect(bad.calls[0].schemaValid).toBe(false);
    expect(report.metrics.calls.timeouts).toBe(1);
    expect(report.metrics.tokens.unknownCalls).toBe(1);
  }, 20000);
  it("truthful summaries follow the actual tool results", () => {
    expect(truthfulSummaries([{ kind: "activities", rows: [] }])).toEqual([
      "没有符合条件的结果，请调整条件。",
    ]);
    expect(
      truthfulSummaries([{ kind: "error", code: "TOOL_FAILED", message: "x" }]),
    ).toContain("工具执行失败，请稍后重试。");
    expect(truthfulSummaries([])).toEqual([]);
  });
});

describe("metrics", () => {
  it("nearest-rank p50 / p95", () => {
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2);
    expect(
      percentile(
        Array.from({ length: 20 }, (_, i) => i + 1),
        0.95,
      ),
    ).toBe(19);
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([], 0.5)).toBeNull();
    expect(() => percentile([1], 0)).toThrow();
  });
  it("complete-task rate needs every repeat to pass; not_run is outside the denominator", () => {
    const a = (
      caseId: string,
      repeat: number,
      status: CaseAttempt["status"],
    ): CaseAttempt => ({
      caseId,
      scenario: "pet-profile",
      tags: [],
      repeat,
      status,
      businessValid: status === "pass",
      fieldsCorrect: status === "pass" ? 2 : 1,
      fieldsTotal: 2,
      failedChecks: [],
      calls: [],
    });
    const m = summarize([
      a("A", 1, "pass"),
      a("A", 2, "fail"),
      a("B", 1, "pass"),
      a("B", 2, "pass"),
      a("C", 1, "pass"),
      a("C", 2, "not_run"),
    ]);
    expect(m.passRate).toBe(4 / 5);
    expect(m.completeTaskRate).toBe(1 / 2);
    expect(m.keyFieldAccuracy).toBe(9 / 10);
    expect(m.attempts).toMatchObject({ executed: 5, notRun: 1 });
  });
});

describe("simulated vs live separation", () => {
  it("refuses to merge simulated with live, or a file named against its content", async () => {
    const { report } = await simulate(["--cases", "PP04"]);
    const live = { ...report, simulated: false };
    expect(() =>
      assertMergeable([
        { file: "a-qwen3.8-flash-simulated.json", report },
        { file: "b-qwen3.8-flash-live.json", report: live },
      ]),
    ).toThrow(/拒绝合并/);
    expect(() => assertMergeable([{ file: "a-live.json", report }])).toThrow(
      /不一致/,
    );
    expect(() =>
      assertMergeable([{ file: "a-simulated.json", report: live }]),
    ).toThrow(/不一致/);
    const md = compareMarkdown([
      { file: "a-qwen3.8-flash-simulated.json", report },
      {
        file: "b-qwen3.8-max-0902-simulated.json",
        report: { ...report, model: "qwen3.8-max-0902" },
      },
    ]);
    expect(md).toContain("模拟数据（mock 传输，未调用真实模型）");
    expect(md.match(/^## /gm)?.length).toBe(
      md.match(/^## 【模拟数据】/gm)?.length,
    );
  });
});
