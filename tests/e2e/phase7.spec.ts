import { test, expect, Page, Route } from "@playwright/test";
import path from "node:path";
import { inspectJpegDataUrl } from "../../src/lib/ai/jpeg";

/** Mock of /api/ai/pet-photo (AI_ENABLED=false in E2E); every response is a fixture. */
const draft = (over: Record<string, unknown> = {}) => ({
  status: "recognized",
  dogConfidence: 0.95,
  breed: { value: "柯基", confidence: 0.86, accepted: true },
  size: { value: "small", confidence: 0.8, accepted: true },
  coatColor: { value: "黄白相间", confidence: 0.9, accepted: true },
  features: [
    { value: "立耳", confidence: 0.9, accepted: true },
    { value: "短腿", confidence: 0.4, accepted: false },
  ],
  removed: 0,
  messages: [],
  ...over,
});
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
async function ready(page: Page, url: string) {
  await page.goto(url);
  await expect(
    page.getByRole("button", { name: "切换演示身份" }),
  ).toBeEnabled();
}
const saved = (page: Page) =>
  page.evaluate(() => localStorage.getItem("pawmeet:state:v1"));
async function upload(page: Page) {
  await page
    .getByLabel("上传照片")
    .setInputFiles(path.resolve("tests/e2e/fixtures/dog-with-exif.jpg"));
  await expect(
    page.getByRole("img", { name: "已选照片 1", exact: true }),
  ).toBeVisible();
}
const recognize = (page: Page) =>
  page.getByRole("button", { name: "识别照片", exact: true });

test("拍照建档：点击才识别，只发送去除 EXIF 的 ≤512px JPEG；填入 → 修改 → 保存", async ({
  page,
}) => {
  const requests: {
    body: Record<string, unknown>;
    headers: Record<string, string>;
  }[] = [];
  await page.route("**/api/ai/pet-photo", (route: Route) => {
    requests.push({
      body: route.request().postDataJSON(),
      headers: route.request().headers(),
    });
    return route.fulfill({ json: success(draft()) });
  });
  await ready(page, "/me/pets/new");
  await expect(recognize(page)).toBeDisabled();
  await upload(page);
  const before = await saved(page);
  // Choosing a photo never calls the model by itself.
  await page.waitForTimeout(300);
  expect(requests).toHaveLength(0);
  await recognize(page).click();
  await expect(page.getByTestId("photo-draft")).toBeVisible();
  expect(requests).toHaveLength(1);
  const body = requests[0].body;
  expect(Object.keys(body)).toEqual(["image"]);
  const image = String(body.image);
  const info = inspectJpegDataUrl(image);
  expect(info).not.toBeNull();
  expect(Math.max(info!.width, info!.height)).toBeLessThanOrEqual(512);
  expect(info!.metadata).toBe(false);
  expect(
    Buffer.from(image.split(",")[1], "base64").toString("latin1"),
  ).not.toContain("PAWMEET-GPS-MARKER");
  expect(JSON.stringify(body)).not.toContain("pawmeet:state");
  // Recognition result is a draft only.
  expect(await saved(page)).toBe(before);
  await expect(page.getByTestId("photo-draft")).toContainText("柯基");
  await page.getByRole("button", { name: "填入表单（尚未保存）" }).click();
  const breed = page.getByLabel("品种", { exact: true });
  await expect(breed).toHaveValue("柯基");
  await expect(breed).toHaveAttribute("data-ai-filled", "true");
  await expect(page.getByLabel("体型", { exact: true })).toHaveValue("small");
  await expect(page.locator('textarea[name="notes"]')).toHaveValue(
    "外观：黄白相间、立耳",
  );
  expect(await saved(page)).toBe(before);
  await breed.fill("彭布罗克柯基");
  await expect(breed).not.toHaveAttribute("data-ai-filled", "true");
  await page.getByLabel("宠物名字", { exact: true }).fill("识图团子");
  await page.getByRole("button", { name: "确认保存档案" }).click();
  await expect(page).toHaveURL("/me");
  await page.reload();
  const pet = JSON.parse((await saved(page))!).pets.find(
    (p: { name: string }) => p.name === "识图团子",
  );
  expect(pet).toMatchObject({
    breed: "彭布罗克柯基",
    size: "small",
    socialNotes: "外观：黄白相间、立耳",
  });
});

test("拍照建档：失败可见、非狗不填，手填流程不受影响", async ({ page }) => {
  let reply: () => Parameters<Route["fulfill"]>[0] = () => ({
    status: 503,
    json: {
      ok: false,
      requestId: "e2e-fail",
      error: {
        code: "AI_NOT_CONFIGURED",
        message: "AI尚未配置：请在服务端设置DASHSCOPE_API_KEY并启用AI_ENABLED",
        retryable: false,
      },
    },
  });
  await page.route("**/api/ai/pet-photo", (route) => route.fulfill(reply()));
  await ready(page, "/me/pets/new");
  await upload(page);
  const before = await saved(page);
  await recognize(page).click();
  const failure = page.getByRole("alert").filter({ hasText: "照片识别失败" });
  await expect(failure).toBeVisible();
  await expect(failure).toContainText("AI_NOT_CONFIGURED");
  await expect(page.getByLabel("品种", { exact: true })).toHaveValue("");
  reply = () => ({
    json: success(
      draft({
        status: "not_dog",
        dogConfidence: 0.92,
        breed: { value: null, confidence: 0.1, accepted: false },
        size: { value: "unknown", confidence: 0.1, accepted: false },
        coatColor: { value: null, confidence: 0.1, accepted: false },
        features: [],
        messages: [
          "无法识别：照片里看起来不是狗，没有填入任何字段，请换一张或手动填写。",
        ],
      }),
    ),
  });
  await recognize(page).click();
  await expect(page.getByTestId("photo-messages")).toContainText("无法识别");
  await expect(
    page.getByRole("button", { name: "没有可填入的字段" }),
  ).toBeDisabled();
  expect(await saved(page)).toBe(before);
  await page.getByLabel("宠物名字", { exact: true }).fill("手填豆豆");
  await page.getByLabel("品种", { exact: true }).fill("比格");
  await page.getByLabel("体型", { exact: true }).selectOption("medium");
  await page.getByRole("button", { name: "确认保存档案" }).click();
  await expect(page).toHaveURL("/me");
  const pet = JSON.parse((await saved(page))!).pets.find(
    (p: { name: string }) => p.name === "手填豆豆",
  );
  expect(pet).toMatchObject({ breed: "比格", size: "medium" });
});

test("拍照建档：低置信度字段显示 AI 猜测，点“采用”才填入，保存后持久化", async ({
  page,
}) => {
  await page.route("**/api/ai/pet-photo", (route) =>
    route.fulfill({
      json: success(
        draft({
          breed: {
            value: "柴犬",
            confidence: 0.45,
            accepted: false,
            suggested: true,
          },
          size: {
            value: "medium",
            confidence: 0.8,
            accepted: true,
            suggested: false,
          },
          coatColor: { value: null, confidence: 0.1, accepted: false },
          features: [],
          messages: [
            "品种不确定（AI 猜测“柴犬”，把握 45%），未自动填入，可点“采用”或手动填写。",
          ],
        }),
      ),
    }),
  );
  await ready(page, "/me/pets/new");
  await upload(page);
  const before = await saved(page);
  await recognize(page).click();
  const suggestion = page.getByTestId("photo-suggest-breed");
  await expect(suggestion).toContainText("AI 猜测：柴犬（把握 45%），请确认");
  const breed = page.getByLabel("品种", { exact: true });
  await expect(breed).toHaveValue("");
  // Automatic fields still need the main button; the suggestion needs its own click.
  await page.getByRole("button", { name: "填入表单（尚未保存）" }).click();
  await expect(page.getByLabel("体型", { exact: true })).toHaveValue("medium");
  await expect(breed).toHaveValue("");
  await page.getByRole("button", { name: "采用品种 柴犬" }).click();
  await expect(breed).toHaveValue("柴犬");
  await expect(breed).toHaveAttribute("data-ai-filled", "true");
  await expect(suggestion).toContainText("已填入");
  expect(await saved(page)).toBe(before);
  await page.getByLabel("宠物名字", { exact: true }).fill("采用小柴");
  await page.getByRole("button", { name: "确认保存档案" }).click();
  await expect(page).toHaveURL("/me");
  const pet = JSON.parse((await saved(page))!).pets.find(
    (p: { name: string }) => p.name === "采用小柴",
  );
  expect(pet).toMatchObject({ breed: "柴犬", size: "medium" });
});

test("拍照建档：品种与体型冲突时按品种表的典型体型自动填入并显示提示", async ({
  page,
}) => {
  await page.route("**/api/ai/pet-photo", (route) =>
    route.fulfill({
      json: success(
        draft({
          breed: {
            value: "比格犬",
            confidence: 0.95,
            accepted: true,
            suggested: false,
          },
          size: {
            value: "medium",
            confidence: 0.85,
            accepted: true,
            suggested: false,
            modelValue: "small",
            hint: "体型按比格的典型体型（中型）填入，AI 原判断为小型",
          },
          coatColor: { value: "三色", confidence: 0.9, accepted: true },
          features: [],
          messages: [
            "体型按比格的典型体型（中型）填入，AI 原判断为小型，请复核。",
          ],
        }),
      ),
    }),
  );
  await ready(page, "/me/pets/new");
  await upload(page);
  const before = await saved(page);
  await recognize(page).click();
  await expect(page.getByTestId("photo-size-from-breed")).toContainText(
    "体型按比格的典型体型（中型）填入，AI 原判断为小型",
  );
  // No choice is asked for; the size is part of the automatic fill.
  await expect(page.getByTestId("photo-suggest-size")).toHaveCount(0);
  await page.getByRole("button", { name: "填入表单（尚未保存）" }).click();
  await expect(page.getByLabel("品种", { exact: true })).toHaveValue("比格犬");
  const size = page.getByLabel("体型", { exact: true });
  await expect(size).toHaveValue("medium");
  await expect(size).toHaveAttribute("data-ai-filled", "true");
  // Still nothing saved until the owner confirms.
  expect(await saved(page)).toBe(before);
  await page.getByLabel("宠物名字", { exact: true }).fill("比格豆豆");
  await page.getByRole("button", { name: "确认保存档案" }).click();
  await expect(page).toHaveURL("/me");
  const pet = JSON.parse((await saved(page))!).pets.find(
    (p: { name: string }) => p.name === "比格豆豆",
  );
  expect(pet).toMatchObject({ breed: "比格犬", size: "medium" });
});
