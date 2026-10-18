import { randomUUID } from "node:crypto";
import { callModel } from "../../src/server/ai/client";
import { AiError } from "../../src/server/ai/errors";
import { generatePostMeta, precheckPost } from "../../src/server/ai/service";
import { MODEL_WHITELIST, resolveModel } from "../../src/server/ai/models";
import { COMMUNITY_PROMPT_VERSION } from "../../src/server/ai/prompts";
import {
  postMetaOutputSchema,
  postSafetyOutputSchema,
  type PostMetaDraft,
  type PostSafetyResult,
} from "../../src/lib/ai/contracts";
import { locateExcerpt, rulePrecheck } from "../../src/domain/moderation";
import {
  BREED_WORDS,
  COMMUNITY_CASES,
  COMMUNITY_CASE_VERSION,
  type CommunityCase,
  type MetaCase,
  type SafetyCase,
} from "../cases/community";
import { COMMUNITY_SMOKE_CAP, type EvalBudget, type Ticket } from "./budget";
import { requestNotSent } from "./https-transport";
import { percentile, ratio, type Usage } from "./metrics";
import { SIMULATED_BANNER } from "./report";

/** One pooled budget for every model of this smoke (AGENTS: community AI smoke ≤50k). */
export const COMMUNITY_BUDGET_KEY = "community-smoke-all-models";

export type CommunityConfig = {
  mode: "live" | "simulated";
  model: string;
  suite: "meta" | "safety" | "all";
  cases: CommunityCase[];
  tokenLimit: number | null;
  minIntervalMs: number;
  ledger: string;
  dryRun: boolean;
};
const FLAGS = new Set([
  "--mode",
  "--model",
  "--suite",
  "--cases",
  "--token-limit",
  "--min-interval-ms",
  "--ledger",
  "--dry-run",
]);
const int = (name: string, raw: string, min: number, max: number) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max)
    throw Error(`${name} 必须是 ${min}–${max} 之间的整数`);
  return n;
};

/** Validated before any ledger or network access. Live needs --token-limit ≤ 50000. */
export function parseCommunityConfig(argv: string[]): CommunityConfig {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!FLAGS.has(flag)) throw Error(`未知参数：${flag}`);
    if (flag === "--dry-run") values.set(flag, "true");
    else {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--"))
        throw Error(`${flag} 需要取值`);
      values.set(flag, v);
    }
  }
  const mode = values.get("--mode") ?? "simulated";
  if (mode !== "live" && mode !== "simulated")
    throw Error("--mode 只能是 live 或 simulated");
  const model = resolveModel(
    "text",
    values.get("--model") ?? "qwen3.8-flash",
  ).id;
  const raw = values.get("--token-limit");
  let tokenLimit: number | null;
  if (mode === "live") {
    tokenLimit =
      raw === undefined ? 0 : int("--token-limit", raw, 0, COMMUNITY_SMOKE_CAP);
    if (tokenLimit === 0 && !values.has("--dry-run"))
      throw Error(
        `真实冒烟需要 --token-limit（1–${COMMUNITY_SMOKE_CAP}，所有模型合计）；默认 0 不允许真实调用`,
      );
  } else
    tokenLimit =
      raw === undefined ? null : int("--token-limit", raw, 1, 10_000_000);
  if (mode === "simulated" && values.has("--ledger"))
    throw Error("模拟运行只用内存账本");
  const suite = (values.get("--suite") ?? "all") as CommunityConfig["suite"];
  if (!["meta", "safety", "all"].includes(suite))
    throw Error("--suite 只能是 meta / safety / all");
  let cases = COMMUNITY_CASES.filter(
    (c) => suite === "all" || c.suite === suite,
  );
  const spec = values.get("--cases");
  if (spec) {
    const ids = new Set(spec.split(",").map((s) => s.trim()));
    const unknown = [...ids].filter((id) => !cases.some((c) => c.id === id));
    if (unknown.length) throw Error(`未知社区用例：${unknown.join(",")}`);
    cases = cases.filter((c) => ids.has(c.id));
  }
  return {
    mode,
    model,
    suite,
    cases,
    tokenLimit,
    minIntervalMs: int(
      "--min-interval-ms",
      values.get("--min-interval-ms") ?? (mode === "live" ? "1500" : "0"),
      0,
      60000,
    ),
    ledger:
      values.get("--ledger") ?? ".local/ai-eval/step8-community-ledger.json",
    dryRun: values.has("--dry-run"),
  };
}

export const CHECK_LABELS: Record<string, string> = {
  schema: "原始输出符合 Schema",
  reviewed: "通过程序审核（标题 ≤20 字、3–5 个合规标签）",
  grounded: "标题 / 标签用到正文要点",
  no_forbidden_raw: "原始输出无编造身份 / 联系方式 / 健康结论",
  no_wrong_breed: "照片用例不编造品种",
  verdict: "通过 / 建议修改判断正确",
  category: "问题类别命中",
  excerpt_verbatim: "片段可在原文中定位",
};
const parseRaw = (raw: string | null) => {
  try {
    return JSON.parse(
      (raw ?? "")
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, ""),
    );
  } catch {
    return undefined;
  }
};

/** Programmatic checks for a title / tags case; reads the raw text and the reviewed draft. */
export function scoreMeta(
  c: MetaCase,
  draft: PostMetaDraft | null,
  raw: string | null,
) {
  const parsed = postMetaOutputSchema.safeParse(parseRaw(raw));
  const rawText = parsed.success
    ? `${parsed.data.title} ${parsed.data.tags.join(" ")}`
    : "";
  const out = draft ? `${draft.title} ${draft.tags.join(" ")}` : "";
  const checks: Record<string, boolean> = {
    schema: parsed.success,
    reviewed: !!draft,
  };
  if (c.anyOf) checks.grounded = c.anyOf.some((w) => out.includes(w));
  if (c.forbidden)
    checks.no_forbidden_raw = !c.forbidden.some((w) => rawText.includes(w));
  if (c.breeds)
    checks.no_wrong_breed = !BREED_WORDS.some(
      (b) =>
        rawText.includes(b) &&
        !c.breeds!.some((ok) => b.includes(ok) || ok.includes(b)),
    );
  return checks;
}

/** Programmatic checks for a safety case; program rules are recorded alongside. */
export function scoreSafety(
  c: SafetyCase,
  result: PostSafetyResult | null,
  raw: string | null,
) {
  const parsed = postSafetyOutputSchema.safeParse(parseRaw(raw));
  const content = { title: c.title ?? "", text: c.text, tags: c.tags ?? [] };
  const checks: Record<string, boolean> = {
    schema: parsed.success,
    verdict: !!result && result.verdict === c.expect,
  };
  if (c.expect === "revise")
    checks.category =
      !!result && result.issues.some((i) => c.categories!.includes(i.category));
  if (parsed.success && parsed.data.issues.length)
    checks.excerpt_verbatim = parsed.data.issues.every(
      (i) => locateExcerpt(content, i.excerpt) !== null,
    );
  return checks;
}

export type CommunityCallRecord = {
  attempts: number;
  unsentAttempts: number;
  totalMs: number;
  firstByteMs: number | null;
  httpStatus: number | null;
  usage: Usage | null;
  reservedTokens: number;
  chargedTokens: number;
  errorCode: string | null;
};
export type CommunityAttempt = {
  caseId: string;
  suite: CommunityCase["suite"];
  image?: string;
  status: "pass" | "fail" | "error" | "not_run";
  reason?: string;
  error?: string;
  raw: string | null;
  draft?: PostMetaDraft | null;
  safety?: PostSafetyResult | null;
  /** Program-rule layer for safety cases (runs without any model). */
  rules?: { category: string; excerpt: string | null; blocking: boolean }[];
  checks: Record<string, boolean>;
  failedChecks: string[];
  call: CommunityCallRecord | null;
};
export type CommunityDeps = {
  runId: string;
  transport: typeof fetch;
  budget: EvalBudget;
  thumbnails: Map<string, string>;
  git: { commit: string; dirty: boolean };
  clock?: () => number;
  log?: (line: string) => void;
  onCase?: (c: CommunityCase) => void;
};

export async function runCommunityEval(
  config: CommunityConfig,
  deps: CommunityDeps,
) {
  const clock = deps.clock ?? (() => performance.now());
  const log = deps.log ?? (() => {});
  const startedAt = new Date().toISOString();
  const before = deps.budget.snapshot();
  let lastDispatch = -Infinity,
    consecutiveUpstream = 0;
  let stopped: string | null = null;
  const attempts: CommunityAttempt[] = [];
  for (const c of config.cases) {
    const base = {
      caseId: c.id,
      suite: c.suite,
      ...(c.suite === "meta" && c.image ? { image: c.image } : {}),
      raw: null,
      checks: {},
      failedChecks: [],
      call: null,
    };
    const rules =
      c.suite === "safety"
        ? rulePrecheck({
            title: c.title ?? "",
            text: c.text,
            tags: c.tags ?? [],
          }).map((f) => ({
            category: f.category,
            excerpt: f.excerpt,
            blocking: f.blocking,
          }))
        : undefined;
    if (!stopped && consecutiveUpstream >= 3) stopped = "circuit_open";
    if (stopped) {
      attempts.push({ ...base, rules, status: "not_run", reason: stopped });
      continue;
    }
    const image =
      c.suite === "meta" && c.image ? deps.thumbnails.get(c.image) : undefined;
    if (c.suite === "meta" && c.image) {
      if (!image) {
        attempts.push({ ...base, status: "not_run", reason: "缺少缩略图" });
        continue;
      }
      if (!MODEL_WHITELIST.vision.some((m) => m.id === config.model)) {
        attempts.push({
          ...base,
          status: "not_run",
          reason: `${config.model} 不在视觉白名单，照片用例不执行`,
        });
        continue;
      }
    }
    deps.onCase?.(c);
    const record: CommunityCallRecord = {
      attempts: 0,
      unsentAttempts: 0,
      totalMs: 0,
      firstByteMs: null,
      httpStatus: null,
      usage: null,
      reservedTokens: 0,
      chargedTokens: 0,
      errorCode: null,
    };
    type Try = {
      firstByte: number | null;
      status: number | null;
      unsent: boolean;
    };
    const tries: Try[] = [];
    const tickets: Ticket[] = [];
    const start = clock();
    let raw: string | null = null;
    const transport: typeof fetch = async (url, init) => {
      const pause = config.minIntervalMs - (clock() - lastDispatch);
      if (pause > 0) await new Promise((r) => setTimeout(r, pause));
      lastDispatch = clock();
      const a: Try = { firstByte: null, status: null, unsent: false };
      tries.push(a);
      let res: Response;
      try {
        res = await deps.transport(url, init);
      } catch (e) {
        a.unsent = requestNotSent(e);
        throw e;
      }
      a.status = res.status;
      if (!res.body) return res;
      const tap = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          a.firstByte ??= clock();
          controller.enqueue(chunk);
        },
      });
      return new Response(res.body.pipeThrough(tap), {
        status: res.status,
        headers: res.headers,
      });
    };
    const settle = async (usageTotal: number | null) => {
      for (const [i, t] of tickets.entries()) {
        if (t.settled) continue;
        const last = i === tickets.length - 1;
        if (!(last && usageTotal !== null) && (!tries[i] || tries[i].unsent)) {
          record.unsentAttempts++;
          record.chargedTokens += await deps.budget.release(t);
        } else
          record.chargedTokens += await deps.budget.settle(
            t,
            last ? usageTotal : null,
          );
      }
    };
    const call: typeof callModel = async (
      m,
      s,
      r,
      tools,
      _t,
      schema,
      options,
    ) => {
      try {
        const result = await callModel(m, s, r, tools, transport, schema, {
          ...options,
          model: config.model,
          reserve: async (worst) => {
            const ticket = await deps.budget.reserve(worst);
            tickets.push(ticket);
            record.reservedTokens += ticket.reserved;
          },
        });
        raw = result.message.content;
        record.usage = result.usage;
        await settle(result.usage?.total_tokens ?? null);
        return result;
      } catch (e) {
        await settle(null);
        throw e;
      }
    };
    let draft: PostMetaDraft | null = null;
    let safety: PostSafetyResult | null = null;
    let error: string | undefined;
    const session = `eval-${deps.runId}-${c.id}`;
    try {
      if (c.suite === "meta")
        draft = (
          await generatePostMeta(
            { text: c.text, ...(image ? { image } : {}) },
            session,
            randomUUID(),
            call,
          )
        ).data;
      else
        safety = (
          await precheckPost(
            { title: c.title ?? "", text: c.text, tags: c.tags ?? [] },
            session,
            randomUUID(),
            call,
          )
        ).data;
    } catch (e) {
      const code = e instanceof AiError ? e.code : (e as Error).name;
      record.errorCode = code;
      if (code === "AI_EVAL_BUDGET") {
        stopped = "budget";
        attempts.push({
          ...base,
          rules,
          status: "not_run",
          reason: stopped,
          call: record,
        });
        log(`${c.id} not_run (budget)`);
        continue;
      }
      if (code !== "AI_INVALID_OUTPUT")
        error = `${code}:${(e as Error).message}`;
      else error = `AI_INVALID_OUTPUT:${(e as Error).message}`;
    } finally {
      record.totalMs = Math.round(clock() - start);
      record.attempts = tries.length;
      const last = tries.at(-1);
      record.httpStatus = last?.status ?? null;
      record.firstByteMs =
        last?.firstByte != null ? Math.round(last.firstByte - start) : null;
    }
    const responded = raw !== null;
    if (!responded && error?.startsWith("AI_UPSTREAM")) consecutiveUpstream++;
    else consecutiveUpstream = 0;
    const checks = !responded
      ? {}
      : c.suite === "meta"
        ? scoreMeta(c, draft, raw)
        : scoreSafety(c, safety, raw);
    const failed = Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([k]) => k);
    const status: CommunityAttempt["status"] = !responded
      ? "error"
      : failed.length
        ? "fail"
        : "pass";
    attempts.push({
      ...base,
      status,
      ...(error ? { error } : {}),
      raw,
      ...(c.suite === "meta" ? { draft } : { safety, rules }),
      checks,
      failedChecks: failed,
      call: record,
    });
    log(
      `${c.id} ${status}${failed.length ? ` [${failed.join(",")}]` : ""}${error ? ` ${error.slice(0, 90)}` : ""}`,
    );
  }
  const after = deps.budget.snapshot();
  return {
    kind: "pawmeet-community-smoke" as const,
    schemaVersion: 1,
    simulated: config.mode !== "live",
    dataLabel:
      config.mode === "live"
        ? "真实模型调用"
        : "模拟数据（mock 传输，未调用真实模型）",
    runId: deps.runId,
    mode: config.mode,
    model: config.model,
    promptVersion: COMMUNITY_PROMPT_VERSION,
    caseVersion: COMMUNITY_CASE_VERSION,
    git: deps.git.commit,
    gitDirty: deps.git.dirty,
    startedAt,
    finishedAt: new Date().toISOString(),
    config: {
      suite: config.suite,
      cases: config.cases.map((c) => c.id),
      tokenLimit: config.tokenLimit,
      minIntervalMs: config.minIntervalMs,
      ledger: config.mode === "live" ? config.ledger : "memory",
      budgetKey: COMMUNITY_BUDGET_KEY,
    },
    budget: {
      limit: config.tokenLimit,
      chargedBefore: before.chargedTokens,
      chargedAfter: after.chargedTokens,
      chargedThisRun: after.chargedTokens - before.chargedTokens,
      knownThisRun: after.knownTokens - before.knownTokens,
      conservativeThisRun: after.conservativeTokens - before.conservativeTokens,
      transmissionsThisRun: after.transmissions - before.transmissions,
      unsentThisRun: after.unsent - before.unsent,
      stoppedBy: stopped,
    },
    metrics: {
      all: summarizeCommunity(attempts),
      meta: summarizeCommunity(attempts.filter((a) => a.suite === "meta")),
      safety: summarizeCommunity(attempts.filter((a) => a.suite === "safety")),
    },
    cases: attempts,
  };
}
export type CommunityReport = Awaited<ReturnType<typeof runCommunityEval>>;

export function summarizeCommunity(attempts: CommunityAttempt[]) {
  const run = attempts.filter((a) => a.status !== "not_run");
  const calls = run.flatMap((a) => (a.call ? [a.call] : []));
  const ok = calls.filter((c) => c.usage);
  const count = (k: string) => {
    const xs = run.filter((a) => k in a.checks);
    return { ok: xs.filter((a) => a.checks[k]).length, total: xs.length };
  };
  return {
    cases: attempts.length,
    executed: run.length,
    notRun: attempts.length - run.length,
    pass: run.filter((a) => a.status === "pass").length,
    passRate: ratio(run.filter((a) => a.status === "pass").length, run.length),
    errors: run.filter((a) => a.status === "error").length,
    checks: Object.fromEntries(
      Object.keys(CHECK_LABELS).map((k) => [k, count(k)]),
    ),
    latencyMs: {
      totalP50: percentile(
        ok.map((c) => c.totalMs),
        0.5,
      ),
      totalP95: percentile(
        ok.map((c) => c.totalMs),
        0.95,
      ),
    },
    tokens: {
      known: ok.reduce((s, c) => s + c.usage!.total_tokens, 0),
      avg: ok.length
        ? Math.round(
            ok.reduce((s, c) => s + c.usage!.total_tokens, 0) / ok.length,
          )
        : null,
      unknownCalls: calls.length - ok.length,
      charged: calls.reduce((s, c) => s + c.chargedTokens, 0),
    },
  };
}

const pct = (v: number | null) =>
  v === null ? "—" : `${(v * 100).toFixed(1)}%`;
const frac = (x: { ok: number; total: number }) =>
  x.total ? `${x.ok}/${x.total}` : "—";
const sec = (ms: number | null) =>
  ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`;

export const communityReportStem = (r: CommunityReport) =>
  `${r.runId}-${r.model}-community-${r.simulated ? "simulated" : "live"}`;

export function communityMarkdown(r: CommunityReport) {
  const banner = r.simulated ? `${SIMULATED_BANNER}\n\n` : "";
  const row = (name: string, m: ReturnType<typeof summarizeCommunity>) =>
    `| ${name}${r.simulated ? "（模拟）" : ""} | ${m.executed}/${m.cases} | ${pct(m.passRate)} | ${Object.keys(
      CHECK_LABELS,
    )
      .map((k) => frac(m.checks[k]))
      .join(
        " | ",
      )} | ${sec(m.latencyMs.totalP50)} / ${sec(m.latencyMs.totalP95)} | ${m.tokens.avg ?? "—"} / ${m.tokens.known} | ${m.errors} |`;
  const lines = [
    `# 社区 AI 冒烟：${r.model}（${r.dataLabel}）`,
    "",
    banner +
      `runId ${r.runId} · Prompt ${r.promptVersion} · 用例 ${r.caseVersion} · git ${r.git.slice(0, 7)}${r.gitDirty ? "（工作区有改动）" : ""}。照片用例只记录私有图片 ID，不含图片或 base64。`,
    "",
    `| 范围 | 已执行 / 用例 | 通过率 | ${Object.values(CHECK_LABELS).join(" | ")} | 总时长 p50 / p95 | 平均 / 总 Token | 网络 / 结构失败 |`,
    `| --- | --- | --- | ${Object.keys(CHECK_LABELS)
      .map(() => "---")
      .join(" | ")} | --- | --- | --- |`,
    row("全部", r.metrics.all),
    row("标题标签", r.metrics.meta),
    row("安全预检", r.metrics.safety),
    "",
    `额度（${r.config.budgetKey}，所有模型合计）：本次计入 ${r.budget.chargedThisRun}（实际 usage ${r.budget.knownThisRun}，保守计入 ${r.budget.conservativeThisRun}，未发出而释放 ${r.budget.unsentThisRun} 次），上游传输 ${r.budget.transmissionsThisRun} 次，账本累计 ${r.budget.chargedAfter} / 上限 ${r.budget.limit ?? "∞"}；停止原因：${r.budget.stoppedBy ?? "跑完"}。`,
    "",
    "| 用例 | 结果 | 输出（程序审核后） | 程序规则层 | 未通过检查 | 错误 | Token | 总时长 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...r.cases.map((a) => {
      const out = a.draft
        ? `${a.draft.title} / #${a.draft.tags.join(" #")}`
        : a.safety
          ? `${a.safety.verdict}${a.safety.issues.length ? `：${a.safety.issues.map((i) => `${i.category}「${i.excerpt ?? "未定位"}」`).join("；")}` : ""}`
          : "—";
      const rules = a.rules
        ? a.rules.length
          ? a.rules
              .map((f) => `${f.category}${f.blocking ? "（阻止）" : ""}`)
              .join("；")
          : "无"
        : "—";
      return `| ${a.caseId}${a.image ? `（${a.image}）` : ""} | ${a.status}${a.reason ? `（${a.reason}）` : ""} | ${out.replace(/\|/g, "／")} | ${rules} | ${a.failedChecks.map((k) => CHECK_LABELS[k]).join("；") || "—"} | ${(a.error ?? "—").replace(/\|/g, "／").slice(0, 80)} | ${a.call?.usage?.total_tokens ?? "—"} | ${a.call ? sec(a.call.totalMs) : "—"} |`;
    }),
    "",
  ];
  return lines.join("\n");
}
