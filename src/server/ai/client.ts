import "server-only";
import { z } from "zod";
import { toolCallSchema, type AiProgress } from "@/lib/ai/contracts";
import { AiError } from "./errors";
import { reserveAiCall, withAiSlot } from "./quota";
import {
  ModelKind,
  PROVIDERS,
  resolveModel,
  transportConfig,
} from "./models";
import { readChatStream, type Usage } from "./sse";
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };
export type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | ContentPart[];
  tool_calls?: z.infer<typeof toolCallSchema>[];
  tool_call_id?: string;
};
export type AssistantMessage = {
  role: "assistant";
  content: string | null;
  tool_calls?: z.infer<typeof toolCallSchema>[];
};
export type ModelResult = {
  message: AssistantMessage;
  usage: Usage | null;
  model: string;
  /** Upstream attempts including one automatic retry; omitted by test doubles. */
  attempts?: number;
  streamed?: boolean;
};
/**
 * Server / eval-side call options. Route handlers never copy these from browser input:
 * `model` is a whitelisted override for evaluations only.
 */
export type CallOptions = {
  kind?: ModelKind;
  model?: string;
  stream?: boolean;
  /**
   * idempotent: retry once on 429/5xx, network, timeout or mid-stream interruption.
   * pre-response: retry once only when no response body was consumed (429/5xx, connect
   * errors, first-byte timeout). none: never retry.
   */
  retry?: "idempotent" | "pre-response" | "none";
  signal?: AbortSignal;
  onProgress?: (progress: AiProgress) => void;
  backoffMs?: number;
  /**
   * Evaluation only: reserves each attempt's worst case in an independent eval budget
   * instead of the product ledger. Throwing here stops the attempt before any fetch.
   */
  reserve?: (worstTokens: number) => Promise<void> | void;
};
/** Conservative quota estimate for one ≤512px thumbnail, instead of counting base64 bytes. */
const IMAGE_TOKEN_ESTIMATE = 1500;
const RETRYABLE_STATUS = [429, 500, 502, 503, 504];
const RETRYABLE_NETWORK = [
  "ECONNRESET",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
];

/** Builds an image part for vision models; only compressed JPEG/PNG/WebP data URLs. */
export function imagePart(dataUrl: string): ContentPart {
  if (
    !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(dataUrl) ||
    dataUrl.length > 400000
  )
    throw new AiError("AI_INPUT", "图片必须是已压缩的JPEG/PNG/WebP缩略图", 400);
  return { type: "image_url", image_url: { url: dataUrl } };
}

export function aiConfig(kind: ModelKind = "text", model?: string) {
  const profile = resolveModel(kind, model);
  const provider = PROVIDERS[profile.provider];
  const key = process.env[provider.keyEnv];
  if (process.env.AI_ENABLED !== "true" || !key)
    throw new AiError(
      "AI_NOT_CONFIGURED",
      `AI尚未配置：请在服务端设置${provider.keyEnv}并启用AI_ENABLED`,
      503,
    );
  // Gemini uses its fixed official endpoint; only the DashScope region is configurable.
  if (profile.provider === "gemini")
    return {
      model: profile.id,
      profile,
      url: provider.url,
      key,
      ...transportConfig(),
    };
  const base = new URL(
    process.env.AI_BASE_URL ||
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
  );
  if (
    base.protocol !== "https:" ||
    !(
      new Set(["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com"]).has(
        base.hostname,
      ) ||
      /^[a-z0-9-]+\.(cn-beijing|ap-southeast-1|us-east-1|ap-northeast-1)\.maas\.aliyuncs\.com$/.test(
        base.hostname,
      )
    ) ||
    base.port ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname.replace(/\/$/, "") !== "/compatible-mode/v1"
  )
    throw new AiError("AI_CONFIG", "AI_BASE_URL必须是百炼官方兼容API地址", 503);
  return {
    model: profile.id,
    profile,
    url: `${base.origin}/compatible-mode/v1/chat/completions`,
    key,
    ...transportConfig(),
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
            .nullable()
            .transform((value) => value ?? undefined)
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readJson(response: Response) {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.length;
    if (length > 64000) {
      await reader.cancel();
      throw new AiError("AI_UPSTREAM_RESPONSE_LIMIT", "模型响应超过限制");
    }
    chunks.push(part.value);
  }
  const result = responseSchema.parse(
    JSON.parse(Buffer.concat(chunks).toString("utf8")),
  );
  const choice = result.choices[0];
  return {
    finishReason: choice.finish_reason,
    content: choice.message.content ?? "",
    toolCalls: choice.message.tool_calls ?? [],
    usage: result.usage ?? null,
  };
}

export async function callModel(
  messages: Message[],
  session: string,
  requestId: string,
  tools?: unknown[],
  transport: typeof fetch = fetch,
  jsonSchema?: Record<string, unknown>,
  options: CallOptions = {},
): Promise<ModelResult> {
  const config = aiConfig(options.kind, options.model);
  const { profile } = config;
  const images = messages.flatMap((m) =>
    Array.isArray(m.content)
      ? m.content.filter((p) => p.type === "image_url")
      : [],
  );
  if ((images.length && !profile.images) || (tools && profile.kind !== "text"))
    throw new AiError(
      "AI_MODEL_CAPABILITY",
      `${profile.id}不支持本次请求的${images.length ? "图片输入" : "工具调用"}`,
      400,
    );
  if (jsonSchema && !profile.responseFormat)
    throw new AiError(
      "AI_MODEL_CAPABILITY",
      `${profile.id}未开启结构化输出参数，需由业务层解析文本并校验`,
      400,
    );
  if (images.length > 4)
    throw new AiError("AI_INPUT", "单次最多4张缩略图", 400);
  const stream = profile.streamOnly || (options.stream ?? config.stream);
  const retry = options.retry ?? "idempotent";
  const payload = {
    model: config.model,
    messages,
    ...(profile.thinkingParams
      ? { enable_thinking: false, preserve_thinking: false }
      : {}),
    ...(profile.reasoningEffort
      ? { reasoning_effort: profile.reasoningEffort }
      : {}),
    ...(profile.temperature === null
      ? {}
      : { temperature: profile.temperature }),
    max_tokens: profile.maxOutputTokens,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(profile.responseFormat
      ? {
          response_format: jsonSchema
            ? {
                type: "json_schema",
                json_schema: {
                  name: "pawmeet_result",
                  strict: true,
                  schema: jsonSchema,
                },
              }
            : { type: "json_object" },
        }
      : {}),
    ...(tools ? { tools, tool_choice: "auto", parallel_tool_calls: true } : {}),
  };
  const body = JSON.stringify(payload);
  // Size and quota count text bytes; each image counts as a fixed thumbnail estimate.
  const textBytes = Buffer.byteLength(
    images.length
      ? JSON.stringify(payload, (key, value) =>
          key === "image_url" ? { url: "" } : value,
        )
      : body,
    "utf8",
  );
  if (textBytes > 30000)
    throw new AiError(
      "AI_CONTEXT_LIMIT",
      "对话上下文已达上限，请开启新对话",
      400,
    );
  const worstTokens =
    textBytes + profile.maxOutputTokens + images.length * IMAGE_TOKEN_ESTIMATE;
  const maxAttempts = retry === "none" ? 1 : 2;
  const progress = options.onProgress;
  return withAiSlot(async () => {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (options.signal?.aborted)
        throw new AiError("AI_CANCELLED", "请求已取消", 499);
      // Every attempt reserves its own worst case. Never refund unknown consumption.
      if (options.reserve) await options.reserve(worstTokens);
      else await reserveAiCall(session, worstTokens);
      progress?.({
        stage: attempt ? "retrying" : "waiting",
        attempt: attempt + 1,
        chars: 0,
      });
      const controller = new AbortController();
      let reason: "first-byte" | "total" | "client" | undefined;
      const abort = (why: typeof reason) => {
        reason ??= why;
        controller.abort();
      };
      const firstByte = setTimeout(
        () => abort("first-byte"),
        config.firstByteMs,
      );
      const total = setTimeout(() => abort("total"), config.totalMs);
      const onClient = () => abort("client");
      options.signal?.addEventListener("abort", onClient);
      let received = false;
      let again = false;
      let backoff = options.backoffMs ?? 500;
      const canRetry = (preResponse: boolean) =>
        attempt + 1 < maxAttempts &&
        (retry === "idempotent" || (retry === "pre-response" && preResponse));
      try {
        const response = await transport(config.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.key}`,
            "Content-Type": "application/json",
            Accept: stream ? "text/event-stream" : "application/json",
            "X-Client-Request-Id": requestId,
          },
          body,
          signal: controller.signal,
          redirect: "error",
        });
        if (!response.ok) {
          if (RETRYABLE_STATUS.includes(response.status) && canRetry(true)) {
            const after = Number(response.headers.get("retry-after"));
            if (Number.isFinite(after) && after > 0)
              backoff = Math.max(backoff, Math.min(after * 1000, 3000));
            await response.body?.cancel();
            again = true;
            continue;
          }
          const provider = await response.json().catch(() => null);
          const providerCode =
            typeof provider?.error?.code === "string" &&
            /^[a-z0-9_-]{1,20}$/i.test(provider.error.code)
              ? provider.error.code
              : undefined;
          throw new AiError(
            `AI_UPSTREAM_HTTP_${response.status}`,
            response.status === 401 || response.status === 403
              ? "模型认证或访问权限失败"
              : response.status === 429
                ? "模型请求已受限，请稍后重试"
                : "模型服务调用失败，请稍后重试",
            502,
            RETRYABLE_STATUS.includes(response.status),
            providerCode,
          );
        }
        if (!response.body)
          throw new AiError("AI_UPSTREAM_EMPTY", "模型返回空响应");
        const sse =
          stream &&
          !response.headers.get("content-type")?.includes("application/json");
        if (!sse) clearTimeout(firstByte);
        let lastProgress = 0;
        const result = sse
          ? await readChatStream(response.body, (chars) => {
              if (!received) {
                received = true;
                clearTimeout(firstByte);
              }
              const now = Date.now();
              if (now - lastProgress >= 250) {
                lastProgress = now;
                progress?.({ stage: "receiving", attempt: attempt + 1, chars });
              }
            })
          : ((received = true), await readJson(response));
        if (!["stop", "tool_calls"].includes(result.finishReason ?? ""))
          throw new AiError(
            "AI_UPSTREAM_INCOMPLETE",
            "模型输出未完整结束，不能使用该草稿",
          );
        const toolCalls = z
          .array(toolCallSchema)
          .max(3)
          .parse(result.toolCalls.filter(Boolean));
        if (result.content.length > 16000)
          throw new AiError("AI_UPSTREAM_RESPONSE_LIMIT", "模型响应超过限制");
        if (!result.content && !toolCalls.length)
          throw new AiError("AI_UPSTREAM_EMPTY", "模型未返回内容或工具调用");
        return {
          message: {
            role: "assistant" as const,
            content: result.content || null,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          } satisfies AssistantMessage,
          usage: result.usage,
          model: config.model,
          attempts: attempt + 1,
          streamed: sse,
        };
      } catch (e) {
        if (reason === "client")
          throw new AiError("AI_CANCELLED", "请求已取消", 499);
        if (e instanceof AiError) {
          if (e.code === "AI_UPSTREAM_STREAM_INTERRUPTED" && canRetry(false)) {
            again = true;
            continue;
          }
          throw e;
        }
        if (reason) {
          const preResponse = reason === "first-byte" || !received;
          if (canRetry(preResponse)) {
            again = true;
            continue;
          }
          throw new AiError(
            "AI_UPSTREAM_TIMEOUT",
            reason === "first-byte"
              ? "模型长时间未开始响应，请手动重试"
              : "模型请求超时，请手动重试",
            504,
            true,
          );
        }
        if (e instanceof SyntaxError || e instanceof z.ZodError)
          throw new AiError(
            "AI_UPSTREAM_INVALID_RESPONSE",
            "模型返回非法结构或非JSON内容",
          );
        const networkCode = (e as { cause?: { code?: string } })?.cause?.code;
        const transient =
          (networkCode && RETRYABLE_NETWORK.includes(networkCode)) ||
          (e as Error)?.message === "terminated";
        if (transient && canRetry(!received)) {
          again = true;
          continue;
        }
        throw new AiError(
          "AI_UPSTREAM_NETWORK",
          "模型网络连接失败，请手动重试",
          502,
          true,
        );
      } finally {
        clearTimeout(firstByte);
        clearTimeout(total);
        options.signal?.removeEventListener("abort", onClient);
        if (again) await sleep(backoff);
      }
    }
    throw new AiError("AI_UPSTREAM_RETRY_LIMIT", "模型重试次数已达上限");
  });
}
