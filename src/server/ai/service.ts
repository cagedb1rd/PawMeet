import "server-only";
import { z } from "zod";
import {
  AiTask,
  TaskRequest,
  AssistantRequest,
  AssistantStep,
  toolCallSchema,
  petSummarySchema,
  companionContextSchema,
  toolResultSchema,
  assistantSummaries,
  noResultSummaries,
  PetPhotoRequest,
  PetPhotoDraft,
  petPhotoOutputSchema,
  PostMetaRequest,
  PostMetaDraft,
  postMetaOutputSchema,
  PostSafetyRequest,
  PostSafetyResult,
  postSafetyOutputSchema,
} from "@/lib/ai/contracts";
import { reviewPetPhoto } from "@/lib/ai/photo";
import {
  PostMetaReviewError,
  PostSafetyReviewError,
  reviewPostMeta,
  reviewPostSafety,
} from "@/lib/ai/community";
import { validateOutput } from "@/lib/ai/validation";
import { callModel, CallOptions, Message, thumbnailPart } from "./client";
import {
  taskPrompt,
  assistantPrompt,
  nativeTools,
  calendarContext,
  taskOutputSchema,
  finalAnswerSchema,
  workflowPrompt,
  petPhotoPrompt,
  petPhotoJsonSchema,
  postMetaPrompt,
  postMetaJsonSchema,
  postSafetyPrompt,
  postSafetyJsonSchema,
} from "./prompts";
import { AiError } from "./errors";
import { seal, unseal } from "./session";
import { checkedAnswer, answerRepairInstruction } from "./answer";
export async function generateTask(
  task: AiTask,
  input: TaskRequest,
  session: string,
  requestId: string,
  now = new Date(),
  call = callModel,
  options: Pick<CallOptions, "onProgress" | "signal"> = {},
) {
  // Structured extraction has no side effects, so the client may retry it once.
  const result = await call(
    [
      { role: "system", content: taskPrompt(task) },
      {
        role: "user",
        content: JSON.stringify({
          input,
          now: now.toISOString(),
          timezone: "Asia/Shanghai",
          calendar: calendarContext(now),
        }),
      },
    ],
    session,
    requestId,
    undefined,
    undefined,
    taskOutputSchema(task),
    { ...options, retry: "idempotent" },
  );
  try {
    return {
      data: validateOutput(
        task,
        JSON.parse(result.message.content ?? ""),
        input,
        now,
      ),
      usage: result.usage,
      model: result.model,
    };
  } catch {
    throw new AiError(
      "AI_INVALID_OUTPUT",
      task === "companion-intent"
        ? "这次没能读准部分约伴条件。可以改写不确定的描述，或使用手动活动入口；大概日期和时段就足够搜索，不需要精确到分钟。"
        : "AI输出未通过结构与事实校验，请修改描述后重试",
    );
  }
}
/** Strips one Markdown code fence some JSON-mode models still add. */
const unfence = (text: string) =>
  text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

/**
 * Pet-photo vision task: the browser sends only a re-encoded ≤512px JPEG after the user clicks.
 * The output is a program-reviewed draft; nothing is written until the owner saves the form.
 */
export async function recognizePetPhoto(
  input: PetPhotoRequest,
  session: string,
  requestId: string,
  call = callModel,
  options: Pick<CallOptions, "onProgress" | "signal" | "model"> = {},
): Promise<{ data: PetPhotoDraft; usage: unknown; model: string }> {
  const image = thumbnailPart(input.image);
  const result = await call(
    [
      { role: "system", content: petPhotoPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: "识别这张宠物照片的外观，按要求只输出JSON。" },
          image,
        ],
      },
    ],
    session,
    requestId,
    undefined,
    undefined,
    petPhotoJsonSchema,
    { ...options, kind: "vision", retry: "idempotent" },
  );
  let raw: unknown;
  try {
    raw = JSON.parse(unfence(result.message.content ?? ""));
  } catch {
    raw = undefined;
  }
  const parsed = petPhotoOutputSchema.safeParse(raw);
  if (!parsed.success)
    throw new AiError(
      "AI_INVALID_OUTPUT",
      "照片识别结果未通过结构校验，没有填入任何内容；可以重试或手动填写",
    );
  return {
    data: reviewPetPhoto(parsed.data),
    usage: result.usage,
    model: result.model,
  };
}

const parseJson = (text: string | null) => {
  try {
    return JSON.parse(unfence(text ?? ""));
  } catch {
    return undefined;
  }
};

/**
 * Community post title / tags draft. With a thumbnail the vision model (AI_VISION_MODEL) is
 * used, otherwise the text model (AI_MODEL); the output is program-reviewed and only fills
 * the form. Nothing is published here.
 */
export async function generatePostMeta(
  input: PostMetaRequest,
  session: string,
  requestId: string,
  call = callModel,
  options: Pick<CallOptions, "onProgress" | "signal" | "model"> = {},
): Promise<{ data: PostMetaDraft; usage: unknown; model: string }> {
  const text = `为下面这篇帖子起草标题和话题标签，按要求只输出JSON。\n正文：${JSON.stringify(input.text)}`;
  const result = await call(
    [
      { role: "system", content: postMetaPrompt },
      {
        role: "user",
        content: input.image
          ? [{ type: "text", text }, thumbnailPart(input.image)]
          : text,
      },
    ],
    session,
    requestId,
    undefined,
    undefined,
    postMetaJsonSchema,
    { ...options, kind: input.image ? "vision" : "text", retry: "idempotent" },
  );
  const parsed = postMetaOutputSchema.safeParse(
    parseJson(result.message.content),
  );
  if (!parsed.success)
    throw new AiError(
      "AI_INVALID_OUTPUT",
      "标题和标签草稿未通过结构校验，表单没有改动；可以重试或手动填写",
    );
  try {
    return {
      data: reviewPostMeta(parsed.data, input.text),
      usage: result.usage,
      model: result.model,
    };
  } catch (e) {
    if (!(e instanceof PostMetaReviewError)) throw e;
    throw new AiError(
      "AI_INVALID_OUTPUT",
      `标题和标签草稿未通过检查（${e.message}），表单没有改动；可以重试或手动填写`,
    );
  }
}

/**
 * Model layer of the pre-publish precheck: a structured judgement on the user's own title /
 * text / tags only. Program rules run in the browser independently of this call.
 */
export async function precheckPost(
  input: PostSafetyRequest,
  session: string,
  requestId: string,
  call = callModel,
  options: Pick<CallOptions, "onProgress" | "signal" | "model"> = {},
): Promise<{ data: PostSafetyResult; usage: unknown; model: string }> {
  const result = await call(
    [
      { role: "system", content: postSafetyPrompt },
      {
        role: "user",
        content: `检查下面这篇待发布帖子，按要求只输出JSON。\n${JSON.stringify(input)}`,
      },
    ],
    session,
    requestId,
    undefined,
    undefined,
    postSafetyJsonSchema,
    { ...options, kind: "text", retry: "idempotent" },
  );
  const parsed = postSafetyOutputSchema.safeParse(
    parseJson(result.message.content),
  );
  try {
    if (!parsed.success) throw new PostSafetyReviewError("结构不合法");
    return {
      data: reviewPostSafety(parsed.data, input),
      usage: result.usage,
      model: result.model,
    };
  } catch (e) {
    if (!(e instanceof PostSafetyReviewError)) throw e;
    throw new AiError(
      "AI_INVALID_OUTPUT",
      `AI 预检结果未通过校验（${e.message}），这次没有得到 AI 结论`,
    );
  }
}

const messageSchema = z.strictObject({
  role: z.enum(["user", "assistant", "tool"]),
  content: z.string().max(18000).nullable(),
  tool_calls: z.array(toolCallSchema).max(3).optional(),
  tool_call_id: z.string().max(100).optional(),
});
const stateSchema = z.strictObject({
  workflow: companionContextSchema.optional(),
  session: z.string(),
  expires: z.number(),
  round: z.number().int().min(0).max(4),
  toolCount: z.number().int().min(0).max(9).default(0),
  turns: z.number().int().min(1).max(4),
  messages: z.array(messageSchema).max(28),
  pets: z.array(petSummarySchema).max(3),
  refs: z.array(z.string().max(100)).max(30),
  pending: z.array(toolCallSchema).max(3),
});
export async function assistantStep(
  input: AssistantRequest,
  session: string,
  requestId: string,
  now = new Date(),
  call = callModel,
  options: Pick<CallOptions, "onProgress" | "signal"> = {},
): Promise<{ data: AssistantStep; usage: unknown; model: string }> {
  // Tools run in the browser only after a sealed step returns, so a retry never re-runs
  // a tool; still, only failures before any response body are retried.
  const callOptions: CallOptions = { ...options, retry: "pre-response" };
  let state: z.infer<typeof stateSchema>;
  if (input.continuation) {
    try {
      state = stateSchema.parse(unseal(input.continuation));
    } catch (e) {
      if (e instanceof AiError) throw e;
      throw new AiError("AI_CONTINUATION", "对话凭据结构无效", 400);
    }
    if (state.session !== session || state.expires < now.getTime())
      throw new AiError("AI_CONTINUATION", "对话已过期，请重新开始", 400);
    if (input.pets || input.workflow)
      throw new AiError("AI_PROTOCOL", "对话中不能替换宠物上下文", 400);
    if (state.pending.length) {
      if (
        input.text ||
        !input.results ||
        input.results.length !== state.pending.length ||
        new Set(input.results.map((r) => r.toolCallId)).size !==
          state.pending.length ||
        input.results.some(
          (r) => !state.pending.some((c) => c.id === r.toolCallId),
        )
      )
        throw new AiError("AI_PROTOCOL", "必须返回本轮所有工具调用的结果", 400);
      for (const c of state.pending) {
        const r = toolResultSchema.parse(
          input.results.find((r) => r.toolCallId === c.id)!.result,
        );
        const expected = {
          search_pets: "pets",
          search_activities: "activities",
          create_help_draft: "help-draft",
          search_places: "places",
          check_compatibility: "compatibility",
          create_activity_draft: "activity-draft",
        }[c.function.name];
        if (r.kind !== "error" && r.kind !== expected)
          throw new AiError("AI_PROTOCOL", "工具结果类型不匹配", 400);
        state.messages.push({
          role: "tool",
          tool_call_id: c.id,
          content: JSON.stringify(r),
        });
        if (r.kind === "pets" || r.kind === "activities")
          state.refs.push(...r.rows.map((v) => v.id));
      }
      state.pending = [];
    } else {
      if (!input.text?.trim() || input.results?.length)
        throw new AiError("AI_PROTOCOL", "请输入后续问题", 400);
      if (state.turns >= 4)
        throw new AiError("AI_TURN_LIMIT", "最多4轮用户对话，请重新开始", 400);
      state.messages.push({ role: "user", content: input.text });
      state.turns++;
      state.round = 0;
      state.toolCount = 0;
    }
  } else {
    if (!input.text?.trim() || input.results?.length)
      throw new AiError("AI_PROTOCOL", "请输入问题后开始对话", 400);
    state = {
      workflow: input.workflow,
      session,
      expires: now.getTime() + 15 * 60000,
      round: 0,
      toolCount: 0,
      turns: 1,
      messages: [{ role: "user", content: input.text }],
      pets: input.pets ?? [],
      refs: [],
      pending: [],
    };
  }
  if (state.round >= 4)
    throw new AiError(
      "AI_TOOL_ROUND_LIMIT",
      "工具调用已达4轮上限，请缩小任务后重试",
      400,
    );
  const messages: Message[] = [
    {
      role: "system",
      content: `${state.workflow ? workflowPrompt(state.workflow) : ""}\n${assistantPrompt}\nsummary只允许以下值之一：${JSON.stringify(assistantSummaries)}\ncalendar=${JSON.stringify(calendarContext(now))}；now=${now.toISOString()}；本人宠物=${JSON.stringify(state.pets)}`,
    },
    ...(state.messages as Message[]),
  ];
  // Any tool error ends the tool loop: the next round has no tools and must report it
  // through the strict final answer instead of retrying until the round limit.
  const toolFailed = !!input.results?.some((r) => r.result.kind === "error");
  const finalize =
    !!input.results?.length &&
    (toolFailed ||
      !state.workflow ||
      state.workflow.stage === "search" ||
      input.results.some((r) => r.result.kind === "activity-draft"));
  const result = await call(
    messages,
    session,
    requestId,
    finalize
      ? undefined
      : nativeTools.filter((t) =>
          !state.workflow
            ? [
                "search_pets",
                "search_activities",
                "create_help_draft",
              ].includes(t.function.name)
            : state.workflow.stage === "search"
              ? t.function.name === "search_activities"
              : [
                  "search_pets",
                  "search_places",
                  "check_compatibility",
                  "create_activity_draft",
                ].includes(t.function.name),
        ),
    undefined,
    finalize ? finalAnswerSchema : undefined,
    callOptions,
  );
  const calls = result.message.tool_calls ?? [];
  if (finalize && calls.length)
    throw new AiError("AI_TOOL_PROTOCOL", "助手总结阶段返回了额外工具调用");
  const permitted = state.workflow
    ? state.workflow.stage === "search"
      ? ["search_activities"]
      : [
          "search_pets",
          "search_places",
          "check_compatibility",
          "create_activity_draft",
        ]
    : ["search_pets", "search_activities", "create_help_draft"];
  if (
    calls.length > 3 ||
    calls.some((c) => !permitted.includes(c.function.name))
  )
    throw new AiError("AI_TOOL_PROTOCOL", "模型请求了当前阶段未开放的工具");
  if (new Set(calls.map((c) => c.id)).size !== calls.length)
    throw new AiError("AI_TOOL_PROTOCOL", "模型返回重复工具调用ID");
  state.toolCount += calls.length;
  if (state.toolCount > 9)
    throw new AiError("AI_TOOL_CALL_LIMIT", "工具调用已达9次上限", 400);
  state.round++;
  state.refs = [...new Set(state.refs)].slice(-30);
  state.pending = calls;
  let answer: AssistantStep["answer"] = null;
  let usage: unknown = result.usage;
  if (!calls.length) {
    // A terminal success/empty/failure summary needs this step's tool results.
    const allowed = input.results?.length
      ? assistantSummaries
      : noResultSummaries;
    const checked = await checkedAnswer(
      result.message,
      state.refs,
      state.round < 4
        ? () =>
            call(
              [
                ...messages,
                result.message,
                answerRepairInstruction(state.refs, allowed),
              ],
              session,
              requestId,
              undefined,
              undefined,
              finalAnswerSchema,
              callOptions,
            )
        : undefined,
      allowed,
    );
    answer = checked.answer;
    if (
      toolFailed &&
      [
        "已查询，请查看实际结果卡片。",
        "已生成互助草稿，请编辑并确认，尚未发布。",
        "已生成活动草稿，请编辑并确认，尚未创建。",
        "没有符合条件的结果，请调整条件。",
      ].includes(answer.summary)
    )
      throw new AiError(
        "AI_INVALID_OUTPUT",
        "工具失败尚未解决，不能返回查询成功或空结果状态",
      );
    state.messages.push(checked.message);
    if (checked.repaired) {
      state.round++;
      usage = { initial: result.usage, repair: checked.usage };
    }
  } else state.messages.push(result.message);
  const continuation = seal(state);
  if (continuation.length > 40000)
    throw new AiError("AI_CONTEXT_LIMIT", "对话上下文已满，请重新开始", 400);
  return {
    data: { continuation, toolCalls: calls, answer },
    usage,
    model: result.model,
  };
}
