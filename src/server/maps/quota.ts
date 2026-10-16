import "server-only";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const schema = z.strictObject({
  day: z.string(),
  daily: z.number().int().nonnegative(),
  minute: z.number().int(),
  count: z.number().int().nonnegative(),
});
let queue: Promise<unknown> = Promise.resolve();
/** One Node process. Global 60/min is stricter than per-IP; no untrusted IP headers. */
export function reserveMapCall() {
  const next = queue.then(async () => {
    const now = Date.now();
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
    }).format(now);
    const minute = Math.floor(now / 60000);
    const file = path.resolve(".runtime/map-quota.json");
    await mkdir(path.dirname(file), { recursive: true });
    let value = { day, daily: 0, minute, count: 0 };
    try {
      value = schema.parse(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("MAP_QUOTA_UNAVAILABLE");
    }
    if (value.day !== day) value = { day, daily: 0, minute, count: 0 };
    if (value.minute !== minute) {
      value.minute = minute;
      value.count = 0;
    }
    if (value.daily >= 3000 || value.count >= 60)
      throw new Error("MAP_RATE_LIMIT");
    value.daily++;
    value.count++;
    await writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  });
  queue = next.catch(() => {});
  return next;
}
