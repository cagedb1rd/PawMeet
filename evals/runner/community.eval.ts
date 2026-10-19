/**
 * Community AI smoke entry (step 8), started only by `npm run eval:ai -- community ...`.
 * Real calls need --mode live, --token-limit ≤ 50000 (one pooled ledger for every model) and
 * PAWMEET_ALLOW_LIVE_AI=approved. Photo cases send the same ≤512px thumbnails as the vision eval.
 */
import { it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
vi.mock("server-only", () => ({}));
import { EvalBudget, fileStore, memoryStore } from "../lib/budget";
import { createHttpsTransport } from "../lib/https-transport";
import {
  COMMUNITY_BUDGET_KEY,
  communityMarkdown,
  communityReportStem,
  parseCommunityConfig,
  runCommunityEval,
} from "../lib/community-runner";
import { createCommunityMockTransport } from "../lib/community-mock";
import { buildThumbnails } from "../lib/vision-thumbs";
import { loadVisionCases } from "../cases/vision";
import { photoCaseIds, type CommunityCase } from "../cases/community";
import { MODEL_WHITELIST, PROVIDERS, resolveModel } from "@/server/ai/models";

const out = (line: string) => process.stdout.write(`${line}\n`);

it("PawMeet community AI smoke", async () => {
  const config = parseCommunityConfig(
    JSON.parse(process.env.AI_EVAL_ARGS ?? "[]"),
  );
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const budget = await EvalBudget.open({
    model: COMMUNITY_BUDGET_KEY,
    limit: config.tokenLimit ?? Infinity,
    store: config.mode === "live" ? fileStore(config.ledger) : memoryStore(),
    runId,
  });
  out(
    JSON.stringify(
      {
        mode: config.mode,
        model: config.model,
        suite: config.suite,
        cases: config.cases.map((c) => c.id),
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
        "真实冒烟默认关闭；获得批准后设置 PAWMEET_ALLOW_LIVE_AI=approved",
      );
    const keyEnv =
      PROVIDERS[resolveModel("text", config.model).provider].keyEnv;
    if (!process.env[keyEnv]) throw Error(`${keyEnv} 未配置`);
  }
  const ids = new Set(photoCaseIds(config.cases));
  const thumbnails =
    ids.size && MODEL_WHITELIST.vision.some((m) => m.id === config.model)
      ? await buildThumbnails(
          loadVisionCases("private").filter((c) => ids.has(c.id)),
        )
      : new Map<string, string>();
  process.env.AI_ENABLED = "true";
  const ctx: { current: CommunityCase | null } = { current: null };
  const report = await runCommunityEval(config, {
    runId,
    transport:
      config.mode === "live"
        ? createHttpsTransport()
        : createCommunityMockTransport(ctx),
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
  const stem = `evals/reports/${communityReportStem(report)}`;
  await mkdir("evals/reports", { recursive: true });
  await writeFile(`${stem}.json`, JSON.stringify(report, null, 2) + "\n");
  await writeFile(`${stem}.md`, communityMarkdown(report));
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
