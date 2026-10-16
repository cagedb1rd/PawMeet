import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
vi.mock("server-only", () => ({}));
import { reserveAiCall, withAiSlot } from "@/server/ai/quota";
let dir: string;
async function setup() {
  dir = await mkdtemp(path.join(tmpdir(), "paw-ai-"));
  vi.stubEnv("QUOTA_STORE_PATH", path.join(dir, "quota.json"));
  return path.join(dir, "quota.json");
}
afterEach(async () => {
  vi.unstubAllEnvs();
  if (dir) await rm(dir, { recursive: true, force: true });
});
it("serial reservations persist; identity rotation cannot reset global cap", async () => {
  const f = await setup();
  const now = new Date("2026-10-17T02:00:00Z");
  await Promise.all(
    Array.from({ length: 10 }, (_, i) => reserveAiCall(`s${i}`, 100, now)),
  );
  expect(JSON.parse(await readFile(f, "utf8")).global.daily).toBe(10);
  await expect(reserveAiCall("new", 100, now)).rejects.toMatchObject({
    code: "AI_QUOTA",
  });
});
it("session cap survives module reload", async () => {
  const f = await setup();
  const now = new Date("2026-10-17T02:00:00Z");
  for (let i = 0; i < 6; i++) await reserveAiCall("same", 100, now);
  await expect(reserveAiCall("same", 100, now)).rejects.toMatchObject({
    code: "AI_QUOTA",
  });
  vi.resetModules();
  const other = await import("@/server/ai/quota");
  await expect(other.reserveAiCall("same", 100, now)).rejects.toMatchObject({
    code: "AI_QUOTA",
  });
  expect(JSON.parse(await readFile(f, "utf8")).tokens).toBe(600);
});
it("corrupt ledger fails closed", async () => {
  const f = await setup();
  await writeFile(f, "broken");
  await expect(reserveAiCall("s", 1)).rejects.toMatchObject({
    code: "AI_QUOTA_UNAVAILABLE",
  });
});
it("token reservations and Shanghai day reset", async () => {
  await setup();
  vi.stubEnv("AI_MAX_DAILY_TOKENS", "100");
  await reserveAiCall("s", 100, new Date("2026-10-17T15:59:00Z"));
  await expect(
    reserveAiCall("other", 1, new Date("2026-10-17T15:59:01Z")),
  ).rejects.toMatchObject({ code: "AI_QUOTA" });
  await reserveAiCall("s", 100, new Date("2026-10-17T16:00:00Z"));
});
it("concurrency cap releases on exceptions", async () => {
  let release!: () => void;
  const pending = new Promise<void>((r) => (release = r));
  const a = withAiSlot(() => pending),
    b = withAiSlot(() => pending);
  await expect(withAiSlot(async () => 1)).rejects.toMatchObject({
    code: "AI_BUSY",
  });
  release();
  await Promise.all([a, b]);
  await expect(
    withAiSlot(async () => {
      throw Error("error");
    }),
  ).rejects.toThrow();
  await expect(withAiSlot(async () => 1)).resolves.toBe(1);
});
