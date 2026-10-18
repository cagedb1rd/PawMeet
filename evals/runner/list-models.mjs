// One GET /models request (lists models, consumes no tokens). Prints only model ids and
// whether each whitelisted id exists; never prints the key. Never falls back to a chat probe.
//   npm run eval:models                (DashScope / Qwen)
//   npm run eval:models -- gemini      (Google Gemini OpenAI-compatible endpoint)
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const provider = process.argv[2] === "gemini" ? "gemini" : "dashscope";
const WANTED =
  provider === "gemini"
    ? ["gemini-3.5-flash-lite", "gemini-3.8-flash"]
    : [
        "qwen3.8-flash",
        "qwen3.8-max-0902",
        "qwen3.8-27b",
        "qwen3.8-omni-flash",
        "qwen3.5-omni-plus",
      ];
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const keyEnv = provider === "gemini" ? "GEMINI_API_KEY" : "DASHSCOPE_API_KEY";
const key = process.env[keyEnv];
if (!key) {
  console.error(`${keyEnv} 未配置，未发送请求。`);
  process.exit(2);
}
let endpoint = "https://generativelanguage.googleapis.com/v1beta/openai/models";
if (provider === "dashscope") {
  const base = new URL(
    process.env.AI_BASE_URL ||
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
  );
  if (
    base.protocol !== "https:" ||
    !/(^|\.)aliyuncs\.com$/.test(base.hostname) ||
    base.pathname.replace(/\/$/, "") !== "/compatible-mode/v1"
  )
    throw Error("AI_BASE_URL必须是百炼官方兼容API地址");
  endpoint = `${base.origin}/compatible-mode/v1/models`;
}
const checkedAt = new Date().toISOString();
let res;
try {
  res = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${key}` },
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
} catch (e) {
  console.error(
    `模型列表请求未完成：${e?.cause?.code ?? e?.name ?? "network error"}（未改用其他探测）`,
  );
  process.exit(1);
}
const body = await res.json().catch(() => null);
// Gemini lists ids as "models/<id>".
const ids = Array.isArray(body?.data)
  ? body.data.map((m) => String(m.id).replace(/^models\//, "")).sort()
  : [];
const result = {
  checkedAt,
  provider,
  endpoint,
  httpStatus: res.status,
  providerCode:
    typeof body?.error?.code === "string" ? body.error.code : undefined,
  totalModels: ids.length,
  whitelist: Object.fromEntries(WANTED.map((id) => [id, ids.includes(id)])),
  // Near names help the user decide if an id is missing; no substitution happens here.
  related: ids.filter((id) =>
    provider === "gemini"
      ? /^gemini-3\.[58]-flash/.test(id)
      : /^qwen3\.[58]/.test(id) || /omni/.test(id),
  ),
};
mkdirSync("evals/reports", { recursive: true });
const stem = provider === "gemini" ? "gemini-model-list" : "model-list";
const file = `evals/reports/${checkedAt.replace(/[:.]/g, "-")}-${stem}.json`;
writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
console.log(`已保存 ${file}`);
process.exitCode = res.ok ? 0 : 1;
