import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AiError } from "../../src/server/ai/errors";

/**
 * Per-model token caps approved in AGENTS「AI 与模型」. A run's --token-limit can only lower
 * them; 0 (the default) allows no real call. Vision / community smoke are not text evals here.
 */
export const MODEL_TOKEN_CAPS: Record<string, number> = {
  "qwen3.8-flash": 200000,
  "qwen3.8-max-0902": 300000,
  "qwen3.8-27b": 300000,
};

const entrySchema = z.strictObject({
  /** Everything charged so far: actual usage plus conservative charges and open reservations. */
  chargedTokens: z.number().int().nonnegative(),
  knownTokens: z.number().int().nonnegative(),
  conservativeTokens: z.number().int().nonnegative(),
  transmissions: z.number().int().nonnegative(),
  runs: z.array(z.string()).max(500),
});
const ledgerSchema = z.strictObject({
  version: z.literal(1),
  purpose: z.literal("pawmeet-eval-budget"),
  models: z.record(z.string(), entrySchema),
});
export type Ledger = z.infer<typeof ledgerSchema>;
export type LedgerStore = {
  load(): Promise<Ledger>;
  save(ledger: Ledger): Promise<void>;
};
const fresh = (): Ledger => ({
  version: 1,
  purpose: "pawmeet-eval-budget",
  models: {},
});

/** In-memory store for simulated runs and tests. */
export function memoryStore(initial: Ledger = fresh()): LedgerStore & {
  value: Ledger;
} {
  const store = {
    value: structuredClone(initial),
    async load() {
      return structuredClone(store.value);
    },
    async save(l: Ledger) {
      store.value = structuredClone(l);
    },
  };
  return store;
}

/**
 * Evaluation-only ledger file (default .local/ai-eval/budget-ledger.json, git-ignored).
 * Independent from the product quota ledger. A corrupt file stops the run and is never
 * overwritten.
 */
export function fileStore(file: string): LedgerStore {
  const full = path.resolve(file);
  return {
    async load() {
      let text: string;
      try {
        text = await readFile(full, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return fresh();
        throw e;
      }
      const parsed = ledgerSchema.safeParse(
        (() => {
          try {
            return JSON.parse(text);
          } catch {
            return null;
          }
        })(),
      );
      if (!parsed.success)
        throw new AiError(
          "AI_EVAL_LEDGER",
          `评测额度账本损坏，拒绝运行且不覆盖：${full}`,
          503,
        );
      return parsed.data;
    },
    async save(l: Ledger) {
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(`${full}.tmp`, JSON.stringify(l, null, 2), {
        mode: 0o600,
      });
      await rename(`${full}.tmp`, full);
    },
  };
}

export type Ticket = { id: number; reserved: number; settled: boolean };

/**
 * Hard per-model token budget. Each upstream attempt reserves its worst case before the
 * request (request bytes + max output tokens, an over-estimate of tokens), so an attempt that
 * could cross the limit is refused before any fetch. Settling replaces the reservation with the
 * provider's actual usage; unknown usage (timeouts, interrupted streams, HTTP errors) keeps the
 * full reservation. The ledger is written at reserve time too, so a crash stays conservative.
 */
export class EvalBudget {
  private next = 1;
  private constructor(
    readonly model: string,
    readonly limit: number,
    private store: LedgerStore,
    private ledger: Ledger,
    private runId: string,
  ) {}
  static async open(opts: {
    model: string;
    limit: number;
    store: LedgerStore;
    runId: string;
  }) {
    if (!(opts.limit >= 0)) throw Error("token limit must be >= 0");
    const ledger = await opts.store.load();
    return new EvalBudget(
      opts.model,
      opts.limit,
      opts.store,
      ledger,
      opts.runId,
    );
  }
  private entry() {
    return (this.ledger.models[this.model] ??= {
      chargedTokens: 0,
      knownTokens: 0,
      conservativeTokens: 0,
      transmissions: 0,
      runs: [],
    });
  }
  get charged() {
    return this.ledger.models[this.model]?.chargedTokens ?? 0;
  }
  get remaining() {
    return Math.max(0, this.limit - this.charged);
  }
  snapshot() {
    return structuredClone(this.entry());
  }
  async reserve(worstTokens: number): Promise<Ticket> {
    const tokens = Math.ceil(worstTokens);
    if (!(tokens > 0)) throw Error("reservation must be positive");
    if (this.charged + tokens > this.limit)
      throw new AiError(
        "AI_EVAL_BUDGET",
        `${this.model} 评测额度不足：已计 ${this.charged} / 上限 ${this.limit}，本次预留 ${tokens}`,
        429,
      );
    const e = this.entry();
    e.chargedTokens += tokens;
    e.transmissions++;
    if (!e.runs.includes(this.runId))
      e.runs = [...e.runs, this.runId].slice(-500);
    await this.store.save(this.ledger);
    return { id: this.next++, reserved: tokens, settled: false };
  }
  /** Returns the tokens finally charged for this attempt. */
  async settle(ticket: Ticket, totalTokens: number | null): Promise<number> {
    if (ticket.settled) throw Error("ticket already settled");
    ticket.settled = true;
    const e = this.entry();
    if (totalTokens === null) {
      e.conservativeTokens += ticket.reserved;
      await this.store.save(this.ledger);
      return ticket.reserved;
    }
    const actual = Math.ceil(totalTokens);
    // Actual usage may exceed the byte-based estimate; it is charged in full regardless.
    e.chargedTokens += actual - ticket.reserved;
    e.knownTokens += actual;
    await this.store.save(this.ledger);
    return actual;
  }
}
