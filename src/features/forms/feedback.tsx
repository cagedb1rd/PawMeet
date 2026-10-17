"use client";
import { useEffect, useId, useRef } from "react";
import { z } from "zod";

const fields: Record<string, [string, string]> = {
  name: ["name", "宠物名字"],
  breed: ["breed", "品种"],
  ageMonths: ["age", "月龄"],
  city: ["city", "城市"],
  district: ["district", "区域"],
  size: ["size", "体型"],
  title: ["title", "标题"],
  text: ["text", "动态内容"],
  description: ["description", "活动说明"],
  socialNotes: ["notes", "注意事项"],
  startAt: ["startAt", "开始时间"],
  endAt: ["endAt", "结束时间"],
  capacity: ["capacity", "主人名额"],
  organizerPetId: ["pet", "主办宠物"],
  petId: ["pet", "关联宠物"],
  details: ["details", "需求说明"],
  type: ["type", "互助类型"],
  petIds: ["pets", "关联宠物"],
};
export function describeFormError(error: Error) {
  if (!(error instanceof z.ZodError))
    return [{ name: "", message: error.message }];
  return error.issues.map((issue) => {
    const [name, label] = fields[String(issue.path[0])] ?? ["", "填写内容"];
    const message = /[\u4e00-\u9fff]/.test(issue.message)
      ? issue.message
      : issue.code === "too_small"
        ? `${label}未填写或低于允许的最小值`
        : issue.code === "too_big"
          ? `${label}超过允许的上限，请缩短内容或减少数量`
          : `请检查${label}的格式或选择有效选项`;
    return { name, message };
  });
}
export function FormError({ error }: { error: Error }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const problems = describeFormError(error);
  const findField = (name: string) => {
    const field = ref.current?.closest("form")?.elements.namedItem(name);
    return field instanceof HTMLElement ? field : null;
  };
  useEffect(() => {
    const form = ref.current?.closest("form");
    const restore: (() => void)[] = [];
    let first: HTMLElement | null = null;
    describeFormError(error).forEach((problem, index) => {
      const field = form?.elements.namedItem(problem.name);
      if (!(field instanceof HTMLElement)) return;
      first ??= field;
      const invalid = field.getAttribute("aria-invalid");
      const description = field.getAttribute("aria-describedby");
      field.setAttribute("aria-invalid", "true");
      field.setAttribute(
        "aria-describedby",
        [description, `${id}-${index}`].filter(Boolean).join(" "),
      );
      restore.push(() => {
        if (invalid === null) field.removeAttribute("aria-invalid");
        else field.setAttribute("aria-invalid", invalid);
        if (description === null) field.removeAttribute("aria-describedby");
        else field.setAttribute("aria-describedby", description);
      });
    });
    const target = first ?? ref.current;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
    return () => restore.forEach((fn) => fn());
  }, [error, id]);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      className="field-error form-errors"
    >
      <strong>请检查后再保存</strong>
      <ul>
        {problems.map((problem, index) => (
          <li key={index} id={`${id}-${index}`}>
            {problem.name ? (
              <button
                type="button"
                onClick={() => {
                  const field = findField(problem.name);
                  field?.focus();
                  field?.scrollIntoView({
                    block: "center",
                    behavior: "smooth",
                  });
                }}
              >
                {problem.message}
              </button>
            ) : (
              problem.message
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function clearAiMarker(event: React.FormEvent<HTMLElement>) {
  if (event.target instanceof HTMLElement) delete event.target.dataset.aiFilled;
}
