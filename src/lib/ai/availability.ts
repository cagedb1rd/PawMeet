import { z } from "zod";
export const availabilitySchema = z.strictObject({
  windows: z
    .array(
      z.strictObject({ startAt: z.iso.datetime(), endAt: z.iso.datetime() }),
    )
    .min(1)
    .max(8),
  label: z.string().max(250),
  broad: z.boolean(),
});
export type Availability = z.infer<typeof availabilitySchema>;
const dayMs = 86400000,
  offset = 8 * 3600000;
const dateLabel = (day: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(`${day}T12:00:00+08:00`));
const localDay = (stamp: number) =>
  new Date(stamp + offset).toISOString().slice(0, 10);
const negative = (text: string, index: number) =>
  /(?:不要|不能|不方便|排除|不是|别|不接受|不得)[^，。；\n]{0,5}$/.test(
    text.slice(Math.max(0, index - 8), index),
  );
/** Availability buckets are disclosed search boundaries, never an activity schedule. */
export function resolveAvailability(
  input: {
    startAt: string | null;
    endAt: string | null;
    timeText: string | null;
  },
  now = new Date(),
): Availability {
  if (input.startAt && input.endAt) {
    if (
      Date.parse(input.endAt) <= Date.parse(input.startAt) ||
      Date.parse(input.endAt) <= now.getTime()
    )
      throw Error("这个时间范围已过或顺序有误，请调整日期或时段");
    const fmt = (t: string) =>
      new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(t));
    return availabilitySchema.parse({
      windows: [
        {
          startAt: new Date(input.startAt).toISOString(),
          endAt: new Date(input.endAt).toISOString(),
        },
      ],
      label: `${fmt(input.startAt)} — ${fmt(input.endAt)}`,
      broad: false,
    });
  }
  const text = input.timeText ?? "",
    today = localDay(now.getTime()),
    todayStamp = Date.parse(`${today}T00:00:00+08:00`);
  const dateMentions = [
    ...text.matchAll(
      /20\d{2}[-年]\d{1,2}[-月]\d{1,2}日?|后天|明天|今天|今晚|(?:下下|上上|下|上|本|这)?(?:周|星期|礼拜)[一二三四五六日天末]/g,
    ),
  ];
  const periodSignatures = dateMentions.flatMap((m, index) => {
    if (negative(text, m.index!)) return [];
    const clause = text.slice(
      m.index! + m[0].length,
      dateMentions[index + 1]?.index,
    );
    const signature = [/上午|早上|清晨/, /中午/, /下午|午后/, /晚上|傍晚|晚间/]
      .map((pattern) => (pattern.test(clause) ? "1" : "0"))
      .join("");
    return signature === "0000" ? [] : [signature];
  });
  if (new Set(periodSignatures).size > 1)
    throw Error(
      "不同日期对应了不同的时段，请先选一天和大概时段，不用精确到分钟",
    );
  const weekday = (new Date(todayStamp + offset).getUTCDay() + 6) % 7;
  const days = new Set<string>();
  const excludedDays = new Set<string>();
  const add = (stamp: number, excluded = false) =>
    (excluded ? excludedDays : days).add(localDay(stamp));
  for (const m of text.matchAll(/(20\d{2})[-年](\d{1,2})[-月](\d{1,2})日?/g)) {
    const day = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    const stamp = Date.parse(`${day}T00:00:00+08:00`);
    if (!Number.isFinite(stamp) || localDay(stamp) !== day)
      throw Error("日期不存在，请重新选择");
    add(stamp, negative(text, m.index!));
  }
  for (const [term, n] of [
    ["后天", 2],
    ["明天", 1],
    ["今天", 0],
    ["今晚", 0],
  ] as const) {
    for (const m of text.matchAll(new RegExp(term, "g")))
      add(todayStamp + n * dayMs, negative(text, m.index!));
  }
  const weekdayDigits = "一二三四五六日";
  for (const m of text.matchAll(
    /((?:下下|上上|下|上|本|这)?)(?:周|星期|礼拜)([一二三四五六日天])/g,
  )) {
    const target = m[2] === "天" ? 6 : weekdayDigits.indexOf(m[2]);
    let delta = target - weekday;
    if (m[1] === "下下") delta += 14;
    else if (m[1] === "上上") delta -= 14;
    else if (m[1] === "上") delta -= 7;
    else if (m[1] === "下") delta += 7;
    else if (!m[1] && delta < 0) delta += 7;
    add(todayStamp + delta * dayMs, negative(text, m.index!));
  }
  for (const weekend of text.matchAll(/(下下|上上|下|上|本|这)?周末/g)) {
    const shift =
      weekend[1] === "下下"
        ? 14
        : weekend[1] === "下"
          ? 7
          : weekend[1] === "上上"
            ? -14
            : weekend[1] === "上"
              ? -7
              : 0;
    for (const target of [5, 6]) {
      let delta = target - weekday + shift;
      if (!weekend[1] && weekday < 5 && delta < 0) delta += 7;
      if (!weekend[1] && weekday === 6 && target === 5) continue;
      add(todayStamp + delta * dayMs, negative(text, weekend.index!));
    }
  }
  for (const day of excludedDays) days.delete(day);
  if (!days.size)
    throw Error(
      "想哪天一起玩？说“周六下午或晚上”或选个日期就行，不用精确到分钟",
    );
  if (days.size > 2) throw Error("时间里有多个日期，请先选一个或一个周末");
  const periods: { name: string; from: number; to: number }[] = [];
  const excludedPeriods: { from: number; to: number }[] = [];
  for (const [pattern, name, from, to] of [
    [/上午|早上|清晨/g, "上午", 6, 12],
    [/中午/g, "中午", 11, 14],
    [/下午|午后/g, "下午", 12, 18],
    [/晚上|傍晚|晚间|今晚/g, "晚上", 18, 24],
  ] as const) {
    const matches = [...text.matchAll(pattern)];
    if (matches.some((m) => negative(text, m.index!)))
      excludedPeriods.push({ from, to });
    if (matches.some((m) => !negative(text, m.index!)))
      periods.push({ name, from, to });
  }
  let buckets = periods.length ? periods : [{ name: "当天", from: 0, to: 24 }];
  for (const excluded of excludedPeriods)
    buckets = buckets.flatMap((b) => {
      if (b.to <= excluded.from || b.from >= excluded.to) return [b];
      return [
        { ...b, to: Math.min(b.to, excluded.from) },
        { ...b, from: Math.max(b.from, excluded.to) },
      ].filter((part) => part.from < part.to);
    });
  if (!buckets.length) throw Error("所选时段都已排除，请重新选择日期或时段");
  const windows: Availability["windows"] = [];
  for (const day of [...days].sort())
    for (const b of buckets) {
      const base = Date.parse(`${day}T00:00:00+08:00`);
      const start = Math.max(
        base + b.from * 3600000,
        input.startAt ? Date.parse(input.startAt) : -Infinity,
      );
      const end = Math.min(
        base + b.to * 3600000,
        input.endAt ? Date.parse(input.endAt) : Infinity,
      );
      if (end > now.getTime() && start < end)
        windows.push({
          startAt: new Date(start).toISOString(),
          endAt: new Date(end).toISOString(),
        });
    }
  if (!windows.length)
    throw Error("这个日期或时段已经过去了，请换个日期或说“下周六”");
  // Merge adjacent OR buckets, while preserving gaps such as morning OR evening.
  windows.sort((a, b) => a.startAt.localeCompare(b.startAt));
  const merged: Availability["windows"] = [];
  for (const w of windows) {
    const last = merged.at(-1);
    if (last && w.startAt <= last.endAt) {
      if (w.endAt > last.endAt) last.endAt = w.endAt;
    } else merged.push({ ...w });
  }
  const bounds = buckets
    .map((b) => `${b.name} ${b.from}:00–${b.to}:00`)
    .join(" / ");
  return availabilitySchema.parse({
    windows: merged,
    label: `${[...new Set(windows.map((w) => localDay(Date.parse(w.startAt))))].map(dateLabel).join("、")} · ${bounds}（查询范围）`,
    broad: true,
  });
}
