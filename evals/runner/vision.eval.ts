/**
 * Vision (pet-photo) evaluation entry, started only by `npm run eval:ai -- vision ...`.
 * Real calls need --mode live, --token-limit ≤ the model's vision cap and
 * PAWMEET_ALLOW_LIVE_AI=approved. Reports contain file names only, never image data.
 */
import { it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
vi.mock("server-only", () => ({}));
import { EvalBudget, fileStore, memoryStore } from "../lib/budget";
import { createHttpsTransport } from "../lib/https-transport";
import {
  parseVisionConfig,
  runVisionEval,
  visionMarkdown,
  visionReportStem,
} from "../lib/vision-runner";
import { createVisionMockTransport } from "../lib/vision-mock";
import { buildThumbnails } from "../lib/vision-thumbs";
import type { VisionCase } from "../cases/vision";
import { PROVIDERS, resolveModel } from "@/server/ai/models";

const out = (line: string) => process.stdout.write(`${line}\n`);

it("PawMeet vision evaluation", async () => {
  const config = parseVisionConfig(
    JSON.parse(process.env.AI_EVAL_ARGS ?? "[]"),
  );
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const store =
    config.mode === "live" ? fileStore(config.ledger) : memoryStore();
  const budget = await EvalBudget.open({
    model: config.model,
    limit: config.tokenLimit ?? Infinity,
    store,
    runId,
  });
  out(
    JSON.stringify(
      {
        mode: config.mode,
        model: config.model,
        cases: config.cases.length,
        public: config.cases.filter((c) => c.source === "public").length,
        private: config.cases.filter((c) => c.source === "private").length,
        unlabelled: config.cases.filter((c) => c.isDog === null).length,
        tokenLimit: config.tokenLimit,
        ledger: config.mode === "live" ? config.ledger : "memory",
        alreadyCharged: budget.charged,
        remaining: config.tokenLimit === null ? null : budget.remaining,
      },
      null,
      2,
    ),
  );
  if (config.dryRun) return;
  if (config.mode === "live") {
    if (process.env.PAWMEET_ALLOW_LIVE_AI !== "approved")
      throw Error(
        "真实评测默认关闭；获得批准后设置 PAWMEET_ALLOW_LIVE_AI=approved",
      );
    const keyEnv =
      PROVIDERS[resolveModel("vision", config.model).provider].keyEnv;
    if (!process.env[keyEnv]) throw Error(`${keyEnv} 未配置`);
  }
  const thumbnails = await buildThumbnails(config.cases);
  process.env.AI_ENABLED = "true";
  const ctx: { current: VisionCase | null } = { current: null };
  const report = await runVisionEval(config, {
    runId,
    transport:
      config.mode === "live"
        ? createHttpsTransport()
        : createVisionMockTransport(ctx),
    budget,
    thumbnails,
    onCase: (c) => (ctx.current = c),
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
  const stem = `evals/reports/${visionReportStem(report)}`;
  await mkdir("evals/reports", { recursive: true });
  await writeFile(`${stem}.json`, JSON.stringify(report, null, 2) + "\n");
  await writeFile(`${stem}.md`, visionMarkdown(report));
  out(
    JSON.stringify(
      {
        report: `${stem}.md`,
        metrics: report.metrics.all,
        budget: report.budget,
      },
      null,
      2,
    ),
  );
}, 3_600_000);
