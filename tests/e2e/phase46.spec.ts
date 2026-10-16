import { test, expect, Page } from "@playwright/test";

async function ready(page: Page, route = "/") {
  await page.goto(route);
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
test.beforeEach(async ({ page }) => {
  // UI regression is never allowed to reach a paid model endpoint.
  await page.route("**/api/ai/**", (route) => route.abort());
});

test("关注、取消、作者主页、粉丝与身份隔离真实持久化", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "关注", exact: true }).click();
  await expect(
    page.getByText("还没有关注的日常", { exact: true }),
  ).toBeVisible();
  await page.goto("/posts/post-2");
  await page.getByRole("button", { name: "关注", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "已关注", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.goto("/");
  await page.getByRole("button", { name: "关注", exact: true }).click();
  await expect(page.locator(".note-card")).toHaveCount(1);
  await expect(page.locator(".note-author")).toContainText("陈一一");
  await page.reload();
  await page.getByRole("button", { name: "关注", exact: true }).click();
  await expect(page.locator(".note-card")).toHaveCount(1);
  await switchUser(page, "陈一一");
  await expect(page.locator(".note-card")).toHaveCount(0);
  await page.goto("/me");
  await page.getByRole("button", { name: /粉丝/ }).click();
  await expect(
    page.getByRole("dialog").getByRole("link", { name: /林小满/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭弹窗" }).click();
  await switchUser(page, "林小满");
  await page.goto("/users/user-2");
  await page.getByRole("button", { name: "已关注", exact: true }).click();
  await page.goto("/");
  await page.getByRole("button", { name: "关注", exact: true }).click();
  await expect(page.locator(".note-card")).toHaveCount(0);
});

test("发布标题、搜索标题与正文、用户昵称、空结果与刷新", async ({
  page,
}, info) => {
  await ready(page, "/posts/new");
  await page.getByLabel("帖子标题", { exact: true }).fill("小蝴蝶观察日记");
  await page
    .getByLabel("动态内容", { exact: true })
    .fill("今天在公园看到了蓝色蜻蜓。");
  await page.getByRole("button", { name: "确认发布动态" }).click();
  await expect(page.locator(".note-card").first()).toContainText(
    "小蝴蝶观察日记",
  );
  await page.getByRole("link", { name: "搜索", exact: true }).click();
  const search = page.getByRole("textbox", { name: "搜索帖子或用户" });
  await search.fill("小蝴蝶");
  await expect(page.locator(".note-card")).toHaveCount(1);
  await page.locator(".note-main").click();
  await expect(page.locator("h1")).toHaveText("小蝴蝶观察日记");
  await expect(
    page.getByText("今天在公园看到了蓝色蜻蜓。", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator("h1")).toHaveText("小蝴蝶观察日记");
  await page.goto("/search?q=蜻蜓");
  await expect(page.locator(".note-card")).toHaveCount(1);
  await search.fill("陈一一");
  await page.locator(".people-list").getByRole("link").click();
  await expect(page).toHaveURL("/users/user-2");
  await expect(
    page.getByRole("heading", { name: "陈一一", exact: true }),
  ).toBeVisible();
  await page.goto("/search?q=肯定没有的结果");
  await expect(
    page.getByText("没有找到相关内容", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "清空搜索" }).click();
  await expect(search).toHaveValue("");
  if (info.project.name === "desktop") {
    await page
      .getByRole("textbox", { name: "搜索帖子与用户", exact: true })
      .fill("陈一一");
    await page
      .getByRole("textbox", { name: "搜索帖子与用户", exact: true })
      .press("Enter");
    await expect(search).toHaveValue("陈一一");
    await expect(page.locator(".people-list")).toContainText("陈一一");
  }
});

test("真实双列错落、图片原比例、固定导航与多宽度截图", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const width of info.project.name === "mobile"
    ? [375, 390]
    : [768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of [
      "/",
      "/discover",
      "/help",
      "/activities",
      "/me",
      "/search",
    ]) {
      await ready(page, route);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      if (route === "/") {
        await expect(page.locator(".masonry-feed")).toHaveCSS(
          "display",
          "grid",
        );
        await expect(page.locator(".masonry-column")).toHaveCount(2);
        await page.locator(".note-cover").evaluateAll((images) =>
          images.forEach((im) => {
            (im as HTMLImageElement).loading = "eager";
          }),
        );
        await expect
          .poll(() =>
            page
              .locator(".note-cover")
              .evaluateAll((images) =>
                images.every((im) => (im as HTMLImageElement).naturalWidth > 0),
              ),
          )
          .toBe(true);
        const sizes = await page.locator(".note-cover").evaluateAll((images) =>
          images.map((image) => {
            const im = image as HTMLImageElement;
            return {
              height: im.height,
              ratio: im.width / im.height,
              natural: im.naturalWidth / im.naturalHeight,
            };
          }),
        );
        expect(new Set(sizes.map((s) => s.height)).size).toBeGreaterThan(2);
        const rowStarts = await page
          .locator(".masonry-column")
          .evaluateAll((columns) =>
            columns.map((col) => col.children[1].getBoundingClientRect().top),
          );
        expect(Math.abs(rowStarts[0] - rowStarts[1])).toBeGreaterThan(1);
        sizes.forEach((s) =>
          expect(Math.abs(s.ratio - s.natural)).toBeLessThan(0.02),
        );
        if (width < 768) {
          const nav = page.getByRole("navigation", { name: "移动导航" });
          await expect(nav).toBeVisible();
          expect(await nav.getByRole("link").allTextContents()).toEqual([
            "首页",
            "附近",
            "发布",
            "活动",
            "我的",
          ]);
          await nav.getByRole("link", { name: "发布帖子" }).click();
          await expect(page).toHaveURL("/posts/new");
          await page.evaluate(() =>
            window.scrollTo(0, document.body.scrollHeight),
          );
          const button = await page
            .getByRole("button", { name: "确认发布动态" })
            .boundingBox();
          const navBox = await nav.boundingBox();
          expect(button!.y + button!.height).toBeLessThan(navBox!.y);
          await ready(page);
        }
      }
      await page.screenshot({
        path: info.outputPath(
          `${width}-${route === "/" ? "home" : route.slice(1)}.png`,
        ),
        fullPage: true,
      });
    }
  }
  expect(errors).toEqual([]);
});

test("附近二级切换、我的记录与智能约伴预留入口", async ({ page }) => {
  await ready(page, "/discover");
  await page
    .getByRole("navigation", { name: "附近分类" })
    .getByRole("link", { name: "临时互助" })
    .click();
  await expect(
    page.getByRole("heading", { name: "临时互助", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "发布求助", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "附近分类" })
    .getByRole("link", { name: "附近宠友" })
    .click();
  await expect(page.getByTestId("result-count")).toBeVisible();
  await page.goto("/me");
  await page.getByRole("link", { name: "我的互助 →", exact: true }).click();
  await expect(page.getByRole("button", { name: "我的互助记录" })).toHaveClass(
    /selected/,
  );
  await page.goto("/me");
  await page.getByRole("link", { name: "我的活动 →", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "我的活动", exact: true }),
  ).toHaveClass(/selected/);
  await expect(page.getByRole("region", { name: "AI 智能约伴" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "手动发起活动" }),
  ).toHaveAttribute("href", "/activities/new");
});

test("封面加载失败显示替代状态，详情内容与点赞仍可操作", async ({ page }) => {
  await page.route("**/images/dog-2.jpg", (route) => route.abort());
  await ready(page, "/posts/post-2");
  await expect(page.locator(".note-gallery .image-fallback")).toBeVisible();
  await expect(page.locator(".note-body")).not.toBeEmpty();
  await page.getByRole("button", { name: "点赞", exact: true }).click();
  await expect(page.getByRole("button", { name: "取消点赞" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
