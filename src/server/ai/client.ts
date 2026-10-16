import "server-only";
import { z } from "zod";
import { toolCallSchema } from "@/lib/ai/contracts";
import { AiError } from "./errors";
import { reserveAiCall, withAiSlot } from "./quota";
export type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: z.infer<typeof toolCallSchema>[];
  tool_call_id?: string;
};
export function aiConfig() {
  if (process.env.AI_ENABLED !== "true" || !process.env.GLM_API_KEY)
    throw new AiError(
      "AI_NOT_CONFIGURED",
      "AI尚未配置：请在服务端设置GLM_API_KEY并启用AI_ENABLED",
      503,
    );
  const model = process.env.GLM_MODEL || "glm-4.7-flash";
  if (model !== "glm-4.7-flash")
    throw new AiError(
      "AI_MODEL_NOT_APPROVED",
      "本阶段仅允许glm-4.7-flash；其他模型需要用户授权",
      503,
    );
  const base = new URL(
    process.env.GLM_BASE_URL || "https://open.bigmodel.cn/api/paas/v4",
  );
  if (
    base.protocol !== "https:" ||
    base.hostname !== "open.bigmodel.cn" ||
    base.port ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname.replace(/\/$/, "") !== "/api/paas/v4"
  )
    throw new AiError("AI_CONFIG", "GLM_BASE_URL必须是智谱普通API地址", 503);
  return {
    model,
    url: `${base.origin}/api/paas/v4/chat/completions`,
    key: process.env.GLM_API_KEY,
  };
}
const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string(),
        message: z.object({
          role: z.literal("assistant"),
          content: z.string().max(16000).nullable().optional(),
          tool_calls: z
            .array(
              toolCallSchema
                .extend({ index: z.number().int().nonnegative().optional() })
                .transform(({ index, ...call }) => {
                  void index;
                  return call;
                }),
            )
            .max(3)
            .optional(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().nonnegative(),
      completion_tokens: z.number().nonnegative(),
      total_tokens: z.number().nonnegative(),
    })
    .optional(),
});
export async function callGlm(
  messages: Message[],
  session: string,
  requestId: string,
  tools?: unknown[],
  transport: typeof fetch = fetch,
) {
  const config = aiConfig();
  const body = JSON.stringify({
    model: config.model,
    messages,
    request_id: requestId,
    thinking: { type: "disabled" },
    temperature: 0.1,
    max_tokens: 1400,
    stream: false,
    ...(tools
      ? { tools, tool_choice: "auto" }
      : { response_format: { type: "json_object" } }),
  });
  if (body.length > 30000)
    throw new AiError(
      "AI_CONTEXT_LIMIT",
      "对话上下文已达上限，请开启新对话",
      400,
    );
  return withAiSlot(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      // Conservatively reserve all request UTF-8 bytes plus output cap. Never refund unknown consumption.
      await reserveAiCall(session, Buffer.byteLength(body, "utf8") + 1400);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await transport(config.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.key}`,
            "Content-Type": "application/json",
          },
          body,
          signal: controller.signal,
          redirect: "error",
        });
        if (!response.ok) {
          if (attempt === 0 && [429, 503].includes(response.status)) {
            await response.body?.cancel();
            await new Promise((r) => setTimeout(r, 350));
            continue;
          }
          const provider = await response.json().catch(() => null);
          const providerCode =
            typeof provider?.error?.code === "string" &&
            /^[a-z0-9_-]{1,20}$/i.test(provider.error.code)
              ? provider.error.code
              : undefined;
          throw new AiError(
            `GLM_HTTP_${response.status}`,
            providerCode === "1305"
              ? "GLM免费模型当前访问量过大，请稍后重试"
              : response.status === 401 || response.status === 403
                ? "GLM认证或访问权限失败"
                : "GLM服务调用失败，请稍后重试",
            502,
            [429, 500, 502, 503, 504].includes(response.status),
            providerCode,
          );
        }
        if (!response.body) throw new AiError("GLM_EMPTY", "GLM返回空响应");
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.length;
          if (length > 64000) {
            await reader.cancel();
            throw new AiError("GLM_RESPONSE_LIMIT", "GLM响应超过限制");
          }
          chunks.push(part.value);
        }
        const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const result = responseSchema.parse(raw);
        const choice = result.choices[0];
        if (!["stop", "tool_calls"].includes(choice.finish_reason))
          throw new AiError(
            "GLM_INCOMPLETE",
            "GLM输出未完整结束，不能使用该草稿",
          );
        if (!choice.message.content && !choice.message.tool_calls?.length)
          throw new AiError("GLM_EMPTY", "GLM未返回内容或工具调用");
        return {
          message: {
            role: "assistant" as const,
            content: choice.message.content ?? null,
            ...(choice.message.tool_calls?.length
              ? { tool_calls: choice.message.tool_calls }
              : {}),
          },
          usage: result.usage ?? null,
          model: config.model,
        };
      } catch (e) {
        if (e instanceof AiError) throw e;
        if (controller.signal.aborted)
          throw new AiError(
            "GLM_TIMEOUT",
            "GLM请求超时，请手动重试",
            504,
            true,
          );
        if (e instanceof SyntaxError || e instanceof z.ZodError)
          throw new AiError(
            "GLM_INVALID_RESPONSE",
            "GLM返回非法结构或非JSON内容",
          );
        throw new AiError(
          "GLM_NETWORK",
          "GLM网络连接失败，请手动重试",
          502,
          true,
        );
      } finally {
        clearTimeout(timer);
      }
    }
    throw new AiError("GLM_RETRY_LIMIT", "GLM重试次数已达上限");
  });
}
