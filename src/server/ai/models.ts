import "server-only";
import { AiError } from "./errors";
import type { ImageTokenRule } from "@/lib/ai/estimate";

export type ModelKind = "text" | "vision";
export type Provider = "dashscope" | "gemini";
/** Server-only provider endpoints and key variables; never configurable from the browser. */
export const PROVIDERS: Record<
  Provider,
  { label: string; keyEnv: string; url: string }
> = {
  dashscope: {
    label: "Qwen",
    keyEnv: "DASHSCOPE_API_KEY",
    url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  },
  gemini: {
    label: "Gemini",
    keyEnv: "GEMINI_API_KEY",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  },
};
export type ModelProfile = {
  id: string;
  kind: ModelKind;
  provider: Provider;
  /** Provider only accepts stream=true (qwen3.5-omni per the Qwen-Omni docs). */
  streamOnly: boolean;
  /** Sends enable_thinking/preserve_thinking=false. */
  thinkingParams: boolean;
  /**
   * Strongest response_format the model supports. json_object models receive JSON mode even
   * when a schema is requested (Qwen-Omni has no JSON Schema mode; multimodal requests are
   * downgraded by the provider anyway); the business layer validates with Zod either way.
   */
  responseFormat: "json_schema" | "json_object";
  /** Accepts image_url content parts. */
  images: boolean;
  /** Image token rule for reservations (see src/lib/ai/estimate.ts). */
  imageTokens?: ImageTokenRule;
  /** Sends modalities:["text"] (Qwen-Omni can also answer with audio). */
  textOnly?: boolean;
  /**
   * OpenAI reasoning_effort: lowest level for Gemini 3 (thinking cannot be turned off);
   * "none" turns off qwen3.8-omni-flash thinking, which is on by default (xhigh).
   */
  reasoningEffort?: "none" | "minimal" | "low";
  /** null = provider default (Gemini 3 recommends keeping the default 1.0). */
  temperature: number | null;
  /** max_tokens; on Gemini 3 it includes thinking tokens, so it is set higher. */
  maxOutputTokens: number;
};
const qwenText = (id: string): ModelProfile => ({
  id,
  kind: "text",
  provider: "dashscope",
  streamOnly: false,
  thinkingParams: true,
  responseFormat: "json_schema",
  images: false,
  temperature: 0.1,
  maxOutputTokens: 1400,
});
const geminiText = (
  id: string,
  reasoningEffort: "minimal" | "low",
): ModelProfile => ({
  id,
  kind: "text",
  provider: "gemini",
  streamOnly: false,
  thinkingParams: false,
  responseFormat: "json_schema",
  images: false,
  reasoningEffort,
  temperature: null,
  maxOutputTokens: 4096,
});

/**
 * Qwen-Omni (verified in the Qwen-Omni docs, 2026-10-19): 3.8-omni-flash accepts stream=false
 * and thinks by default (reasoning_effort "none" turns it off); 3.5-omni only streams and has no
 * thinking mode. Both support JSON mode but not JSON Schema. Output is small JSON, so 1000.
 */
const qwenOmni = (
  id: string,
  extra: Pick<ModelProfile, "streamOnly"> & Partial<ModelProfile>,
): ModelProfile => ({
  id,
  kind: "vision",
  provider: "dashscope",
  thinkingParams: false,
  responseFormat: "json_object",
  images: true,
  imageTokens: "qwen",
  textOnly: true,
  temperature: 0.1,
  maxOutputTokens: 1000,
  ...extra,
});
/** Gemini vision: same thinking levels as text; 2048 covers thinking plus a small JSON. */
const geminiVision = (
  id: string,
  reasoningEffort: "minimal" | "low",
): ModelProfile => ({
  ...geminiText(id, reasoningEffort),
  kind: "vision",
  images: true,
  imageTokens: "gemini3",
  maxOutputTokens: 2048,
});

/**
 * Server whitelist (AGENTS「AI 与模型」), names verified against each provider's model list;
 * changes require user approval. No automatic fallback, across or within providers.
 * Gemini thinking uses the lowest level each model supports (3.8 Flash cannot go below low).
 */
export const MODEL_WHITELIST: Record<ModelKind, readonly ModelProfile[]> = {
  text: [
    qwenText("qwen3.8-flash"),
    qwenText("qwen3.8-max-0902"),
    qwenText("qwen3.8-27b"),
    geminiText("gemini-3.5-flash-lite", "minimal"),
    geminiText("gemini-3.8-flash", "low"),
  ],
  vision: [
    qwenOmni("qwen3.8-omni-flash", {
      streamOnly: false,
      reasoningEffort: "none",
    }),
    qwenOmni("qwen3.5-omni-plus", { streamOnly: true }),
    geminiVision("gemini-3.5-flash-lite", "minimal"),
    geminiVision("gemini-3.8-flash", "low"),
  ],
};
const DEFAULT_MODEL: Record<ModelKind, string> = {
  text: "qwen3.8-flash",
  vision: "qwen3.8-omni-flash",
};
const ENV_NAME: Record<ModelKind, string> = {
  text: "AI_MODEL",
  vision: "AI_VISION_MODEL",
};

/** Resolves the env default or a server/eval-side override; never reads browser input. */
export function resolveModel(kind: ModelKind, override?: string): ModelProfile {
  const id = override || process.env[ENV_NAME[kind]] || DEFAULT_MODEL[kind];
  const profile = MODEL_WHITELIST[kind].find((m) => m.id === id);
  if (!profile)
    throw new AiError(
      "AI_MODEL_NOT_APPROVED",
      `仅允许白名单内${kind === "text" ? "文本" : "视觉"}模型：${MODEL_WHITELIST[kind].map((m) => m.id).join("、")}；其他型号需要用户授权`,
      503,
    );
  return profile;
}

function intEnv(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new AiError(
      "AI_CONFIG",
      `${name}必须是${min}–${max}之间的整数毫秒`,
      503,
    );
  return value;
}

export function transportConfig() {
  const stream = process.env.AI_STREAM || "true";
  if (stream !== "true" && stream !== "false")
    throw new AiError("AI_CONFIG", "AI_STREAM只能是true或false", 503);
  const firstByteMs = intEnv("AI_FIRST_BYTE_TIMEOUT_MS", 15000, 1000, 120000);
  const totalMs = intEnv("AI_TOTAL_TIMEOUT_MS", 40000, 1000, 180000);
  if (firstByteMs > totalMs)
    throw new AiError(
      "AI_CONFIG",
      "AI_FIRST_BYTE_TIMEOUT_MS不能大于AI_TOTAL_TIMEOUT_MS",
      503,
    );
  return { stream: stream === "true", firstByteMs, totalMs };
}
