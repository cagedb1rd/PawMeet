import { test, expect } from "@playwright/test";
import { comparisonEvidence } from "../../src/domain/matching";
import type { DemoState } from "../../src/domain/schemas";
test("真实Qwen：页面生成、主人编辑确认和刷新", async ({ page }) => {
  await page.goto("/me/pets/new");
  await expect(
    page.getByRole("button", { name: "切换演示身份" }),
  ).toBeEnabled();
  const before = await page.evaluate(() =>
    localStorage.getItem("pawmeet:state:v1"),
  );
  await page
    .getByLabel("AI 宠物档案与社交信息描述")
    .fill(
      "狗狗叫泡泡，两岁史宾格，中型犬，住杭州滨江区，温和，喜欢散步，不喜欢抢玩具。",
    );
  await page.getByRole("button", { name: "生成 AI 草稿", exact: true }).click();
  await expect(page.getByTestId("ai-draft")).toBeVisible({ timeout: 46000 });
  expect(
    await page.evaluate(() => localStorage.getItem("pawmeet:state:v1")),
  ).toBe(before);
  await page.getByRole("button", { name: "填入表单（尚未保存）" }).click();
  await expect(page.getByLabel("宠物名字", { exact: true })).toHaveValue(
    "泡泡",
  );
  await page.getByLabel("宠物名字", { exact: true }).fill("主人确认的泡泡");
  await page.getByRole("button", { name: "确认保存档案" }).click();
  await expect(page).toHaveURL("/me");
  await page.reload();
  await expect(page.getByText("主人确认的泡泡", { exact: true })).toBeVisible();
  await page.screenshot({
    path: ".local/ai-live/profile-confirmed.png",
    fullPage: true,
  });
});
test("真实Qwen原生多工具：本地查询、工具回传和最终回答", async ({ page }) => {
  await page.goto("/assistant");
  await expect(
    page.getByRole("button", { name: "切换演示身份" }),
  ).toBeEnabled();
  await page
    .getByLabel("AI 助手需求")
    .fill(
      "找5公里内性格温和的狗狗，也查找滨江区已有活动。未提到的条件不要添加。",
    );
  await page.getByRole("button", { name: "发送给 AI 助手" }).click();
  await expect(
    page.getByTestId("tool-result").filter({ hasText: "search_pets" }).first(),
  ).toBeVisible({ timeout: 90000 });
  await expect(
    page
      .getByTestId("tool-result")
      .filter({ hasText: "search_activities" })
      .first(),
  ).toBeVisible({ timeout: 90000 });
  await expect(page.getByLabel("AI 助手需求")).toBeEnabled({ timeout: 90000 });
  await expect(page.locator("p[role=alert]")).toHaveCount(0);
  await expect(
    page.getByText("已查询，请查看实际结果卡片。", { exact: false }),
  ).toBeVisible();
  await page.screenshot({
    path: ".local/ai-live/native-tools.png",
    fullPage: true,
  });
});

test("真实Qwen互助工具和后续对话：草稿可编辑且未发布", async ({ page }) => {
  await page.goto("/assistant");
  await expect(
    page.getByRole("button", { name: "切换演示身份" }),
  ).toBeEnabled();
  const before = await page.evaluate(() =>
    localStorage.getItem("pawmeet:state:v1"),
  );
  await page
    .getByLabel("AI 助手需求")
    .fill("明天下午帮我遛年糕30分钟，不能松牵引绳，请整理互助草稿");
  await page.getByRole("button", { name: "发送给 AI 助手" }).click();
  const open = page.getByRole("button", {
    name: "打开可编辑互助表单（尚未发布）",
  });
  await expect(open.first()).toBeVisible({ timeout: 90000 });
  await expect(page.getByLabel("AI 助手需求")).toBeEnabled({ timeout: 90000 });
  await expect(page.locator("p[role=alert]")).toHaveCount(0);
  await open.first().click();
  expect(
    await page.evaluate(() => localStorage.getItem("pawmeet:state:v1")),
  ).toBe(before);
  await page.getByLabel("AI 助手需求").fill("接下来只查5公里内已有活动");
  await page.getByRole("button", { name: "发送给 AI 助手" }).click();
  await expect(
    page
      .getByTestId("tool-result")
      .filter({ hasText: "search_activities" })
      .first(),
  ).toBeVisible({ timeout: 90000 });
  await expect(page.getByLabel("AI 助手需求")).toBeEnabled({ timeout: 90000 });
  await expect(page.locator("p[role=alert]")).toHaveCount(0);
  expect(
    await page.evaluate(() => localStorage.getItem("pawmeet:state:v1")),
  ).toBe(before);
});

test("真实Qwen：规则适配解释和社区文案保持事实来源", async ({ page }) => {
  await page.goto("/me");
  await expect(
    page.getByRole("button", { name: "切换演示身份" }),
  ).toBeEnabled();
  const state = (await page.evaluate(() =>
    JSON.parse(localStorage.getItem("pawmeet:state:v1")!),
  )) as DemoState;
  const own = state.pets.find((p) => p.ownerId === state.activeUserId)!;
  const other = state.pets.find((p) => p.ownerId !== state.activeUserId)!;
  const evidence = comparisonEvidence(state, own, other);
  for (const [task, input] of [
    [
      "social-analysis",
      { text: "整理两宠规则依据，不新增事实", context: { evidence } },
    ],
    ["post-copy", { text: "今天在公园散步，记得牵绳。", context: {} }],
  ] as const) {
    const response = await page.request.post(`/api/ai/${task}`, {
      headers: { Origin: new URL(page.url()).origin },
      data: input,
      timeout: 45000,
    });
    const result = await response.json();
    expect(result, {
      message: `${task}: ${result.error?.code ?? response.status()}`,
    }).toMatchObject({
      ok: true,
      meta: { provider: "qwen", model: "qwen3.8-flash" },
    });
    if (task === "post-copy")
      expect(input.text.includes(result.data.text)).toBe(true);
    else
      expect(
        result.data.explanation
          .split("\n")
          .every((line: string) => evidence.some((item) => item.fact === line)),
      ).toBe(true);
  }
});
