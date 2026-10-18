import { test, expect, Page } from "@playwright/test";
import path from "node:path";

async function ready(page: Page, url = "/") {
  await page.goto(url);
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
const snapshot = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("pawmeet:state:v1")!));

test("宠物 CRUD、照片上传、身份归属与刷新持久化", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page, "/me");
  await page.getByRole("link", { name: "添加宠物" }).click();
  await page.getByLabel("宠物名字", { exact: true }).fill("测试毛球");
  await page.getByLabel("品种", { exact: true }).fill("小土狗");
  await page.getByLabel("月龄", { exact: true }).fill("18");
  await page
    .getByLabel("上传照片")
    .setInputFiles(path.resolve("public/images/dog-1.jpg"));
  await expect(
    page.getByRole("img", { name: "已选照片 1", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "温和", exact: true }).click();
  await page.getByRole("button", { name: "确认保存档案" }).click();
  await expect(page).toHaveURL("/me");
  await page.getByRole("link", { name: /测试毛球/ }).click();
  await expect(page.getByRole("heading", { name: "测试毛球" })).toBeVisible();
  const photo = (await snapshot(page)).pets.find(
    (p: { name: string }) => p.name === "测试毛球",
  ).photo;
  expect(photo.kind).toBe("upload");
  await page.reload();
  await expect(
    page.getByRole("img", { name: "测试毛球", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page
        .getByRole("img", { name: "测试毛球", exact: true })
        .evaluate((el: HTMLImageElement) => el.naturalWidth),
    )
    .toBeGreaterThan(0);
  await page.getByRole("link", { name: "编辑档案" }).click();
  await page.getByLabel("宠物名字", { exact: true }).fill("毛球改名");
  await page.getByRole("button", { name: "确认保存档案" }).click();
  await page.getByRole("link", { name: /毛球改名/ }).click();
  await expect(page).toHaveURL(/\/pets\/[^/]+$/);
  const url = page.url();
  await switchUser(page, "陈一一");
  await expect(page.getByRole("link", { name: "编辑档案" })).toHaveCount(0);
  await page.goto("/me");
  await expect(page.getByRole("link", { name: /毛球改名/ })).toHaveCount(0);
  await switchUser(page, "林小满");
  await page.goto(url);
  await page.getByRole("button", { name: "删除档案", exact: true }).click();
  await page.getByRole("button", { name: "确认删除" }).click();
  await expect(
    page.getByRole("heading", { name: "这份档案不存在或已删除" }),
  ).toBeVisible();
  await page.goto("/me");
  await expect(page.getByRole("link", { name: /毛球改名/ })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("link", { name: /毛球改名/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("发布含照片动态、点赞切换与重置", async ({ page }) => {
  await ready(page, "/posts/new");
  await page.getByLabel("动态内容").fill("测试日常：今天认识了新朋友");
  await page.getByRole("checkbox", { name: "年糕" }).check();
  await page
    .getByLabel("上传照片")
    .setInputFiles(path.resolve("public/images/dog-3.jpg"));
  await expect(page.getByRole("img", { name: "已选照片 1" })).toBeVisible();
  await page.getByRole("button", { name: "确认发布动态" }).click();
  // E2E runs with AI_ENABLED=false: the AI precheck layer is reported as not run.
  await page.getByRole("button", { name: "不经 AI 预检发布" }).click();
  await expect(page).toHaveURL("/");
  const post = page.locator(".post-card").first();
  await expect(post).toContainText("测试日常");
  await post.getByRole("button", { name: "点赞", exact: true }).click();
  await expect(post.getByRole("button", { name: "取消点赞" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.reload();
  await expect(
    page
      .locator(".post-card")
      .first()
      .getByRole("button", { name: "取消点赞" }),
  ).toBeVisible();
  await switchUser(page, "陈一一");
  await expect(
    page
      .locator(".post-card")
      .first()
      .getByRole("button", { name: "点赞", exact: true }),
  ).toBeVisible();
  await page
    .locator(".post-card")
    .first()
    .getByRole("button", { name: "点赞", exact: true })
    .click();
  expect((await snapshot(page)).posts[0].likedByUserIds).toHaveLength(2);
  await page
    .locator(".post-card")
    .first()
    .getByRole("button", { name: "取消点赞" })
    .click();
  expect((await snapshot(page)).posts[0].likedByUserIds).toHaveLength(1);
  await page.goto("/me");
  await page.getByText("演示与本地数据", { exact: true }).click();
  await page.getByRole("button", { name: "重置演示数据", exact: true }).click();
  await page.getByRole("button", { name: "确认重置" }).click();
  await expect(
    page.getByRole("button", { name: "切换演示身份" }),
  ).toContainText("林小满");
  await expect.poll(async () => (await snapshot(page)).posts.length).toBe(12);
  expect((await snapshot(page)).pets).toHaveLength(25);
  await page.reload();
  expect((await snapshot(page)).posts).toHaveLength(12);
  const count = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const r = indexedDB.open("pawmeet-images", 1);
        r.onsuccess = () => {
          const db = r.result;
          const q = db.transaction("images").objectStore("images").count();
          q.onsuccess = () => {
            resolve(q.result);
            db.close();
          };
          q.onerror = () => reject(q.error);
        };
      }),
  );
  expect(count).toBe(0);
});

test("创建活动、跨身份报名、取消与名额持久化", async ({ page }) => {
  await ready(page, "/activities/new");
  await page.getByLabel("活动名称").fill("测试周末草地局");
  const future = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  await page.getByLabel("开始时间", { exact: true }).fill(`${future}T14:00`);
  await page.getByLabel("结束时间", { exact: true }).fill(`${future}T16:00`);
  await page.getByLabel("主人名额").fill("2");
  await page.getByRole("button", { name: "确认创建活动" }).click();
  await expect(page).toHaveURL("/activities");
  await page.getByRole("link", { name: /测试周末草地局/ }).click();
  await expect(page.getByText("你是本次组织者，已自动报名")).toBeVisible();
  await switchUser(page, "陈一一");
  await page.getByRole("button", { name: "确认报名", exact: true }).click();
  await expect(page.getByText("已报名，刷新后仍保留")).toBeVisible();
  await page.reload();
  await expect(page.getByText("已报名，刷新后仍保留")).toBeVisible();
  await switchUser(page, "周可可");
  await expect(page.getByRole("button", { name: "名额已满" })).toBeDisabled();
  await switchUser(page, "陈一一");
  await page.getByRole("button", { name: "取消报名", exact: true }).click();
  await page.getByRole("button", { name: "确认取消", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "确认报名", exact: true }),
  ).toBeEnabled();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "确认报名", exact: true }),
  ).toBeEnabled();
  await switchUser(page, "林小满");
  await page.getByRole("button", { name: "取消活动", exact: true }).click();
  await page.getByRole("button", { name: "确认取消", exact: true }).click();
  await expect(page.getByText("活动已取消，保留历史报名")).toBeVisible();
});

test("五栏布局、可搜索档案、无横向溢出及页面截图", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const route of ["/", "/discover", "/activities", "/help", "/me"]) {
    await ready(page, route);
    await expect(page.locator("main h1")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.locator("img").evaluateAll((images) =>
      images.forEach((image) => {
        if (image instanceof HTMLImageElement) image.loading = "eager";
      }),
    );
    await expect
      .poll(() =>
        page
          .locator("img")
          .evaluateAll((images) =>
            images.every(
              (image) =>
                image instanceof HTMLImageElement &&
                image.complete &&
                image.naturalWidth > 0,
            ),
          ),
      )
      .toBe(true);
    await page.screenshot({
      path: info.outputPath(`${route === "/" ? "home" : route.slice(1)}.png`),
      fullPage: true,
    });
    if (route === "/")
      await page.screenshot({ path: info.outputPath("home-viewport.png") });
  }
  await page.goto("/discover");
  await page.getByLabel("按名称品种或区域搜索").fill("布丁");
  await expect(page.locator(".pet-card")).toHaveCount(1);
  await page.getByLabel("按名称品种或区域搜索").fill("没有这个名字");
  await expect(page.getByText("没有找到这样的宠友")).toBeVisible();
  expect(errors).toEqual([]);
});

test("375px / 768px 布局和导航", async ({ page }, info) => {
  for (const width of [375, 768]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ["/", "/discover", "/activities", "/help", "/me"]) {
      await ready(page, route);
      await expect(page.locator("main h1")).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await page.screenshot({
      path: info.outputPath(`me-${width}.png`),
      fullPage: true,
    });
  }
});

test("模拟身份草稿保护与浏览器副本独立", async ({ page, browser }) => {
  await ready(page, "/posts/new");
  await page.getByLabel("动态内容").fill("未保存的草稿");
  await page.getByRole("button", { name: "切换演示身份" }).click();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /陈一一/ })
    .click();
  await expect(
    page.getByRole("button", { name: "切换演示身份" }),
  ).toContainText("林小满");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭弹窗" })
    .click();
  await expect(page.getByLabel("动态内容")).toHaveValue("未保存的草稿");
  await page.getByRole("button", { name: "确认发布动态" }).click();
  // E2E runs with AI_ENABLED=false: the AI precheck layer is reported as not run.
  await page.getByRole("button", { name: "不经 AI 预检发布" }).click();
  await expect(page).toHaveURL("/");
  const isolated = await browser.newContext();
  const other = await isolated.newPage();
  await ready(other);
  expect((await snapshot(other)).posts).toHaveLength(12);
  expect((await snapshot(page)).posts).toHaveLength(13);
  await isolated.close();
});

test("损坏数据保护与用户确认恢复", async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("injected")) {
      localStorage.setItem("pawmeet:state:v1", "{broken");
      sessionStorage.setItem("injected", "yes");
    }
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "需要先处理本地数据" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem("pawmeet:state:v1")),
  ).toBe("{broken");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出原始数据" }).click();
  expect((await download).suggestedFilename()).toBe("pawmeet-recovery.txt");
  await page.getByRole("button", { name: "重置演示数据", exact: true }).click();
  await page.getByRole("button", { name: "确认重置" }).click();
  await expect(
    page.getByRole("heading", { name: "宠物社区", exact: true }),
  ).toBeVisible();
});

test("第二标签只读，释放写锁后刷新可编辑", async ({ page, context }) => {
  await ready(page);
  const second = await context.newPage();
  await ready(second, "/me");
  await second.getByText("演示与本地数据", { exact: true }).click();
  await expect(second.getByText("只读模式", { exact: true })).toBeVisible();
  await expect(
    second.getByRole("button", { name: "重置演示数据", exact: true }),
  ).toBeDisabled();
  await page.close();
  await second.reload();
  await second.getByText("演示与本地数据", { exact: true }).click();
  await expect(second.getByText("当前可编辑", { exact: true })).toBeVisible();
});

test("localStorage 配额失败保留表单，原状态不变（故障注入）", async ({
  page,
}) => {
  await ready(page, "/posts/new");
  const old = await snapshot(page);
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("test quota", "QuotaExceededError");
    };
  });
  await page.getByLabel("动态内容").fill("失败时不要丢失这段草稿");
  await page.getByRole("button", { name: "确认发布动态" }).click();
  // E2E runs with AI_ENABLED=false: the AI precheck layer is reported as not run.
  await page.getByRole("button", { name: "不经 AI 预检发布" }).click();
  await expect(page.getByRole("status")).toContainText("保存失败");
  await expect(page.getByLabel("动态内容")).toHaveValue(
    "失败时不要丢失这段草稿",
  );
  expect((await snapshot(page)).posts).toEqual(old.posts);
});

test("图片损坏与 IndexedDB 失败可见（故障注入）", async ({ page }) => {
  await ready(page, "/posts/new");
  await page.getByLabel("上传照片").setInputFiles({
    name: "bad.png",
    mimeType: "image/png",
    buffer: Buffer.from("invalid image"),
  });
  await expect(page.locator("main").getByRole("alert")).toContainText(
    "无法解码",
  );
  await page.evaluate(() => {
    indexedDB.open = () => {
      throw new Error("injected indexedDB failure");
    };
  });
  await page
    .getByLabel("上传照片")
    .setInputFiles(path.resolve("public/images/dog-1.jpg"));
  await expect(page.locator("main").getByRole("alert")).toContainText(
    "injected indexedDB failure",
  );
  await expect(page.getByRole("img", { name: "已选照片 1" })).toHaveCount(0);
});
