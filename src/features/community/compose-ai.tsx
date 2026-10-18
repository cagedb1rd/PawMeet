"use client";
import { useEffect, useRef, useState } from "react";
import type { ImageRef } from "@/domain/schemas";
import { formatTags } from "@/domain/community";
import {
  PRECHECK_CATEGORIES,
  PRECHECK_FIELD_LABELS,
  type PrecheckContent,
  type PrecheckFinding,
} from "@/domain/moderation";
import type { PostMetaDraft } from "@/lib/ai/contracts";
import { aiPostMeta } from "@/lib/ai/client";
import { makeThumbnail } from "@/lib/ai/thumbnail";
import { photoBlob } from "@/features/ai/photo";
import { AiProgressHint, useAiProgress } from "@/features/ai/progress";

const isPlaceholder = (image: ImageRef | undefined) =>
  !image ||
  (image.kind === "static" && image.path.endsWith("dog-placeholder.svg"));

/**
 * "AI 生成标题和标签": only runs when clicked, from the body text the user already wrote. The
 * first photo is included (as the ≤512px re-encoded thumbnail) only when the user ticks it.
 * The draft fills the title / tags fields (marked AI 填入); publishing is still the user's click.
 */
export function PostMetaAssist({
  text,
  image,
  disabled,
  onApply,
}: {
  text: string;
  image: ImageRef | undefined;
  disabled: boolean;
  onApply: (draft: PostMetaDraft) => void;
}) {
  const [busy, setBusy] = useState(false),
    [withPhoto, setWithPhoto] = useState(false),
    [error, setError] = useState(""),
    [draft, setDraft] = useState<PostMetaDraft | null>(null),
    [applied, setApplied] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const progress = useAiProgress(busy);
  useEffect(() => () => controller.current?.abort(), []);
  const noPhoto = isPlaceholder(image);
  const generate = async () => {
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError("");
    setDraft(null);
    setApplied(false);
    try {
      const thumbnail =
        withPhoto && !noPhoto
          ? (await makeThumbnail(await photoBlob(image!))).dataUrl
          : undefined;
      const result = await aiPostMeta(
        { text, ...(thumbnail ? { image: thumbnail } : {}) },
        abort.signal,
        progress.onProgress,
      );
      if (!abort.signal.aborted) setDraft(result.data);
    } catch (e) {
      if (!abort.signal.aborted)
        setError(e instanceof Error ? e.message : "生成失败");
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  };
  return (
    <section className="ai-panel" aria-label="AI 标题和话题标签">
      <h3>AI 标题和话题标签</h3>
      <p className="form-hint">
        点击后才生成：根据上面已写的正文起草标题（≤20 字）和 3–5
        个话题标签，结果只是草稿，可改可删，不会自动发布。
      </p>
      <label className="check-line">
        <input
          type="checkbox"
          checked={withPhoto && !noPhoto}
          disabled={busy || disabled || noPhoto}
          onChange={(e) => setWithPhoto(e.target.checked)}
        />
        同时参考第一张照片（只发送压缩到 512px、已去除拍摄信息的缩略图）
      </label>
      <div className="button-row">
        <button
          type="button"
          className="button secondary"
          disabled={busy || disabled || !text.trim()}
          onClick={generate}
        >
          {busy ? "AI 正在生成…" : draft ? "重新生成" : "AI 生成标题和标签"}
        </button>
        {busy && (
          <button
            type="button"
            onClick={() => {
              controller.current?.abort();
              setBusy(false);
              setError("已取消生成，表单没有改动");
            }}
          >
            取消生成
          </button>
        )}
      </div>
      {!text.trim() && (
        <p className="form-hint">先在正文里写一句话，再点击生成。</p>
      )}
      <AiProgressHint text={progress.text} />
      {error && (
        <p role="alert" className="field-error">
          标题和标签生成失败：{error}。可以手动填写。
        </p>
      )}
      {draft && (
        <div data-testid="post-meta-draft">
          <p className="pill">AI 草稿 · 待你复核</p>
          <dl className="ai-preview">
            <div>
              <dt>标题</dt>
              <dd>{draft.title}</dd>
            </div>
            <div>
              <dt>话题标签</dt>
              <dd>{formatTags(draft.tags)}</dd>
            </div>
            {draft.note && (
              <div>
                <dt>提示</dt>
                <dd>{draft.note}</dd>
              </div>
            )}
          </dl>
          {draft.removed > 0 && (
            <p className="form-hint">
              程序已去掉 {draft.removed} 个不合格式或正文没有依据的标签。
            </p>
          )}
          <div className="button-row">
            <button
              type="button"
              className="button secondary"
              disabled={disabled || applied}
              onClick={() => {
                onApply(draft);
                setApplied(true);
              }}
            >
              {applied ? "已填入，请检查标题和标签" : "填入表单（尚未发布）"}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(null);
                setApplied(false);
              }}
            >
              丢弃草稿
            </button>
          </div>
          {applied && (
            <p className="form-hint" role="status">
              已填入的字段标记为“AI
              填入”，修改后标记消失；点击“确认发布动态”才会发布。
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export type AiPrecheck =
  | { status: "running" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string }
  | { status: "done"; findings: PrecheckFinding[] };
export type PrecheckState = {
  key: string;
  content: PrecheckContent;
  rules: PrecheckFinding[];
  ai: AiPrecheck;
};

/** Excerpt with a little surrounding context from the submitted field. */
function Snippet({
  content,
  finding,
}: {
  content: PrecheckContent;
  finding: PrecheckFinding;
}) {
  if (!finding.field || !finding.excerpt)
    return <span className="muted">（AI 未给出可在原文中定位的片段）</span>;
  const source =
    finding.field === "tags" ? content.tags.join(" ") : content[finding.field];
  const at = source.indexOf(finding.excerpt);
  if (at < 0) return <mark>{finding.excerpt}</mark>;
  const before = source.slice(Math.max(0, at - 10), at);
  const after = source.slice(
    at + finding.excerpt.length,
    at + finding.excerpt.length + 10,
  );
  return (
    <span>
      {PRECHECK_FIELD_LABELS[finding.field]}：「{at > 10 && "…"}
      {before}
      <mark>{finding.excerpt}</mark>
      {after}
      {at + finding.excerpt.length + 10 < source.length && "…"}」
    </span>
  );
}

/**
 * Result of the two-layer precheck. Never shows "已通过" unless both layers ran and found
 * nothing (that case publishes directly). Blocking findings (rule-detected personal info)
 * offer no override; other findings and a failed AI layer need the user's explicit choice.
 */
export function PrecheckPanel({
  check,
  disabled,
  onPublish,
  onRetry,
  onEdit,
}: {
  check: PrecheckState;
  disabled: boolean;
  onPublish: () => void;
  onRetry: () => void;
  onEdit: () => void;
}) {
  const ai = check.ai;
  const findings = [
    ...check.rules,
    ...(ai.status === "done" ? ai.findings : []),
  ];
  const blocking = findings.some((f) => f.blocking);
  const aiMissing = ai.status === "failed" || ai.status === "skipped";
  return (
    <section
      className="ai-panel precheck-panel"
      aria-label="发布前预检"
      data-testid="precheck"
      role={ai.status === "running" ? undefined : "alert"}
    >
      <h3>
        {ai.status === "running"
          ? "正在做发布前预检…"
          : blocking
            ? "需要修改后才能发布"
            : findings.length
              ? "预检建议修改"
              : "AI 预检未执行"}
      </h3>
      {ai.status === "running" && (
        <p className="form-hint">
          程序规则已检查{check.rules.length ? "，发现下列问题" : "，未发现问题"}
          ；正在等待 AI 预检结果。
        </p>
      )}
      {findings.length > 0 && (
        <ul className="precheck-list">
          {findings.map((f, i) => (
            <li key={i} data-category={f.category}>
              <span className="pill">
                {PRECHECK_CATEGORIES[f.category]} ·{" "}
                {f.source === "rule" ? "程序规则" : "AI 判断"}
                {f.blocking ? " · 必须修改" : ""}
              </span>{" "}
              <Snippet content={check.content} finding={f} />
              <br />
              <small>{f.reason}</small>
            </li>
          ))}
        </ul>
      )}
      {aiMissing && (
        <p className="field-error" data-testid="ai-precheck-missing">
          AI 预检未执行：
          {ai.status === "failed" ? ai.error : ai.reason}
          。只有程序规则生效
          {check.rules.length ? "" : "且未发现问题"}，不能视为预检通过。
        </p>
      )}
      {blocking && (
        <p className="form-hint">
          个人信息（手机号、微信号、QQ
          号、门牌地址等）不能公开发布，请删除后再点“确认发布动态”。
        </p>
      )}
      {ai.status !== "running" && (
        <div className="button-row">
          <button type="button" className="button secondary" onClick={onEdit}>
            去修改
          </button>
          {ai.status === "failed" && !blocking && (
            <button type="button" disabled={disabled} onClick={onRetry}>
              重试 AI 预检
            </button>
          )}
          {!blocking && (findings.length > 0 || aiMissing) && (
            <button
              type="button"
              className="button"
              disabled={disabled}
              onClick={onPublish}
            >
              {findings.length ? "仍要发布" : "不经 AI 预检发布"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
