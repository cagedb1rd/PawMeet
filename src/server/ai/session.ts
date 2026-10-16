import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { AiError } from "./errors";
function secret() {
  const key = process.env.DEMO_SESSION_SECRET || process.env.GLM_API_KEY;
  if (!key)
    throw new AiError("AI_NOT_CONFIGURED", "AI尚未配置GLM_API_KEY", 503);
  return key;
}
function mac(data: string) {
  return createHmac("sha256", secret())
    .update(`pawmeet-ai:${data}`)
    .digest("base64url");
}
export function seal(value: unknown) {
  const data = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${data}.${mac(data)}`;
}
export function unseal(token: string): unknown {
  const [data, sig, ...rest] = token.split(".");
  if (!data || !sig || rest.length)
    throw new AiError("AI_CONTINUATION", "对话凭据无效，请重新开始", 400);
  const expected = Buffer.from(mac(data));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new AiError("AI_CONTINUATION", "对话凭据无效，请重新开始", 400);
  try {
    return JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
  } catch {
    throw new AiError("AI_CONTINUATION", "对话凭据损坏", 400);
  }
}
export function sessionId(cookie: string | undefined) {
  if (cookie)
    try {
      const v = unseal(cookie) as { id?: unknown; expires?: unknown };
      if (
        typeof v.id === "string" &&
        typeof v.expires === "number" &&
        v.expires > Date.now()
      )
        return { id: v.id, cookie };
    } catch {
      /* Replace only invalid session; global limits still apply. */
    }
  const id = randomUUID();
  return { id, cookie: seal({ id, expires: Date.now() + 86400000 }) };
}
