import { randomUUID } from "node:crypto";
import { callModel, thumbnailPart } from "../../src/server/ai/client";
import { AiError } from "../../src/server/ai/errors";
import { recognizePetPhoto } from "../../src/server/ai/service";
import { MODEL_WHITELIST, resolveModel } from "../../src/server/ai/models";
import { PHOTO_PROMPT_VERSION } from "../../src/server/ai/prompts";
import {
  petPhotoOutputSchema,
  type PetPhotoDraft,
} from "../../src/lib/ai/contracts";
import {
  forbiddenClaim,
  photoFill,
  reviewPetPhoto,
} from "../../src/lib/ai/photo";
import { inspectJpegDataUrl } from "../../src/lib/ai/jpeg";
import {
  CATEGORY_LABELS,
  VISION_CASE_VERSION,
  breedMatches,
  categoryOf,
  loadVisionCases,
  type VisionCase,
  type VisionCategory,
} from "../cases/vision";
import { VISION_TOKEN_CAPS, type EvalBudget, type Ticket } from "./budget";
import { requestNotSent } from "./https-transport";
import { percentile, ratio, type Usage } from "./metrics";
import { SIMULATED_BANNER } from "./report";

export type VisionConfig = {
  mode: "live" | "simulated";
  model: string;
  source: "public" | "private" | "all";
  cases: VisionCase[];
  tokenLimit: number | null;
  maxCalls: number | null;
  minIntervalMs: number;
  ledger: string;
  dryRun: boolean;
};
const FLAGS = new Set([
  "--mode",
  "--model",
  "--source",
  "--cases",
  "--token-limit",
  "--max-calls",
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

/** Validated before any ledger or network access. Live needs --token-limit ≤ the vision cap. */
export function parseVisionConfig(argv: string[], root?: string): VisionConfig {
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
    "vision",
    values.get("--model") ?? "qwen3.8-omni-flash",
  ).id;
  if (!MODEL_WHITELIST.vision.some((m) => m.id === model))
    throw Error("仅评测视觉白名单模型");
  const cap = VISION_TOKEN_CAPS[model];
  if (cap === undefined) throw Error(`${model} 没有批准的视觉评测额度`);
  const raw = values.get("--token-limit");
  let tokenLimit: number | null;
  if (mode === "live") {
    tokenLimit = raw === undefined ? 0 : int("--token-limit", raw, 0, cap);
    if (tokenLimit === 0 && !values.has("--dry-run"))
      throw Error(
        `真实视觉评测需要 --token-limit（1–${cap}，${model} 批准上限）；默认 0 不允许真实调用`,
      );
  } else
    tokenLimit =
      raw === undefined ? null : int("--token-limit", raw, 1, 10_000_000);
  if (mode === "simulated" && values.has("--ledger"))
    throw Error("模拟运行只用内存账本");
  // Real evaluations use only the labelled private images (user decision, step 7); the public
  // demo photos stay available for simulated runs and offline tests.
  const source = (values.get("--source") ??
    (mode === "live" ? "private" : "all")) as VisionConfig["source"];
  if (!["public", "private", "all"].includes(source))
    throw Error("--source 只能是 public / private / all");
  if (mode === "live" && source !== "private")
    throw Error(
      "真实视觉评测只用 evals/fixtures/private-images 的带标签图片（--source private）",
    );
  let cases = loadVisionCases(source, root);
  const spec = values.get("--cases");
  if (spec) {
    const ids = new Set(spec.split(",").map((s) => s.trim()));
    const unknown = [...ids].filter((id) => !cases.some((c) => c.id === id));
    if (unknown.length) throw Error(`未知视觉用例：${unknown.join(",")}`);
    cases = cases.filter((c) => ids.has(c.id));
  }
  return {
    mode,
    model,
    source,
    cases,
    tokenLimit,
    maxCalls: values.has("--max-calls")
      ? int("--max-calls", values.get("--max-calls")!, 1, 500)
      : null,
    minIntervalMs: int(
      "--min-interval-ms",
      values.get("--min-interval-ms") ?? (mode === "live" ? "1500" : "0"),
      0,
      60000,
    ),
    ledger: values.get("--ledger") ?? ".local/ai-eval/step7-vision-ledger.json",
    dryRun: values.has("--dry-run"),
  };
}

export const CHECK_LABELS: Record<string, string> = {
  schema: "原始输出符合 Schema",
  no_claims_raw: "原始输出无健康 / 年龄 / 性格判断",
  dog_recognized: "单只狗被识别为狗",
  not_dog_rejected: "非狗判定无法识别且不填",
  multiple_nothing_filled: "多只狗不填任何字段",
  size_not_wrong: "体型不乱填（填了就须符合标签）",
  breed_not_wrong: "品种不乱填（填了就须符合标签）",
};

/** Programmatic checks; every check reads the reviewed draft or the raw text, no LLM judge. */
export function scoreVision(
  c: VisionCase,
  draft: PetPhotoDraft | null,
  raw: string | null,
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      (raw ?? "")
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, ""),
    );
  } catch {
    parsed = undefined;
  }
  const schema = petPhotoOutputSchema.safeParse(parsed).success;
  const fill = draft
    ? photoFill(draft)
    : { breed: undefined, size: undefined, appearance: undefined };
  const filledAny = Object.values(fill).some((v) => v !== undefined);
  const checks: Record<string, boolean> = {
    schema,
    no_claims_raw: !forbiddenClaim(raw),
  };
  if (c.isDog === false)
    checks.not_dog_rejected =
      !filledAny && (!draft || ["not_dog", "uncertain"].includes(draft.status));
  if (c.isDog === true && !c.multiple && c.breed)
    checks.dog_recognized = draft?.status === "recognized";
  if (c.multiple) checks.multiple_nothing_filled = !filledAny;
  if (c.sizes)
    checks.size_not_wrong =
      fill.size === undefined || c.sizes.includes(fill.size as never);
  if (c.isDog !== null)
    checks.breed_not_wrong =
      fill.breed === undefined ||
      (!!c.breed && breedMatches(c.breed, fill.breed));
  const coverage = {
    breedLabelled: c.isDog === true && !c.multiple && !!c.breed,
    breedCorrect:
      !!c.breed && !!fill.breed && breedMatches(c.breed, fill.breed),
    sizeLabelled: c.isDog === true && !c.multiple && !!c.sizes?.length,
    sizeCorrect: !!fill.size && !!c.sizes?.includes(fill.size as never),
  };
  return {
    schema,
    checks,
    failed: Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([k]) => k),
    fill,
    coverage,
  };
}

export type VisionCallRecord = {
  attempts: number;
  unsentAttempts: number;
  timedOutAttempts: number;
  firstByteMs: number | null;
  totalMs: number;
  httpStatus: number | null;
  usage: Usage | null;
  reservedTokens: number;
  chargedTokens: number;
  errorCode: string | null;
};
export type VisionAttempt = {
  caseId: string;
  file: string;
  source: VisionCase["source"];
  category?: VisionCategory;
  labelled: boolean;
  status: "pass" | "fail" | "error" | "not_run";
  reason?: string;
  error?: string;
  thumbnail?: { width: number; height: number; bytes: number };
  /** Raw model text before validation (JSON only; never image data). */
  raw: string | null;
  draft: PetPhotoDraft | null;
  checks: Record<string, boolean>;
  failedChecks: string[];
  coverage?: ReturnType<typeof scoreVision>["coverage"];
  call: VisionCallRecord | null;
};

export type VisionDeps = {
  runId: string;
  transport: typeof fetch;
  budget: EvalBudget;
  thumbnails: Map<string, string>;
  git: { commit: string; dirty: boolean };
  clock?: () => number;
  log?: (line: string) => void;
  /** Simulated runs: tells the mock transport which case is current. */
  onCase?: (c: VisionCase) => void;
};

export async function runVisionEval(config: VisionConfig, deps: VisionDeps) {
  const clock = deps.clock ?? (() => performance.now());
  const log = deps.log ?? (() => {});
  const startedAt = new Date().toISOString();
  const before = deps.budget.snapshot();
  let transmissions = 0,
    lastDispatch = -Infinity,
    consecutiveUpstream = 0;
  let stopped: string | null = null;
  const attempts: VisionAttempt[] = [];
  for (const c of config.cases) {
    const base = {
      caseId: c.id,
      file: c.file,
      source: c.source,
      category: categoryOf(c),
      labelled: c.isDog !== null,
      raw: null,
      draft: null,
      checks: {},
      failedChecks: [],
      call: null,
    };
    if (!stopped && consecutiveUpstream >= 3) stopped = "circuit_open";
    if (stopped) {
      attempts.push({ ...base, status: "not_run", reason: stopped });
      continue;
    }
    deps.onCase?.(c);
    const image = deps.thumbnails.get(c.id);
    const info = image ? inspectJpegDataUrl(image) : null;
    try {
      if (!image) throw Error("missing thumbnail");
      thumbnailPart(image);
    } catch (e) {
      attempts.push({
        ...base,
        status: "not_run",
        reason: `缩略图未通过服务端检查：${(e as Error).message}`,
      });
      continue;
    }
    const record: VisionCallRecord = {
      attempts: 0,
      unsentAttempts: 0,
      timedOutAttempts: 0,
      firstByteMs: null,
      totalMs: 0,
      httpStatus: null,
      usage: null,
      reservedTokens: 0,
      chargedTokens: 0,
      errorCode: null,
    };
    type Attempt = {
      firstByte: number | null;
      status: number | null;
      completed: boolean;
      unsent: boolean;
      signal?: AbortSignal | null;
    };
    const tries: Attempt[] = [];
    const tickets: Ticket[] = [];
    const start = clock();
    let raw: string | null = null;
    const transport: typeof fetch = async (url, init) => {
      const pause = config.minIntervalMs - (clock() - lastDispatch);
      if (pause > 0) await new Promise((r) => setTimeout(r, pause));
      lastDispatch = clock();
      const a: Attempt = {
        firstByte: null,
        status: null,
        completed: false,
        unsent: false,
        signal: init?.signal,
      };
      tries.push(a);
      let res: Response;
      try {
        res = await deps.transport(url, init);
      } catch (e) {
        a.unsent = requestNotSent(e);
        throw e;
      }
      a.status = res.status;
      if (!res.body) {
        a.completed = true;
        return res;
      }
      const tap = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          a.firstByte ??= clock();
          controller.enqueue(chunk);
        },
        flush() {
          a.completed = true;
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
            if (config.maxCalls !== null && transmissions >= config.maxCalls)
              throw new AiError(
                "AI_EVAL_MAX_CALLS",
                `已达 --max-calls ${config.maxCalls}`,
                429,
              );
            const ticket = await deps.budget.reserve(worst);
            tickets.push(ticket);
            record.reservedTokens += ticket.reserved;
            transmissions++;
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
    let draft: PetPhotoDraft | null = null;
    let error: string | undefined;
    try {
      draft = (
        await recognizePetPhoto(
          { image },
          `eval-${deps.runId}-${c.id}`,
          randomUUID(),
          call,
        )
      ).data;
    } catch (e) {
      const code = e instanceof AiError ? e.code : (e as Error).name;
      record.errorCode = code;
      if (code === "AI_EVAL_BUDGET" || code === "AI_EVAL_MAX_CALLS") {
        stopped = code === "AI_EVAL_BUDGET" ? "budget" : "max_calls";
        attempts.push({
          ...base,
          status: "not_run",
          reason: stopped,
          call: record,
        });
        log(`${c.id} not_run (${stopped})`);
        continue;
      }
      if (code !== "AI_INVALID_OUTPUT")
        error = `${code}:${(e as Error).message}`;
    } finally {
      record.totalMs = Math.round(clock() - start);
      record.attempts = tries.length;
      record.timedOutAttempts = tries.filter(
        (a) => a.signal?.aborted && !a.completed,
      ).length;
      const last = tries.at(-1);
      record.httpStatus = last?.status ?? null;
      record.firstByteMs =
        last?.firstByte != null ? Math.round(last.firstByte - start) : null;
    }
    const responded = raw !== null;
    if (!responded && error?.startsWith("AI_UPSTREAM")) consecutiveUpstream++;
    else consecutiveUpstream = 0;
    const score = scoreVision(c, draft, raw);
    const status: VisionAttempt["status"] = !responded
      ? "error"
      : score.failed.length
        ? "fail"
        : "pass";
    attempts.push({
      ...base,
      status,
      ...(error
        ? { error }
        : !draft && responded
          ? { error: "AI_INVALID_OUTPUT" }
          : {}),
      thumbnail: info
        ? {
            width: info.width,
            height: info.height,
            bytes: Math.floor(((image.length - 23) * 3) / 4),
          }
        : undefined,
      raw,
      draft,
      checks: responded ? score.checks : {},
      failedChecks: responded ? score.failed : [],
      coverage: responded ? score.coverage : undefined,
      call: record,
    });
    log(
      `${c.id} ${status}${score.failed.length && responded ? ` [${score.failed.join(",")}]` : ""}${error ? ` ${error.slice(0, 80)}` : ""}`,
    );
  }
  const after = deps.budget.snapshot();
  return {
    kind: "pawmeet-vision-eval" as const,
    schemaVersion: 1,
    simulated: config.mode !== "live",
    dataLabel:
      config.mode === "live"
        ? "真实模型调用"
        : "模拟数据（mock 传输，未调用真实模型）",
    runId: deps.runId,
    mode: config.mode,
    model: config.model,
    promptVersion: PHOTO_PROMPT_VERSION,
    caseVersion: VISION_CASE_VERSION,
    git: deps.git.commit,
    gitDirty: deps.git.dirty,
    startedAt,
    finishedAt: new Date().toISOString(),
    config: {
      source: config.source,
      cases: config.cases.map((c) => c.id),
      tokenLimit: config.tokenLimit,
      maxCalls: config.maxCalls,
      minIntervalMs: config.minIntervalMs,
      ledger: config.mode === "live" ? config.ledger : "memory",
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
    metrics: metricsByCategory(attempts),
    cases: attempts,
  };
}
export type VisionReport = Awaited<ReturnType<typeof runVisionEval>>;

/** Overall plus one summary per image category present in the run. */
export function metricsByCategory(attempts: VisionAttempt[]) {
  const groups = (Object.keys(CATEGORY_LABELS) as VisionCategory[]).filter(
    (k) => attempts.some((a) => a.category === k),
  );
  return {
    all: summarizeVision(attempts),
    byCategory: Object.fromEntries(
      groups.map((k) => [
        k,
        summarizeVision(attempts.filter((a) => a.category === k)),
      ]),
    ) as Partial<Record<VisionCategory, ReturnType<typeof summarizeVision>>>,
  };
}

/**
 * Re-derives categories from the current labels and keeps only private images. Lets reports
 * written before the category grouping (step 7 first runs, which also covered the 6 public
 * photos) be re-summarised without new model calls.
 */
export function privateOnly(r: VisionReport): VisionReport {
  const labels = new Map(
    loadVisionCases("private").map((c) => [c.id, c] as const),
  );
  const cases = r.cases
    .filter((a) => a.source === "private")
    .map((a) => {
      const c = labels.get(a.caseId);
      return {
        ...a,
        category: a.category ?? (c ? categoryOf(c) : "unlabelled"),
      };
    });
  const dropped = r.cases.length - cases.length;
  return {
    ...r,
    cases,
    metrics: metricsByCategory(cases),
    ...(dropped ? { droppedPublic: dropped } : {}),
  };
}

export function summarizeVision(attempts: VisionAttempt[]) {
  const run = attempts.filter((a) => a.status !== "not_run");
  const responded = run.filter((a) => a.raw !== null);
  const calls = run.flatMap((a) => (a.call ? [a.call] : []));
  const ok = calls.filter((c) => c.usage);
  const count = (k: string) => {
    const xs = responded.filter((a) => k in a.checks);
    return { ok: xs.filter((a) => a.checks[k]).length, total: xs.length };
  };
  const cov = responded.flatMap((a) => (a.coverage ? [a.coverage] : []));
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
    breedFilledCorrect: {
      ok: cov.filter((c) => c.breedLabelled && c.breedCorrect).length,
      total: cov.filter((c) => c.breedLabelled).length,
    },
    sizeFilledCorrect: {
      ok: cov.filter((c) => c.sizeLabelled && c.sizeCorrect).length,
      total: cov.filter((c) => c.sizeLabelled).length,
    },
    latencyMs: {
      totalP50: percentile(
        ok.map((c) => c.totalMs),
        0.5,
      ),
      totalP95: percentile(
        ok.map((c) => c.totalMs),
        0.95,
      ),
      firstByteP50: percentile(
        ok.flatMap((c) => (c.firstByteMs === null ? [] : [c.firstByteMs])),
        0.5,
      ),
    },
    tokens: {
      known: ok.reduce((s, c) => s + c.usage!.total_tokens, 0),
      knownCalls: ok.length,
      avg: ok.length
        ? Math.round(
            ok.reduce((s, c) => s + c.usage!.total_tokens, 0) / ok.length,
          )
        : null,
      unknownCalls: calls.length - ok.length,
      charged: calls.reduce((s, c) => s + c.chargedTokens, 0),
    },
    timeouts: calls.filter((c) => c.errorCode === "AI_UPSTREAM_TIMEOUT").length,
  };
}

const pct = (v: number | null) =>
  v === null ? "—" : `${(v * 100).toFixed(1)}%`;
const frac = (x: { ok: number; total: number }) =>
  x.total ? `${x.ok}/${x.total}` : "—";
const sec = (ms: number | null) =>
  ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`;

export function visionReportStem(r: VisionReport) {
  return `${r.runId}-${r.model}-vision-${r.simulated ? "simulated" : "live"}`;
}

export function visionMarkdown(r: VisionReport) {
  const banner = r.simulated ? `${SIMULATED_BANNER}\n\n` : "";
  const row = (name: string, m: ReturnType<typeof summarizeVision>) =>
    `| ${name}${r.simulated ? "（模拟）" : ""} | ${m.executed}/${m.cases} | ${pct(m.passRate)} | ${frac(m.checks.schema)} | ${frac(m.checks.no_claims_raw)} | ${frac(m.checks.not_dog_rejected)} | ${frac(m.checks.size_not_wrong)} | ${frac(m.checks.breed_not_wrong)} | ${frac(m.breedFilledCorrect)} | ${frac(m.sizeFilledCorrect)} | ${sec(m.latencyMs.totalP50)} / ${sec(m.latencyMs.totalP95)} | ${m.tokens.avg ?? "—"} / ${m.tokens.known} | ${m.errors} |`;
  const lines = [
    `# 视觉评测：${r.model}（${r.dataLabel}）`,
    "",
    banner +
      `runId ${r.runId} · Prompt ${r.promptVersion} · 用例 ${r.caseVersion} · git ${r.git.slice(0, 7)}${r.gitDirty ? "（工作区有改动）" : ""}。报告只含文件名，不含图片或 base64。`,
    "",
    "| 范围 | 已执行 / 用例 | 通过率 | Schema 合法 | 无违规判断 | 非狗拒识 | 体型不乱填 | 品种不乱填 | 品种填对 | 体型填对 | 总时长 p50 / p95 | 平均 / 总 Token | 网络 / 超时失败 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    row("全部", r.metrics.all),
    ...Object.entries(r.metrics.byCategory).map(([k, m]) =>
      row(CATEGORY_LABELS[k as VisionCategory], m!),
    ),
    "",
    ...((r as { droppedPublic?: number }).droppedPublic
      ? [
          `说明：由同一次真实运行派生，按用户要求去掉 ${(r as { droppedPublic?: number }).droppedPublic} 张公开演示图片后只统计私有带标签图片；下面的额度行是整次运行（含公开图片的调用）。`,
          "",
        ]
      : []),
    `额度：本次计入 ${r.budget.chargedThisRun}（实际 usage ${r.budget.knownThisRun}，保守计入 ${r.budget.conservativeThisRun}，未发出而释放 ${r.budget.unsentThisRun} 次），上游传输 ${r.budget.transmissionsThisRun} 次，账本累计 ${r.budget.chargedAfter} / 上限 ${r.budget.limit ?? "∞"}；停止原因：${r.budget.stoppedBy ?? "跑完"}。`,
    "",
    "| 用例 | 类别 | 结果 | 状态 / 品种 / 体型（程序审核后） | 未通过检查 | 错误 | Token | 总时长 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...r.cases.map(
      (a) =>
        `| ${a.file} | ${a.category ? CATEGORY_LABELS[a.category] : "—"}${a.source === "public" ? "（公开）" : ""} | ${a.status}${a.reason ? `（${a.reason}）` : ""} | ${a.draft ? `${a.draft.status} / ${a.draft.breed.value ?? "—"}${a.draft.breed.accepted ? "✓" : ""} / ${a.draft.size.value}${a.draft.size.accepted ? "✓" : ""}` : "—"} | ${a.failedChecks.map((k) => CHECK_LABELS[k]).join("；") || "—"} | ${a.error ?? "—"} | ${a.call?.usage?.total_tokens ?? "—"} | ${a.call ? sec(a.call.totalMs) : "—"} |`,
    ),
    "",
    "✓ = 通过置信度与内容规则、会填入表单。",
  ];
  return lines.join("\n") + "\n";
}

/** Cross-model table; callers pass privateOnly(...) reports for the real evaluation. */
export function visionCompareMarkdown(reports: VisionReport[]) {
  const sim = new Set(reports.map((r) => r.simulated));
  if (sim.size > 1) throw Error("模拟与真实视觉报告不能合并对比");
  const head = `| 模型 | 范围 | 已执行 / 用例 | 通过率 | Schema 合法 | 无违规判断 | 非狗拒识 | 体型不乱填 | 品种不乱填 | 品种填对 | 体型填对 | 总时长 p50 / p95 | 平均 Token | 网络 / 超时失败 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`;
  const rows = reports.flatMap((r) =>
    [
      ["all", r.metrics.all] as const,
      ...Object.entries(r.metrics.byCategory),
    ].map(([k, m]) => {
      m = m!;
      return `| ${r.model} | ${k === "all" ? "全部" : CATEGORY_LABELS[k as VisionCategory]} | ${m.executed}/${m.cases} | ${pct(m.passRate)} | ${frac(m.checks.schema)} | ${frac(m.checks.no_claims_raw)} | ${frac(m.checks.not_dog_rejected)} | ${frac(m.checks.size_not_wrong)} | ${frac(m.checks.breed_not_wrong)} | ${frac(m.breedFilledCorrect)} | ${frac(m.sizeFilledCorrect)} | ${sec(m.latencyMs.totalP50)} / ${sec(m.latencyMs.totalP95)} | ${m.tokens.avg ?? "—"} | ${m.errors} |`;
    }),
  );
  return `${[...sim][0] ? `${SIMULATED_BANNER}\n\n` : ""}${head}\n${rows.join("\n")}\n`;
}

/**
 * Offline recheck: re-applies the current program rules (confidence threshold, suggestions,
 * breed–size cross-check) to the raw model outputs saved in a live report. No model call.
 * Counts breed and size on labelled single-dog images: filled automatically (and how many of
 * those are wrong) versus left for the owner to confirm. "before" uses the drafts produced by
 * the rules at run time.
 */
export function recheckRules(
  r: VisionReport,
  cases: VisionCase[] = loadVisionCases("private"),
) {
  const labels = new Map(cases.map((c) => [c.id, c] as const));
  const tally = () => ({ auto: 0, autoWrong: 0, confirm: 0, empty: 0 });
  const before = tally(),
    after = tally();
  const wrongAuto: string[] = [];
  for (const a of r.cases) {
    const c = labels.get(a.caseId);
    if (!c || !a.raw || c.isDog !== true || c.multiple || !c.breed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        a.raw
          .trim()
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```$/, ""),
      );
    } catch {
      continue;
    }
    const out = petPhotoOutputSchema.safeParse(parsed);
    if (!out.success) continue;
    const now = reviewPetPhoto(out.data);
    const fields = [
      {
        name: "breed",
        wrong: (v: string) => !breedMatches(c.breed!, v),
        old: a.draft?.breed,
        cur: now.breed,
      },
      {
        name: "size",
        wrong: (v: string) => !c.sizes?.includes(v as never),
        old: a.draft?.size,
        cur: now.size,
      },
    ];
    for (const f of fields) {
      for (const [t, field, isNew] of [
        [before, f.old, false],
        [after, f.cur, true],
      ] as const) {
        if (!field) continue;
        const value = String(field.value ?? "");
        if (field.accepted) {
          t.auto++;
          if (f.wrong(value)) {
            t.autoWrong++;
            if (isNew) wrongAuto.push(`${a.file} ${f.name}=${value}`);
          }
        } else if (
          isNew
            ? (field as { suggested?: boolean }).suggested
            : value && value !== "unknown"
        )
          t.confirm++;
        else t.empty++;
      }
    }
  }
  return { model: r.model, runId: r.runId, before, after, wrongAuto };
}

export function recheckMarkdown(reports: VisionReport[]) {
  const results = reports.map((r) => recheckRules(r));
  const rows = results.flatMap((x) => [
    `| ${x.model} | 运行时规则 | ${x.before.auto} | ${x.before.autoWrong} | ${x.before.auto ? `${(((x.before.auto - x.before.autoWrong) / x.before.auto) * 100).toFixed(1)}%` : "—"} | ${x.before.confirm}（低置信度，当时只显示“不确定”） | ${x.before.empty} |`,
    `| ${x.model} | 建议 + 品种表校正体型 | ${x.after.auto} | ${x.after.autoWrong} | ${x.after.auto ? `${(((x.after.auto - x.after.autoWrong) / x.after.auto) * 100).toFixed(1)}%` : "—"} | ${x.after.confirm} | ${x.after.empty} |`,
  ]);
  const wrong = results
    .filter((x) => x.wrongAuto.length)
    .map((x) => `- ${x.model}：${x.wrongAuto.join("；")}`);
  return [
    "> 离线复算：用报告中保存的同一批真实原始模型输出重新执行程序规则，**没有新的模型调用**；只统计有品种 / 体型标签的单只狗图片上的品种与体型两个字段。",
    "",
    "| 模型 | 规则 | 自动填入字段 | 其中错误 | 自动填入准确率 | 需用户确认字段 | 未给值 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    wrong.length
      ? "复算后仍自动填错的字段："
      : "复算后自动填入的字段全部正确。",
    ...wrong,
  ].join("\n");
}
