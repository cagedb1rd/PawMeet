/** `npm run eval:ai -- vision-compare a.json b.json ...`: cross-model vision table. */
import { it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
vi.mock("server-only", () => ({}));
import {
  privateOnly,
  visionCompareMarkdown,
  visionMarkdown,
  type VisionReport,
} from "../lib/vision-runner";

it("vision compare", async () => {
  const files: string[] = JSON.parse(process.env.AI_EVAL_ARGS ?? "[]");
  if (files.length < 2) throw Error("至少需要两份视觉报告");
  const reports: VisionReport[] = await Promise.all(
    files.map(async (f) => JSON.parse(await readFile(f, "utf8"))),
  );
  if (reports.some((r) => r.kind !== "pawmeet-vision-eval"))
    throw Error("只接受视觉评测报告");
  // Real results count only the 16 labelled private images, grouped by category; public demo
  // photos in older reports are dropped here (their calls stay in each run's own budget).
  const scoped = reports.map((r) => (r.simulated ? r : privateOnly(r)));
  const md = visionCompareMarkdown(scoped);
  const time = new Date().toISOString().replace(/[:.]/g, "-");
  const kind = reports[0].simulated ? "simulated" : "live";
  const stem = `evals/reports/${time}-vision-compare-${kind}.md`;
  await writeFile(
    stem,
    `# 视觉模型对比（${kind === "live" ? "真实调用，仅私有 16 张带标签图片，按类别" : "模拟数据"}）\n\n${files.map((f) => `- ${f}`).join("\n")}\n\n${md}`,
  );
  process.stdout.write(`${stem}\n`);
  if (kind === "live")
    for (const [i, r] of scoped.entries()) {
      const out = files[i].replace(/\.json$/, "-private.md");
      await writeFile(out, visionMarkdown(r));
      process.stdout.write(`${out}\n`);
    }
});
