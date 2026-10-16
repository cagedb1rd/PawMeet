import "server-only";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AiError } from "./errors";
const counter = z.strictObject({
  daily: z.number().int().nonnegative(),
  minute: z.number().int(),
  count: z.number().int().nonnegative(),
});
const ledger = z.strictObject({
  day: z.string(),
  global: counter,
  tokens: z.number().int().nonnegative(),
  sessions: z.record(z.string(), counter),
});
let queue: Promise<unknown> = Promise.resolve();
let active = 0;
export async function withAiSlot<T>(call: () => Promise<T>) {
  if (active >= 2)
    throw new AiError("AI_BUSY", "AI正忙，请稍后重试", 429, true);
  active++;
  try {
    return await call();
  } finally {
    active--;
  }
}
export function reserveAiCall(
  session: string,
  worstTokens: number,
  now = new Date(),
) {
  const next = queue.then(async () => {
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
    }).format(now);
    const minute = Math.floor(now.getTime() / 60000);
    const file = path.resolve(
      process.env.QUOTA_STORE_PATH || ".runtime/ai-quota.json",
    );
    const fresh = () => ({ daily: 0, minute, count: 0 });
    try {
      await mkdir(path.dirname(file), { recursive: true });
      let value: z.infer<typeof ledger> = {
        day,
        global: fresh(),
        tokens: 0,
        sessions: {},
      };
      try {
        value = ledger.parse(JSON.parse(await readFile(file, "utf8")));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (value.day !== day)
        value = { day, global: fresh(), tokens: 0, sessions: {} };
      const s = value.sessions[session] ?? fresh();
      if (s.minute !== minute) {
        s.minute = minute;
        s.count = 0;
      }
      if (value.global.minute !== minute) {
        value.global.minute = minute;
        value.global.count = 0;
      }
      const maxCalls = Math.min(
        200,
        Number(process.env.AI_MAX_DAILY_CALLS || 200),
      );
      const maxTokens = Math.min(
        300000,
        Number(process.env.AI_MAX_DAILY_TOKENS || 300000),
      );
      if (
        !Number.isFinite(maxCalls) ||
        !Number.isFinite(maxTokens) ||
        maxCalls < 1 ||
        maxTokens < 1
      )
        throw Error("Invalid budget");
      if (
        s.count >= 6 ||
        s.daily >= 20 ||
        value.global.count >= 10 ||
        value.global.daily >= maxCalls ||
        value.tokens + worstTokens > maxTokens
      )
        throw new AiError(
          "AI_QUOTA",
          "AI演示额度已达上限，请稍后或明天重试",
          429,
          true,
        );
      s.count++;
      s.daily++;
      value.sessions[session] = s;
      value.global.count++;
      value.global.daily++;
      value.tokens += worstTokens;
      await writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    } catch (e) {
      if (e instanceof AiError) throw e;
      throw new AiError(
        "AI_QUOTA_UNAVAILABLE",
        "AI额度账本不可用，调用已关闭",
        503,
      );
    }
  });
  queue = next.catch(() => {});
  return next;
}
