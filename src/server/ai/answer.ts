import "server-only";
import {
  AssistantSummary,
  assistantAnswerSchema,
  assistantSummaries,
} from "@/lib/ai/contracts";
import type { AssistantMessage, Message } from "./client";
import { AiError } from "./errors";

function parse(
  message: AssistantMessage,
  refs: string[],
  allowed: readonly AssistantSummary[],
) {
  if (message.role !== "assistant") throw Error("Invalid assistant role");
  if (message.tool_calls?.length) throw Error("Unexpected final tool call");
  const answer = assistantAnswerSchema.parse(JSON.parse(message.content ?? ""));
  if (answer.references.some((id) => !refs.includes(id)))
    throw Error("Unknown reference");
  if (!allowed.includes(answer.summary))
    throw Error("Summary not supported by tool results");
  return answer;
}
export function answerRepairInstruction(
  refs: string[],
  allowed: readonly AssistantSummary[] = assistantSummaries,
): Message {
  return {
    role: "system",
    content: `最终回答未通过校验。只返回单个JSON对象，恰好包含summary和references，不带说明或代码围栏。summary从${JSON.stringify(allowed)}逐字选择，依据实际工具结果如实报告成功、空结果、澄清或失败；互助草稿尚未发布。references只可选${JSON.stringify(refs)}，没有引用时用[]。不要请求工具或生成实体。`,
  };
}
/** One real model repair, within the caller's existing round and quota limits. */
export async function checkedAnswer(
  message: AssistantMessage,
  refs: string[],
  repair?: () => Promise<{ message: AssistantMessage; usage: unknown }>,
  allowed: readonly AssistantSummary[] = assistantSummaries,
) {
  try {
    return {
      answer: parse(message, refs, allowed),
      message: { ...message, role: "assistant" as const },
      repaired: false,
      usage: null as unknown,
    };
  } catch {
    if (repair) {
      const result = await repair();
      try {
        return {
          answer: parse(result.message, refs, allowed),
          message: { ...result.message, role: "assistant" as const },
          repaired: true,
          usage: result.usage,
        };
      } catch {
        /* Never salvage a prefix or substitute a canned successful answer. */
      }
    }
    throw new AiError("AI_INVALID_OUTPUT", "助手回答未通过工具结果与引用校验");
  }
}
