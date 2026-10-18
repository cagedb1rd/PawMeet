import { it, expect, vi } from "vitest";
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
vi.mock("server-only", () => ({}));
import { callModel } from "@/server/ai/client";
import { generateTask, assistantStep } from "@/server/ai/service";
import { AiError } from "@/server/ai/errors";
import { PROMPT_VERSION } from "@/server/ai/prompts";
import { VALIDATION_VERSION } from "@/lib/ai/validation";
import {
  CompanionIntent,
  emptyMatch,
  nativeToolSchemas,
  ToolName,
} from "@/lib/ai/contracts";
import { resolveAvailability } from "@/lib/ai/availability";
import { executeCompanionTool } from "@/lib/ai/companion";
import { stateSchema } from "@/domain/schemas";
import { DEFAULT_REFERENCE } from "@/domain/geo";

type CaseResult = {
  id: string;
  status: "not_run" | "pass" | "fail" | "error";
  checks?: Record<string, boolean>;
  data?: unknown;
  error?: unknown;
  reason?: string;
};
type Transmission = {
  number: number;
  caseId: string;
  startedAt: string;
  latencyMs?: number;
  httpStatus?: number;
  usage?: unknown;
  response?: unknown;
  error?: string;
  request?: unknown;
};
/** Explicitly selected live suite only. Ordinary Vitest and Playwright never include it. */
it("approved Phase 4.5 bounded Qwen availability regression smoke", async () => {
  if (
    process.env.AI_EVAL_MODE !== "live" ||
    process.env.PAWMEET_ALLOW_LIVE_AI !== "approved"
  )
    throw Error("Explicit live approval is required");
  const max = Number(process.env.AI_EVAL_MAX_CALLS);
  if (!Number.isInteger(max) || max < 1 || max > 6)
    throw Error("Budget must be 1..6 actual transmissions");
  const runId = process.env.AI_EVAL_RUN_ID!;
  const reportPath = process.env.AI_EVAL_REPORT!;
  process.env.QUOTA_STORE_PATH = path.resolve(
    `.local/ai-eval/${runId}.quota.json`,
  );
  process.env.AI_MAX_DAILY_CALLS = String(max);
  process.env.AI_MAX_DAILY_TOKENS = "60000";
  process.env.AI_ENABLED = "true";
  const now = new Date();
  const samples = [
    {
      id: "colloquial-or",
      text: "这周六下午或者晚上想找附近的狗狗玩伴，最好好相处一点",
    },
    { id: "hard-exclusions", text: "下周日想散步，不要大型犬，3公里内就好" },
    {
      id: "missing-day",
      text: "想找附近小伙伴一起遛弯，性格随和一点，时间还没定",
    },
  ];
  const selectedCase = process.env.AI_EVAL_CASE || "";
  if (selectedCase && !samples.some((s) => s.id === selectedCase))
    throw Error("Unknown companion extraction case");
  const cases: CaseResult[] = [
    ...samples.map((s) => ({ id: s.id, status: "not_run" as const })),
    { id: "native-selection", status: "not_run" },
    { id: "tool-feedback", status: "not_run" },
  ];
  const transmissions: Transmission[] = [];
  const report = {
    runId,
    mode: "live",
    suite: "companion",
    model: process.env.AI_MODEL ?? "qwen3.8-flash",
    promptVersion: PROMPT_VERSION,
    validationVersion: VALIDATION_VERSION,
    git: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    gitDirty: true,
    now: now.toISOString(),
    maxTransmissions: max,
    maxOutputTokensPerTransmission: 1400,
    scope:
      "Real Qwen service smoke with a fresh browser's actual localStorage snapshot. Read-only executor runs the same shared business function in Node; this is not an end-to-end live UI or organization evaluation.",
    confirmation:
      "User authorized necessary real API validation; predeclared varied extraction and native query smoke, max six transmissions including retries.",
    samples,
    selectedCase: selectedCase || null,
    cases,
    transmissions,
    actualProviderCalls: 0,
    knownUsage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    unknownUsageTransmissions: 0,
    businessUnchanged: false,
  };
  async function persist() {
    report.actualProviderCalls = transmissions.length;
    report.knownUsage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };
    report.unknownUsageTransmissions = 0;
    for (const t of transmissions) {
      const u = t.usage as
        | {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
          }
        | undefined;
      if (typeof u?.total_tokens === "number") {
        report.knownUsage.prompt_tokens += u.prompt_tokens ?? 0;
        report.knownUsage.completion_tokens += u.completion_tokens ?? 0;
        report.knownUsage.total_tokens += u.total_tokens;
      } else report.unknownUsageTransmissions++;
    }
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  let activeCase = "extract",
    lastStart = 0;
  const transport: typeof fetch = async (input, init) => {
    if (transmissions.length >= max)
      throw new AiError(
        "AI_EVAL_BUDGET",
        "Approved transmission budget exhausted",
        429,
        false,
      );
    const pause = 6500 - (Date.now() - lastStart);
    if (pause > 0) await new Promise((r) => setTimeout(r, pause));
    const body = JSON.parse(String(init?.body));
    const t: Transmission = {
      number: transmissions.length + 1,
      caseId: activeCase,
      startedAt: new Date().toISOString(),
      request: {
        messages: body.messages,
        toolNames: body.tools?.map(
          (v: { function: { name: string } }) => v.function.name,
        ),
        responseFormat: body.response_format?.type,
        max_tokens: body.max_tokens,
      },
    };
    transmissions.push(t);
    lastStart = Date.now();
    await persist();
    try {
      const res = await fetch(input, init);
      t.httpStatus = res.status;
      // Bounded audit of provider usage, even if business output validation fails later.
      const reader = res.clone().body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (reader)
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.length;
          if (length > 64000) {
            await reader.cancel();
            break;
          }
          chunks.push(part.value);
        }
      try {
        const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        t.usage = raw.usage;
        if (res.ok) t.response = { model: raw.model, choices: raw.choices };
        else t.response = { providerCode: raw.error?.code };
      } catch {
        t.error = "Provider audit response not parseable within limit";
      }
      t.latencyMs = Date.now() - lastStart;
      await persist();
      return res;
    } catch (e) {
      t.latencyMs = Date.now() - lastStart;
      t.error = e instanceof Error ? e.name : "TransportError";
      await persist();
      throw e;
    }
  };
  const model: typeof callModel = (
    messages,
    session,
    requestId,
    tools,
    _transport,
    schema,
    options,
  ) =>
    callModel(messages, session, requestId, tools, transport, schema, options);
  const errorData = (e: unknown) =>
    e instanceof AiError
      ? { code: e.code, message: e.message, providerCode: e.providerCode }
      : {
          code: "EVAL_FAILURE",
          message: e instanceof Error ? e.message : "Unknown error",
        };
  const origin = "http://localhost:3106";
  const occupied = await fetch(origin, { signal: AbortSignal.timeout(500) })
    .then(() => true)
    .catch(() => false);
  if (occupied)
    throw Error(
      "Evaluation port 3106 is already occupied; refusing to reuse or stop another server",
    );
  const server = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "--port", "3106"],
    {
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, AI_ENABLED: "false", APP_ORIGIN: origin },
    },
  );
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (server.exitCode !== null)
        throw Error("Read-only preview server exited");
      if (
        await fetch(origin, { signal: AbortSignal.timeout(500) })
          .then((r) => r.ok)
          .catch(() => false)
      ) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!ready) throw Error("Read-only preview startup timeout");
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(origin + "/activities");
    await expect
      .poll(() =>
        page.getByRole("button", { name: "切换演示身份" }).isEnabled(),
      )
      .toBe(true);
    const before = await page.evaluate(() =>
      localStorage.getItem("pawmeet:state:v1"),
    );
    const state = stateSchema.parse(JSON.parse(before!));
    const own = state.pets.find(
      (p) => p.ownerId === state.activeUserId && !p.archivedAt,
    )!;
    for (const [index, sample] of samples.entries()) {
      if (selectedCase && sample.id !== selectedCase) {
        cases[index].reason = "Outside selected extraction case";
        continue;
      }
      if (transmissions.length >= max) {
        cases[index].reason = "Budget exhausted";
        continue;
      }
      activeCase = sample.id;
      try {
        const result = await generateTask(
          "companion-intent",
          {
            text: sample.text,
            context: {
              pets: [
                {
                  id: own.id,
                  name: own.name,
                  revision: own.revision,
                  temperamentTags: own.temperamentTags,
                  activityTags: own.activityTags,
                  socialNotes: own.socialNotes,
                },
              ],
            },
          },
          "phase45-approved",
          crypto.randomUUID(),
          now,
          model,
        );
        const i = result.data as CompanionIntent;
        const checks: Record<string, boolean> = {
          noGuessedMinutes: i.startAt === null && i.endAt === null,
          noInventedBreed: i.match.breeds.length === 0,
        };
        if (sample.id === "missing-day")
          checks.asksDay = i.clarifications.length > 0;
        else {
          checks.searchableRoughTime =
            i.clarifications.length === 0 &&
            i.match.clarifications.length === 0;
          try {
            checks.resolvable = resolveAvailability(i, now).windows.length > 0;
          } catch {
            checks.resolvable = false;
          }
        }
        if (sample.id === "hard-exclusions") {
          checks.radius = i.match.radiusKm === 3;
          checks.excludedLarge = i.match.excludedSizes.includes("large");
          checks.noComplement = i.match.sizes.length === 0;
        }
        const t = transmissions.filter((t) => t.caseId === sample.id).at(-1);
        let raw: unknown;
        try {
          raw = JSON.parse(
            (t?.response as { choices?: { message: { content: string } }[] })
              ?.choices?.[0]?.message.content ?? "null",
          );
        } catch {}
        cases[index] = {
          id: sample.id,
          status: Object.values(checks).every(Boolean) ? "pass" : "fail",
          checks,
          data: {
            validated: i,
            rawDiffersFromValidated: JSON.stringify(raw) !== JSON.stringify(i),
            note: "Validated behavior includes deterministic recovery; raw provider output retained in transmissions. Not raw model accuracy.",
          },
        };
      } catch (e) {
        cases[index] = { id: sample.id, status: "error", error: errorData(e) };
      }
      await persist();
    }
    // Independent, predeclared confirmed input; never substitute a mock extraction after failure.
    const intent: CompanionIntent = {
      mode: "search",
      match: { ...emptyMatch, radiusKm: 3, excludedSizes: ["large"] },
      startAt: null,
      endAt: null,
      timeText: "下周六下午或晚上",
      activityType: "散步",
      placeQuery: null,
      preferences: ["性格温和", "附近有草坪"],
      hardRequirements: [],
      clarifications: [],
      warnings: [],
    };
    const availability = resolveAvailability(intent, now);
    if (!selectedCase && transmissions.length < max) {
      activeCase = "native-selection";
      try {
        const first = await assistantStep(
          {
            text: "按已确认条件优先查询已有活动。",
            pets: [
              {
                id: own.id,
                name: own.name,
                revision: own.revision,
                temperamentTags: own.temperamentTags,
                activityTags: own.activityTags,
                socialNotes: own.socialNotes,
              },
            ],
            workflow: { stage: "search", intent, availability },
          },
          "phase45-approved",
          crypto.randomUUID(),
          now,
          model,
        );
        const calls = first.data.toolCalls;
        const checks = {
          nativeActivitySelected:
            calls.length === 1 &&
            calls[0].function.name === "search_activities",
          knownConditionsCarried:
            calls.length > 0 &&
            calls.every((c) => {
              try {
                const a = JSON.parse(c.function.arguments);
                return (
                  a.radiusKm === 3 &&
                  Date.parse(a.startAfter) ===
                    Date.parse(availability.windows[0].startAt) &&
                  Date.parse(a.startBefore) ===
                    Date.parse(availability.windows.at(-1)!.endAt) &&
                  !a.district
                );
              } catch {
                return false;
              }
            }),
          allParametersValid:
            calls.length > 0 &&
            calls.every((c) => {
              try {
                return nativeToolSchemas[c.function.name as ToolName].safeParse(
                  JSON.parse(c.function.arguments),
                ).success;
              } catch {
                return false;
              }
            }),
        };
        cases[3] = {
          id: "native-selection",
          status: Object.values(checks).every(Boolean) ? "pass" : "fail",
          checks,
          data: {
            confirmedInput: intent,
            toolCalls: calls,
            answer: first.data.answer,
          },
        };
        if (calls.length && transmissions.length < max) {
          activeCase = "tool-feedback";
          const results = await Promise.all(
            calls.map(async (c) => ({
              toolCallId: c.id,
              result: await executeCompanionTool(
                c,
                state,
                DEFAULT_REFERENCE,
                own.id,
                intent,
                "search",
                {},
                now,
              ),
            })),
          );
          try {
            const final = await assistantStep(
              { continuation: first.data.continuation, results },
              "phase45-approved",
              crypto.randomUUID(),
              now,
              model,
            );
            const returnedIds = results.flatMap((r) =>
              r.result.kind === "activities"
                ? r.result.rows.map((row) => row.id)
                : [],
            );
            const errors = results.some((r) => r.result.kind === "error"),
              empty = !errors && returnedIds.length === 0;
            const expected = errors
              ? ["工具执行失败，请稍后重试。", "需要补充信息，请查看工具提示。"]
              : empty
                ? ["没有符合条件的结果，请调整条件。"]
                : ["已查询，请查看实际结果卡片。"];
            const checks = {
              actualBusinessResults: results.every(
                (r) => r.result.kind === "activities",
              ),
              finalAnswer:
                !!final.data.answer && final.data.toolCalls.length === 0,
              truthfulStatus:
                !!final.data.answer &&
                expected.includes(final.data.answer.summary),
              referencesValid:
                !!final.data.answer &&
                final.data.answer.references.every((id) =>
                  returnedIds.includes(id),
                ),
            };
            cases[4] = {
              id: "tool-feedback",
              status: Object.values(checks).every(Boolean) ? "pass" : "fail",
              checks,
              data: {
                results,
                answer: final.data.answer,
                toolCalls: final.data.toolCalls,
              },
            };
          } catch (e) {
            cases[4] = {
              id: "tool-feedback",
              status: "error",
              error: errorData(e),
              data: { results },
            };
          }
        } else
          cases[4].reason = calls.length
            ? "Transmission budget used by retries/repair"
            : "No native tool call to execute";
      } catch (e) {
        cases[3] = {
          id: "native-selection",
          status: "error",
          error: errorData(e),
        };
        cases[4].reason = "Native selection failed";
      }
    } else {
      cases[3].reason = selectedCase
        ? "Outside selected extraction case"
        : "Budget exhausted during extraction";
      cases[4].reason = selectedCase
        ? "Outside selected extraction case"
        : "Budget exhausted";
    }
    report.businessUnchanged =
      before ===
      (await page.evaluate(() => localStorage.getItem("pawmeet:state:v1")));
  } finally {
    await browser?.close();
    server.kill();
    await persist();
  }
  expect(transmissions.length).toBeLessThanOrEqual(max);
  expect(report.businessUnchanged).toBe(true);
  const assessed = selectedCase
    ? cases.filter((c) => c.id === selectedCase)
    : cases;
  expect(assessed.map((c) => ({ id: c.id, status: c.status }))).toEqual(
    assessed.map((c) => ({ id: c.id, status: "pass" })),
  );
}, 240000);
