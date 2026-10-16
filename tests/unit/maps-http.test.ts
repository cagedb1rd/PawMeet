import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const get = vi.hoisted(() => vi.fn());
vi.mock("node:https", () => ({ get }));
import { requestAMap } from "@/server/maps/http";
const target = new URL("https://restapi.amap.com/v3/place/around");
function response(status = 200) {
  const incoming = Object.assign(new EventEmitter(), {
    statusCode: status,
    resume: vi.fn(),
    destroy: vi.fn(),
  });
  get.mockImplementationOnce((_url, _options, cb) => {
    queueMicrotask(() => cb(incoming));
    return new EventEmitter();
  });
  return incoming;
}
it("native HTTPS only accepts fixed upstream and refuses redirects", async () => {
  expect(() => requestAMap(new URL("https://evil.test/"))).toThrow(
    "MAP_HOST_DENIED",
  );
  const incoming = response(302);
  await expect(requestAMap(target)).rejects.toThrow("MAP_UPSTREAM_HTTP_302");
  expect(incoming.resume).toHaveBeenCalled();
});
it("bounded response body, stream errors and network errors are visible", async () => {
  let incoming = response();
  let result = requestAMap(target);
  await Promise.resolve();
  incoming.emit("data", Buffer.from("cb({})"));
  incoming.emit("end");
  expect(await result).toBe("cb({})");
  incoming = response();
  result = requestAMap(target);
  await Promise.resolve();
  incoming.emit("data", Buffer.alloc(512001));
  await expect(result).rejects.toThrow("MAP_RESPONSE_TOO_LARGE");
  expect(incoming.destroy).toHaveBeenCalled();
  incoming = response();
  result = requestAMap(target);
  await Promise.resolve();
  incoming.emit("error", new Error("secret request URL"));
  await expect(result).rejects.toThrow("MAP_UPSTREAM_FAILED");
});
