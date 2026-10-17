import { resolveAvailability } from "./availability";
import {
  AiTask,
  TaskRequest,
  outputSchemas,
  HelpDraft,
  MatchIntent,
} from "./contracts";

const matchTagEvidence: Record<string, RegExp> = {
  温和: /温和|温顺|温柔|松弛/,
  慢热: /慢热|需要.{0,6}熟悉/,
  活泼: /活泼|活跃/,
  亲人: /亲人|喜欢人|亲近人/,
  独立: /独立/,
  怕追逐: /(?:怕|不喜欢).{0,6}(?:追逐|追赶|奔跑|冲过来)/,
  喜欢追逐: /(?:喜欢|爱).{0,5}追|会追/,
  散步: /散步|慢慢走|遛弯/,
  闻闻探索: /闻闻|嗅闻|闻一闻/,
  接飞盘: /飞盘/,
  晒太阳: /晒太阳/,
  草地撒欢: /草地|撒欢/,
  一起慢跑: /慢跑|跑步/,
};

export const VALIDATION_VERSION = "pawmeet-validation-8";
export const genericCare = [
  "请主人确认喂食品牌、份量及禁忌，未确认前不要自行喂食。",
  "请主人补充健康状况；如涉及用药，请向主人及兽医核实，不在此生成剂量。",
  "请主人当面确认交接地点、物品、紧急联系渠道及异常处理方式。",
  "双方主人在公共场地保持牵引，出现不适立即停止互动。",
] as const;
export function statedAge(text: string): number | null {
  if (/或者|记不清|不确定|大概|左右/.test(text)) return null;
  const number = (v: string) => {
    if (/^\d+$/.test(v)) return Number(v);
    const digits: Record<string, number> = {
      零: 0,
      一: 1,
      二: 2,
      两: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9,
    };
    if (v.includes("十")) {
      const [a, b] = v.split("十");
      return (a ? digits[a] : 1) * 10 + (b ? digits[b] : 0);
    }
    return digits[v];
  };
  const values = [
    ...text.matchAll(/(\d+|[一二两三四五六七八九十]+)\s*(岁半|岁|个月|月龄)/g),
  ]
    .map(
      (m) =>
        number(m[1]) * (m[2].startsWith("岁") ? 12 : 1) +
        (m[2] === "岁半" ? 6 : 0),
    )
    .filter(Number.isFinite);
  if (!values.length) return null;
  if (/写错|纠正|其实|实际|改成/.test(text)) return values.at(-1)!;
  return new Set(values).size === 1 ? values[0] : null;
}
export function validateHelp(
  draft: HelpDraft,
  pets: { id: string }[],
  now: Date,
) {
  if (draft.petId && !pets.some((p) => p.id === draft.petId))
    throw Error("输出引用了未知宠物");
  const missing = [...draft.clarifications];
  if (!draft.petId) missing.push("请选择本人的宠物");
  if (!draft.type) missing.push("请确认互助类型");
  if (!draft.startAt || !draft.endAt)
    missing.push("请补充明确的北京时间起止，模糊时段不能直接发布");
  if (draft.startAt && Date.parse(draft.startAt) <= now.getTime())
    missing.push("开始时间已过，请重新确认日期");
  if (
    draft.startAt &&
    draft.endAt &&
    Date.parse(draft.endAt) <= Date.parse(draft.startAt)
  )
    missing.push("结束必须晚于开始，请确认是否跨天");
  if (
    draft.startAt &&
    draft.endAt &&
    draft.durationMinutes &&
    Math.abs(
      Date.parse(draft.endAt) -
        Date.parse(draft.startAt) -
        draft.durationMinutes * 60000,
    ) > 1000
  )
    missing.push("时长和起止时间不一致");
  if (!draft.locationQuery) missing.push("请补充并确认公共交接地点");
  return { ...draft, clarifications: [...new Set(missing)].slice(0, 12) };
}
export function validateMatch(draft: MatchIntent) {
  for (const [positive, negative] of [
    [draft.sizes, draft.excludedSizes],
    [draft.breeds, draft.excludedBreeds],
    [draft.temperaments, draft.excludedTemperaments],
    [draft.activities, draft.excludedActivities],
  ]) {
    if (positive.some((v) => negative.includes(v as never)))
      draft.clarifications.push("包含与排除条件冲突，请重新描述");
  }
  if (draft.unmappedTerms.length)
    draft.clarifications.push("存在未支持的筛选词，请改用已提供的标签");
  draft.clarifications = [...new Set(draft.clarifications)].slice(0, 12);
  return draft;
}
export function validateOutput<T extends AiTask>(
  task: T,
  raw: unknown,
  request: TaskRequest,
  now: Date,
) {
  const data = outputSchemas[task].parse(raw);
  if (task === "companion-intent") {
    const intent = outputSchemas["companion-intent"].parse(data),
      source = request.text;
    const warnings = [...intent.warnings];
    const originalPreferences = source
      .split(/[，。；,\n]|(?=希望|最好)/)
      .map((t) => t.trim())
      .filter((t) => /希望|最好|性格|一起玩/.test(t) && t.length <= 80);
    const sourcePreferences = intent.preferences.filter((t) =>
      source.includes(t),
    );
    const missingPreferences = intent.preferences.filter(
      (t) => !source.includes(t),
    );
    if (missingPreferences.some((t) => /允许|准入|认证|保证|安全|剂量/.test(t)))
      throw Error("偏好包含无原文依据的准入或安全声明");
    if (missingPreferences.length)
      warnings.push(
        "部分软偏好未能准确对应原文，已保留你的原话供核实，没有当作硬筛选。",
      );
    intent.preferences = [
      ...new Set([
        ...sourcePreferences,
        ...(missingPreferences.length || !sourcePreferences.length
          ? originalPreferences
          : []),
      ]),
    ].slice(0, 8);
    for (const fact of [...intent.hardRequirements, intent.placeQuery].filter(
      Boolean,
    ))
      if (!source.includes(fact!)) throw Error("硬条件或地点缺少原文依据");
    if (intent.activityType && !source.includes(intent.activityType)) {
      if (
        /散(?:散)?步|遛(?:遛)?狗|遛弯/.test(source) &&
        /散步|遛狗/.test(intent.activityType)
      )
        intent.activityType = "散步";
      else throw Error("活动类型缺少原文依据");
    }
    const distanceWords: Record<string, number> = {
      一: 1,
      两: 2,
      二: 2,
      三: 3,
      五: 5,
      十: 10,
    };
    const distances = [
      ...source.matchAll(/(\d+(?:\.\d+)?|[一二两三五十])\s*(?:公里|千米|km)/gi),
    ];
    const limits = [
      ...new Set(distances.map((m) => distanceWords[m[1]] ?? Number(m[1]))),
    ];
    const distanceQuestions: string[] = [];
    if (limits.length) {
      if (
        limits.length !== 1 ||
        ![1, 3, 5, 10].includes(limits[0]) ||
        /(?:公里|千米|km)\s*(?:以外|之外|以上)/i.test(source)
      )
        distanceQuestions.push(
          "距离条件暂不能明确执行，请确认 1、3、5 或 10 公里以内的上限。",
        );
      else {
        if (intent.match.radiusKm !== limits[0])
          warnings.push("搜索距离已按你原文的明确上限校正。");
        intent.match.radiusKm = limits[0] as 1 | 3 | 5 | 10;
      }
    }
    const hardUnmapped = intent.match.unmappedTerms.filter(
      (t) =>
        /必须|不要|不能|排除|别|拒绝|不得|禁止|不接受|只要|公里|千米|km/.test(
          t,
        ) ||
        source
          .split(/[，。；,\n]/)
          .some(
            (c) =>
              /必须|不要|不能|排除|别|拒绝|不得|禁止|不接受|只要/.test(c) &&
              c.includes(t),
          ),
    );
    if (intent.match.unmappedTerms.some((t) => !hardUnmapped.includes(t)))
      warnings.push(
        "“一起玩”等自由偏好会在结果里保留，需向主人核实，不会阻止搜索。",
      );
    const match = outputSchemas["match-intent"].parse(
      validateOutput(
        "match-intent",
        {
          ...intent.match,
          temperaments: [],
          activities: [],
          unmappedTerms: hardUnmapped,
          clarifications: [],
        },
        request,
        now,
      ),
    );
    const keepSupportedSoft = <T extends string>(tags: T[]): T[] =>
      tags.filter((tag) => {
        if (matchTagEvidence[tag]?.test(source)) return true;
        if (
          tag === "温和" &&
          /性格好(?:些|点|一点)?|好相处|友好|随和|脾气好/.test(source)
        ) {
          warnings.push(
            "友好、好相处等描述暂按温和标签参与排序，实际互动偏好仍需向主人核实。",
          );
          return true;
        }
        warnings.push(
          "有些性格或活动偏好暂不能对应已知标签，已保留原文，不据此排除候选。",
        );
        return false;
      });
    match.clarifications = [
      ...new Set([...match.clarifications, ...distanceQuestions]),
    ].slice(0, 12);
    match.temperaments = keepSupportedSoft(intent.match.temperaments);
    match.activities = keepSupportedSoft(intent.match.activities);
    intent.match = match;
    const timeIndex = source.search(
      /20\d{2}[-年]|后天|明天|今天|今晚|(?:下下|上上|下|上|本|这)?(?:周|星期|礼拜)[一二三四五六日天末]/,
    );
    intent.timeText =
      timeIndex >= 0
        ? source.slice(Math.max(0, timeIndex - 8), timeIndex + 90).trim()
        : intent.timeText && source.includes(intent.timeText)
          ? intent.timeText
          : null;
    if (
      !/(?:\d{1,2}[:：]\d{2}|[零一二两三四五六七八九十\d]+[点时])/.test(source)
    ) {
      if (intent.startAt || intent.endAt)
        warnings.push("未采用模型猜测的具体时刻，按你的原文时段查询。");
      intent.startAt = null;
      intent.endAt = null;
    }
    intent.clarifications = [];
    try {
      resolveAvailability(intent, now);
    } catch (e) {
      intent.clarifications = [
        e instanceof Error ? e.message : "请补充大概日期或时段",
      ];
    }
    intent.warnings = [...new Set(warnings)].slice(0, 8);
    return intent;
  }
  const source = [
    request.text,
    request.context.facts ?? "",
    ...(request.context.pets ?? []).flatMap((p) => [
      p.name,
      ...p.temperamentTags,
      ...p.activityTags,
      p.socialNotes,
    ]),
  ].join("\n");
  const rejectGuarantee = (text: string) => {
    if (/绝对安全|保证.{0,8}(不咬|安全)|通过专业.{0,6}(认证|评估)/.test(text))
      throw Error("输出包含无依据保证或认证");
  };
  // Warnings may quote rejected requests; only inspect facts/recommendations.
  const { warnings: _w, clarifications: _c, ...facts } = data;
  void _w;
  void _c;
  rejectGuarantee(JSON.stringify(facts));
  // Labels and titles are visible too; they cannot hide an invented dose/quantity.
  for (const value of JSON.stringify(facts).match(
    /\d+(?:\.\d+)?\s*(?:毫克|毫升|公斤|mg|ml|kg|克|粒|g)/gi,
  ) ?? [])
    if (!source.includes(value)) throw Error("不得生成剂量或份量");
  const extractive = (values: string[]) => {
    if (values.some((v) => !source.includes(v)))
      throw Error("输出事实缺少原文依据");
  };
  const preserveNegation = (values: string[]) => {
    for (const value of values) {
      if (/不|没|怕|禁止|避免/.test(value)) continue;
      let index = source.indexOf(value),
        positive = false;
      while (index >= 0) {
        if (
          !/(?:不喜欢|不爱|不想|不要|不能|禁止|避免|怕)[^，。；\n]{0,6}$/.test(
            source.slice(Math.max(0, index - 10), index),
          )
        )
          positive = true;
        index = source.indexOf(value, index + value.length);
      }
      if (!positive) throw Error("摘录丢失了否定或触发条件");
    }
  };
  if (task === "pet-profile") {
    const p = outputSchemas["pet-profile"].parse(data);
    extractive(
      [p.name, p.breed, p.city, p.district].filter(
        (s): s is string => s !== null,
      ),
    );
    extractive([
      ...p.likes,
      ...p.dislikes,
      ...p.cautions,
      ...p.temperamentTags.map((t) => t.evidence),
      ...p.activityTags.map((t) => t.evidence),
    ]);
    preserveNegation([...p.likes, ...p.activityTags.map((t) => t.evidence)]);
    if (p.likes.some((value) => /不怕|不讨厌/.test(value)))
      throw Error("不害怕不能推断为喜欢");
    if (p.ageMonths !== null && p.ageMonths !== statedAge(request.text))
      throw Error("月龄无明确依据或存在冲突");
    if (
      p.size &&
      p.size !== "unknown" &&
      !{ small: /小型|体型小/, medium: /中型|体型中等/, large: /大型|体型大/ }[
        p.size
      ].test(request.text)
    )
      throw Error("不能根据品种猜测体型");
    for (const tag of [...p.temperamentTags, ...p.activityTags])
      if (
        tag.value !== "怕追逐" &&
        /(?:不爱|不喜欢|不要|不能|怕)/.test(tag.evidence)
      )
        throw Error("否定证据不能生成正向标签");
    const mapping: Record<string, RegExp> = {
      温和: /温和|温顺|温柔|松弛/,
      慢热: /慢热|需要.{0,6}熟悉/,
      活泼: /活泼|活跃/,
      亲人: /亲人|喜欢人|亲近人/,
      独立: /独立/,
      怕追逐: /(?:怕|不喜欢).{0,6}(?:追逐|追赶|奔跑|冲过来)/,
      喜欢追逐: /(?:喜欢|爱).{0,5}追|会追/,
      散步: /散步|慢慢走|遛弯/,
      闻闻探索: /闻闻|嗅闻|闻一闻/,
      接飞盘: /飞盘/,
      晒太阳: /晒太阳/,
      草地撒欢: /草地|撒欢/,
      一起慢跑: /慢跑|跑步/,
    };
    for (const tag of [...p.temperamentTags, ...p.activityTags])
      if (
        !mapping[tag.value].test(tag.evidence) ||
        (tag.value === "怕追逐" && /不怕/.test(tag.evidence))
      )
        throw Error("标签与原文证据不相符");
    for (const key of ["name", "breed", "city", "district"] as const)
      if (!p[key])
        p.clarifications.push(
          `请补充${{ name: "名字", breed: "品种或明确未知", city: "城市", district: "地区" }[key]}`,
        );
    p.clarifications = [...new Set(p.clarifications)].slice(0, 12);
    return p;
  }
  if (task === "social-card") {
    const c = outputSchemas["social-card"].parse(data);
    extractive([...c.traits, ...c.likes, ...c.dislikes, ...c.cautions]);
    preserveNegation(c.likes);
    if (
      c.meetingAdvice &&
      !genericCare.includes(c.meetingAdvice as (typeof genericCare)[number])
    )
      extractive([c.meetingAdvice]);
    return c;
  }
  if (task === "care-checklist") {
    const c = outputSchemas["care-checklist"].parse(data);
    if (
      /只(?:能)?(?:喂|吃).{0,6}(?:原粮|狗粮|犬粮)/.test(source) &&
      /(?:^|[，。；\n])(?:可以|允许|随意).{0,6}零食/.test(source)
    ) {
      c.clarifications = [
        ...new Set([
          ...c.clarifications,
          "喂食要求存在冲突：仅原粮与允许零食需由主人确认，未确认前不得自行喂食。",
        ]),
      ].slice(0, 12);
      c.items.forEach((item) => {
        item.needsConfirmation = true;
      });
    }
    for (const item of c.items) {
      if (!genericCare.includes(item.detail as (typeof genericCare)[number]))
        extractive([item.detail]);
      else if (!item.needsConfirmation)
        throw Error("通用待核实项不能标为已知事实");
      if (
        /(毫克|mg|毫升|ml|克|粒).{0,3}\d|\d.{0,3}(毫克|mg|毫升|ml|克|粒)/i.test(
          item.detail,
        ) &&
        !source.includes(item.detail)
      )
        throw Error("不得生成剂量或份量");
    }
    // Missing medical/diet facts stay explicitly unknown even if model omitted them.
    for (const [i, detail] of genericCare.slice(0, 3).entries())
      if (!c.items.some((v) => v.detail === detail))
        c.items.push({
          title: ["饮食待确认", "健康与用药待确认", "交接待确认"][i],
          detail,
          needsConfirmation: true,
        });
    return outputSchemas["care-checklist"].parse(c);
  }
  if (task === "help-intent") {
    const h = outputSchemas["help-intent"].parse(data);
    if (h.details) extractive([h.details]);
    if (h.locationQuery) extractive([h.locationQuery]);
    if (h.district) extractive([h.district]);
    const explicitTime =
      /(?:\d{1,2}[:：]\d{2}|[零一二两三四五六七八九十\d]+[点时])/.test(
        request.text,
      );
    if (h.startAt && !explicitTime) {
      h.startAt = null;
      h.endAt = null;
      h.clarifications.push("只提供模糊时段，不能猜测具体时刻");
    }
    if (h.startAt) {
      const relative = request.text.includes("后天")
        ? 2
        : request.text.includes("明天")
          ? 1
          : /(今天|今晚)/.test(request.text)
            ? 0
            : null;
      if (relative !== null) {
        const expected = new Date(
          now.getTime() + 8 * 3600000 + relative * 86400000,
        )
          .toISOString()
          .slice(0, 10);
        const actual = new Date(Date.parse(h.startAt) + 8 * 3600000)
          .toISOString()
          .slice(0, 10);
        if (actual !== expected) {
          h.startAt = null;
          h.endAt = null;
          h.clarifications.push("相对日期解析与当前北京时间不一致，请重新确认");
        }
      }
    }
    return validateHelp(h, request.context.pets ?? [], now);
  }
  if (task === "match-intent") {
    const m = validateMatch(outputSchemas["match-intent"].parse(data));
    for (const tag of [
      ...m.temperaments,
      ...m.excludedTemperaments,
      ...m.activities,
      ...m.excludedActivities,
    ])
      if (!matchTagEvidence[tag]?.test(request.text))
        throw Error("筛选标签缺少用户描述依据");
    const sizeEvidence = {
      small: /小型|体型小/,
      medium: /中型|体型中等/,
      large: /大型|体型大/,
      unknown: /体型未知|未知体型|不知道体型/,
    };
    if (
      [...m.sizes, ...m.excludedSizes].some(
        (size) => !sizeEvidence[size].test(request.text),
      )
    )
      throw Error("筛选体型缺少用户描述依据");
    if (
      [...m.breeds, ...m.excludedBreeds].some(
        (breed) =>
          ["狗", "狗狗", "犬", "宠友"].includes(breed) ||
          !request.text.includes(breed),
      )
    )
      throw Error("犬种筛选缺少用户描述依据");
    const distances = [
      ...request.text.matchAll(/(\d+(?:\.\d+)?)\s*(?:公里|千米|km)/gi),
    ].map((v) => Number(v[1]));
    if (distances.some((n) => ![1, 3, 5, 10].includes(n))) {
      m.radiusKm = null;
      m.clarifications.push("仅支持1/3/5/10公里，请确认范围");
    }
    if (request.text.includes("以内") && request.text.includes("以外"))
      m.clarifications.push("距离上下界需要澄清，当前只支持单一半径");
    m.clarifications = [...new Set(m.clarifications)].slice(0, 12);
    return m;
  }
  if (task === "social-analysis") {
    const c = outputSchemas["social-analysis"].parse(data);
    const allowed = request.context.evidence ?? [];
    if (
      !c.evidenceCodes.length ||
      c.evidenceCodes.some((code) => !allowed.some((e) => e.code === code))
    )
      throw Error("解释引用了未知规则依据");
    // Explanations are extractive sentences. Their ordering is the model's job; facts remain program-owned.
    const sentences = c.explanation.split("\n").filter(Boolean);
    if (
      sentences.some(
        (line) =>
          !allowed.some(
            (e) => c.evidenceCodes.includes(e.code) && e.fact === line,
          ),
      )
    )
      throw Error("解释超出规则依据");
    return c;
  }
  if (task === "post-copy") {
    const p = outputSchemas["post-copy"].parse(data);
    extractive([p.text]);
    return p;
  }
  return data;
}
