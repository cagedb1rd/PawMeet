// One GET /models request (lists models, consumes no tokens). Prints only model ids and
// whether each whitelisted id exists; never prints the key. Never falls back to a chat probe.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const WANTED = [
  "qwen3.8-flash",
  "qwen3.8-max-0902",
  "qwen3.8-27b",
  "qwen3.8-omni-flash",
  "qwen3.5-omni-plus",
];
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const key = process.env.DASHSCOPE_API_KEY;
if (!key) {
  console.error("DASHSCOPE_API_KEY 未配置，未发送请求。");
  process.exit(2);
}
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
const checkedAt = new Date().toISOString();
let res;
try {
  res = await fetch(`${base.origin}/compatible-mode/v1/models`, {
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
const ids = Array.isArray(body?.data)
  ? body.data.map((m) => String(m.id)).sort()
  : [];
const result = {
  checkedAt,
  endpoint: `${base.origin}/compatible-mode/v1/models`,
  httpStatus: res.status,
  providerCode:
    typeof body?.error?.code === "string" ? body.error.code : undefined,
  totalModels: ids.length,
  whitelist: Object.fromEntries(WANTED.map((id) => [id, ids.includes(id)])),
  // Near names help the user decide if an id is missing; no substitution happens here.
  related: ids.filter((id) => /^qwen3\.[58]/.test(id) || /omni/.test(id)),
};
mkdirSync("evals/reports", { recursive: true });
const file = `evals/reports/${checkedAt.replace(/[:.]/g, "-")}-model-list.json`;
writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
console.log(`已保存 ${file}`);
process.exitCode = res.ok ? 0 : 1;
