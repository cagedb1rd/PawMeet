import type { VisionCase } from "../cases/vision";

/**
 * Simulated vision transport (SSE like DashScope / Gemini). Answers follow the case labels so
 * the report format can be shown without any model call; two deliberate deviations (one wrong
 * size, one health claim) demonstrate failure rows. Numbers are synthetic: 模拟数据.
 */
export function createVisionMockTransport(ctx: {
  current: VisionCase | null;
}): typeof fetch {
  return async () => {
    const c = ctx.current!;
    const dog =
      c.isDog === false
        ? { value: "no", confidence: 0.92 }
        : c.isDog
          ? { value: "yes", confidence: 0.93 }
          : { value: "unsure", confidence: 0.4 };
    const out = {
      dog,
      multipleDogs: c.multiple,
      breed: { value: c.breed, confidence: c.breed ? 0.82 : 0.2 },
      size: {
        value: c.id.endsWith("dog-4") ? "large" : (c.sizes?.[0] ?? "unknown"),
        confidence: c.sizes?.length ? 0.75 : 0.2,
      },
      coatColor: {
        value: c.isDog ? "棕白相间" : null,
        confidence: c.isDog ? 0.7 : 0.1,
      },
      features: c.id.endsWith("dog-6")
        ? [{ value: "看起来很健康", confidence: 0.8 }]
        : c.isDog
          ? [{ value: "垂耳", confidence: 0.7 }]
          : [],
    };
    const usage = {
      prompt_tokens: 900,
      completion_tokens: 120,
      total_tokens: 1020,
    };
    const events = [
      {
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: JSON.stringify(out) },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage },
    ];
    return new Response(
      events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  };
}
