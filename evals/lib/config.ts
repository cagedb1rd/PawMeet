import { MODEL_WHITELIST, resolveModel } from "../../src/server/ai/models";
import { currentCases, retiredCases, type EvalCase } from "../cases/current";
import { MODEL_TOKEN_CAPS } from "./budget";

export type EvalMode = "live" | "simulated";
export type EvalConfig = {
  mode: EvalMode;
  model: string;
  cases: EvalCase[];
  repeat: number;
  /** Cumulative per-model tokens allowed in the ledger; null = unlimited (simulated only). */
  tokenLimit: number | null;
  maxCalls: number | null;
  minIntervalMs: number;
  ledger: string;
  mockFaults: boolean;
  dryRun: boolean;
};

const FLAGS = new Set([
  "--mode",
  "--model",
  "--cases",
  "--repeat",
  "--token-limit",
  "--max-calls",
  "--min-interval-ms",
  "--ledger",
  "--mock-faults",
  "--dry-run",
]);
const BOOLEAN = new Set(["--mock-faults", "--dry-run"]);

/**
 * Selects current cases by id (CI01), scenario (companion-intent) or tag (tag:injection),
 * comma separated. Retired ids are refused rather than silently skipped.
 */
export function selectCases(spec: string | undefined): EvalCase[] {
  if (!spec || spec === "all") return currentCases;
  const picked = new Set<EvalCase>();
  for (const token of spec
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)) {
    const retired = retiredCases.find((r) => r.id === token);
    if (retired)
      throw Error(`${token} 已停用（${retired.reason}），不计入当前评测`);
    const hits = token.startsWith("tag:")
      ? currentCases.filter((c) => c.tags.includes(token.slice(4) as never))
      : currentCases.filter((c) => c.id === token || c.scenario === token);
    if (!hits.length) throw Error(`未知用例或场景：${token}`);
    hits.forEach((c) => picked.add(c));
  }
  return currentCases.filter((c) => picked.has(c));
}

const int = (name: string, raw: string, min: number, max: number) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max)
    throw Error(`${name} 必须是 ${min}–${max} 之间的整数`);
  return n;
};

/** Parses CLI flags. Validation happens before any budget, ledger or network access. */
export function parseConfig(argv: string[]): EvalConfig {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!FLAGS.has(flag)) throw Error(`未知参数：${flag}`);
    if (BOOLEAN.has(flag)) values.set(flag, "true");
    else {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--"))
        throw Error(`${flag} 需要取值`);
      values.set(flag, v);
    }
  }
  const raw = values.get("--mode") ?? "simulated";
  const mode = raw === "mock" ? "simulated" : raw;
  if (mode !== "live" && mode !== "simulated")
    throw Error("--mode 只能是 live 或 simulated（mock 为别名）");
  const requested = values.get("--model") ?? "qwen3.8-flash";
  // Same server whitelist as production; throws AI_MODEL_NOT_APPROVED otherwise.
  const model = resolveModel("text", requested).id;
  if (!MODEL_WHITELIST.text.some((m) => m.id === model))
    throw Error("仅评测文本白名单模型");
  const cap = MODEL_TOKEN_CAPS[model];
  if (cap === undefined) throw Error(`${model} 没有批准的评测额度`);
  const limitRaw = values.get("--token-limit");
  let tokenLimit: number | null;
  if (mode === "live") {
    tokenLimit =
      limitRaw === undefined ? 0 : int("--token-limit", limitRaw, 0, cap);
    if (tokenLimit === 0 && !values.has("--dry-run"))
      throw Error(
        `真实评测需要 --token-limit（1–${cap}，${model} 批准上限）；默认 0 不允许真实调用`,
      );
  } else
    tokenLimit =
      limitRaw === undefined
        ? null
        : int("--token-limit", limitRaw, 1, 10_000_000);
  if (mode === "simulated" && values.has("--ledger"))
    throw Error("模拟运行只用内存账本，不写入评测额度账本");
  if (mode === "live" && values.has("--mock-faults"))
    throw Error("--mock-faults 只用于模拟传输");
  return {
    mode,
    model,
    cases: selectCases(values.get("--cases")),
    repeat: int("--repeat", values.get("--repeat") ?? "1", 1, 5),
    tokenLimit,
    maxCalls: values.has("--max-calls")
      ? int("--max-calls", values.get("--max-calls")!, 1, 1000)
      : null,
    minIntervalMs: int(
      "--min-interval-ms",
      values.get("--min-interval-ms") ?? (mode === "live" ? "1500" : "0"),
      0,
      60000,
    ),
    ledger: values.get("--ledger") ?? ".local/ai-eval/budget-ledger.json",
    mockFaults: values.has("--mock-faults"),
    dryRun: values.has("--dry-run"),
  };
}

/** Planning estimate of total tokens per upstream call, by scenario (see docs/AI_EVAL.md). */
export const TOKEN_ESTIMATE_PER_CALL: Record<EvalCase["scenario"], number> = {
  "companion-intent": 1300,
  "companion-tools": 2000,
  "pet-profile": 1200,
  "help-intent": 1200,
};

/**
 * Upstream calls one attempt of a case normally needs (excluding retries / answer repairs):
 * extraction 1; search workflow = tool call + final answer; organize = pets/places, compatibility,
 * draft, final answer. Used for dry-run planning only.
 */
export function plannedCalls(c: EvalCase) {
  if (c.scenario !== "companion-tools") return 1;
  return c.stage === "search" ? 2 : 4;
}
