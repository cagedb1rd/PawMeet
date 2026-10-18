// CLI for the PawMeet evaluation runner. Real model calls need all of: --mode live,
// --token-limit within the model's approved cap, and PAWMEET_ALLOW_LIVE_AI=approved.
//   npm run eval:ai -- --mode simulated [--mock-faults] [--cases CI01,tag:injection] [--repeat 2]
//   npm run eval:ai -- --mode live --model qwen3.8-flash --token-limit 200000 --repeat 2 [--dry-run]
//   npm run eval:ai -- compare evals/reports/a.json evals/reports/b.json
//   npm run eval:ai -- legacy [--suite all|core|tools]   (core.v2 mock regression only)
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const argv = process.argv.slice(2);
const entry = ["compare", "legacy"].includes(argv[0]) ? argv[0] : "run";
const args = entry === "run" ? argv : argv.slice(1);
const option = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const live = entry === "run" && option("--mode") === "live";
const env = { ...process.env, AI_EVAL_ENTRY: entry };
if (live) {
  // Secrets stay in process memory; they are never printed or written to reports.
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  Object.assign(env, process.env, { AI_EVAL_ENTRY: entry });
} else {
  // Simulated / legacy runs never see a real key or a configurable upstream URL.
  delete env.AI_BASE_URL;
  env.DASHSCOPE_API_KEY = "simulated-key-not-a-secret";
  env.DEMO_SESSION_SECRET = "simulated-session-secret";
  env.AI_STREAM = "true";
  env.AI_FIRST_BYTE_TIMEOUT_MS = "1000";
  env.AI_TOTAL_TIMEOUT_MS = "4000";
}
if (entry === "legacy") {
  const suite = option("--suite") ?? "all";
  if (!["all", "core", "tools"].includes(suite))
    throw Error("legacy --suite 只能是 all、core 或 tools（仅 mock）");
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-mock`;
  Object.assign(env, {
    AI_EVAL_MODE: "mock",
    AI_EVAL_SUITE: suite,
    AI_EVAL_RUN_ID: runId,
    AI_EVAL_REPORT: `evals/reports/${runId}.json`,
  });
} else env.AI_EVAL_ARGS = JSON.stringify(args);
const child = spawnSync(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    "--config",
    "evals/vitest.config.ts",
  ],
  { stdio: "inherit", env },
);
process.exitCode = child.status ?? 1;
