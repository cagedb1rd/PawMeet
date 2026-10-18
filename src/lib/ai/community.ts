import { POST_TAG_PATTERN } from "@/domain/schemas";
import {
  locateExcerpt,
  rulePrecheck,
  type PrecheckContent,
  type PrecheckFinding,
} from "@/domain/moderation";
import {
  POST_META_LIMITS,
  type PostMetaDraft,
  type PostMetaOutput,
  type PostSafetyOutput,
  type PostSafetyResult,
} from "./contracts";

/**
 * Health conclusions and user identities may appear in a draft only when the user's own text
 * already says them ("今天打了疫苗" may yield a 疫苗 tag); otherwise the model invented them.
 */
const CLAIM =
  /疾病|生病|病了|症状|发炎|感染|过敏|寄生虫|诊断|治疗|用药|药物|吃药|剂量|疫苗|驱虫|绝育|怀孕|手术|康复|体检|兽医|医生|专家|认证|官方|博主|达人|训犬师|商家|店主|客服/g;
export function ungroundedClaim(value: string, source: string) {
  return [...value.matchAll(CLAIM)].some((m) => !source.includes(m[0]));
}

export class PostMetaReviewError extends Error {}

/**
 * Business review of a schema-valid title / tags output. Over-long titles or fewer than three
 * usable tags fail visibly instead of being cut; personal information or invented health /
 * identity claims in the title fail too. Invalid or extra tags are dropped and counted.
 */
export function reviewPostMeta(
  raw: PostMetaOutput,
  sourceText: string,
): PostMetaDraft {
  const title = raw.title
    .trim()
    .replace(/^[《“"'「#＃\s]+|[》”"'」\s]+$/g, "")
    .trim();
  if (!title || [...title].length > POST_META_LIMITS.titleMax)
    throw new PostMetaReviewError(`标题需为 1–${POST_META_LIMITS.titleMax} 字`);
  if (ungroundedClaim(title, sourceText))
    throw new PostMetaReviewError("标题包含正文没有的健康或身份信息");
  if (rulePrecheck({ title, text: "", tags: [] }).length)
    throw new PostMetaReviewError("标题包含个人信息或导流内容");
  let removed = 0;
  const tags: string[] = [];
  for (const t of raw.tags) {
    const tag = t
      .trim()
      .replace(/^[#＃]+/, "")
      .replace(/\s+/g, "");
    if (
      !POST_TAG_PATTERN.test(tag) ||
      ungroundedClaim(tag, sourceText) ||
      rulePrecheck({ title: "", text: "", tags: [tag] }).length ||
      tags.includes(tag) ||
      tags.length >= POST_META_LIMITS.tagsMax
    ) {
      removed++;
      continue;
    }
    tags.push(tag);
  }
  if (tags.length < POST_META_LIMITS.tagsMin)
    throw new PostMetaReviewError(
      `可用话题标签少于 ${POST_META_LIMITS.tagsMin} 个`,
    );
  const note = raw.note?.trim() || null;
  return {
    title,
    tags,
    note:
      note &&
      !ungroundedClaim(note, sourceText) &&
      !rulePrecheck({ title: "", text: note, tags: [] }).length
        ? note
        : null,
    removed,
  };
}

export class PostSafetyReviewError extends Error {}

/**
 * Normalises the model's structured judgement. "pass" with issues is treated as "revise";
 * "revise" without any issue is not usable. An excerpt that is not verbatim in the submitted
 * text keeps the reason but loses its highlight (field / excerpt null).
 */
export function reviewPostSafety(
  raw: PostSafetyOutput,
  content: PrecheckContent,
): PostSafetyResult {
  if (raw.verdict === "revise" && !raw.issues.length)
    throw new PostSafetyReviewError("建议修改但没有给出原因");
  const issues = raw.issues.map((i) => {
    const field = locateExcerpt(content, i.excerpt);
    return {
      category: i.category,
      field,
      excerpt: field ? i.excerpt.trim() : null,
      reason: i.reason.trim(),
    };
  });
  return { verdict: issues.length ? "revise" : "pass", issues };
}

/** AI findings are suggestions only; blocking comes from deterministic rules (D025). */
export function aiFindings(result: PostSafetyResult): PrecheckFinding[] {
  return result.issues.map((i) => ({
    source: "ai",
    category: i.category,
    field: i.field,
    excerpt: i.excerpt,
    reason: i.reason,
    blocking: false,
  }));
}
