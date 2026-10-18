import { test, expect, Page, Route } from "@playwright/test";
import path from "node:path";
import { inspectJpegDataUrl } from "../../src/lib/ai/jpeg";

/**
 * Community AI with mocked /api/ai/post-meta and /api/ai/post-safety (AI_ENABLED=false in
 * E2E, so every model answer here is a fixture). Program rules run for real in the browser.
 */
const success = (data: unknown) => ({
  ok: true,
  requestId: "e2e-mock-request",
  data,
  meta: {
    provider: "gemini",
    model: "mock-fixture",
    promptVersion: "mock",
    usage: null,
    latencyMs: 0,
  },
});
const metaDraft = {
  title: "江边晒太阳的下午",
  tags: ["江边", "散步", "晒太阳"],
  note: null,
  removed: 0,
};
async function ready(page: Page, url: string) {
  await page.goto(url);
  await expect(
    page.getByRole("button", { name: "切换演示身份" }),
  ).toBeEnabled();
}
const saved = (page: Page) =>
  page.evaluate(() => localStorage.getItem("pawmeet:state:v1"));
const body = (page: Page) => page.getByLabel("动态内容", { exact: true });
const publishButton = (page: Page) =>
  page.getByRole("button", { name: "确认发布动态" });
const panel = (page: Page) => page.getByTestId("precheck");

/** post-safety mock: flags 布洛芬 as dangerous advice, everything else passes. */
function mockSafety(page: Page, calls: unknown[]) {
  return page.route("**/api/ai/post-safety", (route: Route) => {
    const input = route.request().postDataJSON();
    calls.push(input);
    const at = String(input.text).indexOf("喂了半片布洛芬");
    return route.fulfill({
      json: success(
        at >= 0
          ? {
              verdict: "revise",
              issues: [
                {
                  category: "dangerous_advice",
                  field: "text",
                  excerpt: "喂了半片布洛芬",
                  reason: "人用药可能对狗狗有害，请咨询兽医",
                },
              ],
            }
          : { verdict: "pass", issues: [] },
      ),
    });
  });
}

test("生成标题标签 → 修改 → 预检提示（个人信息阻止 / 用药建议）→ 修改后发布", async ({
  page,
}) => {
  const metaCalls: Record<string, unknown>[] = [];
  const safetyCalls: unknown[] = [];
  await page.route("**/api/ai/post-meta", (route: Route) => {
    metaCalls.push(route.request().postDataJSON());
    return route.fulfill({ json: success(metaDraft) });
  });
  await mockSafety(page, safetyCalls);
  await ready(page, "/posts/new");
  const before = await saved(page);
  const generate = page.getByRole("button", { name: "AI 生成标题和标签" });
  await expect(generate).toBeDisabled();
  await body(page).fill("周末带年糕去江边散步，晒了一下午太阳");
  await generate.click();
  await expect(page.getByTestId("post-meta-draft")).toContainText(
    "#江边 #散步 #晒太阳",
  );
  // Only the body text is sent (no photo was ticked); nothing is written yet.
  expect(metaCalls).toEqual([{ text: "周末带年糕去江边散步，晒了一下午太阳" }]);
  expect(await saved(page)).toBe(before);
  await page.getByRole("button", { name: "填入表单（尚未发布）" }).click();
  const title = page.getByLabel("帖子标题", { exact: true });
  const tags = page.getByLabel("话题标签", { exact: true });
  await expect(title).toHaveValue("江边晒太阳的下午");
  await expect(title).toHaveAttribute("data-ai-filled", "true");
  await expect(tags).toHaveValue("#江边 #散步 #晒太阳");
  await expect(tags).toHaveAttribute("data-ai-filled", "true");
  await title.fill("江边晒太阳");
  await expect(title).not.toHaveAttribute("data-ai-filled", "true");
  await expect(tags).toHaveAttribute("data-ai-filled", "true");
  expect(await saved(page)).toBe(before);

  // Personal information: blocked by the program rule, no override, model not called.
  await body(page).fill("周末带年糕去江边散步，想约的打13800138000");
  await publishButton(page).click();
  await expect(panel(page)).toContainText("需要修改后才能发布");
  await expect(panel(page).locator("mark")).toHaveText("13800138000");
  await expect(panel(page)).toContainText("个人信息 · 程序规则 · 必须修改");
  await expect(panel(page)).toContainText("AI 预检未执行");
  await expect(
    panel(page).getByRole("button", { name: "仍要发布" }),
  ).toHaveCount(0);
  expect(safetyCalls).toHaveLength(0);
  expect(await saved(page)).toBe(before);

  // Editing clears the stale result; dangerous advice is a suggestion from both layers.
  await body(page).fill("周末带年糕去江边散步。它有点发烧，喂了半片布洛芬");
  await expect(panel(page)).toHaveCount(0);
  await publishButton(page).click();
  await expect(panel(page)).toContainText("预检建议修改");
  await expect(panel(page)).toContainText("危险建议 / 用药 · 程序规则");
  await expect(panel(page)).toContainText("危险建议 / 用药 · AI 判断");
  await expect(panel(page)).toContainText("人用药可能对狗狗有害");
  await expect(
    panel(page).getByRole("button", { name: "仍要发布" }),
  ).toBeVisible();
  expect(safetyCalls).toEqual([
    {
      title: "江边晒太阳",
      text: "周末带年糕去江边散步。它有点发烧，喂了半片布洛芬",
      tags: ["江边", "散步", "晒太阳"],
    },
  ]);
  expect(await saved(page)).toBe(before);

  // Fix the text and publish: both layers pass, so it publishes right away.
  await body(page).fill("周末带年糕去江边散步。它有点发烧，已经约了兽医");
  await publishButton(page).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("status")).toContainText(
    "程序规则与 AI 预检均未发现问题",
  );
  const card = page.locator(".note-card").first();
  await expect(card).toContainText("江边晒太阳");
  await card.locator(".note-main").click();
  await expect(page.getByLabel("话题标签")).toHaveText("#江边 #散步 #晒太阳");
  expect(safetyCalls).toHaveLength(2);
});

test("“仍要发布”：用户确认忽略广告导流建议", async ({ page }) => {
  const safetyCalls: unknown[] = [];
  await mockSafety(page, safetyCalls);
  await ready(page, "/posts/new");
  await body(page).fill("狗粮团购，扫码进群领优惠");
  await publishButton(page).click();
  await expect(panel(page)).toContainText("广告导流 · 程序规则");
  await expect(panel(page).locator("mark").first()).toHaveText("扫码");
  expect(await saved(page)).not.toContain("扫码进群");
  await panel(page).getByRole("button", { name: "仍要发布" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("status")).toContainText("你确认忽略了预检建议");
  expect(await saved(page)).toContain("扫码进群");
});

test("失败可见：AI 预检失败不显示通过，可重试；生成失败表单不变", async ({
  page,
}) => {
  let safety = 0;
  await page.route("**/api/ai/post-safety", (route: Route) => {
    safety++;
    return safety === 1
      ? route.fulfill({
          status: 504,
          json: {
            ok: false,
            requestId: "e2e-timeout",
            error: {
              code: "AI_UPSTREAM_TIMEOUT",
              message: "模型长时间未开始响应，请手动重试",
              retryable: true,
            },
          },
        })
      : route.fulfill({ json: success({ verdict: "pass", issues: [] }) });
  });
  await page.route("**/api/ai/post-meta", (route: Route) =>
    route.fulfill({
      status: 502,
      json: {
        ok: false,
        requestId: "e2e-invalid",
        error: {
          code: "AI_INVALID_OUTPUT",
          message: "标题和标签草稿未通过结构校验",
          retryable: false,
        },
      },
    }),
  );
  await ready(page, "/posts/new");
  const before = await saved(page);
  await body(page).fill("今天在草地上晒太阳");
  await page.getByRole("button", { name: "AI 生成标题和标签" }).click();
  await expect(page.getByRole("alert").first()).toContainText(
    "AI_INVALID_OUTPUT",
  );
  await expect(page.getByLabel("帖子标题", { exact: true })).toHaveValue("");
  await publishButton(page).click();
  await expect(page.getByTestId("ai-precheck-missing")).toContainText(
    "模型长时间未开始响应",
  );
  await expect(panel(page)).toContainText("AI 预检未执行");
  await expect(panel(page)).toContainText("不能视为预检通过");
  await expect(panel(page)).not.toContainText("已通过");
  expect(await saved(page)).toBe(before);
  await panel(page).getByRole("button", { name: "重试 AI 预检" }).click();
  await expect(page).toHaveURL("/");
  expect(safety).toBe(2);
});

test("AI 未配置（真实服务端 AI_ENABLED=false）：规则仍生效，可确认不经 AI 预检发布", async ({
  page,
}) => {
  await ready(page, "/posts/new");
  await body(page).fill("加我vx：pawpal_2026 一起遛狗");
  await publishButton(page).click();
  await expect(panel(page)).toContainText("需要修改后才能发布");
  await body(page).fill("周末一起遛狗吗");
  await publishButton(page).click();
  await expect(page.getByTestId("ai-precheck-missing")).toContainText(
    "AI 预检未执行：",
  );
  await panel(page).getByRole("button", { name: "不经 AI 预检发布" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("status")).toContainText("AI 预检未执行");
});

test("照片 + 一句话：勾选后才发送去除 EXIF 的 ≤512px 缩略图", async ({
  page,
}) => {
  const calls: Record<string, unknown>[] = [];
  await page.route("**/api/ai/post-meta", (route: Route) => {
    calls.push(route.request().postDataJSON());
    return route.fulfill({ json: success(metaDraft) });
  });
  await ready(page, "/posts/new");
  const tick = page.getByRole("checkbox", { name: /同时参考第一张照片/ });
  await expect(tick).toBeDisabled();
  await page
    .getByLabel("上传照片")
    .setInputFiles(path.resolve("tests/e2e/fixtures/dog-with-exif.jpg"));
  await expect(
    page.getByRole("img", { name: "已选照片 1", exact: true }),
  ).toBeVisible();
  await body(page).fill("今天的它");
  await page.getByRole("button", { name: "AI 生成标题和标签" }).click();
  await expect(page.getByTestId("post-meta-draft")).toBeVisible();
  expect(Object.keys(calls[0])).toEqual(["text"]);
  await tick.check();
  await page.getByRole("button", { name: "重新生成" }).click();
  await expect.poll(() => calls.length).toBe(2);
  expect(Object.keys(calls[1]).sort()).toEqual(["image", "text"]);
  const info = inspectJpegDataUrl(String(calls[1].image));
  expect(info).not.toBeNull();
  expect(Math.max(info!.width, info!.height)).toBeLessThanOrEqual(512);
  expect(info!.metadata).toBe(false);
});
