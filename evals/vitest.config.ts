import { defineConfig } from "vitest/config";
import path from "node:path";
const entries: Record<string, string> = {
  run: "evals/runner/multi-model.eval.ts",
  compare: "evals/runner/compare.eval.ts",
  legacy: "evals/runner/evaluate.test.ts",
};
export default defineConfig({
  resolve: { alias: { "@": path.resolve("src") } },
  test: {
    include: [entries[process.env.AI_EVAL_ENTRY ?? "run"] ?? entries.run],
    testTimeout: 3600000,
  },
});
