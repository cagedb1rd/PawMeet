"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { fillForm } from "@/features/ai/draft";
import {
  AiPrecheck,
  PostMetaAssist,
  PrecheckPanel,
  PrecheckState,
} from "@/features/community/compose-ai";
import { formatTags, parseTags } from "@/domain/community";
import { precheckKey, rulePrecheck } from "@/domain/moderation";
import { aiFindings } from "@/lib/ai/community";
import { aiPostSafety } from "@/lib/ai/client";
import { FormError, clearAiMarker } from "./feedback";
import { useDemo } from "@/features/demo/provider";
import { PhotoPicker, Title, usePhotoDraft, useUnsaved } from "@/components/ui";
import { postInputSchema, PostInput } from "@/domain/schemas";
import { Field } from "./field";

export function PostForm() {
  const { state } = useDemo();
  return state ? <PostEditor key={state.activeUserId} /> : null;
}
function PostEditor() {
  const form = useRef<HTMLFormElement>(null);
  const { state, run, writable, notify } = useDemo(),
    router = useRouter();
  const draft = usePhotoDraft(),
    [error, setError] = useState<Error | null>(null),
    { setDirty } = useUnsaved(),
    [text, setText] = useState(""),
    [check, setCheck] = useState<PrecheckState | null>(null);
  // Identity of the content the latest precheck applies to; stale AI answers are ignored.
  const checking = useRef<string | null>(null);
  const precheckAbort = useRef<AbortController | null>(null);
  useEffect(() => () => precheckAbort.current?.abort(), []);
  const pets = state!.pets.filter(
    (p) => p.ownerId === state!.activeUserId && !p.archivedAt,
  );
  const clearCheck = () => {
    precheckAbort.current?.abort();
    checking.current = null;
    setCheck(null);
  };
  const publish = (input: PostInput, message: string) => {
    if (run({ type: "publish-post", input })) {
      draft.markSaved();
      setDirty(false);
      notify(message);
      router.push("/");
    }
  };
  const readInput = (): PostInput => {
    const f = new FormData(form.current!);
    return postInputSchema.parse({
      title: f.get("title"),
      text,
      tags: parseTags(String(f.get("tags") ?? "")),
      petIds: f.getAll("pets"),
      images: draft.images,
    });
  };
  /** Rules first (always), then the model; publishes directly only if both found nothing. */
  const precheck = async (input: PostInput) => {
    const content = { title: input.title, text: input.text, tags: input.tags };
    const key = precheckKey(content);
    const rules = rulePrecheck(content);
    precheckAbort.current?.abort();
    checking.current = key;
    if (rules.some((f) => f.blocking)) {
      setCheck({
        key,
        content,
        rules,
        ai: {
          status: "skipped",
          reason: "请先删除个人信息，修改后会重新预检",
        },
      });
      return;
    }
    setCheck({ key, content, rules, ai: { status: "running" } });
    const abort = new AbortController();
    precheckAbort.current = abort;
    let ai: AiPrecheck;
    try {
      const result = await aiPostSafety(content, abort.signal);
      ai = { status: "done", findings: aiFindings(result.data) };
    } catch (e) {
      ai = {
        status: "failed",
        error: e instanceof Error ? e.message : "AI 预检失败",
      };
    }
    if (abort.signal.aborted || checking.current !== key) return;
    if (!rules.length && ai.status === "done" && !ai.findings.length) {
      checking.current = null;
      setCheck(null);
      publish(input, "动态已发布（程序规则与 AI 预检均未发现问题）");
      return;
    }
    setCheck({ key, content, rules, ai });
  };
  return (
    <div className="form-container">
      <Link href="/" className="back-link">
        ← 返回社区
      </Link>
      <Title
        eyebrow="SHARE A LITTLE HAPPINESS"
        title="分享一点，毛茸茸的快乐。"
        description="不需要大事，小日常就很值得记录。"
      />
      <form
        ref={form}
        className="card form-card"
        onChange={() => {
          setDirty(true);
          setError(null);
          // A precheck applies to exactly the checked text; any edit needs a new check.
          clearCheck();
        }}
        onInputCapture={clearAiMarker}
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          let input: PostInput;
          try {
            input = readInput();
          } catch (e) {
            clearCheck();
            setError(e instanceof Error ? e : new Error("请检查表单内容"));
            return;
          }
          void precheck(input);
        }}
      >
        <fieldset disabled={!writable || draft.busy}>
          <Field label="帖子标题（选填）">
            <input
              name="title"
              aria-label="帖子标题"
              maxLength={60}
              placeholder="给这个小日常起个名字"
            />
          </Field>
          <Field label="今天发生了什么？ *">
            <textarea
              aria-label="动态内容"
              name="text"
              required
              maxLength={1000}
              rows={6}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="分享今天的小开心吧…"
            />
            <small>{text.length}/1000</small>
          </Field>
          <Field
            label="话题标签（选填）"
            hint="最多 5 个，用空格分隔；每个最多 12 字，只含中文、字母、数字"
          >
            <input
              name="tags"
              aria-label="话题标签"
              maxLength={80}
              placeholder="#柯基 #周末遛狗"
            />
          </Field>
          <PostMetaAssist
            text={text}
            image={draft.images[0]}
            disabled={!writable}
            onApply={(meta) => {
              fillForm(form.current, {
                title: meta.title,
                tags: formatTags(meta.tags),
              });
              clearCheck();
              setDirty(true);
            }}
          />
          <h3>
            这次和谁一起？ <span className="muted small">最多选 3 位</span>
          </h3>
          <div className="pet-checkboxes">
            {pets.map((p) => (
              <label key={p.id}>
                <input type="checkbox" name="pets" value={p.id} />
                {p.name}
              </label>
            ))}
          </div>
          <h3>加几张可爱照片</h3>
          <PhotoPicker draft={draft} max={3} />
          {error && <FormError error={error} />}
          {check && (
            <PrecheckPanel
              check={check}
              disabled={!writable}
              onEdit={() => {
                const first = [
                  ...check.rules,
                  ...(check.ai.status === "done" ? check.ai.findings : []),
                ][0];
                const field = form.current?.elements.namedItem(
                  first?.field ?? "text",
                );
                if (field instanceof HTMLElement) field.focus();
              }}
              onRetry={() => {
                try {
                  void precheck(readInput());
                } catch (e) {
                  clearCheck();
                  setError(
                    e instanceof Error ? e : new Error("请检查表单内容"),
                  );
                }
              }}
              onPublish={() => {
                try {
                  const input = readInput();
                  const same =
                    precheckKey({
                      title: input.title,
                      text: input.text,
                      tags: input.tags,
                    }) === check.key;
                  if (!same) {
                    void precheck(input);
                    return;
                  }
                  checking.current = null;
                  publish(
                    input,
                    check.ai.status === "done"
                      ? "动态已发布（你确认忽略了预检建议）"
                      : "动态已发布（AI 预检未执行，已由你确认发布）",
                  );
                } catch (e) {
                  clearCheck();
                  setError(
                    e instanceof Error ? e : new Error("请检查表单内容"),
                  );
                }
              }}
            />
          )}
          <button
            type="submit"
            className="button form-submit"
            disabled={check?.ai.status === "running"}
          >
            {check?.ai.status === "running" ? "正在预检…" : "确认发布动态"}
          </button>
        </fieldset>
      </form>
    </div>
  );
}
