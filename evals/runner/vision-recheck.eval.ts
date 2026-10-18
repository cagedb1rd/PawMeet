/**
 * `npm run eval:ai -- vision-recheck a.json b.json ...`: re-applies the current program rules
 * to the raw outputs saved in live vision reports. No model call; output is labelled as such.
 */
import { it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
vi.mock("server-only", () => ({}));
import { recheckMarkdown, type VisionReport } from "../lib/vision-runner";

it("vision rules recheck", async () => {
  const files: string[] = JSON.parse(process.env.AI_EVAL_ARGS ?? "[]");
  if (!files.length) throw Error("至少需要一份真实视觉报告");
  const reports: VisionReport[] = await Promise.all(
    files.map(async (f) => JSON.parse(await readFile(f, "utf8"))),
  );
  if (reports.some((r) => r.kind !== "pawmeet-vision-eval" || r.simulated))
    throw Error("只接受真实视觉评测报告");
  const time = new Date().toISOString().replace(/[:.]/g, "-");
  const out = `evals/reports/${time}-vision-recheck-offline.md`;
  await writeFile(
    out,
    `# 视觉规则离线复算（不是新的真实调用）\n\n${files.map((f) => `- ${f}`).join("\n")}\n\n${recheckMarkdown(reports)}\n`,
  );
  process.stdout.write(`${out}\n`);
});
