import "server-only";
import { AiError } from "./errors";

export type ModelKind = "text" | "vision";
export type ModelProfile = {
  id: string;
  kind: ModelKind;
  /** Provider only accepts stream=true (Qwen-Omni class; re-verify in docs before step 7). */
  streamOnly: boolean;
  /** Sends enable_thinking/preserve_thinking=false. */
  thinkingParams: boolean;
  /** Sends response_format (JSON mode / strict JSON Schema). */
  responseFormat: boolean;
  /** Accepts image_url content parts. */
  images: boolean;
};

/**
 * Server whitelist (AGENTS「AI 与模型」). Names still pending step 5 verification against
 * the Model Studio list; changes require user approval. No automatic fallback.
 */
export const MODEL_WHITELIST: Record<ModelKind, readonly ModelProfile[]> = {
  text: ["qwen3.8-flash", "qwen3.8-max-0902", "qwen3.8-27b"].map((id) => ({
    id,
    kind: "text" as const,
    streamOnly: false,
    thinkingParams: true,
    responseFormat: true,
    images: false,
  })),
  vision: ["qwen3.8-omni-flash", "qwen3.5-omni-plus"].map((id) => ({
    id,
    kind: "vision" as const,
    streamOnly: true,
    thinkingParams: false,
    responseFormat: false,
    images: true,
  })),
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
