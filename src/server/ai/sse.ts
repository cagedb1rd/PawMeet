import "server-only";
import { z } from "zod";
import { AiError } from "./errors";

const usageSchema = z.object({
  prompt_tokens: z.number().nonnegative(),
  completion_tokens: z.number().nonnegative(),
  total_tokens: z.number().nonnegative(),
});
export type Usage = z.infer<typeof usageSchema>;
const chunkSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullable().optional(),
            tool_calls: z
              .array(
                z.object({
                  index: z.number().int().nonnegative().max(2),
                  id: z.string().nullable().optional(),
                  type: z.string().nullable().optional(),
                  function: z
                    .object({
                      name: z.string().nullable().optional(),
                      arguments: z.string().nullable().optional(),
                    })
                    .optional(),
                }),
              )
              .nullable()
              .optional(),
          })
          .optional(),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .optional(),
  usage: usageSchema.nullable().optional(),
});
export const STREAM_LIMITS = { rawBytes: 512000, line: 64000, text: 16000 };
export type StreamResult = {
  content: string;
  toolCalls: {
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }[];
  finishReason: string | null;
  usage: Usage | null;
};

/**
 * Parses an OpenAI-compatible chat.completions SSE body: concatenates content deltas,
 * stitches tool_call fragments by index, and keeps the trailing usage chunk.
 * Throws AI_UPSTREAM_STREAM_INTERRUPTED (retryable) when the stream closes before a
 * finish_reason; transport errors from the reader propagate to the caller.
 */
export async function readChatStream(
  body: ReadableStream<Uint8Array>,
  onDelta?: (chars: number) => void,
): Promise<StreamResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const result: StreamResult = {
    content: "",
    toolCalls: [],
    finishReason: null,
    usage: null,
  };
  let raw = 0;
  let buffer = "";
  let done = false;
  const fail = async (error: AiError) => {
    await reader.cancel().catch(() => {});
    throw error;
  };
  const handle = async (line: string) => {
    if (!line.startsWith("data:")) return; // comments, event:, id:, retry:
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      done = true;
      return;
    }
    let chunk: z.infer<typeof chunkSchema>;
    try {
      const value = JSON.parse(data);
      if (value && typeof value === "object" && "error" in value)
        return fail(
          new AiError("AI_UPSTREAM_STREAM_ERROR", "Qwen流式响应返回错误"),
        );
      chunk = chunkSchema.parse(value);
    } catch (e) {
      if (e instanceof AiError) throw e;
      return fail(
        new AiError(
          "AI_UPSTREAM_INVALID_RESPONSE",
          "Qwen返回非法结构或非JSON内容",
        ),
      );
    }
    if (chunk.usage) result.usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta;
    if (delta?.content) result.content += delta.content;
    for (const part of delta?.tool_calls ?? []) {
      const call = (result.toolCalls[part.index] ??= {
        id: "",
        type: "function",
        function: { name: "", arguments: "" },
      });
      if (part.id) call.id = part.id;
      if (part.type) call.type = part.type;
      // Names arrive whole in the first fragment; never concatenate repeats.
      if (part.function?.name && !call.function.name)
        call.function.name = part.function.name;
      if (part.function?.arguments)
        call.function.arguments += part.function.arguments;
    }
    if (choice.finish_reason) result.finishReason = choice.finish_reason;
    const size =
      result.content.length +
      result.toolCalls.reduce(
        (n, c) => n + (c?.function.arguments.length ?? 0),
        0,
      );
    if (size > STREAM_LIMITS.text)
      return fail(
        new AiError("AI_UPSTREAM_RESPONSE_LIMIT", "Qwen响应超过限制"),
      );
    onDelta?.(size);
  };
  while (!done) {
    const part = await reader.read();
    if (part.done) {
      buffer += decoder.decode();
      break;
    }
    raw += part.value.length;
    if (raw > STREAM_LIMITS.rawBytes)
      return fail(
        new AiError("AI_UPSTREAM_RESPONSE_LIMIT", "Qwen响应超过限制"),
      );
    buffer += decoder.decode(part.value, { stream: true });
    let index: number;
    while (!done && (index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      await handle(line);
    }
    if (buffer.length > STREAM_LIMITS.line)
      return fail(
        new AiError("AI_UPSTREAM_RESPONSE_LIMIT", "Qwen响应超过限制"),
      );
  }
  if (!done && buffer.trim()) await handle(buffer.replace(/\r$/, ""));
  if (done) await reader.cancel().catch(() => {});
  if (!result.finishReason)
    throw new AiError(
      "AI_UPSTREAM_STREAM_INTERRUPTED",
      "Qwen流式输出中途断开，未得到完整结果",
      502,
      true,
    );
  if (result.toolCalls.some((c) => !c))
    throw new AiError(
      "AI_UPSTREAM_INVALID_RESPONSE",
      "Qwen返回非法结构或非JSON内容",
    );
  return result;
}
