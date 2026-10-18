import type { PetPhotoDraft, PetPhotoOutput } from "./contracts";

/** Below this the field is shown as "不确定" and never filled into the form. */
export const PHOTO_CONFIDENCE_MIN = 0.6;
/**
 * A photo only gives appearance. Text that reads like a diagnosis, an age conclusion or a
 * temperament judgement is removed, whatever confidence the model attached to it.
 */
const FORBIDDEN =
  /病|症|炎|感染|过敏|寄生虫|跳蚤|蜱|伤口|受伤|疼|健康|诊断|治疗|用药|药物|剂量|疫苗|绝育|怀孕|胖|减肥|超重|偏瘦|瘦弱|营养不良|岁|月龄|年龄|幼犬|老年犬|成年犬|老狗|小奶狗|性格|脾气|温顺|温和|凶|攻击|咬人|友好|亲人|胆小|活泼|乖巧|焦虑|聪明|disease|sick|infect|diagnos|vaccin|injur|obese|puppy|senior|aggress|friendly|temperament|years? old|months? old/i;
const UNKNOWN_BREED =
  /^(未知|不确定|无法判断|无法识别|unknown|n\/a|none|mixed|混血|串串)$/i;

export const forbiddenClaim = (text: string | null | undefined) =>
  !!text && FORBIDDEN.test(text);

const SIZE_LABEL = { small: "小型", medium: "中型", large: "大型" } as const;

/**
 * Business review of a schema-valid model output. Decides what may be filled: nothing at all
 * unless the photo is confidently one dog; each field separately by confidence; forbidden
 * claims dropped. Messages are program-written, never model text.
 */
export function reviewPetPhoto(raw: PetPhotoOutput): PetPhotoDraft {
  const messages: string[] = [];
  let removed = 0;
  const clean = (value: string | null) => {
    if (forbiddenClaim(value)) {
      removed++;
      return null;
    }
    return value?.trim() || null;
  };
  const breedValue = clean(raw.breed.value);
  const coatValue = clean(raw.coatColor.value);
  const features = raw.features.flatMap((f) => {
    if (forbiddenClaim(f.value)) {
      removed++;
      return [];
    }
    return [{ value: f.value.trim(), confidence: f.confidence }];
  });
  const status: PetPhotoDraft["status"] =
    raw.dog.value === "no" && raw.dog.confidence >= PHOTO_CONFIDENCE_MIN
      ? "not_dog"
      : raw.dog.value !== "yes" || raw.dog.confidence < PHOTO_CONFIDENCE_MIN
        ? "uncertain"
        : raw.multipleDogs
          ? "multiple"
          : "recognized";
  const fillable = status === "recognized";
  const ok = (value: unknown, c: number) =>
    fillable && value != null && c >= PHOTO_CONFIDENCE_MIN;
  const breedOk =
    ok(breedValue, raw.breed.confidence) && !UNKNOWN_BREED.test(breedValue!);
  const sizeOk =
    raw.size.value !== "unknown" && ok(raw.size.value, raw.size.confidence);
  const coatOk = ok(coatValue, raw.coatColor.confidence);
  const draft: PetPhotoDraft = {
    status,
    dogConfidence: raw.dog.confidence,
    breed: {
      value: breedValue,
      confidence: raw.breed.confidence,
      accepted: breedOk,
    },
    size: {
      value: raw.size.value,
      confidence: raw.size.confidence,
      accepted: sizeOk,
    },
    coatColor: {
      value: coatValue,
      confidence: raw.coatColor.confidence,
      accepted: coatOk,
    },
    features: features.map((f) => ({
      ...f,
      accepted: ok(f.value, f.confidence),
    })),
    removed,
    messages,
  };
  if (status === "not_dog")
    messages.push(
      "无法识别：照片里看起来不是狗，没有填入任何字段，请换一张或手动填写。",
    );
  else if (status === "uncertain")
    messages.push(
      "不确定照片里是否有狗（或画面太模糊），没有填入任何字段，请手动填写。",
    );
  else if (status === "multiple")
    messages.push(
      "照片里有多只狗，无法确定是哪一只，没有填入任何字段；请换单只照片或手动填写。",
    );
  else {
    if (!breedOk)
      messages.push("品种不确定，请手动填写（可留空保存为“未知”）。");
    if (!sizeOk) messages.push("体型不确定，请手动选择。");
    if (!coatOk && !draft.features.some((f) => f.accepted))
      messages.push("毛色与外观特征不确定，未写入提醒。");
  }
  if (removed)
    messages.push(
      `已忽略 ${removed} 项看起来像健康、年龄或性格判断的内容：照片只能识别外观。`,
    );
  return draft;
}

/** Form values from accepted fields only; undefined means "leave the field as it is". */
export function photoFill(draft: PetPhotoDraft) {
  const appearance = [
    draft.coatColor.accepted ? draft.coatColor.value : null,
    ...draft.features.filter((f) => f.accepted).map((f) => f.value),
  ].filter(Boolean);
  return {
    breed: draft.breed.accepted ? draft.breed.value! : undefined,
    size:
      draft.size.accepted && draft.size.value !== "unknown"
        ? draft.size.value
        : undefined,
    appearance: appearance.length
      ? `外观：${appearance.join("、")}`
      : undefined,
  };
}

export const sizeLabel = (size: string) =>
  size in SIZE_LABEL ? SIZE_LABEL[size as keyof typeof SIZE_LABEL] : "不确定";
