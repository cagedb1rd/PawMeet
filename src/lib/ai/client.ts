import { z } from "zod";
import {
  AiData,
  AiTask,
  TaskRequest,
  outputSchemas,
  AiSuccess,
  AssistantRequest,
  AssistantStep,
  toolCallSchema,
  assistantAnswerSchema,
} from "./contracts";
const assistantStepSchema = z.strictObject({
  continuation: z.string().max(40000),
  toolCalls: z.array(toolCallSchema).max(3),
  answer: assistantAnswerSchema.nullable(),
});
async function request<T>(
  task: string,
  body: unknown,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<AiSuccess<T>> {
  const response = await fetch(`/api/ai/${task}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(45000)])
      : AbortSignal.timeout(45000),
  });
  const result = await response.json();
  if (!response.ok || result.ok !== true)
    throw Error(
      `${result.error?.message ?? "AI调用失败"} [${result.error?.code ?? response.status} · ${result.requestId ?? "无请求编号"}]`,
    );
  return { ...result, data: schema.parse(result.data) };
}
export function aiTask<T extends AiTask>(
  task: T,
  body: TaskRequest,
  signal?: AbortSignal,
) {
  return request(
    task,
    body,
    outputSchemas[task] as unknown as z.ZodType<AiData<T>>,
    signal,
  );
}
export function aiAssistant(body: AssistantRequest, signal?: AbortSignal) {
  return request<AssistantStep>("assistant", body, assistantStepSchema, signal);
}
