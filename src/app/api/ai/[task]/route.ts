import { NextRequest, NextResponse } from "next/server";
import {
  AI_STREAM_TYPE,
  AiProgress,
  AiTask,
  outputSchemas,
  taskRequestSchema,
  assistantRequestSchema,
  petPhotoRequestSchema,
  postMetaRequestSchema,
  postSafetyRequestSchema,
} from "@/lib/ai/contracts";
import {
  generateTask,
  assistantStep,
  recognizePetPhoto,
  generatePostMeta,
  precheckPost,
} from "@/server/ai/service";
import { aiConfig } from "@/server/ai/client";
import { AiError } from "@/server/ai/errors";
import { sessionId } from "@/server/ai/session";
import {
  COMMUNITY_PROMPT_VERSION,
  PHOTO_PROMPT_VERSION,
  PROMPT_VERSION,
} from "@/server/ai/prompts";
import { PROVIDERS } from "@/server/ai/models";
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
    const photo = task === "pet-photo";
    const community = task === "post-meta" || task === "post-safety";
    if (
      task !== "assistant" &&
      !photo &&
      !community &&
      !Object.hasOwn(outputSchemas, task)
    )
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
    // Bound the stream itself, rather than trusting Content-Length. A ≤512px JPEG thumbnail
    // is about 30–80KB of base64; text tasks stay at 48KB.
    const limit = photo || task === "post-meta" ? 170000 : 48000;
    const reader = request.body?.getReader();
    if (!reader) throw new AiError("AI_INPUT", "请求不能为空", 400);
    const parts: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const p = await reader.read();
      if (p.done) break;
      length += p.value.length;
      if (length > limit) {
        await reader.cancel();
        throw new AiError(
          "AI_INPUT_LIMIT",
          `AI请求超过${Math.round(limit / 1000)}KB限制`,
          413,
        );
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
        : photo
          ? petPhotoRequestSchema.safeParse(raw)
          : task === "post-meta"
            ? postMetaRequestSchema.safeParse(raw)
            : task === "post-safety"
              ? postSafetyRequestSchema.safeParse(raw)
              : taskRequestSchema.safeParse(raw);
    if (!parsed.success)
      throw new AiError("AI_INPUT", "请求字段或长度不合法", 400);
    // Post title / tags with a thumbnail go to the vision model; everything else is text.
    const vision =
      photo ||
      (task === "post-meta" &&
        !!postMetaRequestSchema.parse(parsed.data).image);
    const config = aiConfig(vision ? "vision" : "text");
    const session = sessionId(request.cookies.get("pawmeet-ai")?.value);
    // The browser never selects a model: only progress/signal are passed down.
    const run = (
      onProgress?: (p: AiProgress) => void,
    ): Promise<{ data: unknown; usage: unknown; model: string }> =>
      task === "post-meta"
        ? generatePostMeta(
            postMetaRequestSchema.parse(parsed.data),
            session.id,
            requestId,
            undefined,
            { onProgress, signal: request.signal },
          )
        : task === "post-safety"
          ? precheckPost(
              postSafetyRequestSchema.parse(parsed.data),
              session.id,
              requestId,
              undefined,
              { onProgress, signal: request.signal },
            )
          : photo
            ? recognizePetPhoto(
                petPhotoRequestSchema.parse(parsed.data),
                session.id,
                requestId,
                undefined,
                { onProgress, signal: request.signal },
              )
            : task === "assistant"
              ? assistantStep(
                  assistantRequestSchema.parse(parsed.data),
                  session.id,
                  requestId,
                  undefined,
                  undefined,
                  { onProgress, signal: request.signal },
                )
              : generateTask(
                  task as AiTask,
                  taskRequestSchema.parse(parsed.data),
                  session.id,
                  requestId,
                  undefined,
                  undefined,
                  { onProgress, signal: request.signal },
                );
    const success = (result: Awaited<ReturnType<typeof run>>) => ({
      ok: true,
      requestId,
      data: result.data,
      meta: {
        provider: PROVIDERS[config.profile.provider].label.toLowerCase(),
        model: result.model,
        promptVersion: photo
          ? PHOTO_PROMPT_VERSION
          : community
            ? COMMUNITY_PROMPT_VERSION
            : PROMPT_VERSION,
        schemaVersion: 1,
        latencyMs: Date.now() - start,
        usage: result.usage,
      },
    });
    const withCookie = <T extends NextResponse>(response: T) => {
      response.cookies.set("pawmeet-ai", session.cookie, {
        httpOnly: true,
        sameSite: "strict",
        secure:
          process.env.NODE_ENV === "production" && origin.startsWith("https:"),
        maxAge: 86400,
        path: "/api/ai",
      });
      return response;
    };
    if (!request.headers.get("accept")?.includes(AI_STREAM_TYPE))
      return withCookie(
        NextResponse.json(success(await run()), {
          headers: { "Cache-Control": "no-store" },
        }),
      );
    // NDJSON progress: switch to a stream only once the model starts responding, so
    // failures before that (quota, config, upstream HTTP) keep their real HTTP status.
    const encoder = new TextEncoder();
    const early: string[] = [];
    let sink: ((line: string) => void) | undefined;
    let started!: () => void;
    const progressed = new Promise<void>((r) => (started = r));
    const work = run((progress) => {
      const line = JSON.stringify({ type: "progress", ...progress }) + "\n";
      if (sink) sink(line);
      else early.push(line);
      if (progress.stage !== "waiting") started();
    });
    const first = await Promise.race([
      work.then((result) => ({ result })),
      progressed.then(() => null),
    ]);
    if (first)
      return withCookie(
        NextResponse.json(success(first.result), {
          headers: { "Cache-Control": "no-store" },
        }),
      );
    let open = true;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (line: string) => {
          if (open) controller.enqueue(encoder.encode(line));
        };
        early.forEach(write);
        sink = write;
        work
          .then(
            (result) =>
              write(
                JSON.stringify({ type: "result", body: success(result) }) +
                  "\n",
              ),
            (e) => {
              const { status, body } = failure(e, requestId);
              write(JSON.stringify({ type: "error", status, body }) + "\n");
            },
          )
          .finally(() => {
            if (open) controller.close();
            open = false;
          });
      },
      cancel() {
        open = false;
      },
    });
    return withCookie(
      new NextResponse(body, {
        headers: {
          "Content-Type": `${AI_STREAM_TYPE}; charset=utf-8`,
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        },
      }),
    );
  } catch (e) {
    const { status, body } = failure(e, requestId);
    return NextResponse.json(body, {
      status,
      headers: {
        "Cache-Control": "no-store",
        ...(status === 429 ? { "Retry-After": "60" } : {}),
      },
    });
  }
}
function failure(e: unknown, requestId: string) {
  const error =
    e instanceof AiError
      ? e
      : new AiError("AI_INTERNAL", "AI服务暂不可用", 503);
  return {
    status: error.status,
    body: {
      ok: false as const,
      requestId,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      },
    },
  };
}
