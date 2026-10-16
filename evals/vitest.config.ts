import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({
  resolve: { alias: { "@": path.resolve("src") } },
  test: { include: ["evals/runner/evaluate.test.ts"], testTimeout: 900000 },
});
