import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
vi.mock("server-only", () => ({}));
import {
  EvalBudget,
  memoryStore,
  MODEL_TOKEN_CAPS,
  VISION_TOKEN_CAPS,
} from "../../evals/lib/budget";
import {
  createHttpsTransport,
  requestNotSent,
} from "../../evals/lib/https-transport";
import {
  breedMatches,
  categoryOf,
  loadVisionCases,
  parseLabels,
  type VisionCase,
} from "../../evals/cases/vision";
import {
  parseVisionConfig,
  privateOnly,
  recheckRules,
  runVisionEval,
  scoreVision,
  visionCompareMarkdown,
  visionMarkdown,
} from "../../evals/lib/vision-runner";
import { createVisionMockTransport } from "../../evals/lib/vision-mock";
import { reviewPetPhoto } from "@/lib/ai/photo";

beforeEach(() => {
  vi.stubEnv("AI_ENABLED", "true");
  vi.stubEnv("DASHSCOPE_API_KEY", "unit-test-key");
  vi.stubEnv("GEMINI_API_KEY", "unit-test-key");
  vi.stubEnv("AI_VISION_MODEL", "");
  vi.stubEnv("AI_STREAM", "true");
  vi.stubEnv("AI_BASE_URL", "");
  vi.stubEnv("AI_FIRST_BYTE_TIMEOUT_MS", "1000");
  vi.stubEnv("AI_TOTAL_TIMEOUT_MS", "4000");
});
afterEach(() => vi.unstubAllEnvs());

describe("eval budget: unsent attempts are released, everything else stays conservative", () => {
  it("release returns the reservation and counts it; unknown usage keeps the full charge", async () => {
    const store = memoryStore();
    const b = await EvalBudget.open({
      model: "gemini-3.8-flash",
      limit: 10000,
      store,
      runId: "u",
    });
    const t1 = await b.reserve(4000);
    expect(await b.release(t1)).toBe(0);
    expect(b.charged).toBe(0);
    const t2 = await b.reserve(4000);
    expect(await b.settle(t2, null)).toBe(4000);
    const t3 = await b.reserve(4000);
    expect(await b.settle(t3, 1500)).toBe(1500);
    expect(store.value.models["gemini-3.8-flash"]).toMatchObject({
      chargedTokens: 5500,
      knownTokens: 1500,
      conservativeTokens: 4000,
      transmissions: 3,
      unsent: 1,
    });
    await expect(b.release(t3)).rejects.toThrow("already settled");
  });
  it("ledgers written before the unsent field still load", async () => {
    const b = await EvalBudget.open({
      model: "m",
      limit: 10,
      store: memoryStore({
        version: 1,
        purpose: "pawmeet-eval-budget",
        models: {
          m: {
            chargedTokens: 3,
            knownTokens: 3,
            conservativeTokens: 0,
            transmissions: 1,
            runs: ["x"],
          } as never,
        },
      }),
      runId: "u",
    });
    expect(b.snapshot().unsent).toBe(0);
  });
  it("vision caps follow the approvals (Qwen 50k, Gemini rerun 60k) and are separate from the text caps", () => {
    expect(VISION_TOKEN_CAPS).toEqual({
      "qwen3.8-omni-flash": 50000,
      "qwen3.5-omni-plus": 50000,
      "gemini-3.5-flash-lite": 60000,
      "gemini-3.8-flash": 60000,
    });
    expect(MODEL_TOKEN_CAPS["gemini-3.8-flash"]).toBe(300000);
  });
});

describe("requestNotSent / HTTPS transport", () => {
  it("only proven connect-phase failures count as unsent", () => {
    expect(requestNotSent({ requestSent: false })).toBe(true);
    expect(
      requestNotSent({ requestSent: true, cause: { code: "ECONNREFUSED" } }),
    ).toBe(false);
    expect(requestNotSent({ cause: { code: "UND_ERR_CONNECT_TIMEOUT" } })).toBe(
      true,
    );
    expect(requestNotSent({ cause: { code: "ECONNRESET" } })).toBe(false);
    expect(requestNotSent(new DOMException("aborted", "AbortError"))).toBe(
      false,
    );
  });
  it("refused connection rejects with requestSent=false", async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as net.AddressInfo;
    await new Promise((r) => server.close(r));
    const error = await createHttpsTransport()(`https://127.0.0.1:${port}/x`, {
      method: "POST",
      body: "{}",
    }).catch((e) => e);
    expect(error.requestSent).toBe(false);
    expect(requestNotSent(error)).toBe(true);
  });
  it("abort during a TLS handshake that never completes rejects with requestSent=false", async () => {
    const sockets: net.Socket[] = [];
    const server = net.createServer((s) => sockets.push(s)); // accepts, never speaks TLS
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as net.AddressInfo;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const error = await createHttpsTransport()(`https://127.0.0.1:${port}/x`, {
      method: "POST",
      body: "{}",
      signal: controller.signal,
    }).catch((e) => e);
    expect(error.requestSent).toBe(false);
    sockets.forEach((s) => s.destroy());
    await new Promise((r) => server.close(r));
  });
  it("refuses non-https URLs", async () => {
    await expect(
      createHttpsTransport()("http://example.test/"),
    ).rejects.toThrow("https");
  });
});

describe("vision cases and labels", () => {
  it("parses labels.csv with a UTF-8 BOM, unknown values and notes", () => {
    const labels = parseLabels(
      "﻿file,is_dog,breed,size,notes\r\n" +
        "dog-01.jpg,true,比熊,small,\r\n" +
        'hard-01.jpg,true,法国斗牛犬,small,"两只狗同时入镜, 穿救生衣"\r\n' +
        "notdog-01.jpg,false,unknown,unknown,猫\r\n" +
        "x.jpg,,,,\r\n",
    );
    expect(labels.get("dog-01.jpg")).toMatchObject({
      isDog: true,
      breed: "比熊",
      sizes: ["small"],
      multiple: false,
    });
    expect(labels.get("hard-01.jpg")?.multiple).toBe(true);
    expect(labels.get("notdog-01.jpg")).toMatchObject({
      isDog: false,
      breed: null,
      sizes: [],
    });
    expect(labels.get("x.jpg")).toMatchObject({ isDog: null, sizes: null });
    expect(() => parseLabels("file,dog\n")).toThrow("列必须是");
    expect(() =>
      parseLabels("file,is_dog,breed,size,notes\na.jpg,true,x,huge,\n"),
    ).toThrow("size");
    expect(() =>
      parseLabels("file,is_dog,breed,size,notes\n../a.jpg,true,x,small,\n"),
    ).toThrow("文件名");
  });
  it("public cases are always present; breed aliases match common names", () => {
    const pub = loadVisionCases("public");
    expect(pub.map((c) => c.file)).toEqual([
      "dog-1.jpg",
      "dog-2.jpg",
      "dog-3.jpg",
      "dog-4.jpg",
      "dog-5.jpg",
      "dog-6.jpg",
    ]);
    expect(pub.every((c) => c.source === "public")).toBe(true);
    expect(breedMatches("金毛寻回犬", "金毛")).toBe(true);
    expect(breedMatches("法国斗牛犬", "法斗")).toBe(true);
    expect(breedMatches("玩具贵宾", "泰迪")).toBe(true);
    expect(breedMatches("柴犬", "秋田犬")).toBe(false);
  });
});

const dog: VisionCase = {
  id: "t-dog",
  file: "t.jpg",
  source: "private",
  isDog: true,
  breed: "柯基",
  sizes: ["small"],
  multiple: false,
  notes: "",
};
const raw = (o: Record<string, unknown>) =>
  JSON.stringify({
    dog: { value: "yes", confidence: 0.9 },
    multipleDogs: false,
    breed: { value: "柯基", confidence: 0.9 },
    size: { value: "small", confidence: 0.9 },
    coatColor: { value: null, confidence: 0.1 },
    features: [],
    ...o,
  });
const run = (c: VisionCase, text: string) =>
  scoreVision(c, reviewPetPhoto(JSON.parse(text)), text);

describe("vision categories and private-only scope", () => {
  it("groups labelled images into regular small / medium / large, hard and non-dog", () => {
    const labels = parseLabels(
      [
        "file,is_dog,breed,size,notes",
        "dog-01.jpg,true,比熊,small,",
        "dog-09.jpg,true,金毛寻回犬,large,",
        "hard-01.jpg,true,法国斗牛犬,small,两只狗同时入镜",
        "hard-02.jpg,true,unknown,unknown,狗鼻特写",
        "notdog-02.jpg,false,unknown,unknown,毛绒玩具",
      ].join("\n"),
    );
    expect([...labels.values()].map((c) => categoryOf(c))).toEqual([
      "small",
      "large",
      "hard",
      "hard",
      "notdog",
    ]);
    expect(
      categoryOf({ file: "x.jpg", isDog: null, sizes: null, multiple: false }),
    ).toBe("unlabelled");
  });
  it("live runs refuse the public demo photos", () => {
    expect(() =>
      parseVisionConfig([
        "--mode",
        "live",
        "--model",
        "gemini-3.8-flash",
        "--token-limit",
        "1000",
        "--source",
        "public",
      ]),
    ).toThrow("private");
    expect(
      parseVisionConfig([
        "--mode",
        "live",
        "--model",
        "gemini-3.8-flash",
        "--token-limit",
        "1000",
        "--dry-run",
      ]).source,
    ).toBe("private");
  });
  it("privateOnly drops public cases from an older report and regroups by category", () => {
    const attempt = (
      caseId: string,
      file: string,
      source: "public" | "private",
    ) => ({
      caseId,
      file,
      source,
      labelled: true,
      status: "pass" as const,
      raw: "{}",
      draft: null,
      checks: { schema: true },
      failedChecks: [],
      call: null,
    });
    const old = {
      kind: "pawmeet-vision-eval",
      simulated: false,
      metrics: {},
      cases: [
        attempt("pub-dog-1", "dog-1.jpg", "public"),
        attempt("prv-unknown", "zz-not-labelled.jpg", "private"),
      ],
    } as unknown as Parameters<typeof privateOnly>[0];
    const scoped = privateOnly(old);
    expect(scoped.cases.map((c) => c.file)).toEqual(["zz-not-labelled.jpg"]);
    expect(scoped.cases[0].category).toBe("unlabelled");
    expect(scoped.metrics.all.executed).toBe(1);
    expect(Object.keys(scoped.metrics.byCategory)).toEqual(["unlabelled"]);
  });
});

describe("offline rules recheck (saved raw outputs, no model call)", () => {
  it("counts automatic fills, their errors and fields left for confirmation, before and after", () => {
    const beagle: VisionCase = {
      id: "prv-dog-07",
      file: "dog-07.jpg",
      source: "private",
      isDog: true,
      breed: "比格",
      sizes: ["medium"],
      multiple: false,
      notes: "",
    };
    const rawText = JSON.stringify({
      dog: { value: "yes", confidence: 0.99 },
      multipleDogs: false,
      breed: { value: "比格犬", confidence: 0.95 },
      size: { value: "small", confidence: 0.85 },
      coatColor: { value: "三色", confidence: 0.9 },
      features: [],
    });
    const report = {
      kind: "pawmeet-vision-eval",
      model: "gemini-3.5-flash-lite",
      runId: "u",
      simulated: false,
      cases: [
        {
          caseId: "prv-dog-07",
          file: "dog-07.jpg",
          source: "private",
          raw: rawText,
          // Draft as produced by the rules at run time: size filled automatically.
          draft: {
            breed: { value: "比格犬", confidence: 0.95, accepted: true },
            size: { value: "small", confidence: 0.85, accepted: true },
          },
        },
      ],
    } as unknown as Parameters<typeof recheckRules>[0];
    const r = recheckRules(report, [beagle]);
    expect(r.before).toEqual({ auto: 2, autoWrong: 1, confirm: 0, empty: 0 });
    expect(r.after).toEqual({ auto: 2, autoWrong: 0, confirm: 0, empty: 0 });
    expect(r.wrongAuto).toEqual([]);
  });
});

describe("vision scoring (programmatic)", () => {
  it("passes a correct dog; leaving uncertain fields empty is not a failure", () => {
    expect(run(dog, raw({})).failed).toEqual([]);
    const empty = run(
      dog,
      raw({
        breed: { value: null, confidence: 0.2 },
        size: { value: "unknown", confidence: 0.2 },
      }),
    );
    expect(empty.failed).toEqual([]);
    expect(empty.coverage).toMatchObject({
      breedCorrect: false,
      sizeCorrect: false,
    });
  });
  it("flags a wrong size, a wrong breed and a health claim in the raw output", () => {
    // A breed outside the size table: a confident wrong size is filled and must be flagged.
    const mixed = { ...dog, breed: "田园犬" };
    expect(
      run(
        mixed,
        raw({
          breed: { value: "田园犬", confidence: 0.9 },
          size: { value: "large", confidence: 0.9 },
        }),
      ).failed,
    ).toEqual(["size_not_wrong"]);
    // A table breed (柯基: small / medium, typical small) with an out-of-range size is filled
    // with the typical size instead, which matches this label.
    const crossChecked = run(
      dog,
      raw({ size: { value: "large", confidence: 0.9 } }),
    );
    expect(crossChecked.failed).toEqual([]);
    expect(crossChecked.fill.size).toBe("small");
    expect(
      run(dog, raw({ breed: { value: "柴犬", confidence: 0.9 } })).failed,
    ).toEqual(["breed_not_wrong"]);
    const claim = run(
      dog,
      raw({ features: [{ value: "疑似皮肤病", confidence: 0.9 }] }),
    );
    expect(claim.failed).toEqual(["no_claims_raw"]);
  });
  it("non-dog must be rejected; multi-dog must fill nothing; invalid JSON fails schema", () => {
    const cat = { ...dog, isDog: false, breed: null, sizes: [] };
    expect(
      run(cat, raw({ dog: { value: "no", confidence: 0.9 } })).failed,
    ).toEqual([]);
    expect(run(cat, raw({})).failed).toContain("not_dog_rejected");
    const two = { ...dog, multiple: true };
    expect(run(two, raw({ multipleDogs: true })).failed).toEqual([]);
    expect(scoreVision(dog, null, "这是一只柯基").failed).toEqual(
      expect.arrayContaining(["schema", "dog_recognized"]),
    );
  });
});

describe("vision runner", () => {
  it("config: whitelist only, live needs --token-limit within 50k, simulated uses memory", () => {
    expect(() => parseVisionConfig(["--model", "qwen3.8-flash"])).toThrow(
      "白名单",
    );
    expect(() =>
      parseVisionConfig(["--mode", "live", "--model", "gemini-3.8-flash"]),
    ).toThrow("--token-limit");
    expect(() =>
      parseVisionConfig([
        "--mode",
        "live",
        "--model",
        "gemini-3.8-flash",
        "--token-limit",
        "60001",
      ]),
    ).toThrow("60000");
    expect(() =>
      parseVisionConfig([
        "--mode",
        "live",
        "--model",
        "qwen3.8-omni-flash",
        "--token-limit",
        "50001",
      ]),
    ).toThrow("50000");
    expect(
      parseVisionConfig([
        "--mode",
        "live",
        "--model",
        "qwen3.5-omni-plus",
        "--token-limit",
        "50000",
      ]),
    ).toMatchObject({
      tokenLimit: 50000,
      ledger: ".local/ai-eval/step7-vision-ledger.json",
    });
    expect(() => parseVisionConfig(["--ledger", "x.json"])).toThrow("内存");
    expect(() => parseVisionConfig(["--cases", "nope"])).toThrow("未知");
  });
  it("simulated run stops at the budget, keeps file names only and labels the report 模拟", async () => {
    const config = parseVisionConfig([
      "--source",
      "public",
      "--model",
      "gemini-3.8-flash",
    ]);
    const b = await EvalBudget.open({
      model: config.model,
      limit: 9000,
      store: memoryStore(),
      runId: "u",
    });
    const thumb =
      "data:image/jpeg;base64," +
      Buffer.from([
        0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 1, 128, 2, 0, 3, 1, 0x22, 0, 2, 0x11,
        1, 3, 0x11, 1, 0xff, 0xda, 0, 12, 3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0,
        0xff, 0xd9,
      ]).toString("base64");
    const ctx: { current: VisionCase | null } = { current: null };
    const report = await runVisionEval(config, {
      runId: "u",
      transport: createVisionMockTransport(ctx),
      budget: b,
      thumbnails: new Map(config.cases.map((c) => [c.id, thumb])),
      onCase: (c) => (ctx.current = c),
      git: { commit: "0000000", dirty: false },
    });
    // Reservation ≈ prompt + 2048 output + 1120 image: only the first cases fit in 9000.
    expect(report.budget.stoppedBy).toBe("budget");
    expect(report.cases.at(-1)!.status).toBe("not_run");
    expect(report.budget.chargedAfter).toBeLessThanOrEqual(9000);
    expect(report.metrics.all.executed).toBeGreaterThan(0);
    const md = visionMarkdown(report);
    expect(md).toContain("模拟数据");
    expect(md).toContain("dog-1.jpg");
    expect(JSON.stringify(report)).not.toContain("base64");
    expect(() =>
      visionCompareMarkdown([report, { ...report, simulated: false }]),
    ).toThrow("不能合并");
  });
});
