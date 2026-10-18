import { test, expect, Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { emptyMatch } from "../../src/lib/ai/contracts";
const day = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
const success = (data: unknown) => ({
  ok: true,
  requestId: "phase45-offline",
  data,
  meta: {
    provider: "qwen",
    model: "mock-fixture",
    promptVersion: "mock",
    latencyMs: 0,
    usage: null,
  },
});
const call = (name: string, args: unknown = {}) => ({
  id: name,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const saved = (page: Page) =>
  page.evaluate(() => localStorage.getItem("pawmeet:state:v1"));
async function ready(page: Page) {
  await page.goto("/activities");
  await expect(
    page.getByRole("button", { name: "切换演示身份" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "AI 智能约伴", exact: true }).click();
}
async function sdk(page: Page) {
  await page.route("**/api/maps/config", (r) =>
    r.fulfill({ json: { key: "offline-fixture" } }),
  );
  const body = await readFile("tests/e2e/fixtures/amap-sdk.js", "utf8");
  await page.route("https://webapi.amap.com/maps?**", (r) =>
    r.fulfill({ contentType: "application/javascript", body }),
  );
}
async function mock(
  page: Page,
  options: {
    create?: boolean;
    radius?: 1 | 3 | 5 | 10;
    failPlaces?: boolean;
    loop?: boolean;
    timeText?: string | null;
  } = {},
) {
  const seen: { stage: string; tool: string; result?: unknown }[] = [];
  let mode = "search",
    round = 0,
    ids: string[] = [];
  await page.route("**/api/ai/companion-intent", (r) =>
    r.fulfill({
      json: success({
        mode: options.create ? "create" : "search",
        match: { ...emptyMatch, radiusKm: options.radius ?? 5 },
        startAt: null,
        endAt: null,
        timeText:
          options.timeText === undefined
            ? `${day} 下午或晚上`
            : options.timeText,
        activityType: "散步",
        placeQuery: options.failPlaces ? "失败" : "公园",
        preferences: ["最好有草坪"],
        hardRequirements: [],
        clarifications: options.timeText === null ? ["想哪天一起玩？"] : [],
        warnings: [],
      }),
    }),
  );
  await page.route("**/api/ai/assistant", async (r) => {
    const body = r.request().postDataJSON();
    if (body.workflow) {
      mode = body.workflow.stage;
      round = 0;
    }
    if (body.results)
      for (const item of body.results) {
        seen.push({ stage: mode, tool: item.toolCallId, result: item.result });
        if (item.result.kind === "pets")
          ids = item.result.rows.slice(0, 1).map((p: { id: string }) => p.id);
      }
    let tools: ReturnType<typeof call>[] = [];
    if (options.loop) tools = [call("search_pets")];
    else if (mode === "search") {
      if (!body.results) tools = [call("search_activities")];
    } else if (round === 0)
      tools = [
        call("search_pets"),
        call("search_places", { query: options.failPlaces ? "失败" : "公园" }),
      ];
    else if (round === 1 && !options.failPlaces)
      tools = [call("check_compatibility", { petIds: ids })];
    else if (round === 2 && !options.failPlaces)
      tools = [
        call("create_activity_draft", {
          title: "草稿",
          description: "",
          petIds: ids,
          placeIndex: 0,
        }),
      ];
    round++;
    await r.fulfill({
      json: success({
        continuation: `mock-${round}`,
        toolCalls: tools,
        answer: tools.length
          ? null
          : {
              summary: options.failPlaces
                ? "工具执行失败，请稍后重试。"
                : "已查询，请查看实际结果卡片。",
              references: [],
            },
      }),
    });
  });
  return seen;
}
const timeline = (page: Page) => page.getByTestId("companion-timeline");
const step = (page: Page, kind: string) =>
  timeline(page).locator(`[data-testid="timeline-step"][data-kind="${kind}"]`);
async function understand(page: Page) {
  const trigger = page.getByRole("button", {
    name: "AI 智能约伴",
    exact: true,
  });
  if ((await trigger.getAttribute("aria-expanded")) === "false")
    await trigger.click();
  await page
    .getByLabel("智能约伴需求")
    .fill(`${day}下午或晚上5公里内散步，最好有草坪`);
  await page.getByRole("button", { name: "帮我找活动" }).click();
  await expect(
    page.getByRole("heading", { name: "你的约伴计划" }),
  ).toBeVisible();
}
async function finished(page: Page, create = false) {
  if (create)
    await expect(page.getByLabel("活动名称", { exact: true })).toBeVisible();
  else await expect(page.getByTestId("companion-result")).toBeVisible();
}

test("优先已有活动：显示实际卡片/差异/名额，不自动报名，粗略时段自动查询", async ({
  page,
}) => {
  const seen = await mock(page);
  await ready(page);
  await page.evaluate((day) => {
    const s = JSON.parse(localStorage.getItem("pawmeet:state:v1")!);
    s.activities[0].title = "浏览器已有散步";
    s.activities[0].description = "散步";
    s.activities[0].startAt = `${day}T06:00:00.000Z`;
    s.activities[0].endAt = `${day}T07:00:00.000Z`;
    s.activities[0].capacity = 12;
    s.activities[0].place.location = {
      lng: 120.189,
      lat: 30.174,
      crs: "GCJ02",
    };
    localStorage.setItem("pawmeet:state:v1", JSON.stringify(s));
  }, day);
  await page.reload();
  const before = await saved(page);
  await understand(page);
  expect(seen.map((x) => x.tool)).toEqual(["search_activities"]);
  await expect(
    page
      .getByRole("region", { name: "AI 智能约伴" })
      .locator('input[type="datetime-local"]'),
  ).toHaveCount(0);
  await finished(page);
  await expect(
    page
      .getByTestId("companion-result")
      .getByRole("link", { name: /浏览器已有散步/ }),
  ).toBeVisible();
  await expect(page.getByTestId("companion-result")).toContainText("剩余");
  await expect(page.getByTestId("companion-result")).toContainText("未核实");
  expect(seen.map((x) => x.tool)).toEqual(["search_activities"]);
  expect(await saved(page)).toBe(before);
  await page.getByTestId("companion-result").getByRole("link").click();
  await expect(page).toHaveURL(/activities\/activity-/);
  expect(await saved(page)).toBe(before);
});
test("无活动转组局：原生多工具、规则比较、可编辑草稿及主人确认保存", async ({
  page,
}) => {
  await sdk(page);
  const seen = await mock(page);
  await ready(page);
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("pawmeet:state:v1")!);
    s.activities.forEach((a: { status: string }) => (a.status = "cancelled"));
    localStorage.setItem("pawmeet:state:v1", JSON.stringify(s));
  });
  await page.reload();
  const before = await saved(page);
  await understand(page);
  await finished(page);
  await expect(page.getByTestId("companion-result")).toContainText(
    "暂时没有合适的活动",
  );
  await page.getByRole("button", { name: "自己组局", exact: true }).click();
  await expect(page.getByLabel("活动名称", { exact: true })).toHaveValue(
    "待确认约伴活动",
  );
  expect(seen.map((x) => x.tool)).toEqual([
    "search_activities",
    "search_pets",
    "search_places",
    "check_compatibility",
    "create_activity_draft",
  ]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/phase45-companion-${test.info().project.name}.png`,
    fullPage: true,
  });
  expect(JSON.stringify(seen)).not.toContain('"photo"');
  expect(await saved(page)).toBe(before);
  await page.getByLabel("活动名称", { exact: true }).fill("主人确认的散步");
  await expect(page.getByLabel("开始时间", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("结束时间", { exact: true })).toHaveValue("");
  await page.getByLabel("开始时间", { exact: true }).fill(`${day}T14:00`);
  await page.getByLabel("结束时间", { exact: true }).fill(`${day}T15:00`);
  await page.getByRole("button", { name: "确认创建活动", exact: true }).click();
  await page.reload();
  await expect(
    page.locator(".activity-card").filter({ hasText: "主人确认的散步" }),
  ).toBeVisible();
  expect(await saved(page)).not.toBe(before);
});
test("明确自己创建：跳过活动查询，未确认不写入", async ({ page }) => {
  await sdk(page);
  const seen = await mock(page, { create: true });
  await ready(page);
  const before = await saved(page);
  await understand(page);
  await finished(page, true);
  await expect(page.getByLabel("活动名称", { exact: true })).toBeVisible();
  expect(seen.some((x) => x.tool === "search_activities")).toBe(false);
  expect(await saved(page)).toBe(before);
});
test("扩大到5公里保留日期和偏好，仅重查当前阶段", async ({ page }) => {
  const seen = await mock(page, { radius: 3 });
  await ready(page);
  await understand(page);
  await finished(page);
  await expect(page.getByTestId("companion-result")).toBeVisible();
  await expect(page.getByRole("button", { name: "帮我找活动" })).toBeEnabled();
  await page.getByLabel("智能约伴需求").fill("扩大到5公里");
  await page.getByRole("button", { name: "帮我找活动" }).click();
  await expect.poll(() => seen.length).toBe(2);
  expect(seen.map((x) => x.tool)).toEqual([
    "search_activities",
    "search_activities",
  ]);
  await expect(page.getByLabel("约伴日期")).toHaveValue(day);
  await expect(page.getByText(/最好有草坪/).first()).toBeVisible();
});
test("地点工具故障区别于空结果，保留手动恢复", async ({ page }) => {
  await sdk(page);
  await mock(page, { create: true, failPlaces: true });
  await ready(page);
  const before = await saved(page);
  await understand(page);
  await expect(
    page.locator('[data-testid="companion-result"][data-tool="search_places"]'),
  ).toContainText("查询失败");
  await expect(
    page.locator('[data-testid="companion-result"][data-tool="search_places"]'),
  ).not.toContainText("没找到合适地点");
  await expect(page.getByRole("link", { name: "手动发起活动" })).toBeVisible();
  expect(await saved(page)).toBe(before);
});
test("工具循环有界且取消清空旧结果", async ({ page }) => {
  const seen = await mock(page, { create: true, loop: true });
  await ready(page);
  const before = await saved(page);
  await understand(page);
  await expect(
    page.getByRole("region", { name: "AI 智能约伴" }).getByRole("alert"),
  ).toContainText("已达4轮模型上限");
  await expect(step(page, "workflow")).toHaveAttribute("data-status", "error");
  expect(seen.length).toBe(3);
  expect(await saved(page)).toBe(before);
  await page.getByRole("button", { name: "重新开始", exact: true }).click();
  await expect(page.getByTestId("companion-result")).toHaveCount(0);
});
test("API 限流显示错误和请求号，手动创建仍可达", async ({ page }) => {
  await page.route("**/api/ai/**", (r) =>
    r.fulfill({
      status: 429,
      json: {
        ok: false,
        requestId: "mock-limited",
        error: { code: "AI_QUOTA", message: "额度已用完", retryable: false },
      },
    }),
  );
  await ready(page);
  await page.getByLabel("智能约伴需求").fill("散步");
  await page.getByRole("button", { name: "帮我找活动" }).click();
  await expect(
    page.getByRole("region", { name: "AI 智能约伴" }).getByRole("alert"),
  ).toContainText("mock-limited");
  await page.getByRole("link", { name: "手动发起活动" }).click();
  await expect(page.getByLabel("活动名称", { exact: true })).toBeVisible();
});
test("身份切换清除约伴上下文和旧草稿", async ({ page }) => {
  await mock(page);
  await ready(page);
  await understand(page);
  await page.getByRole("button", { name: "切换演示身份" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /陈一一/ })
    .click();
  await expect(page.getByRole("heading", { name: "你的约伴计划" })).toHaveCount(
    0,
  );
  await expect(page.getByLabel("智能约伴需求")).toHaveValue("");
});

test("取消在途需求提取后旧响应不会重现", async ({ page }) => {
  let release: () => void = () => {};
  await page.route("**/api/ai/companion-intent", async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route
      .fulfill({
        json: success({
          mode: "search",
          match: emptyMatch,
          startAt: null,
          endAt: null,
          timeText: null,
          activityType: null,
          placeQuery: null,
          preferences: [],
          hardRequirements: [],
          clarifications: [],
          warnings: [],
        }),
      })
      .catch(() => {});
  });
  await ready(page);
  const before = await saved(page);
  await page.getByLabel("智能约伴需求").fill("散步");
  const request = page.waitForRequest("**/api/ai/companion-intent");
  await page.getByRole("button", { name: "帮我找活动" }).click();
  await request;
  await page.getByRole("button", { name: "取消查询" }).click();
  release();
  await expect(page.getByRole("button", { name: "帮我找活动" })).toBeEnabled();
  await expect(page.getByRole("heading", { name: "你的约伴计划" })).toHaveCount(
    0,
  );
  expect(await saved(page)).toBe(before);
});

test("缺少日期只问日期与时段，不要求分钟", async ({ page }) => {
  const seen = await mock(page, { timeText: null });
  await ready(page);
  await page
    .getByLabel("智能约伴需求")
    .fill("想找好相处的狗狗一起玩，时间还没定");
  await page.getByRole("button", { name: "帮我找活动" }).click();
  await expect(page.getByLabel("约伴日期")).toBeVisible();
  expect(seen).toHaveLength(0);
  await page.getByLabel("约伴日期").fill(day);
  await page.getByLabel("下午", { exact: true }).check();
  await page.getByRole("button", { name: "按这个时段找活动" }).click();
  await finished(page);
  expect(seen.some((x) => x.tool === "search_activities")).toBe(true);
  await expect(page.locator('input[type="datetime-local"]')).toHaveCount(0);
  await expect(page.getByTestId("availability-label")).toContainText(
    "查询范围",
  );
});

test("工具时间线按实际顺序展示状态、耗时与摘要，不写入存储", async ({
  page,
}) => {
  await sdk(page);
  const seen = await mock(page);
  await ready(page);
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("pawmeet:state:v1")!);
    s.activities.forEach((a: { status: string }) => (a.status = "cancelled"));
    localStorage.setItem("pawmeet:state:v1", JSON.stringify(s));
  });
  await page.reload();
  const before = await saved(page);
  await understand(page);
  await finished(page);
  await expect(step(page, "search_activities")).toHaveAttribute(
    "data-status",
    "empty",
  );
  await expect(step(page, "search_activities")).toContainText(
    "没有符合条件的活动",
  );
  await page.getByRole("button", { name: "自己组局", exact: true }).click();
  await expect(page.getByLabel("活动名称", { exact: true })).toBeVisible();
  const kinds = await timeline(page)
    .getByTestId("timeline-step")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
  // Only calls the mock model actually requested, in order; finished model rounds stay in the details.
  expect(kinds).toEqual([
    "understand",
    "search_activities",
    "search_pets",
    "search_places",
    "check_compatibility",
    "create_activity_draft",
  ]);
  expect(seen.map((x) => x.tool)).toEqual(kinds.slice(1));
  await expect(step(page, "search_pets")).toContainText("并行");
  await expect(step(page, "search_places")).toContainText("并行");
  await expect(step(page, "create_activity_draft")).toContainText(
    "草稿已生成，待主人确认",
  );
  await expect(timeline(page).getByText(/秒/).first()).toBeVisible();
  await expect(timeline(page).locator('[data-status="running"]')).toHaveCount(
    0,
  );
  await timeline(page)
    .getByText(/查看完整过程/)
    .click();
  await expect(
    timeline(page).locator('[data-testid="timeline-detail"][data-kind="plan"]'),
  ).toHaveCount(6);
  await expect(timeline(page)).toContainText(
    "请求 2 个工具：查询宠友、查询地点",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await timeline(page).scrollIntoViewIfNeeded();
  await timeline(page).screenshot({
    path: `test-results/phase45-timeline-${test.info().project.name}.png`,
  });
  expect(await saved(page)).toBe(before);
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage })),
  ).not.toContain("timeline");
});
test("时间线区分工具出错、空结果与流程终止", async ({ page }) => {
  await sdk(page);
  await mock(page, { create: true, failPlaces: true });
  await ready(page);
  await understand(page);
  await expect(step(page, "search_places")).toHaveAttribute(
    "data-status",
    "error",
  );
  await expect(step(page, "search_places")).toContainText("失败");
  await expect(step(page, "search_places")).not.toContainText("没有合适地点");
  await expect(step(page, "search_pets")).not.toHaveAttribute(
    "data-status",
    "error",
  );
  await expect(step(page, "workflow")).toHaveAttribute("data-status", "error");
  await expect(step(page, "workflow")).toContainText("工具执行失败尚未解决");
});
test("取消查询把进行中的步骤标为已取消，迟到响应不会复活", async ({ page }) => {
  await mock(page);
  let release: () => void = () => {};
  await page.route("**/api/ai/assistant", async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route
      .fulfill({
        json: success({
          continuation: "late",
          toolCalls: [call("search_activities")],
          answer: null,
        }),
      })
      .catch(() => {});
  });
  await ready(page);
  const before = await saved(page);
  const request = page.waitForRequest("**/api/ai/assistant");
  await page
    .getByLabel("智能约伴需求")
    .fill(`${day}下午或晚上5公里内散步，最好有草坪`);
  await page.getByRole("button", { name: "帮我找活动" }).click();
  await request;
  await expect(step(page, "plan")).toHaveAttribute("data-status", "running");
  await expect(step(page, "understand")).toHaveAttribute("data-status", "done");
  await page.getByRole("button", { name: "取消查询" }).click();
  await expect(step(page, "plan")).toHaveAttribute("data-status", "cancelled");
  await expect(step(page, "plan")).toContainText("已取消");
  release();
  await page.waitForTimeout(300);
  await expect(step(page, "plan")).toHaveAttribute("data-status", "cancelled");
  await expect(step(page, "search_activities")).toHaveCount(0);
  await expect(page.getByTestId("companion-result")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "帮我找活动" })).toBeEnabled();
  expect(await saved(page)).toBe(before);
});
