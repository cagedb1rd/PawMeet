import { expect, test, type Page } from "@playwright/test";
async function ready(page: Page, route: string) {
  await page.goto(route);
  await expect(
    page.getByRole("button", { name: "切换演示身份" }),
  ).toBeEnabled();
}
const snapshot = (page: Page) =>
  page.evaluate(() => localStorage.getItem("pawmeet:state:v1"));

test("紧凑附近：位置按需展开，条件逐项移除，不改业务快照", async ({
  page,
}, info) => {
  await ready(page, "/discover");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: info.outputPath("discover-viewport.png"),
    scale: "css",
  });
  const before = await snapshot(page);
  await expect(page.getByRole("button", { name: "使用当前位置" })).toBeHidden();
  await page.getByRole("button", { name: "调整位置", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "使用当前位置" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "收起位置", exact: true }).click();
  await page.getByText("品种、体型和偏好筛选", { exact: true }).click();
  await page.getByRole("button", { name: "温和", exact: true }).click();
  await page.getByRole("button", { name: "大型犬", exact: true }).click();
  await page.getByText("品种、体型和偏好筛选", { exact: true }).click();
  await page
    .getByRole("button", { name: "移除条件：大型犬", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "移除条件：温和", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "5 公里", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(await snapshot(page)).toBe(before);
});

test("搜索返回保留关键词，个人宠物提供管理入口，弹窗可读名称", async ({
  page,
}) => {
  await ready(page, "/search");
  const input = page.getByRole("textbox", {
    name: "搜索帖子或用户",
    exact: true,
  });
  await input.fill("陈一一");
  await page.locator(".people-list").getByRole("link").click();
  await expect(page).toHaveURL(/\/users\/user-2/);
  await page.goBack();
  await expect(input).toHaveValue("陈一一");
  if (test.info().project.name === "desktop")
    await expect(
      page.getByRole("textbox", { name: "搜索帖子与用户", exact: true }),
    ).toHaveValue("陈一一");
  await ready(page, "/me");
  const pet = page.locator(".my-pets");
  await expect(pet.getByRole("link", { name: "发起约伴" })).toHaveCount(0);
  await expect(pet.getByRole("link", { name: "编辑档案" })).toHaveAttribute(
    "href",
    "/me/pets/pet-1/edit",
  );
  await page.getByRole("button", { name: "切换演示身份" }).click();
  await expect(
    page.getByRole("dialog", { name: "切换演示身份", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "切换演示身份" }),
  ).toBeFocused();
});

test("跨字段时间错误关联输入、定位并保留草稿，修正后可创建", async ({
  page,
}) => {
  await ready(page, "/activities/new");
  const before = await snapshot(page);
  const date = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  await page.getByLabel("活动名称", { exact: true }).fill("体验验收散步");
  await page.getByLabel("开始时间", { exact: true }).fill(`${date}T15:00`);
  const end = page.getByLabel("结束时间", { exact: true });
  await end.fill(`${date}T14:00`);
  await page.getByRole("button", { name: "确认创建活动" }).click();
  await expect(
    page
      .getByRole("alert")
      .getByText("结束时间必须晚于开始时间", { exact: true }),
  ).toBeVisible();
  await expect(end).toHaveAttribute("aria-invalid", "true");
  await expect(end).toBeFocused();
  await expect(page.getByLabel("活动名称", { exact: true })).toHaveValue(
    "体验验收散步",
  );
  expect(await snapshot(page)).toBe(before);
  await end.fill(`${date}T16:00`);
  await expect(end).not.toHaveAttribute("aria-invalid", "true");
  await page.getByRole("button", { name: "确认创建活动" }).click();
  await expect(page).toHaveURL("/activities");
  await expect(
    page.locator(".activity-card").filter({ hasText: "体验验收散步" }),
  ).toContainText("我发起的");
});

test("活动状态随时间与名额展示，列表切换不换封面，约伴首屏紧凑", async ({
  page,
}, info) => {
  await ready(page, "/activities");
  const trigger = page.getByRole("button", {
    name: "AI 智能约伴",
    exact: true,
  });
  const region = page.getByRole("region", { name: "AI 智能约伴" });
  await expect(region).toBeHidden();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  const triggerBox = await trigger.boundingBox();
  const createBox = await page
    .getByRole("link", { name: "发起活动", exact: true })
    .boundingBox();
  expect(triggerBox!.x + triggerBox!.width).toBeLessThanOrEqual(createBox!.x);
  expect(Math.abs(triggerBox!.y - createBox!.y)).toBeLessThan(2);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: info.outputPath("activities-viewport.png"),
    scale: "css",
  });
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("pawmeet:state:v1")!);
    const now = Date.now();
    state.activities[0].startAt = new Date(now - 7200000).toISOString();
    state.activities[0].endAt = new Date(now - 3600000).toISOString();
    state.activities[1].startAt = new Date(now - 1000).toISOString();
    state.activities[1].endAt = new Date(now + 3600000).toISOString();
    state.activities[2].status = "cancelled";
    // Existing organizer occupies one slot; a second valid signup fills capacity 2.
    const activity = state.activities[3];
    activity.capacity = 2;
    state.activitySignups.push({
      ...state.activitySignups[0],
      id: "ux-signup",
      activityId: activity.id,
      userId: "user-1",
      petId: "pet-1",
    });
    localStorage.setItem("pawmeet:state:v1", JSON.stringify(state));
  });
  await page.reload();
  const cards = page.locator(".activity-card");
  await expect(cards.nth(0)).toContainText("已结束");
  await expect(cards.nth(1)).toContainText("进行中");
  await expect(cards.nth(2)).toContainText("已取消");
  await expect(cards.nth(3)).toContainText("名额已满");
  const image = await cards
    .nth(3)
    .locator(".activity-photo img")
    .getAttribute("src");
  await page.getByRole("button", { name: "我的活动", exact: true }).click();
  await expect(
    page.locator(
      'a.activity-card[href="/activities/activity-4"] .activity-photo img',
    ),
  ).toHaveAttribute("src", image!);
  await expect(page.getByLabel("约伴参考宠物", { exact: true })).toBeHidden();
  await expect(
    page.getByRole("button", { name: "重新开始", exact: true }),
  ).toHaveCount(0);
  await trigger.click();
  await expect(region).toBeVisible();
  await page.getByLabel("智能约伴需求").fill("周六下午一起散步");
  await trigger.click();
  await expect(region).toBeHidden();
  await trigger.click();
  await expect(page.getByLabel("智能约伴需求")).toHaveValue("周六下午一起散步");
  expect((await region.boundingBox())!.height).toBeLessThan(380);
});
