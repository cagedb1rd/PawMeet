/**
 * Report metrics. Percentiles use the nearest-rank method on the sorted sample
 * (p50 of [1,2,3,4] = 2, p95 of 20 values = the 19th): every reported value was observed.
 */
export function percentile(values: number[], q: number): number | null {
  if (!values.length) return null;
  if (!(q > 0 && q <= 1)) throw Error("percentile q must be in (0, 1]");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
}
export const ratio = (n: number, d: number) => (d ? n / d : null);

export type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};
export type CallRecord = {
  seq: number;
  caseId: string;
  repeat: number;
  step: number;
  model: string;
  promptVersion: string;
  validationVersion: string;
  git: string;
  attempts: number;
  retries: number;
  /** From call start to first response-body byte of the final attempt. */
  firstByteMs: number | null;
  totalMs: number;
  httpStatus: number | null;
  errorCode: string | null;
  usage: Usage | null;
  /** Worst-case tokens reserved before the attempts (request bytes + max output). */
  reservedTokens: number;
  /** Tokens charged to the eval budget (actual usage, or the conservative reservation). */
  chargedTokens: number;
  timedOutAttempts: number;
  /** Raw model output (content / native tool calls) before any validation. */
  response: { content: string | null; toolCalls?: unknown[] } | null;
  rawBodyExcerpt?: string;
  schemaValid: boolean | null;
  businessValid: boolean | null;
  keyFieldsCorrect: boolean | null;
};
export type AttemptStatus = "pass" | "fail" | "error" | "not_run";
export type CaseAttempt = {
  caseId: string;
  scenario: string;
  tags: string[];
  repeat: number;
  status: AttemptStatus;
  reason?: string;
  businessValid: boolean;
  fieldsCorrect: number;
  fieldsTotal: number;
  failedChecks: string[];
  error?: string;
  observed?: unknown;
  calls: CallRecord[];
};

export function summarize(attempts: CaseAttempt[]) {
  const executed = attempts.filter((a) => a.status !== "not_run");
  const calls = executed.flatMap((a) => a.calls);
  const responded = calls.filter((c) => c.response);
  // Latency samples: calls that returned a model response (timeouts / HTTP errors are counted apart).
  const completed = responded;
  const known = calls.filter((c) => c.usage);
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const byCase = new Map<string, CaseAttempt[]>();
  for (const a of attempts)
    byCase.set(a.caseId, [...(byCase.get(a.caseId) ?? []), a]);
  const fullyExecuted = [...byCase.values()].filter((xs) =>
    xs.every((a) => a.status !== "not_run"),
  );
  const totals = known.map((c) => c.usage!.total_tokens);
  return {
    attempts: {
      planned: attempts.length,
      executed: executed.length,
      pass: executed.filter((a) => a.status === "pass").length,
      fail: executed.filter((a) => a.status === "fail").length,
      error: executed.filter((a) => a.status === "error").length,
      notRun: attempts.length - executed.length,
    },
    passRate: ratio(
      executed.filter((a) => a.status === "pass").length,
      executed.length,
    ),
    schemaValidRate: ratio(
      responded.filter((c) => c.schemaValid).length,
      responded.length,
    ),
    businessValidRate: ratio(
      executed.filter((a) => a.businessValid).length,
      executed.length,
    ),
    keyFieldAccuracy: ratio(
      sum(executed.map((a) => a.fieldsCorrect)),
      sum(executed.map((a) => a.fieldsTotal)),
    ),
    completeTaskRate: ratio(
      fullyExecuted.filter((xs) => xs.every((a) => a.status === "pass")).length,
      fullyExecuted.length,
    ),
    calls: {
      total: calls.length,
      withResponse: responded.length,
      retries: sum(calls.map((c) => c.retries)),
      timeouts: calls.filter((c) => c.errorCode === "AI_UPSTREAM_TIMEOUT")
        .length,
      timedOutAttempts: sum(calls.map((c) => c.timedOutAttempts)),
      errors: Object.fromEntries(
        [...new Set(calls.map((c) => c.errorCode).filter(Boolean))].map(
          (code) => [code, calls.filter((c) => c.errorCode === code).length],
        ),
      ) as Record<string, number>,
    },
    latencyMs: {
      samples: completed.length,
      totalP50: percentile(
        completed.map((c) => c.totalMs),
        0.5,
      ),
      totalP95: percentile(
        completed.map((c) => c.totalMs),
        0.95,
      ),
      firstByteP50: percentile(
        completed.flatMap((c) =>
          c.firstByteMs === null ? [] : [c.firstByteMs],
        ),
        0.5,
      ),
      firstByteP95: percentile(
        completed.flatMap((c) =>
          c.firstByteMs === null ? [] : [c.firstByteMs],
        ),
        0.95,
      ),
    },
    tokens: {
      knownCalls: known.length,
      unknownCalls: calls.length - known.length,
      prompt: sum(known.map((c) => c.usage!.prompt_tokens)),
      completion: sum(known.map((c) => c.usage!.completion_tokens)),
      totalKnown: sum(totals),
      avgPerKnownCall: known.length ? sum(totals) / known.length : null,
      charged: sum(calls.map((c) => c.chargedTokens)),
    },
  };
}
export type Summary = ReturnType<typeof summarize>;
