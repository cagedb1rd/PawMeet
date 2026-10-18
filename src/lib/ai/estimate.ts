/**
 * Conservative token estimates used for quota / eval reservations before any upstream call.
 * Never meant to be exact; they must not be lower than what the provider will bill.
 *
 * Text: BPE tokens cover at least one byte, so an ASCII character is at most one token.
 * Common CJK characters and punctuation are single tokens in Qwen / Gemini vocabularies; they
 * are counted as 1.5 to cover rare characters split into several tokens. Everything else
 * (emoji, rare scripts) counts its full UTF-8 byte length, the true worst case. This replaces
 * the earlier "UTF-8 bytes" estimate, which counted each Chinese character as 3 tokens.
 */
export function estimateTextTokens(text: string): number {
  let ascii = 0,
    cjk = 0,
    other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) ascii++;
    else if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    )
      cjk++;
    else other += new TextEncoder().encode(ch).length;
  }
  return ascii + Math.ceil(cjk * 1.5) + other;
}

export type ImageTokenRule = "qwen" | "gemini3";
/** Qwen default max_pixels (2621440 px / 32 / 32) plus vision_bos / vision_eos. */
const QWEN_UNKNOWN_SIZE = 2560 + 2;
/** Gemini 3 default (unspecified) media_resolution caps an image at 1120 tokens. */
const GEMINI3_IMAGE = 1120;

/**
 * Image tokens per official rules (sources in docs/ARCHITECTURE.md):
 * - Qwen 3.x vision: one token per 32×32 px after smart_resize, +2. The omni page does not
 *   restate the factor, so the older 28×28 factor and ceil rounding are used as an upper bound.
 * - Gemini 3: media_resolution default allots at most 1120 tokens per image.
 * Unknown dimensions fall back to the provider's default per-image maximum.
 */
export function estimateImageTokens(
  rule: ImageTokenRule,
  size: { width: number; height: number } | null,
): number {
  if (rule === "gemini3") return GEMINI3_IMAGE;
  if (!size) return QWEN_UNKNOWN_SIZE;
  const tokens = Math.ceil(size.width / 28) * Math.ceil(size.height / 28) + 2;
  return Math.min(Math.max(tokens, 4 + 2), QWEN_UNKNOWN_SIZE);
}
