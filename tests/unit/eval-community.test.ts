import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  COMMUNITY_SMOKE_CAP,
  EvalBudget,
  memoryStore,
} from "../../evals/lib/budget";
import {
  COMMUNITY_BUDGET_KEY,
  communityMarkdown,
  parseCommunityConfig,
  runCommunityEval,
  scoreMeta,
  scoreSafety,
} from "../../evals/lib/community-runner";
import { createCommunityMockTransport } from "../../evals/lib/community-mock";
import {
  META_CASES,
  SAFETY_CASES,
  type CommunityCase,
} from "../../evals/cases/community";
import { rulePrecheck } from "@/domain/moderation";

beforeEach(() => {
  vi.stubEnv("AI_ENABLED", "true");
  vi.stubEnv("DASHSCOPE_API_KEY", "unit-test-key");
  vi.stubEnv("GEMINI_API_KEY", "unit-test-key");
  vi.stubEnv("AI_STREAM", "false");
  vi.stubEnv("AI_BASE_URL", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("community smoke config", () => {
  it("live needs a token limit within the pooled 50k cap", () => {
    expect(() => parseCommunityConfig(["--mode", "live"])).toThrow(
      "--token-limit",
    );
    expect(() =>
      parseCommunityConfig(["--mode", "live", "--token-limit", "50001"]),
    ).toThrow("50000");
    expect(COMMUNITY_SMOKE_CAP).toBe(50000);
    const c = parseCommunityConfig([
      "--mode",
      "live",
      "--model",
      "gemini-3.8-flash",
      "--token-limit",
      "50000",
      "--suite",
      "safety",
    ]);
    expect(c.cases.every((x) => x.suite === "safety")).toBe(true);
    expect(c.ledger).toBe(".local/ai-eval/step8-community-ledger.json");
  });
  it("rejects non-whitelisted models, unknown cases and a ledger for simulated runs", () => {
    expect(() => parseCommunityConfig(["--model", "gpt-x"])).toThrow();
    expect(() => parseCommunityConfig(["--cases", "ZZ"])).toThrow("未知");
    expect(() => parseCommunityConfig(["--ledger", "x.json"])).toThrow(
      "内存账本",
    );
  });
  it("has 8–10 cases per suite with the required kinds", () => {
    expect(META_CASES.length).toBeGreaterThanOrEqual(8);
    expect(SAFETY_CASES.length).toBeGreaterThanOrEqual(8);
    expect(META_CASES.filter((c) => c.image).length).toBeGreaterThanOrEqual(2);
    const cats = SAFETY_CASES.flatMap((c) => c.categories ?? []);
    for (const k of [
      "personal_info",
      "ad_redirect",
      "abuse",
      "dangerous_advice",
    ])
      expect(cats).toContain(k);
    expect(SAFETY_CASES.some((c) => c.expect === "pass")).toBe(true);
  });
  it("program rules alone already catch the contact and drug cases", () => {
    const rules = (id: string) => {
      const c = SAFETY_CASES.find((x) => x.id === id)!;
      return rulePrecheck({ title: c.title ?? "", text: c.text, tags: [] });
    };
    expect(rules("CS04")[0]).toMatchObject({
      category: "personal_info",
      blocking: true,
    });
    expect(rules("CS08").map((f) => f.category)).toContain("dangerous_advice");
    expect(rules("CS01")).toEqual([]);
    expect(rules("CS02")).toEqual([]);
  });
});

describe("community smoke scoring", () => {
  const cm06 = META_CASES.find((c) => c.id === "CM06")!;
  it("flags invented identities in the raw output even if the review would drop them", () => {
    const raw = JSON.stringify({
      title: "公园晒太阳",
      tags: ["公园", "兽医认证", "晒太阳"],
      note: null,
    });
    const checks = scoreMeta(
      cm06,
      {
        title: "公园晒太阳",
        tags: ["公园", "晒太阳", "日常"],
        note: null,
        removed: 1,
      },
      raw,
    );
    expect(checks.no_forbidden_raw).toBe(false);
    expect(checks.grounded).toBe(true);
  });
  it("photo cases fail on a breed word that the label does not allow", () => {
    const cat = META_CASES.find((c) => c.id === "CM09")!;
    const raw = JSON.stringify({
      title: "可爱柯基",
      tags: ["柯基", "a", "b"],
      note: null,
    });
    expect(scoreMeta(cat, null, raw).no_wrong_breed).toBe(false);
    const shiba = META_CASES.find((c) => c.id === "CM08")!;
    const ok = JSON.stringify({
      title: "柴犬遛弯",
      tags: ["柴犬", "遛弯", "周末"],
      note: null,
    });
    expect(scoreMeta(shiba, null, ok).no_wrong_breed).toBe(true);
  });
  it("safety: verdict, category and verbatim excerpt", () => {
    const cs08 = SAFETY_CASES.find((c) => c.id === "CS08")!;
    const raw = JSON.stringify({
      verdict: "revise",
      issues: [
        { category: "dangerous_advice", excerpt: "喂半片布洛芬", reason: "x" },
      ],
    });
    expect(
      scoreSafety(
        cs08,
        {
          verdict: "revise",
          issues: [
            {
              category: "dangerous_advice",
              field: "text",
              excerpt: "喂半片布洛芬",
              reason: "x",
            },
          ],
        },
        raw,
      ),
    ).toEqual({
      schema: true,
      verdict: true,
      category: true,
      excerpt_verbatim: true,
    });
    const cs01 = SAFETY_CASES.find((c) => c.id === "CS01")!;
    expect(
      scoreSafety(cs01, { verdict: "revise", issues: [] }, "{}").verdict,
    ).toBe(false);
  });
});

describe("community smoke runner (simulated)", () => {
  const run = async (limit: number, model = "gemini-3.8-flash") => {
    const config = parseCommunityConfig([
      "--model",
      model,
      "--token-limit",
      String(limit),
    ]);
    const store = memoryStore();
    const budget = await EvalBudget.open({
      model: COMMUNITY_BUDGET_KEY,
      limit,
      store,
      runId: "unit",
    });
    const ctx: { current: CommunityCase | null } = { current: null };
    const thumbnails = new Map<string, string>();
    const report = await runCommunityEval(config, {
      runId: "unit",
      transport: createCommunityMockTransport(ctx),
      budget,
      thumbnails,
      onCase: (c) => (ctx.current = c),
      git: { commit: "abcdef0", dirty: false },
    });
    return { report, store };
  };
  it("runs text cases, marks photo cases without thumbnails as not run, and labels simulated", async () => {
    const { report } = await run(1_000_000);
    expect(report.simulated).toBe(true);
    expect(report.metrics.safety.pass).toBe(SAFETY_CASES.length);
    const photo = report.cases.filter((c) => c.image);
    expect(photo.every((c) => c.status === "not_run")).toBe(true);
    expect(communityMarkdown(report)).toContain("模拟");
  });
  it("text-only models skip photo cases", async () => {
    const { report } = await run(1_000_000, "qwen3.8-flash");
    const photo = report.cases.filter((c) => c.image);
    expect(
      photo.every(
        (c) => c.reason?.includes("视觉白名单") || c.reason === "缺少缩略图",
      ),
    ).toBe(true);
  });
  it("stops before any request once the pooled budget cannot cover a reservation", async () => {
    const { report, store } = await run(7000);
    expect(report.budget.stoppedBy).toBe("budget");
    expect(
      store.value.models[COMMUNITY_BUDGET_KEY].chargedTokens,
    ).toBeLessThanOrEqual(7000);
    expect(
      report.cases.some((c) => c.status === "not_run" && c.reason === "budget"),
    ).toBe(true);
  });
});
