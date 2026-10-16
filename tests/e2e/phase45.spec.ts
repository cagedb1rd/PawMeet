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
        timeText: "周六下午",
        activityType: "散步",
        placeQuery: options.failPlaces ? "失败" : "公园",
        preferences: ["最好有草坪"],
        hardRequirements: [],
        clarifications: ["请确认具体日期和起止时间"],
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
async function understand(page: Page) {
  await page.getByLabel("智能约伴需求").fill("周六下午5公里内散步，最好有草坪");
  await page.getByRole("button", { name: "理解约伴需求" }).click();
  await expect(
    page.getByRole("heading", { name: "复核约伴条件" }),
  ).toBeVisible();
}
async function confirm(page: Page, create = false) {
  await page.getByLabel("约伴开始时间").fill(`${day}T08:00`);
  await page.getByLabel("约伴结束时间").fill(`${day}T20:00`);
  await page
    .getByRole("button", {
      name: create ? "确认条件并自己组局" : "确认条件并查询已有活动",
    })
    .click();
}
test("优先已有活动：显示实际卡片/差异/名额，不自动报名，复查后才查询", async ({
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
  expect(seen).toHaveLength(0);
  await page.getByRole("button", { name: "确认条件并查询已有活动" }).click();
  await expect(
    page.getByRole("region", { name: "AI 智能约伴" }).getByRole("alert"),
  ).toContainText("请确认具体日期");
  expect(seen).toHaveLength(0);
  await confirm(page);
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
  await confirm(page);
  await expect(page.getByTestId("companion-result")).toContainText(
    "没有满足时间",
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
  await confirm(page, true);
  await expect(page.getByLabel("活动名称", { exact: true })).toBeVisible();
  expect(seen.some((x) => x.tool === "search_activities")).toBe(false);
  expect(await saved(page)).toBe(before);
});
test("扩大到5公里保留日期和偏好，仅重查当前阶段", async ({ page }) => {
  const seen = await mock(page, { radius: 3 });
  await ready(page);
  await understand(page);
  await confirm(page);
  await expect(page.getByTestId("companion-result")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "理解约伴需求" }),
  ).toBeEnabled();
  await page.getByLabel("智能约伴需求").fill("扩大到5公里");
  await page.getByRole("button", { name: "理解约伴需求" }).click();
  await expect.poll(() => seen.length).toBe(2);
  expect(seen.map((x) => x.tool)).toEqual([
    "search_activities",
    "search_activities",
  ]);
  await expect(page.getByLabel("约伴开始时间")).toHaveValue(`${day}T08:00`);
  await expect(page.getByText(/最好有草坪/).first()).toBeVisible();
});
test("地点工具故障区别于空结果，保留手动恢复", async ({ page }) => {
  await sdk(page);
  await mock(page, { create: true, failPlaces: true });
  await ready(page);
  const before = await saved(page);
  await understand(page);
  await confirm(page, true);
  await expect(
    page.getByTestId("companion-result").filter({ hasText: "search_places" }),
  ).toContainText("工具失败");
  await expect(
    page.getByTestId("companion-result").filter({ hasText: "search_places" }),
  ).not.toContainText("没有范围内候选");
  await expect(page.getByRole("link", { name: "手动发起活动" })).toBeVisible();
  expect(await saved(page)).toBe(before);
});
test("工具循环有界且取消清空旧结果", async ({ page }) => {
  const seen = await mock(page, { create: true, loop: true });
  await ready(page);
  const before = await saved(page);
  await understand(page);
  await confirm(page, true);
  await expect(page.getByText(/已达4轮模型上限/)).toBeVisible();
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
  await page.getByRole("button", { name: "理解约伴需求" }).click();
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
  await expect(page.getByRole("heading", { name: "复核约伴条件" })).toHaveCount(
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
  await page.getByRole("button", { name: "理解约伴需求" }).click();
  await request;
  await page.getByRole("button", { name: "取消查询" }).click();
  release();
  await expect(
    page.getByRole("button", { name: "理解约伴需求" }),
  ).toBeEnabled();
  await expect(page.getByRole("heading", { name: "复核约伴条件" })).toHaveCount(
    0,
  );
  expect(await saved(page)).toBe(before);
});
