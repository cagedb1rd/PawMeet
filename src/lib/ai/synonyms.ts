import { interests, temperaments } from "@/domain/schemas";

export type ControlledTag =
  (typeof temperaments)[number] | (typeof interests)[number];

/**
 * Program-owned synonym table for controlled temperament / activity tags.
 * The model may keep the user's wording; mapping to a tag happens here, never by free inference.
 * Words only map to the listed tag; they never produce exclusions, sizes, breeds or distances.
 */
export const TAG_SYNONYMS = {
  温和: [
    "温和",
    "温顺",
    "温柔",
    "松弛",
    "随和",
    "好相处",
    "脾气好",
    "性格好",
    "友好",
    "友善",
    "乖巧",
    "佛系",
  ],
  慢热: ["慢热", "认生", "慢慢熟"],
  活泼: ["活泼", "活跃", "好动", "精力旺盛", "精力充沛", "爱玩"],
  亲人: ["亲人", "喜欢人", "亲近人", "黏人", "粘人"],
  独立: ["独立", "不黏人", "不粘人"],
  怕追逐: [],
  喜欢追逐: ["追着跑"],
  散步: ["散步", "散散步", "慢慢走", "遛弯", "溜弯", "溜达", "遛狗", "遛遛"],
  闻闻探索: ["闻闻", "嗅闻", "闻一闻", "到处闻"],
  接飞盘: ["飞盘"],
  晒太阳: ["晒太阳", "晒晒太阳", "晒暖"],
  草地撒欢: ["撒欢", "草地撒欢"],
  一起慢跑: ["慢跑", "跑步", "陪跑", "晨跑", "夜跑"],
} as const satisfies Record<ControlledTag, readonly string[]>;

/** Phrases whose meaning depends on surrounding words (negation is part of 怕追逐). */
const TAG_PATTERNS: Partial<Record<ControlledTag, RegExp>> = {
  慢热: /需要.{0,6}熟悉/,
  怕追逐: /(?:怕|不喜欢).{0,6}(?:追逐|追赶|奔跑|冲过来)/,
  喜欢追逐: /(?:喜欢|爱).{0,5}追|会追/,
  // 草地 alone is usually a place wish (最好有草地); it is evidence for a model tag, never mapped.
  草地撒欢: /草地/,
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const tagEvidence = Object.fromEntries(
  (Object.keys(TAG_SYNONYMS) as ControlledTag[]).map((tag) => {
    const parts = [
      ...TAG_SYNONYMS[tag].map(escape),
      ...(TAG_PATTERNS[tag] ? [TAG_PATTERNS[tag]!.source] : []),
    ];
    return [tag, new RegExp(parts.join("|"))];
  }),
) as Record<ControlledTag, RegExp>;

/** Walking-family wording shared by activity type normalization and activity content matching. */
// 慢慢走 stays a 散步 tag synonym only: as activity content it is a description, not the activity type.
export const WALK_WORDS = /散(?:散)?步|遛(?:遛)?狗|遛弯|溜弯|溜达|遛遛/;
export const isWalkingType = (value: string | null | undefined) =>
  !!value && new RegExp(`^(?:${WALK_WORDS.source})$`).test(value);

const isTemperament = (tag: ControlledTag) =>
  (temperaments as readonly string[]).includes(tag);

/** A negator shortly before the word within the same clause, e.g. 不要太活泼 / 别太黏人. */
function negatedAt(text: string, index: number) {
  const before = text.slice(Math.max(0, index - 4), index);
  const clause = before.split(/[，。；,;\n]/).at(-1) ?? "";
  return /不|没|别|拒绝|排除|禁止/.test(clause);
}

export type SoftTagHit = { tag: ControlledTag; word: string };
/**
 * Positive (non-negated) synonym hits inside a phrase. Longer words win so 不黏人 is not read as 黏人.
 * 怕追逐 is skipped: its patterns already contain the negation and it is a caution, not a soft wish.
 */
export function softTagsIn(text: string): SoftTagHit[] {
  const hits: (SoftTagHit & { index: number })[] = [];
  const taken: [number, number][] = [];
  const words = (Object.keys(TAG_SYNONYMS) as ControlledTag[])
    .filter((tag) => tag !== "怕追逐")
    .flatMap((tag) => TAG_SYNONYMS[tag].map((word) => ({ tag, word })))
    .sort((a, b) => b.word.length - a.word.length);
  for (const { tag, word } of words) {
    let index = text.indexOf(word);
    while (index >= 0) {
      const end = index + word.length;
      if (!taken.some(([s, e]) => index < e && end > s)) {
        taken.push([index, end]);
        if (!negatedAt(text, index)) hits.push({ tag, word, index });
      }
      index = text.indexOf(word, end);
    }
  }
  return hits
    .sort((a, b) => a.index - b.index)
    .map(({ tag, word }) => ({ tag, word }));
}

/** True when the tag has at least one positive occurrence in the text. */
export function positiveEvidence(tag: ControlledTag, text: string) {
  if (tag === "怕追逐") return tagEvidence[tag].test(text);
  if (softTagsIn(text).some((h) => h.tag === tag)) return true;
  const pattern = TAG_PATTERNS[tag];
  return !!pattern && pattern.test(text);
}

export function splitSoftTags(hits: SoftTagHit[]) {
  const temperamentTags = [
    ...new Set(hits.filter((h) => isTemperament(h.tag)).map((h) => h.tag)),
  ] as (typeof temperaments)[number][];
  const activityTags = [
    ...new Set(hits.filter((h) => !isTemperament(h.tag)).map((h) => h.tag)),
  ] as (typeof interests)[number][];
  return { temperamentTags, activityTags };
}
