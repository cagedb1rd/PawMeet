"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AiDraft, fillForm } from "@/features/ai/draft";
import { PhotoRecognize } from "@/features/ai/photo";
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
import {
  Empty,
  PhotoPicker,
  Title,
  usePhotoDraft,
  useUnsaved,
} from "@/components/ui";
import {
  activityInputSchema,
  interests,
  petInputSchema,
  postInputSchema,
  PostInput,
  temperaments,
  PlaceRef,
  ActivityInput,
} from "@/domain/schemas";
import { demoPlaces } from "@/data/seed";
import { PlacePicker } from "@/features/maps/places";

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function PetForm({ id }: { id?: string }) {
  const { state } = useDemo();
  if (!state) return null;
  const pet = id
    ? state.pets.find((p) => p.id === id && !p.archivedAt)
    : undefined;
  if (id && (!pet || pet.ownerId !== state.activeUserId))
    return (
      <Empty title="无法编辑这份档案">
        <Link href="/me">返回我的</Link>
      </Empty>
    );
  return <PetEditor key={`${state.activeUserId}-${id ?? "new"}`} id={id} />;
}
function PetEditor({ id }: { id?: string }) {
  const form = useRef<HTMLFormElement>(null);
  const { state, run, writable, notify } = useDemo(),
    router = useRouter();
  const pet = state!.pets.find((p) => p.id === id);
  const draft = usePhotoDraft(pet ? [pet.photo] : []),
    [error, setError] = useState<Error | null>(null),
    { setDirty } = useUnsaved();
  const [traits, setTraits] = useState<string[]>(pet?.temperamentTags ?? []),
    [likes, setLikes] = useState<string[]>(pet?.activityTags ?? []);
  const toggle = (tag: string, list: string[], set: (s: string[]) => void) => {
    setDirty(true);
    set(list.includes(tag) ? list.filter((t) => t !== tag) : [...list, tag]);
  };
  return (
    <div className="form-container">
      <Link href="/me" className="back-link">
        ← 返回我的毛孩子
      </Link>
      <Title
        eyebrow="EVERY PAW HAS A STORY"
        title={pet ? `编辑${pet.name}的档案` : "认识一下，新来的小朋友。"}
        description="慢慢介绍它，让大家认识你的毛孩子。"
      />
      <form
        ref={form}
        className="card form-card"
        onChange={() => {
          setDirty(true);
          setError(null);
        }}
        onInputCapture={clearAiMarker}
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          const f = new FormData(e.currentTarget);
          try {
            const input = petInputSchema.parse({
              name: f.get("name"),
              species: "dog",
              breed: f.get("breed") || "未知",
              ageMonths: f.get("age") === "" ? null : Number(f.get("age")),
              size: f.get("size"),
              city: f.get("city"),
              district: f.get("district"),
              photo: draft.images[0] ?? {
                kind: "static",
                path: "/images/dog-placeholder.svg",
              },
              temperamentTags: traits,
              activityTags: likes,
              socialNotes: f.get("notes"),
              demoLocation: pet?.demoLocation ?? demoPlaces[0].location,
              isFictional: true,
            });
            if (run({ type: "save-pet", petId: id, input })) {
              draft.markSaved();
              setDirty(false);
              notify("宠物档案已保存");
              router.push("/me");
            }
          } catch (e) {
            setError(e instanceof Error ? e : new Error("请检查表单内容"));
          }
        }}
      >
        <fieldset disabled={!writable || draft.busy}>
          <AiDraft
            key={`${state!.activeUserId}-${pet?.revision}`}
            task="pet-profile"
            title="AI 宠物档案与社交信息"
            disabled={!writable}
            onApply={(data) => {
              fillForm(form.current, {
                name: data.name ?? pet?.name,
                breed: data.breed ?? pet?.breed,
                age: data.ageMonths,
                size: data.size ?? pet?.size ?? "unknown",
                city: data.city ?? pet?.city ?? "",
                district: data.district ?? pet?.district ?? "",
                notes: [
                  pet?.socialNotes ?? "",
                  ...data.likes.map((v) => `喜欢：${v}`),
                  ...data.dislikes.map((v) => `不喜欢：${v}`),
                  ...data.cautions,
                ].join("；"),
              });
              setTraits(data.temperamentTags.map((t) => t.value));
              setLikes(data.activityTags.map((t) => t.value));
              setDirty(true);
            }}
          />
          <h2>它的第一张名片</h2>
          <PhotoPicker draft={draft} max={1} />
          <PhotoRecognize
            key={
              draft.images[0]?.kind === "upload"
                ? draft.images[0].imageId
                : (draft.images[0]?.path ?? "none")
            }
            image={draft.images[0]}
            disabled={!writable}
            onApply={(fill) => {
              const notes = form.current?.elements.namedItem("notes");
              const current =
                notes instanceof HTMLTextAreaElement ? notes.value.trim() : "";
              fillForm(form.current, {
                ...(fill.breed ? { breed: fill.breed } : {}),
                ...(fill.size ? { size: fill.size } : {}),
                ...(fill.appearance
                  ? {
                      notes: current
                        ? `${current}；${fill.appearance}`
                        : fill.appearance,
                    }
                  : {}),
              });
              setDirty(true);
            }}
          />
          <div className="form-grid">
            <Field label="宠物名字 *">
              <input
                name="name"
                aria-label="宠物名字"
                required
                maxLength={20}
                defaultValue={pet?.name}
                placeholder="比如：年糕"
              />
            </Field>
            <Field label="品种" hint="留空保存为“未知”">
              <input
                name="breed"
                aria-label="品种"
                maxLength={30}
                defaultValue={pet?.breed}
                placeholder="比如：金毛 / 未知"
              />
            </Field>
            <Field label="月龄" hint="不确定可以留空">
              <input
                name="age"
                aria-label="月龄"
                type="number"
                min={0}
                max={360}
                step={1}
                defaultValue={pet?.ageMonths ?? ""}
                placeholder="以月为单位"
              />
            </Field>
            <Field label="体型">
              <select
                name="size"
                aria-label="体型"
                defaultValue={pet?.size ?? "unknown"}
              >
                <option value="unknown">暂不确定</option>
                <option value="small">小型犬</option>
                <option value="medium">中型犬</option>
                <option value="large">大型犬</option>
              </select>
            </Field>
            <Field label="城市 *">
              <input
                name="city"
                required
                maxLength={20}
                defaultValue={pet?.city ?? "杭州"}
              />
            </Field>
            <Field label="区域 *">
              <select name="district" defaultValue={pet?.district ?? "滨江区"}>
                {["滨江区", "萧山区", "上城区", "西湖区"].map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            </Field>
          </div>
          <h3>它是什么性格？</h3>
          <div className="choice-tags">
            {temperaments.map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={traits.includes(t)}
                className={traits.includes(t) ? "selected" : ""}
                onClick={() => toggle(t, traits, setTraits)}
              >
                {t}
              </button>
            ))}
          </div>
          <h3>它喜欢做什么？</h3>
          <div className="choice-tags">
            {interests.map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={likes.includes(t)}
                className={likes.includes(t) ? "selected" : ""}
                onClick={() => toggle(t, likes, setLikes)}
              >
                {t}
              </button>
            ))}
          </div>
          <Field label="见面前的小提醒">
            <textarea
              name="notes"
              maxLength={500}
              rows={4}
              defaultValue={pet?.socialNotes}
              placeholder="例如：慢热，需要一点时间熟悉。不要填写手机号、微信号或住址。"
            />
          </Field>
          {error && <FormError error={error} />}
          <button type="submit" className="button form-submit">
            {draft.busy ? "照片处理中…" : "确认保存档案"}
          </button>
        </fieldset>
      </form>
    </div>
  );
}
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
// datetime-local is explicitly interpreted in Shanghai rather than the device timezone.
export function shanghaiTime(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || !value)
    throw new Error("请填写完整的北京时间");
  return new Date(`${value}:00+08:00`).toISOString();
}
export function ActivityForm() {
  const { state } = useDemo();
  return state ? <ActivityEditor key={state.activeUserId} /> : null;
}
export function ActivityEditor({
  initialInput,
}: { initialInput?: Partial<ActivityInput> } = {}) {
  const params = useSearchParams();
  const recommendedId = params.get("recommendedPetId");
  const [place, setPlace] = useState<PlaceRef>(
    initialInput?.place ?? demoPlaces[0],
  );
  const { state, run, writable, notify } = useDemo(),
    router = useRouter(),
    [error, setError] = useState<Error | null>(null),
    { setDirty } = useUnsaved();
  const pets = state!.pets.filter(
    (p) => p.ownerId === state!.activeUserId && !p.archivedAt,
  );
  return (
    <div className="form-container">
      <Link href="/activities" className="back-link">
        ← 返回活动
      </Link>
      <Title
        eyebrow="MAKE A LITTLE PLAN"
        title="下一次快乐，由你发起。"
        description="确定时间和公共集合点，让大家从容相遇。"
      />
      <form
        className="card form-card"
        onChange={() => {
          setDirty(true);
          setError(null);
        }}
        onInputCapture={clearAiMarker}
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          const f = new FormData(e.currentTarget);
          try {
            const input = activityInputSchema.parse({
              title: f.get("title"),
              description: f.get("description"),
              organizerPetId: f.get("pet"),
              recommendedPetIds:
                initialInput?.recommendedPetIds ??
                (recommendedId ? [recommendedId] : []),
              startAt: shanghaiTime(f.get("startAt")),
              endAt: shanghaiTime(f.get("endAt")),
              capacity: Number(f.get("capacity")),
              place,
            });
            if (run({ type: "create-activity", input })) {
              setDirty(false);
              notify("活动已创建，你和宠物已自动报名");
              router.push("/activities");
            }
          } catch (e) {
            setError(e instanceof Error ? e : new Error("请检查表单内容"));
          }
        }}
      >
        <fieldset disabled={!writable}>
          {recommendedId && (
            <p className="meeting-note">
              推荐约伴对象：
              {state!.pets.find((p) => p.id === recommendedId && !p.archivedAt)
                ?.name ?? "对象不存在，请重新选择"}
            </p>
          )}
          <Field label="活动名称 *">
            <input
              name="title"
              aria-label="活动名称"
              required
              maxLength={40}
              defaultValue={initialInput?.title}
              placeholder="比如：周末江边慢慢走"
            />
          </Field>
          <Field label="带上哪位毛孩子？ *">
            <select
              name="pet"
              aria-label="主办宠物"
              required
              defaultValue={initialInput?.organizerPetId}
            >
              {pets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <h2 className="form-section-title">时间与集合地点</h2>
          <div className="form-grid">
            <Field label="开始时间 *" hint="北京时间 UTC+8">
              <input
                aria-label="开始时间"
                name="startAt"
                defaultValue={
                  initialInput?.startAt
                    ? new Date(Date.parse(initialInput.startAt) + 8 * 3600000)
                        .toISOString()
                        .slice(0, 16)
                    : undefined
                }
                type="datetime-local"
                required
              />
            </Field>
            <Field label="结束时间 *" hint="北京时间 UTC+8">
              <input
                aria-label="结束时间"
                name="endAt"
                defaultValue={
                  initialInput?.endAt
                    ? new Date(Date.parse(initialInput.endAt) + 8 * 3600000)
                        .toISOString()
                        .slice(0, 16)
                    : undefined
                }
                type="datetime-local"
                required
              />
            </Field>
          </div>
          <PlacePicker
            label="集合地点"
            value={place}
            onChange={(p) => {
              setPlace(p);
              setDirty(true);
            }}
          />
          <Field label="主人名额（含组织者） *">
            <input
              name="capacity"
              aria-label="主人名额"
              type="number"
              min={2}
              max={12}
              step={1}
              defaultValue={initialInput?.capacity ?? 6}
              required
            />
          </Field>
          <h2 className="form-section-title">补充说明</h2>
          <Field label="活动说明">
            <textarea
              name="description"
              defaultValue={initialInput?.description}
              data-ai-filled={initialInput ? "true" : undefined}
              maxLength={500}
              rows={4}
              placeholder="活动安排、需要带的物品、初次见面的注意事项…"
            />
          </Field>
          {error && <FormError error={error} />}
          <button
            type="submit"
            className="button form-submit"
            disabled={!pets.length}
          >
            确认创建活动
          </button>
          {!pets.length && (
            <Link href="/me/pets/new">请先创建一份宠物档案 →</Link>
          )}
        </fieldset>
      </form>
    </div>
  );
}
