/**
 * Multi-model evaluation entry, started only by `npm run eval:ai` (evals/runner/run.mjs).
 * Ordinary `npm run test` never includes this file.
 */
import { it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
vi.mock("server-only", () => ({}));
import {
  parseConfig,
  plannedCalls,
  TOKEN_ESTIMATE_PER_CALL,
} from "../lib/config";
import { EvalBudget, fileStore, memoryStore } from "../lib/budget";
import { createMockTransport, type MockContext } from "../lib/mock-transport";
import { runEval } from "../lib/runner";
import { createHttpsTransport } from "../lib/https-transport";
import { reportStem, runMarkdown } from "../lib/report";
import { PROMPT_VERSION } from "@/server/ai/prompts";
import { PROVIDERS, resolveModel } from "@/server/ai/models";
import { VALIDATION_VERSION } from "@/lib/ai/validation";

// Vitest buffers console output of passing tests; progress goes straight to stdout.
const out = (line: string) =>
  process.stdout.write(`${line}
`);

it("PawMeet multi-model evaluation", async () => {
  const config = parseConfig(JSON.parse(process.env.AI_EVAL_ARGS ?? "[]"));
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const calls =
    config.cases.reduce((s, c) => s + plannedCalls(c), 0) * config.repeat;
  const estimate =
    config.cases.reduce(
      (s, c) => s + plannedCalls(c) * TOKEN_ESTIMATE_PER_CALL[c.scenario],
      0,
    ) * config.repeat;
  const store =
    config.mode === "live" ? fileStore(config.ledger) : memoryStore();
  const budget = await EvalBudget.open({
    model: config.model,
    limit: config.tokenLimit ?? Infinity,
    store,
    runId,
  });
  const plan = {
    mode: config.mode,
    model: config.model,
    promptVersion: PROMPT_VERSION,
    validationVersion: VALIDATION_VERSION,
    cases: config.cases.length,
    repeat: config.repeat,
    attempts: config.cases.length * config.repeat,
    plannedCallsExcludingRetries: calls,
    estimatedTokens: estimate,
    tokenLimit: config.tokenLimit,
    ledger: config.mode === "live" ? config.ledger : "memory",
    alreadyCharged: budget.charged,
    remaining: config.tokenLimit === null ? null : budget.remaining,
    maxCalls: config.maxCalls,
  };
  out(JSON.stringify(plan, null, 2));
  if (config.dryRun) return;
  if (config.mode === "live") {
    if (process.env.PAWMEET_ALLOW_LIVE_AI !== "approved")
      throw Error(
        "真实评测默认关闭；获得批准后设置 PAWMEET_ALLOW_LIVE_AI=approved",
      );
    const keyEnv =
      PROVIDERS[resolveModel("text", config.model).provider].keyEnv;
    if (!process.env[keyEnv]) throw Error(`${keyEnv} 未配置`);
    if (estimate > budget.remaining)
      console.warn(
        `预计 ${estimate} Token 超过剩余额度 ${budget.remaining}：到额即停，剩余用例记 not_run。`,
      );
  }
  process.env.AI_ENABLED = "true";
  const mock: MockContext = { current: null, attempt: 0 };
  const report = await runEval(config, {
    runId,
    transport:
      config.mode === "live"
        ? createHttpsTransport()
        : createMockTransport(mock, config.mockFaults),
    budget,
    mock: config.mode === "live" ? undefined : mock,
    git: {
      commit: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      dirty:
        execFileSync("git", ["status", "--porcelain"], {
          encoding: "utf8",
        }).trim().length > 0,
    },
    log: out,
  });
  const stem = `evals/reports/${reportStem(report)}`;
  await mkdir("evals/reports", { recursive: true });
  await writeFile(`${stem}.json`, JSON.stringify(report, null, 2) + "\n");
  await writeFile(`${stem}.md`, runMarkdown(report));
  out(
    JSON.stringify(
      {
        report: `${stem}.json`,
        dataLabel: report.dataLabel,
        attempts: report.metrics.attempts,
        passRate: report.metrics.passRate,
        schemaValidRate: report.metrics.schemaValidRate,
        keyFieldAccuracy: report.metrics.keyFieldAccuracy,
        completeTaskRate: report.metrics.completeTaskRate,
        latencyMs: report.metrics.latencyMs,
        tokens: report.metrics.tokens,
        budget: report.budget,
      },
      null,
      2,
    ),
  );
}, 3_600_000);
