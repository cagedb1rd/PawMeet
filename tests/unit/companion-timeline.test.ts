import { describe, expect, it } from "vitest";
import {
  TIMELINE_LIMIT,
  TimelineStep,
  cancelRunning,
  compactSteps,
  failWorkflow,
  finishStep,
  formatDuration,
  isParallel,
  startStep,
  summarizePlan,
  summarizeTool,
  toolKind,
} from "@/lib/ai/timeline";

describe("tool result summaries keep error, empty and found distinct", () => {
  it.each([
    [{ kind: "activities", rows: [] }, "empty", "没有符合条件的活动"],
    [{ kind: "pets", rows: [] }, "empty", "没有匹配的宠友"],
    [{ kind: "places", rows: [] }, "empty", "范围内没有合适地点"],
    [{ kind: "compatibility", rows: [] }, "empty", "没有可比较的宠友"],
    [
      { kind: "error", code: "TOOL_FAILED", message: "地图服务不可用" },
      "error",
      "失败：地图服务不可用",
    ],
  ] as const)("%j → %s", (result, status, summary) => {
    expect(summarizeTool(result as never)).toEqual({ status, summary });
  });
  it("counts actual rows", () => {
    const row = {
      id: "a",
      title: "t",
      district: "d",
      startAt: "2026-10-24T06:00:00Z",
      endAt: "2026-10-24T07:00:00Z",
      distanceM: 1,
      remaining: 1,
      reasons: [],
      differences: [],
    };
    expect(
      summarizeTool({
        kind: "activities",
        rows: [row, { ...row, id: "b" }, { ...row, id: "c" }],
      } as never),
    ).toEqual({ status: "done", summary: "找到 3 个活动" });
    expect(
      summarizeTool({
        kind: "compatibility",
        rows: [
          { id: "p1", conflicts: ["x"], advice: [], incomplete: false },
          { id: "p2", conflicts: [], advice: [], incomplete: false },
        ],
      }),
    ).toEqual({ status: "done", summary: "比较 2 位宠友，发现 1 处偏好冲突" });
  });
  it("names unknown tools without trusting the provider label", () => {
    expect(toolKind("delete_everything")).toBe("unknown_tool");
    expect(toolKind("plan")).toBe("unknown_tool");
    expect(summarizePlan(["search_pets", "search_places"])).toBe(
      "请求 2 个工具：查询宠友、查询地点",
    );
    expect(summarizePlan([])).toBe("不再调用工具");
  });
});

describe("timeline state transitions", () => {
  const base = () => {
    let t: TimelineStep[] = [];
    t = startStep(t, { id: "u", kind: "understand" }, 0);
    t = finishStep(t, "u", { status: "done", summary: "已提取" }, 50);
    t = startStep(t, { id: "p1", kind: "plan", round: 1 }, 60);
    t = finishStep(t, "p1", { status: "done", summary: "请求 2 个工具" }, 1260);
    t = startStep(t, { id: "a", kind: "search_pets", round: 1 }, 1300);
    t = startStep(t, { id: "b", kind: "search_places", round: 1 }, 1300);
    return t;
  };
  it("keeps real order, labels and durations", () => {
    const t = finishStep(
      base(),
      "a",
      { status: "done", summary: "找到 2 位宠友" },
      1550,
    );
    expect(t.map((s) => s.label)).toEqual([
      "理解需求",
      "模型规划",
      "查询宠友",
      "查询地点",
    ]);
    expect(formatDuration(t[0])).toBe("<0.1 秒");
    expect(formatDuration(t[1])).toBe("1.2 秒");
    expect(formatDuration(t[2])).toBe("0.3 秒");
    expect(formatDuration(t[3])).toBe("");
    expect(t[3].status).toBe("running");
  });
  it("parallel tools share a round; model rounds are not tools", () => {
    const t = base();
    expect(isParallel(t, t[2])).toBe(true);
    expect(isParallel(t, t[1])).toBe(false);
    expect(isParallel(t, t[0])).toBe(false);
  });
  it("compact view hides finished model rounds but shows a running one", () => {
    const t = base();
    expect(compactSteps(t).map((s) => s.id)).toEqual(["u", "a", "b"]);
    const waiting = startStep(t, { id: "p2", kind: "plan", round: 2 }, 2000);
    expect(compactSteps(waiting).map((s) => s.id)).toContain("p2");
  });
  it("cancel marks only running steps; a late result cannot revive them", () => {
    let t = cancelRunning(base(), 1400);
    expect(t.map((s) => s.status)).toEqual([
      "done",
      "done",
      "cancelled",
      "cancelled",
    ]);
    t = finishStep(t, "a", { status: "done", summary: "late" }, 1500);
    expect(t[2].status).toBe("cancelled");
    expect(t[2].summary).not.toBe("late");
  });
  it("workflow failure marks the running step, or appends one stop step", () => {
    const failed = failWorkflow(base(), "w1", "额度已用完", 1400);
    expect(failed.filter((s) => s.status === "error").map((s) => s.id)).toEqual(
      ["a", "b"],
    );
    expect(failed).toHaveLength(4);
    const settled = finishStep(
      finishStep(base(), "a", { status: "empty", summary: "x" }, 1400),
      "b",
      { status: "done", summary: "y" },
      1400,
    );
    const stopped = failWorkflow(settled, "w1", "已达4轮模型上限", 1500);
    expect(stopped.at(-1)).toMatchObject({
      kind: "workflow",
      status: "error",
      summary: "已达4轮模型上限",
    });
    expect(stopped.slice(0, 4).map((s) => s.status)).toEqual([
      "done",
      "done",
      "empty",
      "done",
    ]);
  });
  it("summaries are clipped and the list is bounded", () => {
    let t: TimelineStep[] = [];
    for (let n = 0; n < TIMELINE_LIMIT + 5; n++)
      t = startStep(t, { id: `s${n}`, kind: "search_pets" }, n);
    expect(t).toHaveLength(TIMELINE_LIMIT);
    expect(t[0].id).toBe("s5");
    t = finishStep(t, "s5", { status: "error", summary: "错".repeat(200) }, 99);
    expect(t[0].summary.length).toBe(80);
  });
});
