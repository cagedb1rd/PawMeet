import { test, expect, Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function ready(page: Page, path = "/help") {
  await page.goto(path);
  await expect(
    page.getByRole("button", { name: "切换演示身份" }),
  ).toBeEnabled();
}
async function switchUser(page: Page, name: string) {
  await page.getByRole("button", { name: "切换演示身份" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: new RegExp(name) })
    .click();
  await expect(
    page.getByRole("button", { name: "切换演示身份" }),
  ).toContainText(name);
}
const state = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("pawmeet:state:v1")!));
const date = (days: number, hour: string) =>
  `${new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)}T${hour}`;
async function publish(page: Page, type = "walk") {
  await ready(page, "/help/new");
  await page.getByLabel("求助标题", { exact: true }).fill("周末照看年糕");
  await page.getByLabel("互助类型").selectOption(type);
  await page.getByLabel("开始时间（北京时间）").fill(date(3, "10:00"));
  await page.getByLabel("结束时间（北京时间）").fill(date(3, "11:00"));
  await page
    .getByLabel("需求说明", { exact: true })
    .fill("仅演示，请核对牵引绳与饮水。");
  await page.getByRole("button", { name: "确认发布求助" }).click();
  await expect(page).toHaveURL("/help");
  await page
    .getByRole("article")
    .filter({ hasText: "周末照看年糕" })
    .getByRole("link", { name: "查看求助与交接" })
    .click();
  await expect(page.getByTestId("help-status")).toHaveText("等待帮助");
}
async function saveChecklist(page: Page) {
  await page
    .getByLabel("清单详情 1", { exact: true })
    .fill("主人当面交接牵引绳与饮水。");
  await page.getByRole("button", { name: "主人确认保存清单" }).click();
  await expect(
    page.getByText("主人已确认当前版本；仍需核对标为待确认的细节。"),
  ).toBeVisible();
}

test("三身份真实互助：发布、编辑、申请、选择、双方完成与刷新记录", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await publish(page);
  await expect(
    page.getByRole("button", { name: "申请帮助", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "编辑求助", exact: true }).click();
  await page
    .getByLabel("需求说明", { exact: true })
    .fill("仅演示，主人当面交接用品。");
  await page.getByRole("button", { name: "确认保存求助" }).click();
  await saveChecklist(page);
  const url = page.url();
  await switchUser(page, "陈一一");
  await page.getByLabel("申请说明").fill("B 可以帮助，先确认注意事项。");
  await page.getByRole("button", { name: "申请帮助", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "已申请，不能重复申请" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "帮助者标记完成" }),
  ).toHaveCount(0);
  await switchUser(page, "周可可");
  await page.getByRole("button", { name: "申请帮助", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "求助人确认完成" }),
  ).toHaveCount(0);
  await switchUser(page, "林小满");
  await expect(
    page.getByRole("link", { name: "编辑求助", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "选择陈一一为帮助者" }).click();
  await expect(page.getByTestId("help-status")).toHaveText("已确认帮助者");
  await expect(
    page.getByText("未被选择 / 已关闭", { exact: true }),
  ).toBeVisible();
  await switchUser(page, "周可可");
  await expect(
    page.getByRole("button", { name: "帮助者标记完成" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "当前不能申请" }),
  ).toBeDisabled();
  await switchUser(page, "陈一一");
  await page.getByRole("button", { name: "帮助者标记完成" }).click();
  await expect(page.getByTestId("help-status")).toHaveText("等待求助人确认");
  await switchUser(page, "林小满");
  await page.getByRole("button", { name: "求助人确认完成" }).click();
  await page.reload();
  await expect(page.getByTestId("help-status")).toHaveText("双方已完成");
  await expect(
    page.getByRole("heading", { name: "互助历史记录" }),
  ).toBeVisible();
  for (const name of ["林小满", "陈一一", "周可可"]) {
    if (name !== "林小满") await switchUser(page, name);
    await page.goto("/help");
    await page.getByRole("button", { name: "我的互助记录" }).click();
    await expect(
      page.getByRole("heading", { name: "周末照看年糕" }),
    ).toBeVisible();
    await page.goto(url);
  }
  const s = await state(page),
    h = s.helpRequests.find(
      (v: { title: string }) => v.title === "周末照看年糕",
    );
  expect(h).toMatchObject({
    status: "completed",
    requesterId: "user-1",
    helperId: "user-2",
  });
  expect(
    s.helpEvents.filter((e: { helpId: string }) => e.helpId === h.id),
  ).toHaveLength(8);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("completed-help.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("喂食求助：撤回、重申、清单来源失效、重新确认与取消关闭", async ({
  page,
}, info) => {
  await publish(page, "feed");
  await saveChecklist(page);
  const url = page.url();
  await page.goto("/me/pets/pet-1/edit");
  await page.getByLabel("宠物名字", { exact: true }).fill("年糕新名");
  await page.getByRole("button", { name: "确认保存档案" }).click();
  await page.goto(url);
  await expect(
    page.getByText("来源档案或需求已变更，请主人重新复核清单。"),
  ).toBeVisible();
  await switchUser(page, "陈一一");
  await page.getByRole("button", { name: "申请帮助", exact: true }).click();
  await page.getByRole("button", { name: "撤回申请" }).click();
  await page.getByRole("button", { name: "申请帮助", exact: true }).click();
  await switchUser(page, "林小满");
  await expect(
    page.getByRole("button", { name: "选择陈一一为帮助者" }),
  ).toBeDisabled();
  await saveChecklist(page);
  await expect(
    page.getByRole("button", { name: "选择陈一一为帮助者" }),
  ).toBeEnabled();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "取消演示求助", exact: true }).click();
  await expect(page.getByTestId("help-status")).toHaveText("已取消");
  await switchUser(page, "周可可");
  await expect(
    page.getByRole("button", { name: "当前不能申请" }),
  ).toBeDisabled();
  await page.goto(`${url}/edit`);
  await expect(
    page.getByRole("heading", { name: "无法编辑这条求助" }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("closed-help.png"),
    fullPage: true,
  });
});

test("名片确认、精确偏好冲突、PNG 导出、约伴带入与档案变更失效", async ({
  page,
}, info) => {
  await ready(page, "/pets/pet-1");
  await page.getByRole("link", { name: "查看社交名片", exact: true }).click();
  await expect(page.getByRole("button", { name: "下载 PNG" })).toBeDisabled();
  await page.getByRole("button", { name: "编辑与确认名片" }).click();
  await page
    .getByLabel("喜欢的互动行为", { exact: true })
    .fill("追逐\n并排散步");
  await page.getByLabel("不喜欢的行为", { exact: true }).fill("分享玩具");
  await page
    .getByLabel("需要注意的习惯", { exact: true })
    .fill("初次见面先保持距离");
  await page
    .getByLabel("初次见面建议", { exact: true })
    .fill("主人在场，从短时间并排散步开始。");
  await page
    .getByRole("checkbox", { name: "我已逐项复核，这是我对宠物的描述" })
    .check();
  await page.getByRole("button", { name: "确认保存社交名片" }).click();
  await expect(page.getByText("主人已确认 · 已复核内容")).toBeVisible();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 PNG" }).click();
  const download = await downloading;
  await download.saveAs(info.outputPath("card.png"));
  const bytes = await readFile((await download.path())!);
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(bytes.readUInt32BE(16)).toBe(1080);
  await page.screenshot({
    path: info.outputPath("social-card.png"),
    fullPage: true,
  });
  await switchUser(page, "陈一一");
  await page.goto("/pets/pet-2/card");
  await page.getByRole("button", { name: "编辑与确认名片" }).click();
  await page.getByLabel("不喜欢的行为", { exact: true }).fill("追逐");
  await page
    .getByRole("checkbox", { name: "我已逐项复核，这是我对宠物的描述" })
    .check();
  await page.getByRole("button", { name: "确认保存社交名片" }).click();
  await switchUser(page, "林小满");
  await page.goto("/discover");
  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "布丁", exact: true }) })
    .getByRole("link", { name: "比较社交偏好" })
    .click();
  await expect(
    page.getByText("年糕喜欢追逐，布丁不喜欢追逐，初次见面请避开这一互动。"),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("comparison.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: "以此宠友为推荐对象发起约伴" }).click();
  await expect(page.getByText(/推荐约伴对象：布丁/)).toBeVisible();
  await page.getByLabel("活动名称", { exact: true }).fill("名片约伴演示");
  await page.getByLabel("开始时间", { exact: true }).fill(date(3, "13:00"));
  await page.getByLabel("结束时间", { exact: true }).fill(date(3, "14:00"));
  await page.getByRole("button", { name: "确认创建活动" }).click();
  await expect(page).toHaveURL("/activities");
  const s = await state(page);
  expect(s.activities[0].recommendedPetIds).toEqual(["pet-2"]);
  await page.goto("/me/pets/pet-1/edit");
  await page.getByLabel("宠物名字", { exact: true }).fill("年糕改名");
  await page.getByRole("button", { name: "确认保存档案" }).click();
  await page.goto("/pets/pet-1/card");
  await expect(page.getByText("档案已变更 · 待重新确认")).toBeVisible();
  await expect(page.getByRole("button", { name: "下载 PNG" })).toBeDisabled();
  await page.getByRole("button", { name: "编辑与确认名片" }).click();
  await page
    .getByRole("checkbox", { name: "我已逐项复核，这是我对宠物的描述" })
    .check();
  await page.getByRole("button", { name: "确认保存社交名片" }).click();
  await expect(page.getByRole("button", { name: "下载 PNG" })).toBeEnabled();
  await page.getByRole("button", { name: "编辑与确认名片" }).click();
  for (const label of [
    "社交性格标签",
    "喜欢的互动行为",
    "不喜欢的行为",
    "需要注意的习惯",
  ]) {
    await page
      .getByLabel(label, { exact: true })
      .fill(Array(6).fill("长内容换行验证".repeat(8).slice(0, 60)).join("\n"));
  }
  await page
    .getByLabel("初次见面建议", { exact: true })
    .fill("保持牵引，观察反应。".repeat(30));
  await page
    .getByRole("checkbox", { name: "我已逐项复核，这是我对宠物的描述" })
    .check();
  await page.getByRole("button", { name: "确认保存社交名片" }).click();
  await page.evaluate(() =>
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: undefined,
    }),
  );
  const fallback = page.waitForEvent("download");
  await page.getByRole("button", { name: "分享名片文件" }).click();
  const longCard = await fallback;
  await longCard.saveAs(info.outputPath("long-card.png"));
  const longBytes = await readFile((await longCard.path())!);
  expect(longBytes.readUInt32BE(20)).toBeGreaterThan(bytes.readUInt32BE(20));
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});

test("互助保存故障保留原数据与草稿，修复后重试", async ({ page }) => {
  await ready(page, "/help/new");
  await page.getByLabel("求助标题", { exact: true }).fill("保存失败重试");
  await page.getByLabel("开始时间（北京时间）").fill(date(3, "10:00"));
  await page.getByLabel("结束时间（北京时间）").fill(date(3, "11:00"));
  await page.getByLabel("需求说明", { exact: true }).fill("保留草稿");
  const before = await state(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Object.assign(window, {
      restoreStorage: () => {
        Storage.prototype.setItem = original;
      },
    });
    Storage.prototype.setItem = () => {
      throw new DOMException("quota", "QuotaExceededError");
    };
  });
  await page.getByRole("button", { name: "确认发布求助" }).click();
  await expect(page.getByRole("status")).toContainText("保存失败");
  await expect(page.getByLabel("求助标题", { exact: true })).toHaveValue(
    "保存失败重试",
  );
  expect(await state(page)).toEqual(before);
  await page.evaluate(() =>
    (window as unknown as { restoreStorage: () => void }).restoreStorage(),
  );
  await page.getByRole("button", { name: "确认发布求助" }).click();
  await expect(page).toHaveURL("/help");
  expect((await state(page)).helpRequests).toHaveLength(9);
});

test("旧版数据浏览器迁移与过期需求禁止申请", async ({ page }) => {
  await ready(page);
  await expect(page.getByRole("heading", { name: "临时互助" })).toBeVisible();
  const old = await state(page);
  old.schemaVersion = 1;
  delete old.follows;
  old.posts = old.posts.map((p: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(p).filter(([key]) => key !== "title")),
  );
  old.pets[0].name = "保留的旧档案";
  old.helpRequests = old.helpRequests.map((h: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(h).filter(
        ([k]) =>
          !["helperId", "acceptedApplicationId", "contentRevision"].includes(k),
      ),
    ),
  );
  old.helpRequests[0].startAt = "2020-01-01T00:00:00Z";
  old.helpRequests[0].endAt = "2020-01-01T01:00:00Z";
  const raw = JSON.stringify(old);
  await page.evaluate(
    (raw) => localStorage.setItem("pawmeet:state:v1", raw),
    raw,
  );
  await page.goto("/help/help-1");
  await page.reload();
  await expect(page.getByTestId("help-status")).toHaveText(
    "已过期 · 不再接受申请",
  );
  expect(
    await page.evaluate(() => localStorage.getItem("pawmeet:state:v1")),
  ).toBe(raw);
  await switchUser(page, "陈一一");
  await expect(
    page.getByRole("button", { name: "当前不能申请" }),
  ).toBeDisabled();
  const migrated = await state(page);
  expect(migrated.schemaVersion).toBe(2);
  expect(migrated.pets[0].name).toBe("保留的旧档案");
  expect(migrated.posts).toEqual(
    old.posts.map((p: Record<string, unknown>) => ({ ...p, title: "" })),
  );
});
