"use client";
import { useEffect, useRef, useState } from "react";
import type { ImageRef } from "@/domain/schemas";
import type { PetPhotoDraft } from "@/lib/ai/contracts";
import { aiPetPhoto } from "@/lib/ai/client";
import { photoFill, photoSuggestions, sizeLabel } from "@/lib/ai/photo";
import { makeThumbnail } from "@/lib/ai/thumbnail";
import { getImage } from "@/lib/storage/images";
import { AiProgressHint, useAiProgress } from "./progress";

export async function photoBlob(image: ImageRef): Promise<Blob> {
  if (image.kind === "upload") {
    const blob = await getImage(image.imageId);
    if (!blob) throw new Error("找不到这张照片，请重新选择");
    return blob;
  }
  const response = await fetch(image.path);
  if (!response.ok) throw new Error("读取照片失败，请重新选择");
  return response.blob();
}
const percent = (c: number) => `${Math.round(c * 100)}%`;

export type PhotoFill = Partial<ReturnType<typeof photoFill>>;

/** One low-confidence or conflicting guess; nothing is filled until a choice is clicked. */
function Suggestion({
  text,
  choices,
  adopted,
  disabled,
  onAdopt,
}: {
  text: string;
  choices: { key: string; label: string; name: string; fill: PhotoFill }[];
  adopted: Record<string, string>;
  disabled: boolean;
  onAdopt: (key: string, label: string, value: PhotoFill) => void;
}) {
  const key = choices[0].key;
  return (
    <span className="photo-suggestion" data-testid={`photo-suggest-${key}`}>
      <span>{text}</span>
      {adopted[key] ? (
        <span className="pill" role="status">
          已填入（{adopted[key]}），尚未保存
        </span>
      ) : (
        <span className="button-row">
          {choices.map((c) => (
            <button
              key={c.name}
              type="button"
              aria-label={c.name}
              disabled={disabled}
              onClick={() => onAdopt(c.key, c.label, c.fill)}
            >
              {c.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

/**
 * "识别照片" panel under the photo picker. Nothing is sent until the user clicks; only a
 * re-encoded ≤512px JPEG leaves the browser. The result is a draft: applying it fills the form
 * (marked AI 填入) and saving still requires the owner's own click.
 */
export function PhotoRecognize({
  image,
  disabled,
  onApply,
}: {
  image: ImageRef | undefined;
  disabled: boolean;
  onApply: (fill: PhotoFill) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [draft, setDraft] = useState<PetPhotoDraft | null>(null),
    [applied, setApplied] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const progress = useAiProgress(busy);
  useEffect(() => () => controller.current?.abort(), []);
  const fill = draft ? photoFill(draft) : null;
  const fillable = !!fill && Object.values(fill).some((v) => v !== undefined);
  const suggestions = draft ? photoSuggestions(draft) : null;
  const hasSuggestions =
    !!suggestions && Object.values(suggestions).some((v) => v !== undefined);
  // Per-field “采用” clicks: field → chosen label; each fills only that field.
  const [adopted, setAdopted] = useState<Record<string, string>>({});
  const adoptProps = {
    adopted,
    disabled,
    onAdopt: (key: string, label: string, value: PhotoFill) => {
      onApply(value);
      setAdopted((a) => ({ ...a, [key]: label }));
    },
  };
  const placeholder =
    !image ||
    (image.kind === "static" && image.path.endsWith("dog-placeholder.svg"));
  return (
    <section className="ai-panel" aria-label="AI 识别照片">
      <h3>AI 识别照片</h3>
      <p className="form-hint">
        点击后才识别：只发送压缩到
        512px、已去除拍摄信息的缩略图，原图不离开浏览器。结果只是草稿，可修改，保存前不会写入档案。
      </p>
      <div className="button-row">
        <button
          type="button"
          className="button secondary"
          disabled={busy || disabled || placeholder}
          onClick={async () => {
            if (!image) return;
            const abort = new AbortController();
            controller.current = abort;
            setBusy(true);
            setError("");
            setDraft(null);
            setApplied(false);
            setAdopted({});
            try {
              const thumb = await makeThumbnail(await photoBlob(image));
              const result = await aiPetPhoto(
                thumb.dataUrl,
                abort.signal,
                progress.onProgress,
              );
              if (!abort.signal.aborted) setDraft(result.data);
            } catch (e) {
              if (!abort.signal.aborted)
                setError(e instanceof Error ? e.message : "照片识别失败");
            } finally {
              if (!abort.signal.aborted) setBusy(false);
            }
          }}
        >
          {busy ? "正在识别…" : "识别照片"}
        </button>
        {busy && (
          <button
            type="button"
            onClick={() => {
              controller.current?.abort();
              setBusy(false);
              setError("已取消识别，表单没有改动");
            }}
          >
            取消识别
          </button>
        )}
      </div>
      {placeholder && (
        <p className="form-hint">先在上方选择一张宠物照片，再点击识别。</p>
      )}
      <AiProgressHint text={progress.text} />
      {error && (
        <p role="alert" className="field-error">
          照片识别失败：{error}。表单仍可手动填写。
        </p>
      )}
      {draft && (
        <div data-testid="photo-draft">
          <p className="pill">AI 草稿 · 待主人复核</p>
          <dl className="ai-preview">
            <div>
              <dt>是否为狗</dt>
              <dd>
                {draft.status === "not_dog"
                  ? "无法识别：不像是狗"
                  : draft.status === "uncertain"
                    ? "不确定"
                    : draft.status === "multiple"
                      ? "多只狗"
                      : "是"}
                （把握 {percent(draft.dogConfidence)}）
              </dd>
            </div>
            {draft.status === "recognized" && (
              <>
                <div>
                  <dt>品种</dt>
                  <dd>
                    {draft.breed.accepted ? (
                      `${draft.breed.value}（把握 ${percent(draft.breed.confidence)}，将填入）`
                    ) : suggestions?.breed ? (
                      <Suggestion
                        text={`AI 猜测：${suggestions.breed.value}（把握 ${percent(suggestions.breed.confidence)}），请确认`}
                        choices={[
                          {
                            key: "breed",
                            label: "采用",
                            name: `采用品种 ${suggestions.breed.value}`,
                            fill: { breed: suggestions.breed.value },
                          },
                        ]}
                        {...adoptProps}
                      />
                    ) : (
                      "不确定，未填入"
                    )}
                  </dd>
                </div>
                <div>
                  <dt>体型</dt>
                  <dd>
                    {draft.size.accepted ? (
                      `${sizeLabel(draft.size.value)}（把握 ${percent(draft.size.confidence)}，将填入）`
                    ) : suggestions?.size ? (
                      <Suggestion
                        text={
                          suggestions.size.hint ??
                          `AI 猜测：${sizeLabel(suggestions.size.value)}（把握 ${percent(suggestions.size.confidence)}），请确认`
                        }
                        choices={suggestions.size.options.map((v) => ({
                          key: "size",
                          label:
                            suggestions.size!.options.length > 1
                              ? `选${sizeLabel(v)}`
                              : "采用",
                          name: `采用体型 ${sizeLabel(v)}`,
                          fill: { size: v },
                        }))}
                        {...adoptProps}
                      />
                    ) : (
                      "不确定，未填入"
                    )}
                  </dd>
                </div>
                <div>
                  <dt>外观</dt>
                  <dd>
                    {fill?.appearance
                      ? `${fill.appearance}（将追加到“见面前的小提醒”）`
                      : !suggestions?.appearance && "不确定，未填入"}
                    {suggestions?.appearance && (
                      <Suggestion
                        text={`AI 猜测：${suggestions.appearance.replace(/^外观：/, "")}（把握较低），请确认`}
                        choices={[
                          {
                            key: "appearance",
                            label: "采用",
                            name: "采用外观建议",
                            fill: { appearance: suggestions.appearance },
                          },
                        ]}
                        {...adoptProps}
                      />
                    )}
                  </dd>
                </div>
              </>
            )}
          </dl>
          {draft.messages.length > 0 && (
            <ul className="form-hint" data-testid="photo-messages">
              {draft.messages.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
          <div className="button-row">
            <button
              type="button"
              className="button secondary"
              disabled={disabled || applied || !fillable}
              onClick={() => {
                onApply(fill!);
                setApplied(true);
              }}
            >
              {applied
                ? "已填入，请检查下方表单"
                : fillable
                  ? "填入表单（尚未保存）"
                  : hasSuggestions
                    ? "没有自动填入的字段，可逐项采用建议"
                    : "没有可填入的字段"}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(null);
                setApplied(false);
                setAdopted({});
              }}
            >
              丢弃草稿
            </button>
          </div>
          {applied && (
            <p className="form-hint" role="status">
              已填入的字段已标记“AI
              填入”，修改后标记消失；点击“确认保存档案”才会保存。
            </p>
          )}
        </div>
      )}
    </section>
  );
}
