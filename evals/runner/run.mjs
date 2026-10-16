import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const mode = option("--mode", "mock");
if (!["mock", "live"].includes(mode))
  throw Error("--mode must be mock or live");
const max = Number(option("--max-calls", "55"));
if (!Number.isInteger(max) || max < 1 || max > 100)
  throw Error("--max-calls must be 1..100");
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${mode}`;
const report = `evals/reports/${runId}.json`;
mkdirSync("evals/reports", { recursive: true });
if (args.includes("--dry-run")) {
  console.log(
    JSON.stringify(
      {
        mode,
        core: 35,
        validation: 11,
        nativeTools: 8,
        maxCalls: max,
        model: process.env.GLM_MODEL || "glm-4.7-flash",
        perCallMaxOutputTokens: 1400,
        automaticAttempts: 2,
        note: "Live包含实际工具回传续轮，受max-calls限制；原始输出Schema率与最终校验成功分别统计。",
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
if (mode === "live" && !process.env.GLM_API_KEY) {
  writeFileSync(
    report,
    JSON.stringify(
      {
        runId,
        mode,
        model: "glm-4.7-flash",
        status: "not_run",
        reason: "GLM_API_KEY missing",
        plannedCases: 43,
        actualProviderCalls: 0,
        metrics: {
          schemaPassRate: null,
          keyFieldAccuracy: null,
          toolSelectionAccuracy: null,
          toolExecutionSuccessRate: null,
          completeTaskSuccessRate: null,
        },
      },
      null,
      2,
    ),
  );
  console.log(`真实评测未运行：缺少GLM_API_KEY。报告 ${report}`);
  process.exit(2);
}
const child = spawnSync(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    "--config",
    "evals/vitest.config.ts",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      AI_EVAL_MODE: mode,
      AI_EVAL_REPORT: report,
      AI_EVAL_RUN_ID: runId,
      AI_EVAL_MAX_CALLS: String(max),
      AI_EVAL_CASE: option("--case", ""),
      AI_EVAL_RESUME: option("--resume", ""),
    },
  },
);
process.exit(child.status ?? 1);
