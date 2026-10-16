import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({
  resolve: { alias: { "@": path.resolve("src") } },
  test: {
    include: [
      process.env.AI_EVAL_SUITE === "companion"
        ? "evals/runner/companion-live.test.ts"
        : "evals/runner/evaluate.test.ts",
    ],
    testTimeout: 900000,
  },
});
