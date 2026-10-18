import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
vi.mock("server-only", () => ({}));
import { NextRequest } from "next/server";
import { inspectJpeg, inspectJpegDataUrl } from "@/lib/ai/jpeg";
import { makeThumbnail, thumbnailSize } from "@/lib/ai/thumbnail";
import { estimateImageTokens, estimateTextTokens } from "@/lib/ai/estimate";
import {
  photoFill,
  photoSuggestions,
  reviewPetPhoto,
  forbiddenClaim,
} from "@/lib/ai/photo";
import { typicalSizes } from "@/lib/ai/breeds";
import {
  PetPhotoOutput,
  petPhotoDraftSchema,
  petPhotoOutputSchema,
} from "@/lib/ai/contracts";
import { callModel, thumbnailPart } from "@/server/ai/client";
import { MODEL_WHITELIST, PROVIDERS, resolveModel } from "@/server/ai/models";
import { recognizePetPhoto } from "@/server/ai/service";
import { POST } from "@/app/api/ai/[task]/route";

/** Synthetic JPEG header: SOI, APP0 JFIF, optional APP1 Exif, SOF0 with size, SOS, EOI. */
export function jpegBytes(width: number, height: number, exif = false) {
  const seg = (marker: number, payload: number[]) => [
    0xff,
    marker,
    (payload.length + 2) >> 8,
    (payload.length + 2) & 0xff,
    ...payload,
  ];
  const text = (s: string) => [...s].map((c) => c.charCodeAt(0));
  return new Uint8Array([
    0xff,
    0xd8,
    ...seg(0xe0, [...text("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...(exif ? seg(0xe1, [...text("Exif"), 0, 0, 1, 2, 3, 4]) : []),
    ...seg(0xc0, [
      8,
      height >> 8,
      height & 0xff,
      width >> 8,
      width & 0xff,
      3,
      1,
      0x22,
      0,
      2,
      0x11,
      1,
      3,
      0x11,
      1,
    ]),
    ...seg(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]),
    1,
    2,
    3,
    0xff,
    0xd9,
  ]);
}
const dataUrl = (bytes: Uint8Array) =>
  `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
const good = dataUrl(jpegBytes(512, 384));

const output = (over: Partial<PetPhotoOutput> = {}): PetPhotoOutput => ({
  dog: { value: "yes", confidence: 0.95 },
  multipleDogs: false,
  breed: { value: "柯基", confidence: 0.85 },
  size: { value: "small", confidence: 0.8 },
  coatColor: { value: "黄白相间", confidence: 0.9 },
  features: [
    { value: "立耳", confidence: 0.9 },
    { value: "短腿", confidence: 0.4 },
  ],
  ...over,
});
const usage = { prompt_tokens: 900, completion_tokens: 80, total_tokens: 980 };
function sse(content: string) {
  const events = [
    { choices: [{ index: 0, delta: { role: "assistant", content } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage },
  ];
  return new Response(
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}
const bodyOf = (t: ReturnType<typeof vi.fn<typeof fetch>>, i = 0) =>
  JSON.parse(t.mock.calls[i][1]!.body as string);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paw-photo-"));
  vi.stubEnv("QUOTA_STORE_PATH", path.join(dir, "quota.json"));
  vi.stubEnv("DASHSCOPE_API_KEY", "unit-secret-never-expose");
  vi.stubEnv("GEMINI_API_KEY", "unit-gemini-secret-never-expose");
  vi.stubEnv("AI_ENABLED", "true");
  vi.stubEnv("AI_MODEL", "");
  vi.stubEnv("AI_VISION_MODEL", "");
  vi.stubEnv("AI_STREAM", "");
  vi.stubEnv("AI_FIRST_BYTE_TIMEOUT_MS", "");
  vi.stubEnv("AI_TOTAL_TIMEOUT_MS", "");
  vi.stubEnv("AI_BASE_URL", "");
  vi.stubEnv("APP_ORIGIN", "https://paw.test");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("thumbnail: size and re-encoding", () => {
  it("scales the longest edge down to 512 and never up", () => {
    expect(thumbnailSize(4000, 3000)).toEqual({ width: 512, height: 384 });
    expect(thumbnailSize(1080, 1920)).toEqual({ width: 288, height: 512 });
    expect(thumbnailSize(300, 200)).toEqual({ width: 300, height: 200 });
    expect(thumbnailSize(5000, 3)).toEqual({ width: 512, height: 1 });
    expect(() => thumbnailSize(0, 10)).toThrow("尺寸");
  });
  function fakeCanvas(encode: (q: number) => Uint8Array) {
    const calls = {
      draw: [] as number[][],
      types: [] as string[],
      closed: false,
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: (_i: never, ...rest: number[]) => calls.draw.push(rest),
      }),
      toBlob(cb: (b: Blob | null) => void, type: string, q: number) {
        calls.types.push(type);
        cb(new Blob([encode(q) as BlobPart], { type }));
      },
    };
    const deps = {
      decode: async () => ({
        width: 4032,
        height: 3024,
        close: () => (calls.closed = true),
      }),
      createCanvas: () => canvas,
    };
    return { canvas, calls, deps };
  }
  it("draws onto a fresh ≤512px canvas and re-encodes as JPEG without metadata", async () => {
    const { canvas, calls, deps } = fakeCanvas(() => jpegBytes(512, 384));
    // The original carries Exif / GPS; only the redrawn pixels are encoded.
    const original = new Blob([jpegBytes(4032, 3024, true) as BlobPart], {
      type: "image/jpeg",
    });
    const thumb = await makeThumbnail(original, deps);
    expect([canvas.width, canvas.height]).toEqual([512, 384]);
    expect(calls.draw).toEqual([[0, 0, 512, 384]]);
    expect(calls.types).toEqual(["image/jpeg"]);
    expect(calls.closed).toBe(true);
    expect(thumb).toMatchObject({ width: 512, height: 384 });
    expect(thumb.dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(inspectJpegDataUrl(thumb.dataUrl)).toEqual({
      width: 512,
      height: 384,
      metadata: false,
    });
  });
  it("lowers quality until the thumbnail fits and refuses an encoder that kept metadata", async () => {
    const big = new Uint8Array(200 * 1024);
    big.set(jpegBytes(512, 384));
    const sized = fakeCanvas((q) => (q > 0.6 ? big : jpegBytes(512, 384)));
    await makeThumbnail(new Blob(["x"]), sized.deps);
    expect(sized.calls.types).toHaveLength(3);
    const leaky = fakeCanvas(() => jpegBytes(512, 384, true));
    await expect(makeThumbnail(new Blob(["x"]), leaky.deps)).rejects.toThrow(
      "缩略图检查未通过",
    );
    const undecodable = fakeCanvas(() => jpegBytes(1, 1));
    undecodable.deps.decode = async () => {
      throw Error("bad");
    };
    await expect(
      makeThumbnail(new Blob(["x"]), undecodable.deps),
    ).rejects.toThrow("无法解码");
  });
});

describe("JPEG inspection and server thumbnail check", () => {
  it("reads size and detects Exif", () => {
    expect(inspectJpeg(jpegBytes(640, 480))).toEqual({
      width: 640,
      height: 480,
      metadata: false,
    });
    expect(inspectJpeg(jpegBytes(64, 64, true))?.metadata).toBe(true);
    expect(inspectJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(inspectJpegDataUrl("data:image/png;base64,AAAA")).toBeNull();
  });
  it("accepts a clean ≤512px JPEG and rejects large, tiny, Exif or non-JPEG data", () => {
    expect(thumbnailPart(good)).toEqual({
      type: "image_url",
      image_url: { url: good },
    });
    expect(() => thumbnailPart(dataUrl(jpegBytes(600, 400)))).toThrow("512");
    expect(() => thumbnailPart(dataUrl(jpegBytes(12, 12)))).toThrow("过小");
    expect(() => thumbnailPart(dataUrl(jpegBytes(512, 384, true)))).toThrow(
      "EXIF",
    );
    expect(() => thumbnailPart("data:image/png;base64,AAAA")).toThrow("JPEG");
  });
});

describe("pet-photo business review", () => {
  it("fills only confident fields of a single dog", () => {
    const draft = reviewPetPhoto(output());
    expect(petPhotoDraftSchema.parse(draft)).toEqual(draft);
    expect(draft.status).toBe("recognized");
    expect(photoFill(draft)).toEqual({
      breed: "柯基",
      size: "small",
      appearance: "外观：黄白相间、立耳",
    });
  });
  it("low confidence leaves fields empty with a 不确定 hint, never a guess", () => {
    const draft = reviewPetPhoto(
      output({
        breed: { value: "柴犬", confidence: 0.45 },
        size: { value: "medium", confidence: 0.3 },
        coatColor: { value: "棕色", confidence: 0.2 },
        features: [{ value: "卷尾", confidence: 0.5 }],
      }),
    );
    expect(photoFill(draft)).toEqual({
      breed: undefined,
      size: undefined,
      appearance: undefined,
    });
    expect(draft.messages.join()).toContain("品种不确定");
    expect(draft.messages.join()).toContain("体型不确定");
    // unknown / 混血 breeds and unknown size are never filled even when confident.
    const unknown = reviewPetPhoto(
      output({
        breed: { value: "混血", confidence: 0.9 },
        size: { value: "unknown", confidence: 0.9 },
      }),
    );
    expect(photoFill(unknown).breed).toBeUndefined();
    expect(photoFill(unknown).size).toBeUndefined();
  });
  it("non-dog, unsure and multi-dog photos fill nothing and say why", () => {
    const notDog = reviewPetPhoto(
      output({ dog: { value: "no", confidence: 0.9 } }),
    );
    expect(notDog.status).toBe("not_dog");
    expect(notDog.messages[0]).toContain("无法识别");
    const unsure = reviewPetPhoto(
      output({ dog: { value: "yes", confidence: 0.5 } }),
    );
    expect(unsure.status).toBe("uncertain");
    expect(unsure.messages[0]).toContain("不确定");
    const lowNo = reviewPetPhoto(
      output({ dog: { value: "no", confidence: 0.3 } }),
    );
    expect(lowNo.status).toBe("uncertain");
    const multiple = reviewPetPhoto(output({ multipleDogs: true }));
    expect(multiple.status).toBe("multiple");
    for (const d of [notDog, unsure, lowNo, multiple])
      expect(photoFill(d)).toEqual({
        breed: undefined,
        size: undefined,
        appearance: undefined,
      });
  });
  it("drops diagnosis, age and temperament claims whatever their confidence", () => {
    const draft = reviewPetPhoto(
      output({
        breed: { value: "金毛幼犬", confidence: 0.95 },
        coatColor: { value: "浅金色", confidence: 0.9 },
        features: [
          { value: "疑似皮肤病", confidence: 0.9 },
          { value: "约2岁", confidence: 0.9 },
          { value: "性格温顺", confidence: 0.9 },
          { value: "偏胖需减肥", confidence: 0.9 },
          { value: "垂耳", confidence: 0.9 },
        ],
      }),
    );
    expect(draft.removed).toBe(5);
    const fill = photoFill(draft);
    expect(fill.breed).toBeUndefined();
    expect(fill.appearance).toBe("外观：浅金色、垂耳");
    expect(JSON.stringify(draft)).not.toMatch(/皮肤病|2岁|温顺|偏胖/);
    expect(draft.messages.join()).toContain("健康、年龄或性格");
    expect(forbiddenClaim("立耳")).toBe(false);
    expect(forbiddenClaim("需要打疫苗")).toBe(true);
  });
  it("the output schema has no health / age / temperament fields and is strict", () => {
    expect(
      petPhotoOutputSchema.safeParse({ ...output(), ageMonths: 12 }).success,
    ).toBe(false);
    expect(
      petPhotoOutputSchema.safeParse({
        ...output(),
        size: { value: "huge", confidence: 0.9 },
      }).success,
    ).toBe(false);
    expect(
      petPhotoOutputSchema.safeParse({
        ...output(),
        breed: { value: "柯基", confidence: 1.4 },
      }).success,
    ).toBe(false);
  });
});

describe("low-confidence suggestions and breed–size cross-check", () => {
  const none = { breed: undefined, size: undefined, appearance: undefined };
  it("a usable low-confidence guess becomes a suggestion, never an automatic fill", () => {
    const draft = reviewPetPhoto(
      output({
        breed: { value: "柴犬", confidence: 0.45 },
        size: { value: "medium", confidence: 0.3 },
        coatColor: { value: "赤色", confidence: 0.5 },
        features: [{ value: "卷尾", confidence: 0.4 }],
      }),
    );
    expect(photoFill(draft)).toEqual(none);
    expect(draft.breed).toMatchObject({ accepted: false, suggested: true });
    expect(photoSuggestions(draft)).toEqual({
      breed: { value: "柴犬", confidence: 0.45 },
      size: { value: "medium", confidence: 0.3 },
      appearance: "外观：赤色、卷尾",
    });
    expect(draft.messages.join()).toContain("AI 猜测“柴犬”，把握 45%");
  });
  it("no suggestions at all when the photo is not confidently one dog", () => {
    for (const over of [
      { dog: { value: "no" as const, confidence: 0.9 } },
      { dog: { value: "unsure" as const, confidence: 0.4 } },
      { dog: { value: "yes" as const, confidence: 0.5 } },
      { multipleDogs: true },
    ]) {
      const draft = reviewPetPhoto(
        output({ ...over, breed: { value: "柴犬", confidence: 0.4 } }),
      );
      expect(photoSuggestions(draft)).toEqual(none);
      expect(photoFill(draft)).toEqual(none);
    }
  });
  it("forbidden content is deleted, not offered as a suggestion", () => {
    const draft = reviewPetPhoto(
      output({
        breed: { value: "金毛幼犬", confidence: 0.4 },
        coatColor: { value: "浅金色", confidence: 0.4 },
        features: [
          { value: "疑似皮肤病", confidence: 0.3 },
          { value: "性格胆小", confidence: 0.3 },
        ],
      }),
    );
    expect(draft.removed).toBe(3);
    expect(photoSuggestions(draft).breed).toBeUndefined();
    expect(photoSuggestions(draft).appearance).toBe("外观：浅金色");
    expect(JSON.stringify(draft)).not.toMatch(/幼犬|皮肤病|胆小/);
  });
  it("a size outside a confidently recognised breed's range is replaced by the table's typical size", () => {
    // The dog-07 case from the live run: beagle 0.95, size small 0.85.
    const draft = reviewPetPhoto(
      output({
        breed: { value: "比格犬", confidence: 0.95 },
        size: { value: "small", confidence: 0.85 },
      }),
    );
    expect(photoFill(draft)).toMatchObject({ breed: "比格犬", size: "medium" });
    expect(draft.size).toMatchObject({
      value: "medium",
      accepted: true,
      suggested: false,
      modelValue: "small",
      hint: "体型按比格的典型体型（中型）填入，AI 原判断为小型",
    });
    expect(photoSuggestions(draft).size).toBeUndefined();
    expect(draft.messages.join()).toContain("AI 原判断为小型，请复核");
    // A low-confidence conflicting size is replaced the same way.
    const low = reviewPetPhoto(
      output({
        breed: { value: "比格", confidence: 0.9 },
        size: { value: "large", confidence: 0.4 },
      }),
    );
    expect(photoFill(low).size).toBe("medium");
    // Contested breed outside its range: 萨摩耶 allows medium / large, typical large.
    const samoyed = reviewPetPhoto(
      output({
        breed: { value: "萨摩耶", confidence: 0.95 },
        size: { value: "small", confidence: 0.85 },
      }),
    );
    expect(photoFill(samoyed).size).toBe("large");
    expect(samoyed.size.modelValue).toBe("small");
  });
  it("no replacement: consistent size, contested breed within range, breeds outside the table, low-confidence breed", () => {
    const fill = (
      breed: string,
      bc: number,
      size: "small" | "medium" | "large",
    ) =>
      photoFill(
        reviewPetPhoto(
          output({
            breed: { value: breed, confidence: bc },
            size: { value: size, confidence: 0.85 },
          }),
        ),
      ).size;
    expect(fill("比格", 0.95, "medium")).toBe("medium");
    // 萨摩耶 allows medium or large, so the model's medium (dog-11 answer) is kept.
    expect(fill("萨摩耶", 0.95, "medium")).toBe("medium");
    expect(fill("柴犬", 0.95, "small")).toBe("small");
    expect(fill("田园犬", 0.95, "small")).toBe("small");
    // Only a confirmed (≥0.6) breed is cross-checked; a low-confidence breed never replaces.
    expect(fill("比格", 0.4, "small")).toBe("small");
    const lowBreed = reviewPetPhoto(
      output({
        breed: { value: "比格", confidence: 0.4 },
        size: { value: "small", confidence: 0.85 },
      }),
    );
    expect(lowBreed.size.modelValue).toBeUndefined();
    expect(photoSuggestions(lowBreed).breed).toEqual({
      value: "比格",
      confidence: 0.4,
    });
  });
  it("synonyms and specific names resolve to the right table entry", () => {
    expect(typicalSizes("米格鲁")?.label).toBe("比格");
    expect(typicalSizes("比格犬")?.label).toBe("比格");
    expect(typicalSizes("泰迪")?.sizes).toEqual(["small"]);
    expect(typicalSizes("萨摩耶犬")).toMatchObject({
      typical: "large",
      sizes: ["medium", "large"],
    });
    expect(typicalSizes("法国斗牛犬")?.label).toBe("法国斗牛犬");
    expect(typicalSizes("英国斗牛犬")?.label).toBe("英国斗牛犬");
    expect(typicalSizes("金毛寻回犬")?.sizes).toEqual(["large"]);
    expect(typicalSizes("德 牧")?.label).toBe("德国牧羊犬");
    expect(typicalSizes("田园犬")).toBeNull();
    expect(typicalSizes(null)).toBeNull();
  });
});

describe("vision whitelist and per-model request shape", () => {
  it("vision group = 2 Qwen-Omni + 2 Gemini, default qwen3.8-omni-flash, no cross-group names", () => {
    expect(MODEL_WHITELIST.vision.map((m) => m.id)).toEqual([
      "qwen3.8-omni-flash",
      "qwen3.5-omni-plus",
      "gemini-3.5-flash-lite",
      "gemini-3.8-flash",
    ]);
    expect(resolveModel("vision").id).toBe("qwen3.8-omni-flash");
    expect(() => resolveModel("vision", "qwen3.8-flash")).toThrow("白名单");
    expect(() => resolveModel("vision", "gemini-3-pro")).toThrow("白名单");
    expect(() => resolveModel("text", "qwen3.5-omni-plus")).toThrow("白名单");
    expect(resolveModel("text", "gemini-3.8-flash").images).toBe(false);
  });
  const messages = [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "JSON" }, thumbnailPart(good)],
    },
  ];
  it.each([
    ["gemini-3.5-flash-lite", "minimal"],
    ["gemini-3.8-flash", "low"],
  ])(
    "%s: Gemini endpoint, strict JSON Schema, reasoning %s, image tokens 1120",
    async (model, effort) => {
      vi.stubEnv("AI_VISION_MODEL", model);
      const t = vi.fn<typeof fetch>().mockResolvedValue(sse("{}"));
      const reserve = vi.fn();
      await callModel(
        messages,
        "s",
        "r",
        undefined,
        t,
        { type: "object" },
        {
          kind: "vision",
          reserve,
        },
      );
      expect(t.mock.calls[0][0]).toBe(PROVIDERS.gemini.url);
      const body = bodyOf(t);
      expect(body.response_format.type).toBe("json_schema");
      expect(body.reasoning_effort).toBe(effort);
      expect(body.temperature).toBeUndefined();
      expect(body.modalities).toBeUndefined();
      expect(body.max_tokens).toBe(2048);
      const worst = reserve.mock.calls[0][0];
      expect(worst).toBeGreaterThan(2048 + 1120);
      expect(worst).toBeLessThan(2048 + 1120 + 600);
    },
  );
  it("Qwen-Omni image tokens follow the 28px upper-bound rule for the real thumbnail size", async () => {
    const t = vi.fn<typeof fetch>().mockResolvedValue(sse("{}"));
    const reserve = vi.fn();
    await callModel(
      messages,
      "s",
      "r",
      undefined,
      t,
      { type: "object" },
      {
        kind: "vision",
        reserve,
      },
    );
    const image = estimateImageTokens("qwen", { width: 512, height: 384 });
    expect(image).toBe(19 * 14 + 2);
    const worst = reserve.mock.calls[0][0];
    expect(worst).toBeGreaterThan(1000 + image);
    expect(worst).toBeLessThan(1000 + image + 600);
  });
});

describe("token estimate (not below billed tokens)", () => {
  it("counts ASCII as ≤1 token per char, common CJK as 1.5, other characters by UTF-8 bytes", () => {
    expect(estimateTextTokens("hello")).toBe(5);
    expect(estimateTextTokens("你好，狗")).toBe(6);
    expect(estimateTextTokens("🐶")).toBe(4);
    const chinese = "两岁史宾格，活泼，喜欢追球".repeat(20);
    // The previous UTF-8 byte estimate charged 3 per Chinese character.
    expect(estimateTextTokens(chinese)).toBeLessThan(
      Buffer.byteLength(chinese) * 0.6,
    );
    expect(estimateTextTokens(chinese)).toBeGreaterThanOrEqual(
      [...chinese].length,
    );
  });
  it("image rules: Qwen grid +2 capped at the default max, Gemini 3 fixed 1120", () => {
    expect(estimateImageTokens("qwen", { width: 28, height: 28 })).toBe(6);
    expect(estimateImageTokens("qwen", null)).toBe(2562);
    expect(estimateImageTokens("qwen", { width: 9000, height: 9000 })).toBe(
      2562,
    );
    expect(estimateImageTokens("gemini3", { width: 10, height: 10 })).toBe(
      1120,
    );
  });
});

describe("recognizePetPhoto service", () => {
  it("sends system prompt + thumbnail as a vision call and returns the reviewed draft", async () => {
    const call = vi.fn().mockResolvedValue({
      message: { role: "assistant", content: JSON.stringify(output()) },
      usage,
      model: "qwen3.8-omni-flash",
    });
    const r = await recognizePetPhoto({ image: good }, "s", "r", call);
    const [messages, , , tools, , schema, options] = call.mock.calls[0];
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("JSON");
    expect(messages[1].content[1]).toEqual({
      type: "image_url",
      image_url: { url: good },
    });
    expect(tools).toBeUndefined();
    expect(schema).toBeTruthy();
    expect(options).toMatchObject({ kind: "vision", retry: "idempotent" });
    expect(r.data.status).toBe("recognized");
    expect(r.data.breed).toEqual({
      value: "柯基",
      confidence: 0.85,
      accepted: true,
      suggested: false,
    });
  });
  it("accepts one Markdown fence but rejects non-JSON or off-schema output as AI_INVALID_OUTPUT", async () => {
    const reply = (content: string) =>
      vi.fn().mockResolvedValue({
        message: { role: "assistant", content },
        usage,
        model: "m",
      });
    await expect(
      recognizePetPhoto(
        { image: good },
        "s",
        "r",
        reply("```json\n" + JSON.stringify(output()) + "\n```"),
      ),
    ).resolves.toMatchObject({ data: { status: "recognized" } });
    for (const bad of [
      "这是一只柯基",
      JSON.stringify({ ...output(), health: "良好" }),
      JSON.stringify({ breed: "柯基" }),
    ])
      await expect(
        recognizePetPhoto({ image: good }, "s", "r", reply(bad)),
      ).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT" });
  });
  it("rejects an invalid thumbnail before any model call", async () => {
    const call = vi.fn();
    await expect(
      recognizePetPhoto(
        { image: dataUrl(jpegBytes(1024, 768)) },
        "s",
        "r",
        call,
      ),
    ).rejects.toMatchObject({ code: "AI_INPUT" });
    expect(call).not.toHaveBeenCalled();
  });
});

describe("POST /api/ai/pet-photo", () => {
  const post = (body: unknown, raw?: string) =>
    POST(
      new NextRequest("https://paw.test/api/ai/pet-photo", {
        method: "POST",
        headers: {
          origin: "https://paw.test",
          "Content-Type": "application/json",
        },
        body: raw ?? JSON.stringify(body),
      }),
      { params: Promise.resolve({ task: "pet-photo" }) },
    );
  it("returns a reviewed draft from the default vision model; the upstream gets only the thumbnail", async () => {
    const t = vi
      .fn<typeof fetch>()
      .mockResolvedValue(sse(JSON.stringify(output())));
    vi.stubGlobal("fetch", t);
    const res = await post({ image: good });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.meta).toMatchObject({
      provider: "qwen",
      model: "qwen3.8-omni-flash",
      promptVersion: "pawmeet-photo-2",
    });
    expect(json.data.status).toBe("recognized");
    expect(json.data.breed.accepted).toBe(true);
    expect(JSON.stringify(json)).not.toContain("unit-secret");
    const body = bodyOf(t);
    expect(body.model).toBe("qwen3.8-omni-flash");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.reasoning_effort).toBe("none");
    expect(body.modalities).toEqual(["text"]);
    const images = JSON.stringify(body.messages).match(/data:image/g);
    expect(images).toHaveLength(1);
  });
  it("visible errors: not configured, bad thumbnail, extra fields, oversize, invalid output, upstream 429", async () => {
    const t = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", t);
    vi.stubEnv("AI_ENABLED", "false");
    let res = await post({ image: good });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("AI_NOT_CONFIGURED");
    vi.stubEnv("AI_ENABLED", "true");
    res = await post({ image: dataUrl(jpegBytes(800, 600)) });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("AI_INPUT");
    res = await post({ image: dataUrl(jpegBytes(400, 300, true)) });
    expect((await res.json()).error.message).toContain("EXIF");
    // The browser cannot choose a model or add context such as localStorage.
    res = await post({ image: good, model: "gemini-3.8-flash" });
    expect(res.status).toBe(400);
    res = await post(undefined, JSON.stringify({ image: "A".repeat(180000) }));
    expect(res.status).toBe(413);
    expect(t).not.toHaveBeenCalled();
    t.mockResolvedValue(sse("这是一只柯基，不是JSON"));
    res = await post({ image: good });
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("AI_INVALID_OUTPUT");
    t.mockReset();
    t.mockImplementation(async () => new Response("{}", { status: 429 }));
    res = await post({ image: good });
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("AI_UPSTREAM_HTTP_429");
  });
});
