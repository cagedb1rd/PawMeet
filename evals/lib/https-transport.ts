import https from "node:https";
import { Readable } from "node:stream";

/**
 * Connect-phase failures: the TCP / TLS connection never completed, so no request body
 * reached the provider and nothing can have been billed.
 */
const CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * True only with evidence that the request was never sent: the HTTPS transport below marks
 * `requestSent: false`, or a stock fetch failed with a connect-phase error code. Anything else
 * (timeouts after sending, resets, unknown errors) is treated as possibly billed.
 */
export function requestNotSent(error: unknown): boolean {
  const e = error as { requestSent?: boolean; cause?: { code?: string } };
  if (e?.requestSent === false) return true;
  if (e?.requestSent === true) return false;
  return !!e?.cause?.code && CONNECT_CODES.has(e.cause.code);
}

/**
 * fetch-compatible transport for live evals built on node:https, so each attempt knows
 * whether the TLS connection completed and the body was handed to the socket. An abort or
 * error before that rejects with `requestSent: false` and the eval budget can release the
 * reservation instead of charging it in full (step 6b: most Qwen charges were connect-phase
 * timeouts over a cross-border link). Never follows redirects; streams the response body.
 */
export function createHttpsTransport(): typeof fetch {
  return (input, init = {}) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.protocol !== "https:")
        return reject(new TypeError("only https is allowed"));
      let connected = false,
        written = false,
        settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(Object.assign(error, { requestSent: connected && written }));
      };
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      const req = https.request(url, {
        method: init.method ?? "GET",
        headers,
        agent: false,
      });
      req.on("socket", (socket) => {
        socket.once("secureConnect", () => (connected = true));
      });
      req.on("finish", () => (written = true));
      req.on("response", (res) => {
        settled = true;
        const body = Readable.toWeb(res) as ReadableStream<Uint8Array>;
        const responseHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers))
          if (v !== undefined)
            responseHeaders.set(k, Array.isArray(v) ? v.join(", ") : v);
        init.signal?.addEventListener("abort", () =>
          res.destroy(new DOMException("aborted", "AbortError")),
        );
        resolve(
          new Response(
            [101, 204, 205, 304].includes(res.statusCode ?? 0) ? null : body,
            { status: res.statusCode ?? 502, headers: responseHeaders },
          ),
        );
      });
      req.on("error", (e) => fail(e));
      const signal = init.signal;
      if (signal?.aborted)
        return fail(new DOMException("aborted", "AbortError") as Error);
      signal?.addEventListener("abort", () => {
        const error = new DOMException("aborted", "AbortError") as Error;
        fail(error);
        req.destroy(error);
      });
      req.end(typeof init.body === "string" ? init.body : undefined);
    });
}
