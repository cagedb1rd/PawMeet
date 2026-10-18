import { z } from "zod";
import {
  AI_STREAM_TYPE,
  AiData,
  AiProgress,
  AiTask,
  TaskRequest,
  outputSchemas,
  AiSuccess,
  AssistantRequest,
  AssistantStep,
  aiProgressSchema,
  toolCallSchema,
  assistantAnswerSchema,
} from "./contracts";
const assistantStepSchema = z.strictObject({
  continuation: z.string().max(40000),
  toolCalls: z.array(toolCallSchema).max(3),
  answer: assistantAnswerSchema.nullable(),
});
export type ProgressHandler = (progress: AiProgress) => void;
/** Covers one server step: up to two model calls (repair) with one retry each. */
const BROWSER_TIMEOUT_MS = 120000;

/** Reads the route's NDJSON body: progress lines, then one result or error line. */
export async function readAiStream(
  body: ReadableStream<Uint8Array>,
  onProgress?: ProgressHandler,
): Promise<{ status: number; result: unknown }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const part = await reader.read();
    buffer += part.done
      ? decoder.decode()
      : decoder.decode(part.value, { stream: true });
    let index: number;
    while (
      (index = buffer.indexOf("\n")) >= 0 ||
      (part.done && buffer.trim())
    ) {
      const line = (index >= 0 ? buffer.slice(0, index) : buffer).trim();
      buffer = index >= 0 ? buffer.slice(index + 1) : "";
      if (!line) continue;
      let event: { type?: string; status?: number; body?: unknown };
      try {
        event = JSON.parse(line);
      } catch {
        throw Error("AI响应格式异常，未得到结果，请重试");
      }
      if (event.type === "progress") {
        const { type, ...rest } = event;
        void type;
        const progress = aiProgressSchema.safeParse(rest);
        if (progress.success) onProgress?.(progress.data);
      } else if (event.type === "result" || event.type === "error") {
        await reader.cancel().catch(() => {});
        return {
          status: event.type === "result" ? 200 : (event.status ?? 502),
          result: event.body,
        };
      }
    }
    if (part.done) throw Error("AI响应在完成前中断，未得到结果，请重试");
  }
}

export function describeProgress(progress: AiProgress | null, seconds: number) {
  if (progress?.stage === "receiving")
    return `Qwen 正在生成，已接收约 ${progress.chars} 字符…`;
  if (progress?.stage === "retrying") return "上游响应异常，正在自动重试 1 次…";
  return seconds >= 3 ? `等待 Qwen 响应（${seconds} 秒）…` : "";
}

async function request<T>(
  task: string,
  body: unknown,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
  onProgress?: ProgressHandler,
): Promise<AiSuccess<T>> {
  onProgress?.({ stage: "waiting", attempt: 1, chars: 0 });
  const response = await fetch(`/api/ai/${task}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: `${AI_STREAM_TYPE}, application/json`,
    },
    body: JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(BROWSER_TIMEOUT_MS)])
      : AbortSignal.timeout(BROWSER_TIMEOUT_MS),
  });
  const { status, result } =
    response.body &&
    response.headers.get("content-type")?.startsWith(AI_STREAM_TYPE)
      ? await readAiStream(response.body, onProgress)
      : { status: response.status, result: await response.json() };
  const parsed = result as {
    ok?: unknown;
    requestId?: string;
    data?: unknown;
    error?: { message?: string; code?: string };
  };
  if (status < 200 || status >= 300 || parsed?.ok !== true)
    throw Error(
      `${parsed?.error?.message ?? "AI调用失败"} [${parsed?.error?.code ?? status} · ${parsed?.requestId ?? "无请求编号"}]`,
    );
  return {
    ...(parsed as AiSuccess<unknown>),
    data: schema.parse(parsed.data),
  };
}
export function aiTask<T extends AiTask>(
  task: T,
  body: TaskRequest,
  signal?: AbortSignal,
  onProgress?: ProgressHandler,
) {
  return request(
    task,
    body,
    outputSchemas[task] as unknown as z.ZodType<AiData<T>>,
    signal,
    onProgress,
  );
}
export function aiAssistant(
  body: AssistantRequest,
  signal?: AbortSignal,
  onProgress?: ProgressHandler,
) {
  return request<AssistantStep>(
    "assistant",
    body,
    assistantStepSchema,
    signal,
    onProgress,
  );
}
