import type { ToolResult } from "./contracts";

/**
 * UI-only record of what the companion workflow actually did, in order.
 * Never persisted; holds labels and short program-written summaries, never model reasoning.
 */
export type StepStatus = "running" | "done" | "empty" | "error" | "cancelled";
export type StepKind =
  | "understand"
  | "plan"
  | "workflow"
  | "search_activities"
  | "search_pets"
  | "search_places"
  | "check_compatibility"
  | "create_activity_draft"
  | "unknown_tool";
export type TimelineStep = {
  id: string;
  kind: StepKind;
  label: string;
  /** Model round the step belongs to; tools sharing a round ran in parallel. */
  round: number | null;
  status: StepStatus;
  startedAt: number;
  endedAt: number | null;
  summary: string;
};
export const TIMELINE_LIMIT = 30;
const labels: Record<StepKind, string> = {
  understand: "理解需求",
  plan: "模型规划",
  workflow: "流程结束",
  search_activities: "查询活动",
  search_pets: "查询宠友",
  search_places: "查询地点",
  check_compatibility: "规则比较",
  create_activity_draft: "生成草稿",
  unknown_tool: "未知工具",
};
export const statusLabels: Record<StepStatus, string> = {
  running: "进行中",
  done: "完成",
  empty: "空结果",
  error: "出错",
  cancelled: "已取消",
};
export function toolKind(name: string): StepKind {
  return Object.hasOwn(labels, name) &&
    !["understand", "plan", "workflow", "unknown_tool"].includes(name)
    ? (name as StepKind)
    : "unknown_tool";
}
export function startStep(
  steps: TimelineStep[],
  step: { id: string; kind: StepKind; round?: number | null },
  now: number,
): TimelineStep[] {
  return [
    ...steps,
    {
      id: step.id,
      kind: step.kind,
      label: labels[step.kind],
      round: step.round ?? null,
      status: "running" as const,
      startedAt: now,
      endedAt: null,
      summary: "",
    },
  ].slice(-TIMELINE_LIMIT);
}
export function finishStep(
  steps: TimelineStep[],
  id: string,
  outcome: { status: Exclude<StepStatus, "running">; summary: string },
  now: number,
): TimelineStep[] {
  // Only a still-running step changes; a cancelled step stays cancelled when a late result arrives.
  return steps.map((s) =>
    s.id === id && s.status === "running"
      ? {
          ...s,
          ...outcome,
          summary: outcome.summary.slice(0, 80),
          endedAt: now,
        }
      : s,
  );
}
export function cancelRunning(
  steps: TimelineStep[],
  now: number,
): TimelineStep[] {
  return steps.map((s) =>
    s.status === "running"
      ? {
          ...s,
          status: "cancelled",
          summary: "已取消，未使用该结果",
          endedAt: now,
        }
      : s,
  );
}
/** Marks still-running steps as failed, or records a workflow-level stop when none is running. */
export function failWorkflow(
  steps: TimelineStep[],
  id: string,
  message: string,
  now: number,
): TimelineStep[] {
  if (steps.some((s) => s.status === "running"))
    return steps.map((s) =>
      s.status === "running"
        ? { ...s, status: "error", summary: message.slice(0, 80), endedAt: now }
        : s,
    );
  return finishStep(
    startStep(steps, { id, kind: "workflow" }, now),
    id,
    { status: "error", summary: message },
    now,
  );
}
/** Error, empty and found are kept distinct, matching the result cards. */
export function summarizeTool(result: ToolResult): {
  status: "done" | "empty" | "error";
  summary: string;
} {
  switch (result.kind) {
    case "error":
      return { status: "error", summary: `失败：${result.message}` };
    case "activities":
      return result.rows.length
        ? { status: "done", summary: `找到 ${result.rows.length} 个活动` }
        : { status: "empty", summary: "没有符合条件的活动" };
    case "pets":
      return result.rows.length
        ? { status: "done", summary: `找到 ${result.rows.length} 位宠友` }
        : { status: "empty", summary: "没有匹配的宠友" };
    case "places":
      return result.rows.length
        ? { status: "done", summary: `找到 ${result.rows.length} 个地点` }
        : { status: "empty", summary: "范围内没有合适地点" };
    case "compatibility": {
      if (!result.rows.length)
        return { status: "empty", summary: "没有可比较的宠友" };
      const conflicts = result.rows.reduce((n, r) => n + r.conflicts.length, 0);
      return {
        status: "done",
        summary: `比较 ${result.rows.length} 位宠友，${conflicts ? `发现 ${conflicts} 处偏好冲突` : "未发现明显冲突"}`,
      };
    }
    case "activity-draft":
      return { status: "done", summary: "草稿已生成，待主人确认" };
    case "help-draft":
      return { status: "done", summary: "互助草稿已生成" };
  }
}
export function summarizePlan(toolNames: string[]) {
  return toolNames.length
    ? `请求 ${toolNames.length} 个工具：${toolNames.map((n) => labels[toolKind(n)]).join("、")}`
    : "不再调用工具";
}
export function formatDuration(step: TimelineStep) {
  if (step.endedAt === null) return "";
  const ms = Math.max(0, step.endedAt - step.startedAt);
  return ms < 100 ? "<0.1 秒" : `${(ms / 1000).toFixed(1)} 秒`;
}
/** Compact view keeps user-meaningful steps; model rounds show only while running. */
export function compactSteps(steps: TimelineStep[]) {
  return steps.filter((s) => s.kind !== "plan" || s.status !== "done");
}
/** Tools of the same round with more than one call ran in parallel. */
export function isParallel(steps: TimelineStep[], step: TimelineStep) {
  return (
    step.round !== null &&
    step.kind !== "plan" &&
    steps.filter((s) => s.round === step.round && s.kind !== "plan").length > 1
  );
}
