/**
 * Pre-publish text precheck, program-rule layer. Runs in the browser before any model call and
 * keeps working when the model is unavailable. Only the user's own title / text / tags of this
 * post are checked; images are not reviewed in this version.
 *
 * Policy (docs/DECISIONS.md D025): personal information found by these rules blocks publishing
 * until it is edited out (PRD: no phone, WeChat or door-level address in the business data).
 * Every other category is a visible suggestion the user may override with "仍要发布".
 */
export const PRECHECK_CATEGORIES = {
  personal_info: "个人信息",
  ad_redirect: "广告导流",
  abuse: "辱骂攻击",
  animal_cruelty: "虐待动物",
  dangerous_advice: "危险建议 / 用药",
  other: "其他",
} as const;
export type PrecheckCategory = keyof typeof PRECHECK_CATEGORIES;
export const precheckCategoryIds = Object.keys(
  PRECHECK_CATEGORIES,
) as PrecheckCategory[];
export type PrecheckField = "title" | "text" | "tags";
export const PRECHECK_FIELD_LABELS: Record<PrecheckField, string> = {
  title: "标题",
  text: "正文",
  tags: "话题标签",
};
export type PrecheckContent = { title: string; text: string; tags: string[] };
export type PrecheckFinding = {
  source: "rule" | "ai";
  category: PrecheckCategory;
  /** null when the AI excerpt could not be located in the submitted text. */
  field: PrecheckField | null;
  excerpt: string | null;
  reason: string;
  /** Blocking findings have no "仍要发布" option. */
  blocking: boolean;
};

type Rule = {
  id: string;
  category: PrecheckCategory;
  reason: string;
  pattern: RegExp;
  blocking: boolean;
  /** Skips a match preceded by a warning such as "千万别喂" (safety reminders are fine). */
  negatable?: boolean;
};
const DRUGS =
  "布洛芬|对乙酰氨基酚|扑热息痛|阿司匹林|感冒药|退烧药|止痛药|头孢|阿莫西林|安眠药|人用药|人吃的药";
const TOXIC = "巧克力|葡萄|提子|洋葱|木糖醇";
const RULES: Rule[] = [
  {
    id: "phone",
    category: "personal_info",
    reason: "疑似手机号，公开发布可能泄露联系方式",
    pattern: /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d(?:[-\s]?\d{4}){2}(?!\d)/g,
    blocking: true,
  },
  {
    id: "landline",
    category: "personal_info",
    reason: "疑似座机号码",
    pattern: /(?<!\d)0\d{2,3}-\d{7,8}(?!\d)/g,
    blocking: true,
  },
  {
    id: "id-card",
    category: "personal_info",
    reason: "疑似身份证号",
    pattern: /(?<!\d)\d{17}[\dXx](?![\dA-Za-z])/g,
    blocking: true,
  },
  {
    id: "wechat",
    category: "personal_info",
    reason: "疑似微信号，公开发布可能泄露联系方式",
    pattern:
      /(?:微信|威信|薇信|(?<![A-Za-z])(?:vx|wx|v信|wechat))\s*号?\s*[:：是为]?\s*(?:[A-Za-z][-_A-Za-z0-9]{5,19}|\d{6,})/gi,
    blocking: true,
  },
  {
    id: "qq",
    category: "personal_info",
    reason: "疑似 QQ 号或 QQ 群号",
    pattern:
      /(?:(?<![A-Za-z])qq|扣扣)\s*[号群]?\s*[:：是为]?\s*\d{5,11}(?!\d)/gi,
    blocking: true,
  },
  {
    id: "address",
    category: "personal_info",
    reason: "疑似门牌级住址，公开发布可能暴露住处",
    pattern:
      /[一-鿿]{1,6}(?:路|街|巷|弄|大道)\s*\d+\s*号(?!线)|(?<![第\d])\d+\s*(?:号楼|栋|幢|单元)|(?<!\d)\d{3,4}\s*室/g,
    blocking: true,
  },
  {
    id: "link",
    category: "ad_redirect",
    reason: "包含外部链接，可能是站外导流",
    pattern:
      /https?:\/\/[^\s，。]+|www\.[^\s，。]+|(?<![@\w.])[a-z0-9-]+\.(?:com|cn|net|org|top|xyz|cc|me|io|shop|vip)(?:\/[^\s，。]*)?(?![a-z])/gi,
    blocking: false,
  },
  {
    id: "contact-redirect",
    category: "ad_redirect",
    reason: "引导加好友、扫码或进群，属于站外导流",
    pattern:
      /加(?:我)?(?:微信|(?<![A-Za-z])(?:vx|wx|v|qq)(?![A-Za-z]))|扫码|二维码|进群|加群|拉你进群/gi,
    blocking: false,
  },
  {
    id: "commerce",
    category: "ad_redirect",
    reason: "疑似广告、代购或宠物买卖",
    pattern:
      /代购|优惠券|返利|低价出售|出售幼犬|出售幼猫|卖狗|卖猫|转让幼犬|配种|包邮|淘宝店|拼多多|闲鱼/g,
    blocking: false,
  },
  {
    id: "abuse",
    category: "abuse",
    reason: "包含辱骂或人身攻击用语",
    pattern:
      /傻[逼比屄]|煞笔|(?<![A-Za-z])sb(?![A-Za-z])|智障|脑残|弱智|去死|滚蛋|贱人|狗东西|垃圾人|[操草]你妈|你妈的/gi,
    blocking: false,
  },
  {
    id: "cruelty",
    category: "animal_cruelty",
    reason: "描述或鼓励伤害动物",
    pattern:
      /虐待(?:动物|狗狗?|猫咪?|它)|虐猫|(?:打|摔|毒|踢|电|烫|饿|弄)死(?:它|狗|猫|这只)|活埋|用烟头烫/g,
    blocking: false,
    negatable: true,
  },
  {
    id: "human-drug",
    category: "dangerous_advice",
    reason: "建议给宠物使用人用药物，可能致命；用药请咨询兽医",
    pattern: new RegExp(
      `(?:喂|给(?!自己|我))[^。！？!?\\n]{0,12}(?:${DRUGS})|(?:${DRUGS})[^。！？!?\\n]{0,12}(?:喂|给(?:狗|猫|它))`,
      "g",
    ),
    blocking: false,
    negatable: true,
  },
  {
    id: "toxic-food",
    category: "dangerous_advice",
    reason: "建议给宠物喂常见有毒食物",
    pattern: new RegExp(
      `(?:喂|给(?:狗狗?|猫咪?|它)吃)[^。！？!?\\n]{0,8}(?:${TOXIC})`,
      "g",
    ),
    blocking: false,
    negatable: true,
  },
];
const NEGATION =
  /(?:别|不要|不能|禁止|千万不|切勿|不可|不该|不准|避免|严禁|防止)/;

/**
 * Full-width digits and Latin letters become ASCII with the same length, so match offsets still
 * point into the original text and excerpts are the user's own characters.
 */
export function normalizeWidth(value: string) {
  return value.replace(/[０-９Ａ-Ｚａ-ｚ：]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0),
  );
}

export function rulePrecheck(content: PrecheckContent): PrecheckFinding[] {
  const fields: [PrecheckField, string][] = [
    ["title", content.title],
    ["text", content.text],
    ["tags", content.tags.join(" ")],
  ];
  const findings: PrecheckFinding[] = [];
  const seen = new Set<string>();
  for (const [field, original] of fields) {
    if (!original) continue;
    const value = normalizeWidth(original);
    for (const rule of RULES) {
      for (const m of value.matchAll(rule.pattern)) {
        const start = m.index ?? 0;
        // Only a negation right before the verb, in the same clause, counts ("别慌，喂…" does not).
        const lead = value
          .slice(Math.max(0, start - 4), start)
          .split(/[，。！？；,.!?;\s]/)
          .pop()!;
        if (rule.negatable && NEGATION.test(lead)) continue;
        const excerpt = original.slice(start, start + m[0].length).trim();
        const key = `${rule.category}|${field}|${excerpt}`;
        if (!excerpt || seen.has(key)) continue;
        seen.add(key);
        findings.push({
          source: "rule",
          category: rule.category,
          field,
          excerpt: excerpt.slice(0, 40),
          reason: rule.reason,
          blocking: rule.blocking,
        });
      }
    }
  }
  return findings;
}

/** Locates an AI excerpt in the submitted content; null when it is not a verbatim substring. */
export function locateExcerpt(
  content: PrecheckContent,
  excerpt: string,
): PrecheckField | null {
  const e = excerpt.trim();
  if (!e) return null;
  if (content.title.includes(e)) return "title";
  if (content.text.includes(e)) return "text";
  if (content.tags.join(" ").includes(e.replace(/^[#＃]/, ""))) return "tags";
  return null;
}

/** Content identity for "the check applies to exactly this text". */
export const precheckKey = (c: PrecheckContent) =>
  JSON.stringify([c.title.trim(), c.text.trim(), c.tags]);
