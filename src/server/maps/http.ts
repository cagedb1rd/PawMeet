import "server-only";
import { get } from "node:https";

/** Node HTTPS transport. Fixed URLs are built by proxyTarget; never follow redirects. */
export function requestAMap(target: URL, origin?: string): Promise<string> {
  if (
    target.protocol !== "https:" ||
    target.hostname !== "restapi.amap.com" ||
    target.port ||
    target.username ||
    target.password
  )
    throw new Error("MAP_HOST_DENIED");
  return new Promise((resolve, reject) => {
    const request = get(
      target,
      {
        signal: AbortSignal.timeout(12000),
        family: 4,
        headers: origin ? { Referer: `${new URL(origin).origin}/` } : {},
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`MAP_UPSTREAM_HTTP_${response.statusCode ?? 0}`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 512000) {
            response.destroy();
            reject(new Error("MAP_RESPONSE_TOO_LARGE"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", () => reject(new Error("MAP_UPSTREAM_FAILED")));
        response.on("end", () =>
          resolve(Buffer.concat(chunks).toString("utf8")),
        );
      },
    );
    request.on("error", (error: NodeJS.ErrnoException) => {
      // Operational code only: never log the URL, headers, credentials or body.
      console.warn("Map upstream connection failed", {
        code: error.code ?? "NETWORK_ERROR",
      });
      reject(
        new Error(
          error.code === "ABORT_ERR"
            ? "MAP_UPSTREAM_TIMEOUT"
            : "MAP_UPSTREAM_FAILED",
        ),
      );
    });
  });
}
