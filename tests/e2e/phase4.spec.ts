import { test, expect, Page } from "@playwright/test";
import { emptyMatch } from "../../src/lib/ai/contracts";
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
  expect(await saved(page)).toBe(before);
  await page.getByLabel("宠物名字", { exact: true }).fill("主人改过的名字");
  await page.getByRole("button", { name: "确认保存档案" }).click();
  await expect(page).toHaveURL("/me");
  await page.reload();
  await expect(page.getByText("主人改过的名字", { exact: true })).toBeVisible();
});
test("mock AI 名片：丢弃不写入，确认沿用原命令", async ({ page }) => {
  await page.route("**/api/ai/social-card", (route) =>
    route.fulfill({
      json: success({
        traits: ["活泼"],
        likes: ["并排散步"],
        dislikes: ["不喜欢抢玩具"],
        cautions: ["有点护食"],
        meetingAdvice: "先保持牵引",
        ...notes,
      }),
    }),
  );
  await ready(page, "/me");
  const id = await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("pawmeet:state:v1")!);
    return s.pets.find((p: { ownerId: string }) => p.ownerId === s.activeUserId)
      .id;
  });
  await ready(page, `/pets/${id}/card`);
  await page.getByRole("button", { name: "编辑与确认名片" }).click();
  const before = await saved(page);
  await generate(page, "AI 狗狗社交名片", "活泼，有点护食，不喜欢抢玩具");
  await page.getByRole("button", { name: "丢弃草稿" }).click();
  expect(await saved(page)).toBe(before);
  await generate(page, "AI 狗狗社交名片", "活泼，有点护食，不喜欢抢玩具");
  await page.getByRole("button", { name: "填入表单（尚未保存）" }).click();
  await expect(page.getByLabel("需要注意的习惯")).toHaveValue("有点护食");
  await page.getByLabel("我已逐项复核，这是我对宠物的描述").check();
  await page.getByRole("button", { name: "确认保存社交名片" }).click();
  await expect(page.getByTestId("social-card")).toContainText("有点护食");
});
test("mock AI 推荐：本地筛选和偏好分、无结果不编造", async ({ page }) => {
  await page.route("**/api/ai/match-intent", (route) =>
    route.fulfill({
      json: success({
        ...emptyMatch,
        radiusKm: 5,
        temperaments: ["温和"],
        activities: ["散步"],
        sort: "match",
      }),
    }),
  );
  await ready(page, "/discover");
  await page.locator(".discovery-ai summary").click();
  const before = await saved(page);
  await generate(page, "AI 智能推荐宠友", "找5公里内温和喜欢散步的狗狗");
  await page.getByRole("button", { name: "应用条件并查询" }).click();
  await expect(page.getByTestId("result-count")).toContainText("偏好匹配优先");
  await expect(
    page.getByText("偏好匹配分：", { exact: false }).first(),
  ).toBeVisible();
  expect(await saved(page)).toBe(before);
  await page.screenshot({
    path: `test-results/phase4-recommendation-${test.info().project.name}.png`,
    fullPage: true,
  });
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
  await expect(page.locator("p[role=alert]")).toContainText("地点选择器");
  expect(await saved(page)).toBe(before);
  await page.getByRole("button", { name: "文字地点", exact: true }).click();
  await page.getByLabel("文字地点名称").fill("滨江公园公共东门");
  await page.getByRole("button", { name: "确认文字地点" }).click();
  await page.getByRole("button", { name: "确认发布求助" }).click();
  await expect(page).toHaveURL("/help");
});
test("mock native 工具循环：多工具查询浏览器实际数据并回传，不写业务", async ({
  page,
}) => {
  await ready(page, "/assistant");
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("pawmeet:state:v1")!);
    const p = s.pets.find(
      (p: { ownerId: string }) => p.ownerId !== s.activeUserId,
    );
    p.breed = "本地专属品种";
    p.name = "浏览器实有狗";
    localStorage.setItem("pawmeet:state:v1", JSON.stringify(s));
  });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "切换演示身份" }),
  ).toBeEnabled();
  const before = await saved(page);
  let returned: unknown;
  await page.route("**/api/ai/assistant", async (route) => {
    const body = route.request().postDataJSON();
    if (!body.results)
      await route.fulfill({
        json: success({
          continuation: "mock-signed-token",
          toolCalls: [
            {
              id: "pets",
              type: "function",
              function: {
                name: "search_pets",
                arguments: JSON.stringify({
                  ...emptyMatch,
                  radiusKm: 10,
                  breeds: ["本地专属品种"],
                }),
              },
            },
            {
              id: "activities",
              type: "function",
              function: {
                name: "search_activities",
                arguments: JSON.stringify({
                  district: null,
                  radiusKm: 5,
                  startAfter: null,
                  startBefore: null,
                }),
              },
            },
          ],
          answer: null,
        }),
      });
    else {
      returned = body.results;
      await route.fulfill({
        json: success({
          continuation: "mock-final-token",
          toolCalls: [],
          answer: { summary: "已查询，请查看实际结果卡片。", references: [] },
        }),
      });
    }
  });
  await page.getByLabel("AI 助手需求").fill("找本地专属品种宠友和附近活动");
  await page.getByRole("button", { name: "发送给 AI 助手" }).click();
  await expect(page.getByTestId("tool-result")).toHaveCount(2);
  await expect(page.getByText("浏览器实有狗", { exact: true })).toBeVisible();
  await expect(
    page.getByText("已查询，请查看实际结果卡片。", { exact: false }),
  ).toBeVisible();
  expect(JSON.stringify(returned)).toContain("浏览器实有狗");
  expect(JSON.stringify(returned)).not.toContain("photo");
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
