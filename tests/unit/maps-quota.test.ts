import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const storage = vi.hoisted(() => ({
  files: new Map<string, string>(),
  fail: false,
}));
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => {}),
  readFile: vi.fn(async (file: string) => {
    if (!storage.files.has(file))
      throw Object.assign(new Error(), { code: "ENOENT" });
    return storage.files.get(file);
  }),
  writeFile: vi.fn(async (file: string, value: string) => {
    if (storage.fail) throw Object.assign(new Error(), { code: "EACCES" });
    storage.files.set(file, value);
  }),
  rename: vi.fn(async (source: string, target: string) => {
    storage.files.set(target, storage.files.get(source)!);
    storage.files.delete(source);
  }),
}));
afterEach(() => {
  storage.files.clear();
  storage.fail = false;
  vi.useRealTimers();
  vi.resetModules();
});
it("serializes 60 simultaneous calls and preserves the limit on module restart", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-17T10:00:00+08:00"));
  let { reserveMapCall } = await import("@/server/maps/quota");
  await Promise.all(Array.from({ length: 60 }, () => reserveMapCall()));
  await expect(reserveMapCall()).rejects.toThrow("MAP_RATE_LIMIT");
  vi.resetModules();
  ({ reserveMapCall } = await import("@/server/maps/quota"));
  await expect(reserveMapCall()).rejects.toThrow("MAP_RATE_LIMIT");
  vi.setSystemTime(new Date("2026-10-17T10:01:00+08:00"));
  await expect(reserveMapCall()).resolves.toBeUndefined();
});
it("global China-day limit resets only at day boundary; corrupt or unwritable ledger fails closed", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-17T23:59:00+08:00"));
  const { reserveMapCall } = await import("@/server/maps/quota");
  await reserveMapCall();
  const file = [...storage.files.keys()][0];
  const value = JSON.parse(storage.files.get(file)!);
  storage.files.set(file, JSON.stringify({ ...value, daily: 3000 }));
  await expect(reserveMapCall()).rejects.toThrow("MAP_RATE_LIMIT");
  vi.setSystemTime(new Date("2026-10-18T00:00:00+08:00"));
  await expect(reserveMapCall()).resolves.toBeUndefined();
  storage.files.set(file, "{broken");
  await expect(reserveMapCall()).rejects.toThrow("MAP_QUOTA_UNAVAILABLE");
  expect(storage.files.get(file)).toBe("{broken");
  storage.files.delete(file);
  storage.fail = true;
  await expect(reserveMapCall()).rejects.toThrow();
  expect(storage.files.has(file)).toBe(false);
});
