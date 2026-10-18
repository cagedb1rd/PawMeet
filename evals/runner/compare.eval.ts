/** `npm run eval:ai -- compare <a.json> <b.json> ...`: multi-model Markdown comparison. */
import { it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
vi.mock("server-only", () => ({}));
import { assertMergeable, compareMarkdown } from "../lib/report";

it("PawMeet eval comparison", async () => {
  const files: string[] = JSON.parse(process.env.AI_EVAL_ARGS ?? "[]");
  if (!files.length)
    throw Error(
      "用法：npm run eval:ai -- compare <报告1.json> <报告2.json> ...",
    );
  const reports = await Promise.all(
    files.map(async (file) => ({
      file,
      report: JSON.parse(await readFile(file, "utf8")),
    })),
  );
  const simulated = assertMergeable(reports);
  const out = `evals/reports/${new Date().toISOString().replace(/[:.]/g, "-")}-compare-${simulated ? "simulated" : "live"}.md`;
  await writeFile(out, compareMarkdown(reports));
  console.log(`已写入 ${out}`);
});
