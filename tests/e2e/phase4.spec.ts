import { test, expect, Page } from "@playwright/test";
const notes = { clarifications: [], warnings: [] };
const success = (data: unknown) => ({
  ok: true,
  requestId: "e2e-mock-request",
  data,
  meta: {
    provider: "qwen",
    model: "mock-fixture",
    promptVersion: "mock",
    usage: null,
    latencyMs: 0,
  },
});
async function ready(page: Page, path: string) {
  await page.goto(path);
  await expect(
    page.getByRole("button", { name: "切换演示身份" }),
  ).toBeEnabled();
}
const saved = (page: Page) =>
  page.evaluate(() => localStorage.getItem("pawmeet:state:v1"));
async function generate(page: Page, title: string, text: string) {
  await page.getByLabel(`${title}描述`).fill(text);
  await page
    .getByRole("region", { name: title })
    .getByRole("button", { name: "生成 AI 草稿", exact: true })
    .click();
  await expect(page.getByTestId("ai-draft")).toBeVisible();
}
test("mock AI 档案：生成与填入均不写入，编辑确认后持久化", async ({ page }) => {
  await page.route("**/api/ai/pet-profile", (route) =>
    route.fulfill({
      json: success({
        name: "AI年糕",
        breed: "史宾格",
        ageMonths: 24,
        size: "medium",
        city: "杭州",
        district: "滨江区",
        temperamentTags: [{ value: "活泼", evidence: "活泼" }],
        activityTags: [],
        likes: ["喜欢追球"],
        dislikes: ["不喜欢抢玩具"],
        cautions: ["有点护食"],
        ...notes,
      }),
    }),
  );
  await ready(page, "/me/pets/new");
  const before = await saved(page);
  await generate(
    page,
    "AI 宠物档案与社交信息",
    "两岁史宾格，活泼，喜欢追球，有点护食，不喜欢抢玩具",
  );
  expect(await saved(page)).toBe(before);
  await page.getByRole("button", { name: "填入表单（尚未保存）" }).click();
  await expect(page.getByLabel("宠物名字", { exact: true })).toHaveValue(
    "AI年糕",
  );
  await expect(page.getByLabel("宠物名字", { exact: true })).toHaveAttribute(
    "data-ai-filled",
    "true",
  );
  expect(await saved(page)).toBe(before);
  await page.getByLabel("宠物名字", { exact: true }).fill("主人改过的名字");
  await expect(
    page.getByLabel("宠物名字", { exact: true }),
  ).not.toHaveAttribute("data-ai-filled", "true");
  await page.getByRole("button", { name: "确认保存档案" }).click();
  await expect(page).toHaveURL("/me");
  await page.reload();
  await expect(page.getByText("主人改过的名字", { exact: true })).toBeVisible();
});
test("mock AI 流式进度：NDJSON 进度与结果被浏览器解析，失败事件可见", async ({
  page,
}) => {
  let calls = 0;
  await page.route("**/api/ai/pet-profile", (route) => {
    expect(route.request().headers()["accept"]).toContain(
      "application/x-ndjson",
    );
    const progress = JSON.stringify({
      type: "progress",
      stage: "receiving",
      attempt: 1,
      chars: 42,
    });
    const last =
      calls++ === 0
        ? {
            type: "result",
            body: success({
              name: "流式年糕",
              breed: null,
              ageMonths: null,
              size: null,
              city: null,
              district: null,
              temperamentTags: [],
              activityTags: [],
              likes: [],
              dislikes: [],
              cautions: [],
              ...notes,
            }),
          }
        : {
            type: "error",
            status: 502,
            body: {
              ok: false,
              requestId: "e2e-stream-error",
              error: {
                code: "AI_UPSTREAM_STREAM_INTERRUPTED",
                message: "Qwen流式输出中途断开，未得到完整结果",
                retryable: true,
              },
            },
          };
    return route.fulfill({
      contentType: "application/x-ndjson; charset=utf-8",
      body: `${progress}\n${JSON.stringify(last)}\n`,
    });
  });
  await ready(page, "/me/pets/new");
  const before = await saved(page);
  await generate(page, "AI 宠物档案与社交信息", "叫流式年糕的小狗");
  await expect(page.getByTestId("ai-draft")).toContainText("流式年糕");
  await page
    .getByRole("region", { name: "AI 宠物档案与社交信息" })
    .getByRole("button", { name: "生成 AI 草稿", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "AI 宠物档案与社交信息" })
      .getByRole("alert"),
  ).toContainText("AI_UPSTREAM_STREAM_INTERRUPTED");
  await expect(page.getByTestId("ai-draft")).toHaveCount(0);
  expect(await saved(page)).toBe(before);
});
test("名片改为手动复核：无需模型仍可编辑确认并持久化", async ({ page }) => {
  await ready(page, "/me");
  const id = await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("pawmeet:state:v1")!);
    return s.pets.find((p: { ownerId: string }) => p.ownerId === s.activeUserId)
      .id;
  });
  let api = 0;
  await page.route("**/api/ai/**", (route) => {
    api++;
    return route.abort();
  });
  await ready(page, `/pets/${id}/card`);
  await page.getByRole("button", { name: "编辑与确认名片" }).click();
  const before = await saved(page);
  await page.getByLabel("需要注意的习惯").fill("有点护食");
  expect(await saved(page)).toBe(before);
  await page.getByLabel("我已逐项复核，这是我对宠物的描述").check();
  await page.getByRole("button", { name: "确认保存社交名片" }).click();
  await page.reload();
  await expect(page.getByTestId("social-card")).toContainText("有点护食");
  expect(api).toBe(0);
});
test("附近保留手动筛选，重复AI入口已经合并到活动", async ({ page }) => {
  await ready(page, "/discover");
  const before = await saved(page);
  await page.getByLabel("按名称品种或区域搜索").fill("不存在的宠物名字");
  await expect(page.getByTestId("result-count")).toContainText("0");
  expect(await saved(page)).toBe(before);
  await expect(page.getByRole("button", { name: "生成 AI 草稿" })).toHaveCount(
    0,
  );
  await page.goto("/assistant");
  await expect(page).toHaveURL(/activities#companion/);
  await expect(page.getByLabel("智能约伴需求")).toBeVisible();
});
test("mock AI 互助：模糊时间保持空，地点需重新确认", async ({ page }) => {
  await ready(page, "/help/new");
  const before = await saved(page);
  const id = await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("pawmeet:state:v1")!);
    return s.pets.find((p: { ownerId: string }) => p.ownerId === s.activeUserId)
      .id;
  });
  await page.route("**/api/ai/help-intent", (route) =>
    route.fulfill({
      json: success({
        type: "walk",
        petId: id,
        title: "临时遛狗",
        details: "不能松牵引绳",
        startAt: null,
        endAt: null,
        durationMinutes: 30,
        timeText: "明天下午",
        district: null,
        locationQuery: null,
        clarifications: ["请补齐具体时间和地点"],
        warnings: [],
      }),
    }),
  );
  await generate(page, "AI 临时互助需求", "明天下午遛狗30分钟，不能松牵引绳");
  await page.getByRole("button", { name: "填入表单（尚未保存）" }).click();
  await expect(page.getByLabel("开始时间（北京时间）")).toHaveValue("");
  await expect(page.getByLabel("需求说明", { exact: true })).toHaveValue(
    "不能松牵引绳",
  );
  expect(await saved(page)).toBe(before);
  const day = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  await page.getByLabel("开始时间（北京时间）").fill(`${day}T14:00`);
  await page.getByLabel("结束时间（北京时间）").fill(`${day}T14:30`);
  await page.getByLabel("我已复核 AI 草稿中的宠物、时间与特别要求").check();
  await page.getByRole("button", { name: "确认发布求助" }).click();
  await expect(page.locator("form").getByRole("alert")).toContainText(
    "地点选择器",
  );
  expect(await saved(page)).toBe(before);
  await page.getByRole("button", { name: "文字地点", exact: true }).click();
  await page.getByLabel("文字地点名称").fill("滨江公园公共东门");
  await page.getByRole("button", { name: "确认文字地点" }).click();
  await page.getByRole("button", { name: "确认发布求助" }).click();
  await expect(page).toHaveURL("/help");
});
test("合并后的原生工具入口默认不自动请求模型", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/ai/**", (route) => {
    calls++;
    return route.abort();
  });
  await ready(page, "/assistant");
  await expect(page).toHaveURL(/activities#companion/);
  await expect(page.getByLabel("智能约伴需求")).toBeVisible();
  expect(calls).toBe(0);
  const before = await saved(page);
  await expect(
    page.getByRole("button", { name: "重新开始", exact: true }),
  ).toHaveCount(0);
  await page.locator(".companion-settings > summary").click();
  await expect(page.getByLabel("约伴参考宠物", { exact: true })).toBeVisible();
  await page.locator(".companion-settings > summary").click();
  expect(calls).toBe(0);
  expect(await saved(page)).toBe(before);
});
test("mock API 失败和身份切换：真实错误可见，旧草稿不能跨身份保存", async ({
  page,
}) => {
  await page.route("**/api/ai/pet-profile", (route) =>
    route.fulfill({
      status: 502,
      json: {
        ok: false,
        requestId: "mock-429",
        error: {
          code: "AI_UPSTREAM_HTTP_429",
          message: "Qwen模型当前繁忙",
          retryable: true,
        },
      },
    }),
  );
  await ready(page, "/me/pets/new");
  const before = await saved(page);
  await page.getByLabel("AI 宠物档案与社交信息描述").fill("一只狗");
  await page.getByRole("button", { name: "生成 AI 草稿", exact: true }).click();
  await expect(page.locator("p[role=alert]")).toContainText(
    "AI_UPSTREAM_HTTP_429",
  );
  await expect(page.getByTestId("ai-draft")).toHaveCount(0);
  expect(await saved(page)).toBe(before);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "切换演示身份" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /陈一一/ })
    .click();
  await expect(page.getByLabel("AI 宠物档案与社交信息描述")).toHaveValue("");
});
