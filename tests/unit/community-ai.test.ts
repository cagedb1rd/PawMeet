import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
vi.mock("server-only", () => ({}));
import { NextRequest } from "next/server";
import { normalizeWidth, precheckKey, rulePrecheck } from "@/domain/moderation";
import { parseTags, formatTags, communityPosts } from "@/domain/community";
import { postInputSchema } from "@/domain/schemas";
import { execute } from "@/domain/commands";
import { createSeed } from "@/data/seed";
import {
  aiFindings,
  reviewPostMeta,
  reviewPostSafety,
  ungroundedClaim,
} from "@/lib/ai/community";
import {
  postMetaDraftSchema,
  postMetaOutputSchema,
  postSafetyOutputSchema,
  type PostMetaOutput,
} from "@/lib/ai/contracts";
import { generatePostMeta, precheckPost } from "@/server/ai/service";
import { POST } from "@/app/api/ai/[task]/route";

const check = (text: string, title = "", tags: string[] = []) =>
  rulePrecheck({ title, text, tags });

describe("rule precheck: personal information (blocking)", () => {
  it.each([
    ["手机号连写", "有意向联系13800138000", "13800138000"],
    ["手机号空格", "电话 138 0013 8000 随时打", "138 0013 8000"],
    ["手机号带 +86 和横线", "+86-138-0013-8000", "+86-138-0013-8000"],
    ["全角数字手机号", "联系１３９１２３４５６７８", "１３９１２３４５６７８"],
    ["座机", "店里电话0571-88886666", "0571-88886666"],
    ["微信号", "加我微信：paw_lover88 一起遛", "微信：paw_lover88"],
    ["vx 数字", "vx 123456789", "vx 123456789"],
    ["V信", "V信是abc_def1", "V信是abc_def1"],
    ["QQ 号", "QQ号 12345678", "QQ号 12345678"],
    ["QQ 群", "qq群：987654321", "qq群：987654321"],
    ["门牌号", "江南大道123号楼下", "江南大道123号"],
    ["楼栋单元", "住在5栋2单元301室", "5栋"],
    ["身份证", "身份证11010119900307123X", "11010119900307123X"],
  ])("%s", (_, text, excerpt) => {
    const findings = check(text);
    const hit = findings.find((f) => f.category === "personal_info");
    expect(hit, JSON.stringify(findings)).toBeDefined();
    expect(hit!.blocking).toBe(true);
    expect(hit!.source).toBe("rule");
    expect(hit!.field).toBe("text");
    expect(hit!.excerpt).toBe(excerpt);
  });
  it("checks title and tags separately and reports the field", () => {
    const f = check("正常正文", "电话13800138000", ["微信abcdef1"]);
    expect(f.map((x) => [x.field, x.category])).toEqual([
      ["title", "personal_info"],
      ["tags", "personal_info"],
    ]);
  });
  it("keeps original characters in excerpts after width normalisation", () => {
    expect(normalizeWidth("１３８ＡＢ：")).toBe("138AB:");
    expect(normalizeWidth("１３８").length).toBe(3);
  });
});

describe("rule precheck: other categories (suggestions, not blocking)", () => {
  it.each([
    ["外链", "详情看 https://example.com/shop", "ad_redirect"],
    ["裸域名", "去 taobao.com 搜", "ad_redirect"],
    ["扫码进群", "扫码进群领狗粮", "ad_redirect"],
    ["加微信无号", "想要的加我微信", "ad_redirect"],
    ["代购", "日本狗粮代购包邮", "ad_redirect"],
    ["辱骂", "楼下那个人就是个傻逼", "abuse"],
    ["英文缩写辱骂", "you sb", "abuse"],
    ["虐待", "邻居一直虐待狗狗", "animal_cruelty"],
    ["打死", "吵就打死它", "animal_cruelty"],
    ["人用药", "狗狗发烧了，喂了半片布洛芬就好了", "dangerous_advice"],
    ["人用药倒序", "对乙酰氨基酚可以给狗吃", "dangerous_advice"],
    [
      "前一句的“别”不算否定",
      "发烧了别慌，喂半片布洛芬就好",
      "dangerous_advice",
    ],
    ["有毒食物", "奖励它吃，喂了一把葡萄", "dangerous_advice"],
  ])("%s", (_, text, category) => {
    const f = check(text);
    expect(f.map((x) => x.category)).toContain(category);
    expect(f.every((x) => !x.blocking)).toBe(true);
  });
});

describe("rule precheck: false-positive samples stay clean", () => {
  it.each([
    "今天走了13800步，累坏了",
    "2026年10月19日下午3点在公园",
    "坐地铁1号线去江边",
    "第3单元的课今天上完了",
    "千万别给狗吃巧克力和葡萄！",
    "不要喂布洛芬，发烧请看兽医",
    "我感冒了吃了感冒药，它一直陪着我",
    "饿死我了，回家先吃饭",
    "狗粮 199 元一袋，有点贵",
    "微信步数今天 20000",
    "今天带它打了疫苗，很勇敢",
    "18:30 集合，带上水和拾便袋",
    "看到一对情侣在秀恩爱",
  ])("%s", (text) => {
    expect(check(text)).toEqual([]);
  });
  it("is deterministic and de-duplicated", () => {
    const f = check("13800138000 13800138000");
    expect(f).toHaveLength(1);
    expect(check("13800138000")).toEqual(f);
  });
  it("precheckKey changes with any edit", () => {
    const a = precheckKey({ title: "t", text: "x", tags: ["a"] });
    expect(precheckKey({ title: "t ", text: " x", tags: ["a"] })).toBe(a);
    expect(precheckKey({ title: "t", text: "x!", tags: ["a"] })).not.toBe(a);
    expect(precheckKey({ title: "t", text: "x", tags: ["b"] })).not.toBe(a);
  });
});

describe("post tags in the business schema", () => {
  const base = { title: "", text: "日常", petIds: [], images: [] };
  it("parses the tag field and defaults to no tags", () => {
    expect(parseTags("#柯基 #海边，周末  #柯基")).toEqual([
      "柯基",
      "海边",
      "周末",
    ]);
    expect(parseTags("  ")).toEqual([]);
    expect(formatTags(["a", "b"])).toBe("#a #b");
    expect(postInputSchema.parse(base).tags).toEqual([]);
  });
  it("rejects more than 5, invalid characters, over-long or duplicate tags", () => {
    const tags = (tags: string[]) =>
      postInputSchema.safeParse({ ...base, tags }).success;
    expect(tags(["a", "b", "c", "d", "e"])).toBe(true);
    expect(tags(["a", "b", "c", "d", "e", "f"])).toBe(false);
    expect(tags(["有空格 的"])).toBe(false);
    expect(tags(["一二三四五六七八九十一二三"])).toBe(false);
    expect(tags(["a", "a"])).toBe(false);
  });
  it("publish-post stores tags and search finds them; old posts without tags still load", () => {
    const state = createSeed();
    expect(state.posts.every((p) => Array.isArray(p.tags))).toBe(true);
    const next = execute(state, {
      type: "publish-post",
      input: { ...base, text: "海边日常", tags: ["沙滩撒欢"] },
    });
    expect(next.posts[0].tags).toEqual(["沙滩撒欢"]);
    expect(communityPosts(next, false, "#沙滩撒欢")[0].id).toBe(
      next.posts[0].id,
    );
  });
});

const meta = (over: Partial<PostMetaOutput> = {}): PostMetaOutput => ({
  title: "周末海边撒欢",
  tags: ["柯基", "海边", "周末遛狗"],
  note: null,
  ...over,
});
const source = "周末带柯基去海边，跑了一下午";

describe("post title / tags review", () => {
  it("normalises and accepts a valid draft", () => {
    const d = reviewPostMeta(
      meta({
        title: "《周末海边撒欢》",
        tags: ["#柯基", " 海边 ", "＃周末遛狗"],
      }),
      source,
    );
    expect(d).toEqual({
      title: "周末海边撒欢",
      tags: ["柯基", "海边", "周末遛狗"],
      note: null,
      removed: 0,
    });
    expect(postMetaDraftSchema.parse(d)).toEqual(d);
  });
  it("title must be 1–20 characters; it is never truncated", () => {
    expect(() =>
      reviewPostMeta(meta({ title: "一".repeat(21) }), source),
    ).toThrow("1–20");
    expect(
      reviewPostMeta(meta({ title: "一".repeat(20) }), source).title,
    ).toHaveLength(20);
  });
  it("drops invalid, duplicate and extra tags, and needs at least 3", () => {
    const d = reviewPostMeta(
      meta({
        tags: [
          "柯基",
          "柯基",
          "海 边!",
          "一二三四五六七八九十一二三",
          "海边",
          "周末",
          "晒太阳",
          "撒欢",
          "快乐",
        ],
      }),
      source,
    );
    expect(d.tags).toEqual(["柯基", "海边", "周末", "晒太阳", "撒欢"]);
    expect(d.removed).toBe(4);
    expect(() =>
      reviewPostMeta(meta({ tags: ["柯基", "海 边"] }), source),
    ).toThrow("少于 3");
  });
  it("removes health / identity claims that the body does not state", () => {
    expect(ungroundedClaim("打疫苗", "今天打了疫苗")).toBe(false);
    expect(ungroundedClaim("疫苗", "今天去海边")).toBe(true);
    const d = reviewPostMeta(
      meta({ tags: ["柯基", "海边", "皮肤过敏", "兽医推荐", "周末"] }),
      source,
    );
    expect(d.tags).toEqual(["柯基", "海边", "周末"]);
    expect(d.removed).toBe(2);
    expect(() =>
      reviewPostMeta(meta({ title: "兽医教你带柯基去海边" }), source),
    ).toThrow("健康或身份");
    expect(
      reviewPostMeta(
        meta({ tags: ["疫苗", "勇敢", "柯基"] }),
        "柯基今天打疫苗很勇敢",
      ).tags,
    ).toEqual(["疫苗", "勇敢", "柯基"]);
  });
  it("never lets personal information into the draft", () => {
    expect(() =>
      reviewPostMeta(meta({ title: "联系13800138000" }), source),
    ).toThrow("个人信息");
    expect(
      reviewPostMeta(meta({ note: "可以加微信abc12345" }), source).note,
    ).toBeNull();
  });
  it("raw output schema rejects extra fields", () => {
    expect(
      postMetaOutputSchema.safeParse({ ...meta(), health: "好" }).success,
    ).toBe(false);
  });
});

describe("AI safety review", () => {
  const content = {
    title: "周末",
    text: "狗狗发烧，喂了半片布洛芬",
    tags: ["日常"],
  };
  it("locates verbatim excerpts and keeps unlocated reasons without highlight", () => {
    const r = reviewPostSafety(
      {
        verdict: "revise",
        issues: [
          {
            category: "dangerous_advice",
            excerpt: "喂了半片布洛芬",
            reason: "人用药有风险",
          },
          { category: "other", excerpt: "不在原文", reason: "说明" },
        ],
      },
      content,
    );
    expect(r.issues[0]).toMatchObject({
      field: "text",
      excerpt: "喂了半片布洛芬",
    });
    expect(r.issues[1]).toMatchObject({
      field: null,
      excerpt: null,
      reason: "说明",
    });
    expect(aiFindings(r).every((f) => f.source === "ai" && !f.blocking)).toBe(
      true,
    );
  });
  it("pass with issues becomes revise; revise without issues is unusable", () => {
    expect(
      reviewPostSafety(
        {
          verdict: "pass",
          issues: [{ category: "abuse", excerpt: "周末", reason: "x" }],
        },
        content,
      ).verdict,
    ).toBe("revise");
    expect(() =>
      reviewPostSafety({ verdict: "revise", issues: [] }, content),
    ).toThrow();
    expect(
      postSafetyOutputSchema.safeParse({
        verdict: "pass",
        issues: [],
        score: 1,
      }).success,
    ).toBe(false);
  });
});

/** Synthetic baseline JPEG header with the given size (see pet-photo.test.ts). */
function jpeg(width: number, height: number) {
  const seg = (marker: number, payload: number[]) => [
    0xff,
    marker,
    (payload.length + 2) >> 8,
    (payload.length + 2) & 0xff,
    ...payload,
  ];
  const bytes = new Uint8Array([
    0xff,
    0xd8,
    ...seg(0xe0, [74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
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
  return `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
}
const usage = { prompt_tokens: 500, completion_tokens: 60, total_tokens: 560 };
const reply = (content: string) =>
  vi.fn().mockResolvedValue({
    message: { role: "assistant", content },
    usage,
    model: "m",
  });

describe("community services (fake model)", () => {
  it("post-meta: text model without image, vision model with a checked thumbnail", async () => {
    const call = reply(JSON.stringify(meta()));
    await generatePostMeta({ text: source }, "s", "r", call);
    expect(call.mock.calls[0][6]).toMatchObject({
      kind: "text",
      retry: "idempotent",
    });
    expect(typeof call.mock.calls[0][1]).toBe("string");
    const image = jpeg(512, 384);
    await generatePostMeta({ text: source, image }, "s", "r", call);
    expect(call.mock.calls[1][6]).toMatchObject({ kind: "vision" });
    const user = call.mock.calls[1][0][1].content;
    expect(user[1]).toEqual({ type: "image_url", image_url: { url: image } });
    // Oversized thumbnails are rejected before any call.
    const before = call.mock.calls.length;
    await expect(
      generatePostMeta(
        { text: source, image: jpeg(1024, 768) },
        "s",
        "r",
        call,
      ),
    ).rejects.toMatchObject({ code: "AI_INPUT" });
    expect(call.mock.calls.length).toBe(before);
  });
  it("post-meta: non-JSON, off-schema or failed review are AI_INVALID_OUTPUT", async () => {
    for (const bad of [
      "标题：周末",
      JSON.stringify({ title: "x" }),
      JSON.stringify(meta({ title: "一".repeat(30) })),
      JSON.stringify(meta({ tags: ["柯基"] })),
    ])
      await expect(
        generatePostMeta({ text: source }, "s", "r", reply(bad)),
      ).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT" });
  });
  it("post-safety: sends only title / text / tags and reviews the verdict", async () => {
    const call = reply(
      "```json\n" +
        JSON.stringify({
          verdict: "revise",
          issues: [{ category: "abuse", excerpt: "傻", reason: "辱骂" }],
        }) +
        "\n```",
    );
    const input = { title: "t", text: "你真傻", tags: ["日常"] };
    const r = await precheckPost(input, "s", "r", call);
    expect(r.data.verdict).toBe("revise");
    const sent = String(call.mock.calls[0][0][1].content);
    expect(sent).toContain(JSON.stringify(input));
    await expect(
      precheckPost(
        input,
        "s",
        "r",
        reply(JSON.stringify({ verdict: "revise", issues: [] })),
      ),
    ).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT" });
  });
});

describe("POST /api/ai/post-meta and post-safety", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "paw-community-"));
    vi.stubEnv("QUOTA_STORE_PATH", path.join(dir, "quota.json"));
    vi.stubEnv("DASHSCOPE_API_KEY", "unit-secret-never-expose");
    vi.stubEnv("GEMINI_API_KEY", "unit-gemini-secret-never-expose");
    vi.stubEnv("AI_ENABLED", "true");
    vi.stubEnv("AI_MODEL", "");
    vi.stubEnv("AI_VISION_MODEL", "");
    vi.stubEnv("AI_STREAM", "false");
    vi.stubEnv("AI_BASE_URL", "");
    vi.stubEnv("APP_ORIGIN", "https://paw.test");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });
  const post = (task: string, body: unknown) =>
    POST(
      new NextRequest(`https://paw.test/api/ai/${task}`, {
        method: "POST",
        headers: {
          origin: "https://paw.test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ task }) },
    );
  const upstream = (content: string) =>
    new Response(
      JSON.stringify({
        choices: [
          { finish_reason: "stop", message: { role: "assistant", content } },
        ],
        usage,
      }),
      { headers: { "content-type": "application/json" } },
    );
  const bodyOf = (t: ReturnType<typeof vi.fn<typeof fetch>>, i = 0) =>
    JSON.parse(t.mock.calls[i][1]!.body as string);

  it("model choice is configuration-driven: AI_MODEL for text, AI_VISION_MODEL with a photo", async () => {
    vi.stubEnv("AI_MODEL", "gemini-3.8-flash");
    vi.stubEnv("AI_VISION_MODEL", "gemini-3.5-flash-lite");
    const t = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => upstream(JSON.stringify(meta())));
    vi.stubGlobal("fetch", t);
    let res = await post("post-meta", { text: source });
    let json = await res.json();
    expect(res.status).toBe(200);
    expect(json.meta).toMatchObject({
      provider: "gemini",
      model: "gemini-3.8-flash",
      promptVersion: "pawmeet-community-1",
    });
    expect(json.data.tags).toEqual(["柯基", "海边", "周末遛狗"]);
    expect(bodyOf(t).response_format.type).toBe("json_schema");
    res = await post("post-meta", { text: source, image: jpeg(400, 300) });
    json = await res.json();
    expect(json.meta.model).toBe("gemini-3.5-flash-lite");
    expect(JSON.stringify(json)).not.toContain("unit-gemini-secret");
  });
  it("defaults stay qwen3.8-flash; the browser cannot pick a model or add fields", async () => {
    const t = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        upstream(JSON.stringify({ verdict: "pass", issues: [] })),
      );
    vi.stubGlobal("fetch", t);
    const res = await post("post-safety", {
      title: "",
      text: "今天很开心",
      tags: [],
    });
    expect((await res.json()).meta).toMatchObject({
      provider: "qwen",
      model: "qwen3.8-flash",
    });
    expect(
      (
        await post("post-safety", {
          title: "",
          text: "x",
          tags: [],
          model: "gemini-3.8-flash",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post("post-safety", {
          title: "",
          text: "x",
          tags: [],
          images: [],
        })
      ).status,
    ).toBe(400);
    expect((await post("post-meta", { text: "" })).status).toBe(400);
    expect(t).toHaveBeenCalledTimes(1);
  });
  it("model unavailable / quota / invalid output are visible errors", async () => {
    vi.stubEnv("AI_ENABLED", "false");
    let res = await post("post-safety", { title: "", text: "x", tags: [] });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("AI_NOT_CONFIGURED");
    vi.stubEnv("AI_ENABLED", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async () => upstream("通过")),
    );
    res = await post("post-safety", { title: "", text: "x", tags: [] });
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("AI_INVALID_OUTPUT");
    vi.stubEnv("AI_MAX_DAILY_TOKENS", "10");
    res = await post("post-meta", { text: source });
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("AI_QUOTA");
  });
});
