import type { CommunityCase } from "../cases/community";

/**
 * Simulated transport for the community smoke: answers what an ideal model would for the
 * current case, so the pipeline (reservation, review, scoring, report) runs offline. Results
 * are labelled simulated and never mixed with live runs.
 */
export function createCommunityMockTransport(ctx: {
  current: CommunityCase | null;
}): typeof fetch {
  return async () => {
    const c = ctx.current;
    if (!c) throw Error("mock transport has no current case");
    const content =
      c.suite === "meta"
        ? {
            title: "模拟标题",
            tags: [...(c.anyOf ?? ["日常"]).slice(0, 1), "模拟", "宠物日常"],
            note: null,
          }
        : c.expect === "pass"
          ? { verdict: "pass", issues: [] }
          : {
              verdict: "revise",
              issues: [
                {
                  category: c.categories![0],
                  excerpt: c.text.slice(0, 8),
                  reason: "模拟原因",
                },
              ],
            };
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: JSON.stringify(content) },
          },
        ],
        usage: { prompt_tokens: 300, completion_tokens: 40, total_tokens: 340 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
}
