import type { sizes } from "./contracts";

type Size = Exclude<(typeof sizes)[number], "unknown">;
/**
 * Program-maintained adult size per common breed, used only to cross-check a vision draft (the
 * model never sees or edits this table): a size inside `sizes` is kept, anything else is replaced
 * by `typical`. Order matters: more specific names first (法国斗牛 before 斗牛, 玩具贵宾 / 泰迪
 * before 贵宾). Contested breeds list several allowed sizes; breeds with real variation are left
 * out so the ordinary confidence rule applies.
 */
export const BREED_SIZES: readonly {
  label: string;
  names: readonly string[];
  /** Used when the model's size falls outside `sizes`. */
  typical: Size;
  /** Sizes accepted as given by the model. */
  sizes: readonly Size[];
}[] = [
  {
    label: "法国斗牛犬",
    names: ["法斗", "法国斗牛"],
    typical: "small",
    sizes: ["small"],
  },
  {
    label: "英国斗牛犬",
    names: ["英国斗牛", "英斗"],
    typical: "medium",
    sizes: ["medium"],
  },
  {
    label: "玩具贵宾",
    names: ["玩具贵宾", "泰迪", "迷你贵宾"],
    typical: "small",
    sizes: ["small"],
  },
  { label: "比熊", names: ["比熊"], typical: "small", sizes: ["small"] },
  {
    label: "巴哥",
    names: ["巴哥", "八哥"],
    typical: "small",
    sizes: ["small"],
  },
  { label: "吉娃娃", names: ["吉娃娃"], typical: "small", sizes: ["small"] },
  { label: "博美", names: ["博美"], typical: "small", sizes: ["small"] },
  { label: "约克夏", names: ["约克夏"], typical: "small", sizes: ["small"] },
  {
    label: "马尔济斯",
    names: ["马尔济斯"],
    typical: "small",
    sizes: ["small"],
  },
  { label: "西施", names: ["西施"], typical: "small", sizes: ["small"] },
  { label: "腊肠", names: ["腊肠"], typical: "small", sizes: ["small"] },
  {
    label: "柯基",
    names: ["柯基"],
    typical: "small",
    sizes: ["small", "medium"],
  },
  {
    label: "柴犬",
    names: ["柴犬"],
    typical: "medium",
    sizes: ["small", "medium"],
  },
  {
    label: "雪纳瑞",
    names: ["雪纳瑞"],
    typical: "small",
    sizes: ["small", "medium"],
  },
  {
    label: "喜乐蒂",
    names: ["喜乐蒂"],
    typical: "small",
    sizes: ["small", "medium"],
  },
  {
    label: "比格",
    names: ["比格", "米格鲁"],
    typical: "medium",
    sizes: ["medium"],
  },
  { label: "可卡", names: ["可卡"], typical: "medium", sizes: ["medium"] },
  {
    label: "边境牧羊犬",
    names: ["边牧", "边境牧羊"],
    typical: "medium",
    sizes: ["medium"],
  },
  {
    label: "澳大利亚牧羊犬",
    names: ["澳牧", "澳大利亚牧羊"],
    typical: "medium",
    sizes: ["medium"],
  },
  { label: "惠比特", names: ["惠比特"], typical: "medium", sizes: ["medium"] },
  {
    label: "萨摩耶",
    names: ["萨摩"],
    typical: "large",
    sizes: ["medium", "large"],
  },
  {
    label: "哈士奇",
    names: ["哈士奇", "西伯利亚雪橇"],
    typical: "medium",
    sizes: ["medium", "large"],
  },
  {
    label: "松狮",
    names: ["松狮"],
    typical: "medium",
    sizes: ["medium", "large"],
  },
  { label: "金毛寻回犬", names: ["金毛"], typical: "large", sizes: ["large"] },
  {
    label: "拉布拉多",
    names: ["拉布拉多"],
    typical: "large",
    sizes: ["large"],
  },
  {
    label: "德国牧羊犬",
    names: ["德牧", "德国牧羊"],
    typical: "large",
    sizes: ["large"],
  },
  {
    label: "阿拉斯加",
    names: ["阿拉斯加"],
    typical: "large",
    sizes: ["large"],
  },
  { label: "秋田犬", names: ["秋田"], typical: "large", sizes: ["large"] },
  { label: "杜宾", names: ["杜宾"], typical: "large", sizes: ["large"] },
  { label: "罗威纳", names: ["罗威纳"], typical: "large", sizes: ["large"] },
  { label: "伯恩山", names: ["伯恩山"], typical: "large", sizes: ["large"] },
  {
    label: "大白熊",
    names: ["大白熊", "比利牛斯"],
    typical: "large",
    sizes: ["large"],
  },
  {
    label: "古代牧羊犬",
    names: ["古牧", "古代牧羊"],
    typical: "large",
    sizes: ["large"],
  },
  { label: "灵缇", names: ["灵缇"], typical: "large", sizes: ["large"] },
];

/** First table entry whose name occurs in the breed text (spaces ignored), else null. */
export function typicalSizes(breed: string | null | undefined) {
  if (!breed) return null;
  const text = breed.replace(/\s/g, "");
  return BREED_SIZES.find((b) => b.names.some((n) => text.includes(n))) ?? null;
}
