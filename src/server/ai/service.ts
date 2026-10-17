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
} from "@/lib/ai/contracts";
import { validateOutput } from "@/lib/ai/validation";
import { callModel, Message } from "./client";
import {
  taskPrompt,
  assistantPrompt,
  nativeTools,
  calendarContext,
  taskOutputSchema,
  finalAnswerSchema,
  workflowPrompt,
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
) {
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
): Promise<{ data: AssistantStep; usage: unknown; model: string }> {
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
  const finalize =
    (!state.workflow ||
      state.workflow.stage === "search" ||
      input.results?.some((r) => r.result.kind === "activity-draft")) &&
    !!input.results?.length &&
    input.results.every((r) => r.result.kind !== "error");
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
    throw new AiError("AI_TOOL_PROTOCOL", "Qwen返回重复工具调用ID");
  state.toolCount += calls.length;
  if (state.toolCount > 9)
    throw new AiError("AI_TOOL_CALL_LIMIT", "工具调用已达9次上限", 400);
  state.round++;
  state.refs = [...new Set(state.refs)].slice(-30);
  state.pending = calls;
  let answer: AssistantStep["answer"] = null;
  let usage: unknown = result.usage;
  if (!calls.length) {
    const checked = await checkedAnswer(
      result.message,
      state.refs,
      state.round < 4
        ? () =>
            call(
              [
                ...messages,
                result.message,
                answerRepairInstruction(state.refs),
              ],
              session,
              requestId,
              undefined,
              undefined,
              finalAnswerSchema,
            )
        : undefined,
    );
    answer = checked.answer;
    if (
      input.results?.some((r) => r.result.kind === "error") &&
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
