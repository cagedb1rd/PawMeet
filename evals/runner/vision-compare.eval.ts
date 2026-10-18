/** `npm run eval:ai -- vision-compare a.json b.json ...`: cross-model vision table. */
import { it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { visionCompareMarkdown, type VisionReport } from "../lib/vision-runner";

it("vision compare", async () => {
  const files: string[] = JSON.parse(process.env.AI_EVAL_ARGS ?? "[]");
  if (files.length < 2) throw Error("至少需要两份视觉报告");
  const reports: VisionReport[] = await Promise.all(
    files.map(async (f) => JSON.parse(await readFile(f, "utf8"))),
  );
  if (reports.some((r) => r.kind !== "pawmeet-vision-eval"))
    throw Error("只接受视觉评测报告");
  const md = visionCompareMarkdown(reports);
  const stem = `evals/reports/${new Date().toISOString().replace(/[:.]/g, "-")}-vision-compare-${reports[0].simulated ? "simulated" : "live"}.md`;
  await writeFile(
    stem,
    `# 视觉模型对比\n\n${files.map((f) => `- ${f}`).join("\n")}\n\n${md}`,
  );
  process.stdout.write(`${stem}\n`);
});
