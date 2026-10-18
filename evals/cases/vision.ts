import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Vision eval cases (pet-photo). Public: the six demo photos in public/images (expectations
 * written here). Private: evals/fixtures/private-images (git-ignored, never committed); the
 * expectations come from its labels.csv. Reports only ever contain file names.
 */
export const VISION_CASE_VERSION = "vision.v1";
export const PUBLIC_DIR = "public/images";
export const PRIVATE_DIR = "evals/fixtures/private-images";
export type Size = "small" | "medium" | "large";
export type VisionCase = {
  id: string;
  file: string;
  source: "public" | "private";
  /** null = no label: only the generic rules are checked. */
  isDog: boolean | null;
  /** Expected breed (label text); null = unknown / not labelled. */
  breed: string | null;
  /** Sizes accepted if the model fills one; [] = must not fill a size; null = not labelled. */
  sizes: Size[] | null;
  /** Two or more dogs: nothing may be filled. */
  multiple: boolean;
  notes: string;
};

const PUBLIC: Omit<VisionCase, "id" | "source">[] = [
  {
    file: "dog-1.jpg",
    isDog: true,
    breed: "金毛寻回犬",
    sizes: ["large", "medium"],
    multiple: false,
    notes: "幼犬，咬着郁金香",
  },
  {
    file: "dog-2.jpg",
    isDog: true,
    breed: "柯基",
    sizes: ["small", "medium"],
    multiple: false,
    notes: "身上贴纸爱心",
  },
  {
    file: "dog-3.jpg",
    isDog: true,
    breed: "法国斗牛犬",
    sizes: ["small"],
    multiple: false,
    notes: "穿卫衣，背面回头",
  },
  {
    file: "dog-4.jpg",
    isDog: true,
    breed: "比格",
    sizes: ["small", "medium"],
    multiple: false,
    notes: "面部特写",
  },
  {
    file: "dog-5.jpg",
    isDog: true,
    breed: "柯基",
    sizes: ["small", "medium"],
    multiple: true,
    notes: "两只狗同框",
  },
  {
    file: "dog-6.jpg",
    isDog: true,
    breed: "拉布拉多寻回犬",
    sizes: ["large"],
    multiple: false,
    notes: "巧克力色，舔鼻子，面部特写",
  },
];

/** Splits one CSV line with "quoted, fields". */
function csvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "",
    quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** labels.csv: file,is_dog,breed,size,notes (UTF-8, BOM allowed). */
export function parseLabels(
  text: string,
): Map<string, Omit<VisionCase, "id" | "source">> {
  const lines = text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim());
  const header = csvLine(lines.shift() ?? "");
  const want = ["file", "is_dog", "breed", "size", "notes"];
  if (want.some((h, i) => header[i] !== h))
    throw Error(`labels.csv 列必须是 ${want.join(",")}`);
  const labels = new Map<string, Omit<VisionCase, "id" | "source">>();
  for (const line of lines) {
    const [file, isDog, breed, size, notes = ""] = csvLine(line);
    if (!/^[\w.-]+\.(jpe?g|png|webp)$/i.test(file))
      throw Error(`labels.csv 文件名不合法：${file}`);
    if (!["true", "false", ""].includes(isDog))
      throw Error(`${file}: is_dog 只能是 true / false`);
    if (!["small", "medium", "large", "unknown", ""].includes(size))
      throw Error(`${file}: size 只能是 small / medium / large / unknown`);
    labels.set(file, {
      file,
      isDog: isDog === "" ? null : isDog === "true",
      breed: !breed || breed === "unknown" ? null : breed,
      sizes: size === "" ? null : size === "unknown" ? [] : [size as Size],
      multiple: /两只|多只/.test(notes),
      notes,
    });
  }
  return labels;
}

export function loadVisionCases(
  source: "public" | "private" | "all" = "all",
  root = process.cwd(),
): VisionCase[] {
  const cases: VisionCase[] = [];
  if (source !== "private")
    cases.push(
      ...PUBLIC.map((c) => ({
        ...c,
        id: `pub-${c.file.replace(/\.\w+$/, "")}`,
        source: "public" as const,
      })),
    );
  const dir = path.join(root, PRIVATE_DIR);
  if (source !== "public" && existsSync(dir)) {
    const labelFile = path.join(dir, "labels.csv");
    const labels = existsSync(labelFile)
      ? parseLabels(readFileSync(labelFile, "utf8"))
      : new Map();
    // Non-dog and hard photos first: a budget stop must not drop the cases that test refusal.
    const rank = (f: string) =>
      f.startsWith("notdog") ? 0 : f.startsWith("hard") ? 1 : 2;
    const files = readdirSync(dir).sort(
      (a, b) => rank(a) - rank(b) || a.localeCompare(b),
    );
    for (const file of files)
      if (/\.(jpe?g|png|webp)$/i.test(file))
        cases.push({
          ...(labels.get(file) ?? {
            file,
            isDog: null,
            breed: null,
            sizes: null,
            multiple: false,
            notes: "无标签：只检查通用规则",
          }),
          id: `prv-${file.replace(/\.\w+$/, "")}`,
          source: "private",
        });
  }
  return cases;
}

const ALIASES: Record<string, string[]> = {
  比熊: ["比熊"],
  玩具贵宾: ["贵宾", "泰迪", "卷毛"],
  法国斗牛犬: ["法斗", "法国斗牛", "斗牛"],
  巴哥: ["巴哥", "八哥"],
  柴犬: ["柴犬"],
  边境牧羊犬: ["边牧", "边境牧羊"],
  比格: ["比格", "米格鲁"],
  英国可卡犬: ["可卡"],
  金毛寻回犬: ["金毛"],
  拉布拉多寻回犬: ["拉布拉多"],
  萨摩耶: ["萨摩"],
  德国牧羊犬: ["德牧", "德国牧羊"],
  柯基: ["柯基"],
};
/** Whether a filled breed agrees with the label (aliases, or one contains the other). */
export function breedMatches(expected: string, got: string): boolean {
  const g = got.replace(/\s/g, "");
  return (
    (ALIASES[expected] ?? []).some((a) => g.includes(a)) ||
    g.includes(expected) ||
    (g.length >= 2 && expected.includes(g))
  );
}
