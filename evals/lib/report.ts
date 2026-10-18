import type { RunReport } from "./runner";
import type { Summary } from "./metrics";

export const SIMULATED_BANNER =
  "> ⚠️ **模拟数据（mock 传输，未调用真实模型）**：仅用于验证 runner、预算与报告流程；准确率、延迟、Token 均为合成数值，不代表任何模型表现，不得与真实结果合并或引用为模型效果。";

/** File stem: simulated output always carries -simulated; live carries -live. */
export function reportStem(
  r: Pick<RunReport, "runId" | "model" | "simulated">,
) {
  return `${r.runId}-${r.model}-${r.simulated ? "simulated" : "live"}`;
}

/**
 * Refuses to combine simulated and live data, and refuses files whose name contradicts their
 * content (e.g. a live report renamed to look simulated, or the reverse).
 */
export function assertMergeable(
  reports: { file: string; report: RunReport }[],
) {
  if (!reports.length) throw Error("没有可汇总的报告");
  for (const { file, report } of reports) {
    if (report.kind !== "pawmeet-eval-run" || report.schemaVersion !== 2)
      throw Error(`${file} 不是 schemaVersion 2 的评测运行报告`);
    const named = /-(simulated|mock)\b/.test(file);
    if (named !== report.simulated)
      throw Error(`${file} 的文件名与内容的模拟 / 真实标记不一致，拒绝汇总`);
  }
  const kinds = new Set(reports.map((r) => r.report.simulated));
  if (kinds.size > 1)
    throw Error("拒绝合并：模拟数据与真实结果不能放进同一张汇总表");
  return reports[0].report.simulated;
}

const pct = (v: number | null) =>
  v === null ? "—" : `${(v * 100).toFixed(1)}%`;
const ms = (v: number | null) => (v === null ? "—" : `${Math.round(v)} ms`);
const num = (v: number | null) =>
  v === null ? "—" : Math.round(v).toLocaleString("en-US");

const HEADER =
  "| 范围 | 已执行 / 计划 | 通过率 | Schema 合法率 | 业务校验通过率 | 关键字段准确率 | 完整任务通过率 | 总时长 p50 / p95 | 首字节 p50 / p95 | 平均 / 总 Token | 超时 | not_run |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
function row(label: string, m: Summary) {
  return `| ${label} | ${m.attempts.executed} / ${m.attempts.planned} | ${pct(m.passRate)} | ${pct(m.schemaValidRate)} | ${pct(m.businessValidRate)} | ${pct(m.keyFieldAccuracy)} | ${pct(m.completeTaskRate)} | ${ms(m.latencyMs.totalP50)} / ${ms(m.latencyMs.totalP95)} | ${ms(m.latencyMs.firstByteP50)} / ${ms(m.latencyMs.firstByteP95)} | ${num(m.tokens.avgPerKnownCall)} / ${num(m.tokens.totalKnown)}${m.tokens.unknownCalls ? `（另 ${m.tokens.unknownCalls} 次未知）` : ""} | ${m.calls.timeouts} | ${m.attempts.notRun} |`;
}
const tag = (simulated: boolean, title: string) =>
  simulated ? `【模拟数据】${title}` : title;

export function runMarkdown(r: RunReport) {
  const s = r.simulated;
  const failures = r.cases.filter(
    (c) => c.status === "fail" || c.status === "error",
  );
  const lines = [
    `# ${s ? "【模拟数据】" : ""}评测报告 ${r.model}`,
    "",
    ...(s ? [SIMULATED_BANNER, ""] : []),
    `- 数据：**${r.dataLabel}**；runId \`${r.runId}\``,
    `- 模型 \`${r.model}\`；Prompt \`${r.promptVersion}\`；validation \`${r.validationVersion}\`；用例 \`${r.caseVersion}\`；Git \`${r.git.slice(0, 7)}\`${r.gitDirty ? "（工作区有未提交修改）" : ""}`,
    `- 冻结时钟 ${r.clock}；重复 ${r.config.repeat} 次；用例 ${r.config.cases.length} 条；最小间隔 ${r.config.minIntervalMs} ms${r.config.mockFaults ? "；注入 mock 故障" : ""}`,
    `- 预算：上限 ${r.budget.limit === null ? "不限（模拟）" : num(r.budget.limit)}；本次计入 ${num(r.budget.chargedThisRun)}（实际 usage ${num(r.budget.knownThisRun)} + 保守计入 ${num(r.budget.conservativeThisRun)}）；账本累计 ${num(r.budget.chargedAfter)}；传输 ${r.budget.transmissionsThisRun} 次${r.budget.stoppedBy ? `；**提前停止：${r.budget.stoppedBy}**，剩余标 not_run` : ""}`,
    "",
    `## ${tag(s, "汇总")}`,
    "",
    HEADER,
    row("全部", r.metrics),
    ...Object.entries(r.byScenario).map(([k, m]) => row(k, m)),
    "",
    `调用 ${r.metrics.calls.total} 次（有响应 ${r.metrics.calls.withResponse}），自动重试 ${r.metrics.calls.retries} 次，超时尝试 ${r.metrics.calls.timedOutAttempts} 次；错误码：${
      Object.entries(r.metrics.calls.errors)
        .map(([k, v]) => `${k}×${v}`)
        .join("、") || "无"
    }。`,
    "",
    `## ${tag(s, "失败与错误")}`,
    "",
    ...(failures.length
      ? [
          "| 用例 | 轮次 | 状态 | 未通过检查 / 错误 |",
          "| --- | --- | --- | --- |",
          ...failures.map(
            (c) =>
              `| ${c.caseId} | ${c.repeat} | ${c.status} | ${(c.status === "error" ? [c.error] : [c.error, ...c.failedChecks]).filter(Boolean).join("；").replace(/\|/g, "\\|").slice(0, 300)} |`,
          ),
        ]
      : ["无。"]),
    "",
    "指标定义见 docs/AI_EVAL.md；原始响应、每次调用的延迟 / usage / 重试 / 错误码在同名 JSON。",
    "",
  ];
  return lines.join("\n");
}

export function compareMarkdown(
  reports: { file: string; report: RunReport }[],
) {
  const simulated = assertMergeable(reports);
  const lines = [
    `# ${simulated ? "【模拟数据】" : ""}多模型对比`,
    "",
    ...(simulated ? [SIMULATED_BANNER, ""] : []),
    `## ${tag(simulated, "模型对比")}`,
    "",
    HEADER.replace("| 范围 |", "| 模型 |"),
    ...reports.map(({ report }) => row(`${report.model}`, report.metrics)),
    "",
    `## ${tag(simulated, "版本与预算")}`,
    "",
    "| 模型 | 报告 | Prompt / validation / 用例 | Git | 重复 | 本次计入 Token | 提前停止 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...reports.map(
      ({ file, report: r }) =>
        `| ${r.model} | ${file.split(/[\\/]/).at(-1)} | ${r.promptVersion} / ${r.validationVersion} / ${r.caseVersion} | ${r.git.slice(0, 7)} | ${r.config.repeat} | ${num(r.budget.chargedThisRun)} | ${r.budget.stoppedBy ?? "否"} |`,
    ),
    "",
  ];
  const versions = new Set(
    reports.map(
      (r) =>
        `${r.report.promptVersion}/${r.report.validationVersion}/${r.report.caseVersion}`,
    ),
  );
  if (versions.size > 1)
    lines.push(
      "> 注意：各报告的 Prompt / validation / 用例版本不同，对比仅供参考。",
      "",
    );
  return lines.join("\n");
}
