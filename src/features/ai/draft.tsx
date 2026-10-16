"use client";
import { useEffect, useRef, useState } from "react";
import { AiTask, AiData, TaskRequest } from "@/lib/ai/contracts";
import { aiTask } from "@/lib/ai/client";
import { Pet } from "@/domain/schemas";
export function petSummary(p: Pet) {
  return {
    id: p.id,
    name: p.name,
    revision: p.revision,
    temperamentTags: p.temperamentTags,
    activityTags: p.activityTags,
    socialNotes: p.socialNotes,
  };
}
export function fillForm(
  form: HTMLFormElement | null,
  values: Record<string, unknown>,
) {
  for (const [name, value] of Object.entries(values)) {
    const field = form?.elements.namedItem(name);
    if (
      field instanceof HTMLInputElement ||
      field instanceof HTMLTextAreaElement ||
      field instanceof HTMLSelectElement
    )
      field.value = value == null ? "" : String(value);
  }
}
const labels: Record<string, string> = {
  name: "名字",
  breed: "品种",
  ageMonths: "月龄",
  size: "体型",
  city: "城市",
  district: "地区",
  temperamentTags: "性格标签",
  activityTags: "活动偏好",
  likes: "喜欢",
  dislikes: "不喜欢",
  cautions: "社交注意事项",
  traits: "社交性格",
  meetingAdvice: "初见建议",
  radiusKm: "半径（公里，未指定默认5）",
  breeds: "品种",
  sizes: "体型",
  temperaments: "性格",
  activities: "活动偏好",
  excludedSizes: "排除体型",
  excludedBreeds: "排除品种",
  excludedTemperaments: "排除性格",
  excludedActivities: "排除活动",
  sort: "排序",
  unmappedTerms: "未识别条件",
  type: "互助类型",
  petId: "关联宠物",
  title: "标题",
  details: "特别要求",
  startAt: "开始时间",
  endAt: "结束时间",
  durationMinutes: "时长（分钟）",
  timeText: "原始时间描述",
  locationQuery: "待确认公共地点",
  items: "交接清单",
  explanation: "社交适配解释",
  text: "文案",
  clarifications: "需要补充或澄清",
  warnings: "提示",
};
function display(v: unknown): string {
  if (v == null) return "未提供";
  if (Array.isArray(v))
    return v.length
      ? v
          .map((item) =>
            typeof item === "object" && item !== null
              ? "value" in item
                ? String(item.value)
                : "title" in item
                  ? `${item.title}：${item.detail}${item.needsConfirmation ? "（待确认）" : ""}`
                  : ""
              : String(item),
          )
          .join("；")
      : "未提供";
  const map: Record<string, string> = {
    small: "小型",
    medium: "中型",
    large: "大型",
    unknown: "未知",
    walk: "遛狗",
    feed: "喂食",
    distance: "距离优先",
    match: "偏好匹配优先",
  };
  return map[String(v)] ?? String(v);
}
export function AiPreview({ data }: { data: unknown }) {
  return (
    <dl className="ai-preview">
      {Object.entries(data as Record<string, unknown>)
        .filter(
          ([key, value]) =>
            key in labels &&
            value !== null &&
            value !== "" &&
            (!Array.isArray(value) || value.length > 0),
        )
        .map(([key, value]) => (
          <div key={key}>
            <dt>{labels[key]}</dt>
            <dd className="pre-wrap">{display(value)}</dd>
          </div>
        ))}
    </dl>
  );
}
export function AiDraft<T extends AiTask>({
  task,
  title,
  context = {},
  onApply,
  disabled = false,
  applyLabel = "填入表单（尚未保存）",
  initialText = "",
}: {
  task: T;
  title: string;
  context?: TaskRequest["context"];
  onApply: (data: AiData<T>) => void;
  disabled?: boolean;
  applyLabel?: string;
  initialText?: string;
}) {
  const [text, setText] = useState(initialText),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [data, setData] = useState<AiData<T> | null>(null),
    [applied, setApplied] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  return (
    <section className="ai-panel" aria-label={title}>
      <h3>{title}</h3>
      <p className="form-hint">
        AI
        仅生成草稿。只发送当前描述与所选档案的必要摘要，请勿输入联系方式或住址；填入后可编辑，确认保存才生效。
      </p>
      <label className="field">
        <span>描述需求</span>
        <textarea
          aria-label={`${title}描述`}
          maxLength={1500}
          rows={3}
          value={text}
          disabled={busy || disabled}
          onChange={(e) => {
            setText(e.target.value);
            setData(null);
            setApplied(false);
          }}
          placeholder="用自己的话描述，未知信息可以留空。"
        />
      </label>
      <div className="button-row">
        <button
          type="button"
          className="button secondary"
          disabled={busy || disabled || !text.trim()}
          onClick={async () => {
            const abort = new AbortController();
            controller.current = abort;
            setBusy(true);
            setError("");
            setData(null);
            setApplied(false);
            try {
              const result = await aiTask(
                task,
                { text, context },
                abort.signal,
              );
              if (!abort.signal.aborted) setData(result.data);
            } catch (e) {
              if (!abort.signal.aborted)
                setError(e instanceof Error ? e.message : "AI调用失败");
            } finally {
              if (!abort.signal.aborted) setBusy(false);
            }
          }}
        >
          {busy ? "AI 正在生成…" : "生成 AI 草稿"}
        </button>
        {busy && (
          <button
            type="button"
            onClick={() => {
              controller.current?.abort();
              setBusy(false);
              setError("已取消生成，未保存任何内容");
            }}
          >
            取消生成
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      {data && (
        <div data-testid="ai-draft">
          <p className="pill">AI 草稿 · 待主人复核</p>
          <AiPreview data={data} />
          <div className="button-row">
            <button
              type="button"
              className="button secondary"
              disabled={disabled || applied}
              onClick={() => {
                onApply(data);
                setApplied(true);
              }}
            >
              {applied ? "已填入，请检查下方表单" : applyLabel}
            </button>
            <button type="button" onClick={() => setData(null)}>
              丢弃草稿
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
