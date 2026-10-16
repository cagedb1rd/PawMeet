import { NextRequest, NextResponse } from "next/server";
import {
  AiTask,
  outputSchemas,
  taskRequestSchema,
  assistantRequestSchema,
} from "@/lib/ai/contracts";
import { generateTask, assistantStep } from "@/server/ai/service";
import { aiConfig } from "@/server/ai/client";
import { AiError } from "@/server/ai/errors";
import { sessionId } from "@/server/ai/session";
import { PROMPT_VERSION } from "@/server/ai/prompts";
export const runtime = "nodejs";
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ task: string }> },
) {
  const requestId = crypto.randomUUID();
  const start = Date.now();
  try {
    const origin = process.env.APP_ORIGIN;
    if (
      !origin ||
      request.headers.get("origin") !== origin ||
      request.headers.get("sec-fetch-site") === "cross-site"
    )
      throw new AiError("AI_ORIGIN", "AI请求来源未获允许", 403);
    const { task } = await params;
    if (task !== "assistant" && !Object.hasOwn(outputSchemas, task))
      throw new AiError("AI_TASK", "未知AI任务", 400);
    if (
      [
        "social-card",
        "social-analysis",
        "care-checklist",
        "post-copy",
        "match-intent",
      ].includes(task)
    )
      throw new AiError(
        "AI_TASK_RETIRED",
        "此独立AI功能已合并或改为规则，请使用活动智能约伴或手动表单",
        400,
      );
    // Bound the stream itself, rather than trusting Content-Length.
    const reader = request.body?.getReader();
    if (!reader) throw new AiError("AI_INPUT", "请求不能为空", 400);
    const parts: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const p = await reader.read();
      if (p.done) break;
      length += p.value.length;
      if (length > 48000) {
        await reader.cancel();
        throw new AiError("AI_INPUT_LIMIT", "AI请求超过48KB限制", 413);
      }
      parts.push(p.value);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.concat(parts).toString("utf8"));
    } catch {
      throw new AiError("AI_INPUT", "请求必须为JSON", 400);
    }
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      throw new AiError("AI_INPUT", "请求必须使用application/json", 400);
    const parsed =
      task === "assistant"
        ? assistantRequestSchema.safeParse(raw)
        : taskRequestSchema.safeParse(raw);
    if (!parsed.success)
      throw new AiError("AI_INPUT", "请求字段或长度不合法", 400);
    aiConfig();
    const session = sessionId(request.cookies.get("pawmeet-ai")?.value);
    const result =
      task === "assistant"
        ? await assistantStep(
            assistantRequestSchema.parse(parsed.data),
            session.id,
            requestId,
          )
        : await generateTask(
            task as AiTask,
            taskRequestSchema.parse(parsed.data),
            session.id,
            requestId,
          );
    const response = NextResponse.json(
      {
        ok: true,
        requestId,
        data: result.data,
        meta: {
          provider: "qwen",
          model: result.model,
          promptVersion: PROMPT_VERSION,
          schemaVersion: 1,
          latencyMs: Date.now() - start,
          usage: result.usage,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
    response.cookies.set("pawmeet-ai", session.cookie, {
      httpOnly: true,
      sameSite: "strict",
      secure:
        process.env.NODE_ENV === "production" && origin.startsWith("https:"),
      maxAge: 86400,
      path: "/api/ai",
    });
    return response;
  } catch (e) {
    const error =
      e instanceof AiError
        ? e
        : new AiError("AI_INTERNAL", "AI服务暂不可用", 503);
    return NextResponse.json(
      {
        ok: false,
        requestId,
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        },
      },
      {
        status: error.status,
        headers: {
          "Cache-Control": "no-store",
          ...(error.status === 429 ? { "Retry-After": "60" } : {}),
        },
      },
    );
  }
}
