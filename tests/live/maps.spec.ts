import { expect, test } from "@playwright/test";
test("真实高德地图、四类 POI 与选点（无 SDK mock）", async ({ page }, info) => {
  const calls: { path: string; status: number; params: string[] }[] = [];
  let tileResponses = 0;
  const observations: { category: string; results: number }[] = [];
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (
      /amap\.com$/.test(url.hostname) &&
      /\/tile\/|\/web_map\/get_tile/.test(url.pathname) &&
      response.ok()
    )
      tileResponses++;
    if (url.pathname.startsWith("/_AMapService/")) {
      calls.push({
        path: url.pathname,
        status: response.status(),
        params: [...url.searchParams.keys()],
      });
      console.log(JSON.stringify(calls.at(-1)));
      if (response.status() !== 200) {
        const value = await response.json().catch(() => ({}));
        if (/^MAP_[A-Z_0-9]+$/.test(value.error)) console.log(value.error);
      }
    }
  });
  await page.goto("/discover");
  await expect(
    page.getByRole("button", { name: "切换演示身份" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "宠友地图", exact: true }).click();
  await expect(page.locator(".map-status"), "地图必须真实完成加载").toHaveCount(
    0,
    { timeout: 25000 },
  );
  await expect(page.locator(".map-marker")).toHaveCount(
    await page.locator("[data-pet-id]").count(),
  );
  await expect.soft
    .poll(() => tileResponses, { timeout: 30000, message: "真实底图资源返回" })
    .toBeGreaterThan(0);
  await page
    .locator(".map-canvas")
    .screenshot({ path: info.outputPath("real-map-detail.png") });
  await page.screenshot({
    path: info.outputPath("real-map.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "宠友列表", exact: true }).click();
  await page.getByRole("button", { name: "手动选择参考位置" }).click();
  await expect(page.locator(".map-status")).toHaveCount(0, { timeout: 20000 });
  for (const category of ["公园", "宠物医院", "宠物店", "咖啡店"]) {
    await page.getByRole("button", { name: category, exact: true }).click();
    await expect
      .soft(page.locator(".poi-results button").first(), `真实${category}查询`)
      .toBeVisible({ timeout: 16000 });
    observations.push({
      category,
      results: await page.locator(".poi-results button").count(),
    });
    if (!(await page.locator(".poi-results button").first().isVisible()))
      continue;
    await page.locator(".poi-results button").first().click();
    await expect(page.locator(".place-details")).toContainText("宠物准入未知");
    await expect(page.locator(".place-details a")).toHaveAttribute(
      "href",
      /^https:\/\/uri.amap.com\/navigation\?/,
    );
  }
  await page.screenshot({
    path: info.outputPath("real-poi.png"),
    fullPage: true,
  });
  await page.locator(".map-canvas").click({ position: { x: 100, y: 250 } });
  await expect
    .soft(page.locator(".place-details"))
    .toContainText("地图所选公共约定点", { timeout: 16000 });
  if (await page.getByRole("button", { name: "确认使用该地点" }).isVisible()) {
    await page.getByRole("button", { name: "确认使用该地点" }).click();
    await expect
      .soft(page.getByTestId("reference-label"))
      .toHaveText("地图所选公共约定点");
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await info.attach("proxy-paths-without-credentials", {
    body: JSON.stringify({ calls, observations, tileResponses }, null, 2),
    contentType: "application/json",
  });
  expect(calls.length).toBeGreaterThan(0);
  expect.soft(calls.every((call) => call.status === 200)).toBe(true);
});
