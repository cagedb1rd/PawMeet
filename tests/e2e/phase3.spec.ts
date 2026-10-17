import { expect, Page, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
async function ready(page: Page, url = "/discover") {
  await page.goto(url);
  await expect(
    page.getByRole("button", { name: "切换演示身份" }),
  ).toBeEnabled();
}
async function mockSDK(page: Page) {
  await page.route("**/api/maps/config", (route) =>
    route.fulfill({ json: { key: "e2e-public-fixture" } }),
  );
  const body = await readFile(
    path.resolve("tests/e2e/fixtures/amap-sdk.js"),
    "utf8",
  );
  await page.route("https://webapi.amap.com/maps?**", (route) =>
    route.fulfill({ contentType: "application/javascript", body }),
  );
}
const ids = (page: Page) =>
  page
    .locator("[data-pet-id]")
    .evaluateAll((elements) =>
      elements.map((e) => e.getAttribute("data-pet-id")),
    );
const date = (days: number, time: string) =>
  `${new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)}T${time}`;
test("本地距离、组合筛选、名片与约伴在无高德配置时可用", async ({ page }) => {
  await ready(page);
  const original = await ids(page);
  expect(original.length).toBeGreaterThan(0);
  const counts: number[] = [];
  for (const km of [1, 3, 5, 10]) {
    await page.getByRole("button", { name: `${km} 公里`, exact: true }).click();
    counts.push((await ids(page)).length);
  }
  expect(new Set(counts).size).toBe(4);
  await page.getByText("品种、体型和偏好筛选", { exact: true }).click();
  await page.getByRole("button", { name: "温和", exact: true }).click();
  await page.getByRole("button", { name: "柯基", exact: true }).click();
  await expect(page.getByText("没有找到这样的宠友")).toBeVisible();
  await page
    .getByRole("button", { name: "清除筛选", exact: true })
    .first()
    .click();
  expect(await ids(page)).toEqual(original);
  await page.getByLabel("按名称品种或区域搜索").fill("布丁");
  await page.locator(".pet-card-main").click();
  await expect(page).toHaveURL(/\/pets\/pet-2\/card/);
  await ready(page);
  await page
    .locator("[data-pet-id='pet-2']")
    .getByRole("link", { name: "发起约伴" })
    .click();
  await expect(page).toHaveURL(/recommendedPetId=pet-2/);
  await expect(page.getByText(/推荐约伴对象：布丁/)).toBeVisible();
});
test("SDK mock：地图和列表同集、标记点击、手动参考点与反复卸载", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await mockSDK(page);
  await ready(page);
  await page.getByRole("button", { name: "宠友地图", exact: true }).click();
  await expect(page.locator(".map-status")).toHaveCount(0);
  const originalState = await page.evaluate(() =>
    localStorage.getItem("pawmeet:state:v1"),
  );
  for (const km of [1, 3, 5, 10]) {
    await page.getByRole("button", { name: `${km} 公里`, exact: true }).click();
    await expect(page.locator(".map-marker")).toHaveCount(
      (await ids(page)).length,
    );
  }
  await page.getByRole("button", { name: "查看布丁", exact: true }).click();
  await expect(page.locator("[data-pet-id='pet-2']")).toHaveClass(
    /pet-selected/,
  );
  await expect(
    page.locator(".selected-pet").getByRole("link", { name: /社交名片/ }),
  ).toHaveAttribute("href", "/pets/pet-2/card");
  await page
    .locator("[data-pet-id='pet-3']")
    .getByRole("button", { name: "在地图查看" })
    .click();
  await expect(
    page.getByRole("button", { name: "查看可乐", exact: true }),
  ).toHaveClass(/selected/);
  await page.locator(".map-canvas").click({ position: { x: 12, y: 280 } });
  await expect(page.getByTestId("reference-label")).toHaveText(
    "地图手选公共参考点",
  );
  expect(
    await page.evaluate(() => localStorage.getItem("pawmeet:state:v1")),
  ).toBe(originalState);
  await page.screenshot({
    path: info.outputPath("discover-map-mock.png"),
    fullPage: true,
  });
  for (let i = 0; i < 3; i++) {
    await page.getByRole("button", { name: "宠友列表", exact: true }).click();
    await page.getByRole("button", { name: "宠友地图", exact: true }).click();
    await expect(page.locator(".map-status")).toHaveCount(0);
  }
  const lifecycle = await page.evaluate(() => [
    Number(document.body.dataset.mapsCreated),
    Number(document.body.dataset.mapsDestroyed),
  ]);
  expect(lifecycle[0] - lifecycle[1]).toBe(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
test("SDK mock：四类地点、空结果、失败、过时查询与地图选点", async ({
  page,
}) => {
  await mockSDK(page);
  await ready(page);
  await page.getByRole("button", { name: "调整位置", exact: true }).click();
  await page.getByRole("button", { name: "手动选择参考位置" }).click();
  await expect(page.locator(".map-status")).toHaveCount(0);
  for (const category of ["公园", "宠物医院", "宠物店", "咖啡店"]) {
    await page.getByRole("button", { name: category, exact: true }).click();
    await page
      .locator(".poi-results")
      .getByRole("button", { name: new RegExp(`测试${category}`) })
      .click();
    await expect(page.locator(".place-details")).toContainText(
      "携宠信息待确认",
    );
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByRole("button", { name: "公园", exact: true }).click();
    await expect(page.locator(".poi-results")).toContainText("测试公园");
  }
  await page.getByLabel("搜索附近地点").fill("慢查询");
  await expect(page.getByText("搜索中…", { exact: true })).toBeVisible();
  await page.getByLabel("搜索附近地点").fill("公园");
  await expect(page.locator(".poi-results")).toContainText("测试公园");
  await page.waitForTimeout(1300);
  await expect(page.locator(".poi-results")).not.toContainText("慢查询");
  await page.getByLabel("搜索附近地点").fill("空结果");
  await expect(
    page.getByText("附近没有搜索结果，请换关键词或手动输入。"),
  ).toBeVisible();
  await page.getByLabel("搜索附近地点").fill("失败");
  await expect(page.getByText(/高德服务失败/)).toBeVisible();
  await page.locator(".map-canvas").click({ position: { x: 12, y: 280 } });
  await expect(page.locator(".place-details")).toContainText(
    "SDK mock 公共入口地址",
  );
  await page.getByRole("button", { name: "确认使用该地点" }).click();
  await expect(page.getByTestId("reference-label")).toHaveText(
    "地图所选公共约定点",
  );
});
test("拒绝定位及 SDK 加载失败保留默认参考点和本地筛选", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "geolocation", {
      value: {
        getCurrentPosition: (
          _ok: unknown,
          fail: (error: { code: number }) => void,
        ) => fail({ code: 1 }),
      },
    });
  });
  await page.route("**/api/maps/config", (route) =>
    route.fulfill({ json: { key: "e2e-public-fixture" } }),
  );
  await page.route("https://webapi.amap.com/maps?**", (route) => route.abort());
  await ready(page);
  const original = await ids(page);
  if (await page.getByRole("button", { name: "调整位置", exact: true }).count())
    await page.getByRole("button", { name: "调整位置", exact: true }).click();
  await page.getByRole("button", { name: "使用当前位置" }).click();
  await expect(page.getByText(/定位权限已拒绝/)).toBeVisible();
  await expect(page.getByTestId("reference-label")).toContainText("杭州滨江");
  await page.getByRole("button", { name: "宠友地图", exact: true }).click();
  await expect(page.getByText(/高德地图加载失败或超时/)).toBeVisible();
  expect(await ids(page)).toEqual(original);
  await page.getByRole("button", { name: "1 公里", exact: true }).click();
  expect((await ids(page)).length).toBeLessThan(original.length);
});
test("SDK mock：主动定位只做一次官方转换且不持久化", async ({ page }) => {
  await mockSDK(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "geolocation", {
      value: {
        getCurrentPosition: (
          ok: (position: {
            coords: { longitude: number; latitude: number };
          }) => void,
        ) => ok({ coords: { longitude: 120.2, latitude: 30.2 } }),
      },
    });
  });
  await ready(page);
  const before = await page.evaluate(() =>
    localStorage.getItem("pawmeet:state:v1"),
  );
  if (await page.getByRole("button", { name: "调整位置", exact: true }).count())
    await page.getByRole("button", { name: "调整位置", exact: true }).click();
  await page.getByRole("button", { name: "使用当前位置" }).click();
  await expect(page.getByTestId("reference-label")).toContainText(
    "浏览器定位参考点",
  );
  expect(await page.evaluate(() => document.body.dataset.convertInput)).toBe(
    "120.2,30.2:gps",
  );
  expect(
    await page.evaluate(() => localStorage.getItem("pawmeet:state:v1")),
  ).toBe(before);
  await page.evaluate(() => {
    document.body.dataset.convertInput = "";
    navigator.geolocation.getCurrentPosition = (ok) => {
      window.addEventListener(
        "release-test-gps",
        () =>
          ok({
            coords: { longitude: 120.2, latitude: 30.2 },
          } as GeolocationPosition),
        { once: true },
      );
    };
  });
  if (await page.getByRole("button", { name: "调整位置", exact: true }).count())
    await page.getByRole("button", { name: "调整位置", exact: true }).click();
  await page.getByRole("button", { name: "使用当前位置" }).click();
  await page.getByRole("button", { name: "恢复滨江默认位置" }).click();
  await page.evaluate(() =>
    window.dispatchEvent(new Event("release-test-gps")),
  );
  await expect(page.getByTestId("reference-label")).toContainText("杭州滨江");
  expect(await page.evaluate(() => document.body.dataset.convertInput)).toBe(
    "",
  );
});
test("SDK mock：活动和互助保存同一 POI，导航跳转只传目的地点", async ({
  page,
}, info) => {
  await mockSDK(page);
  await ready(page, "/activities/new");
  await page.getByLabel("活动名称").fill("地图集合演示");
  await page.getByLabel("开始时间", { exact: true }).fill(date(3, "10:00"));
  await page.getByLabel("结束时间", { exact: true }).fill(date(3, "11:00"));
  await page.getByRole("button", { name: "地图搜索与选点" }).click();
  await page.getByRole("button", { name: "公园", exact: true }).click();
  await page.locator(".poi-results").getByRole("button").click();
  await page.getByRole("button", { name: "确认使用该地点" }).click();
  await page.getByRole("button", { name: "确认创建活动" }).click();
  await expect(page).toHaveURL("/activities");
  await page.getByRole("link", { name: /地图集合演示/ }).click();
  const saved = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("pawmeet:state:v1")!).activities.find(
        (a: { title: string }) => a.title === "地图集合演示",
      ).place,
  );
  expect(saved).toMatchObject({
    source: "amap",
    poiId: "B-MOCK-ONLY",
    petAccess: "unknown",
    location: { crs: "GCJ02", lng: 120.208, lat: 30.214 },
  });
  await page.context().route("https://uri.amap.com/**", (route) =>
    route.fulfill({
      body: "Navigation fixture: no live route or native app",
    }),
  );
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("link", { name: "在高德导航 ↗" }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  const target = new URL(popup.url());
  expect(target.searchParams.get("to")).toBe(`120.208,30.214,${saved.name}`);
  expect(target.searchParams.has("from")).toBe(false);
  await popup.close();
  await ready(page, "/help/new");
  await page.getByLabel("求助标题", { exact: true }).fill("地图交接演示");
  await page.getByLabel("需求说明", { exact: true }).fill("公共地点当面交接");
  await page.getByLabel("开始时间（北京时间）").fill(date(4, "10:00"));
  await page.getByLabel("结束时间（北京时间）").fill(date(4, "11:00"));
  await page.getByRole("button", { name: "地图搜索与选点" }).click();
  await page.getByRole("button", { name: "公园", exact: true }).click();
  await page.locator(".poi-results").getByRole("button").click();
  await page.getByRole("button", { name: "确认使用该地点" }).click();
  await page.getByRole("button", { name: "确认发布求助" }).click();
  await expect(page).toHaveURL("/help");
  await page.reload();
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("pawmeet:state:v1")!).helpRequests.find(
          (h: { title: string }) => h.title === "地图交接演示",
        ).place,
    ),
  ).toEqual(saved);
  await page.screenshot({
    path: info.outputPath("help-poi-mock.png"),
    fullPage: true,
  });
});
test("无地图时文字地点保存、刷新和编辑均保留且不能导航", async ({ page }) => {
  await ready(page, "/help/new");
  await page.getByLabel("求助标题", { exact: true }).fill("文字公共交接");
  await page
    .getByLabel("需求说明", { exact: true })
    .fill("公共点交接，请勿填写住址");
  await page.getByLabel("开始时间（北京时间）").fill(date(4, "10:00"));
  await page.getByLabel("结束时间（北京时间）").fill(date(4, "11:00"));
  await page.getByRole("button", { name: "文字地点", exact: true }).click();
  await page.getByLabel("文字地点名称").fill("公园南门文字点");
  await page.getByLabel("文字地点说明").fill("见面前再核对具体入口");
  await page.getByRole("button", { name: "确认文字地点" }).click();
  await page.getByRole("button", { name: "确认发布求助" }).click();
  await expect(page).toHaveURL("/help");
  await page
    .getByRole("article")
    .filter({ hasText: "文字公共交接" })
    .getByRole("link", { name: "查看求助与交接" })
    .click();
  await expect(page).toHaveURL(/\/help\/[^/]+$/);
  await page.reload();
  await expect(page.locator(".place-details")).toContainText("公园南门文字点");
  await expect(page.getByRole("link", { name: "在高德导航 ↗" })).toHaveCount(0);
  await page.getByRole("link", { name: "编辑求助", exact: true }).click();
  await page.getByRole("button", { name: "确认保存求助" }).click();
  await expect(page.locator(".place-details")).toContainText("公园南门文字点");
});
