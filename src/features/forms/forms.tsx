"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import { AiDraft, fillForm } from "@/features/ai/draft";
import { z } from "zod";
import { useDemo } from "@/features/demo/provider";
import {
  Empty,
  PhotoPicker,
  Title,
  Unavailable,
  usePhotoDraft,
  useUnsaved,
} from "@/components/ui";
import {
  activityInputSchema,
  interests,
  petInputSchema,
  postInputSchema,
  temperaments,
  PlaceRef,
} from "@/domain/schemas";
import { demoPlaces } from "@/data/seed";
import { PlacePicker } from "@/features/maps/places";

function errorMessage(e: unknown) {
  return e instanceof z.ZodError
    ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("；")
    : e instanceof Error
      ? e.message
      : "请检查表单";
}
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
    [error, setError] = useState(""),
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
        description="慢慢介绍它，不确定的信息可以如实填写未知。所有档案均为虚构演示。"
      />
      <form
        ref={form}
        className="card form-card"
        onChange={() => setDirty(true)}
        onSubmit={(e) => {
          e.preventDefault();
          setError("");
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
            setError(errorMessage(e));
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
          <p className="form-hint">
            位置为虚构公共区域参考点，不收集住址；区域文字不会生成精确位置或距离。
          </p>
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
          {error && (
            <p role="alert" className="field-error">
              {error}
            </p>
          )}
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
  const { state, run, writable, notify } = useDemo(),
    router = useRouter();
  const draft = usePhotoDraft(),
    [error, setError] = useState(""),
    { setDirty } = useUnsaved(),
    [text, setText] = useState("");
  const pets = state!.pets.filter(
    (p) => p.ownerId === state!.activeUserId && !p.archivedAt,
  );
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
        className="card form-card"
        onChange={() => setDirty(true)}
        onSubmit={(e) => {
          e.preventDefault();
          setError("");
          const f = new FormData(e.currentTarget);
          try {
            const input = postInputSchema.parse({
              text,
              petIds: f.getAll("pets"),
              images: draft.images,
            });
            if (run({ type: "publish-post", input })) {
              draft.markSaved();
              setDirty(false);
              notify("动态已发布到本地演示社区");
              router.push("/");
            }
          } catch (e) {
            setError(errorMessage(e));
          }
        }}
      >
        <fieldset disabled={!writable || draft.busy}>
          <Field label="今天发生了什么？ *">
            <textarea
              aria-label="动态内容"
              required
              maxLength={1000}
              rows={6}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="分享今天的小开心吧…"
            />
            <small>{text.length}/1000</small>
          </Field>
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
          <AiDraft
            task="post-copy"
            title="AI 整理分享文案"
            disabled={!writable}
            onApply={(data) => {
              setText(data.text);
              setDirty(true);
            }}
          />
          {error && (
            <p role="alert" className="field-error">
              {error}
            </p>
          )}
          <button type="submit" className="button form-submit">
            确认发布动态
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
function ActivityEditor() {
  const params = useSearchParams();
  const recommendedId = params.get("recommendedPetId");
  const [place, setPlace] = useState<PlaceRef>(demoPlaces[0]);
  const { state, run, writable, notify } = useDemo(),
    router = useRouter(),
    [error, setError] = useState(""),
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
        onChange={() => setDirty(true)}
        onSubmit={(e) => {
          e.preventDefault();
          setError("");
          const f = new FormData(e.currentTarget);
          try {
            const input = activityInputSchema.parse({
              title: f.get("title"),
              description: f.get("description"),
              organizerPetId: f.get("pet"),
              recommendedPetIds: recommendedId ? [recommendedId] : [],
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
            setError(errorMessage(e));
          }
        }}
      >
        <fieldset disabled={!writable}>
          {recommendedId && (
            <p className="meeting-note">
              推荐约伴对象：
              {state!.pets.find((p) => p.id === recommendedId && !p.archivedAt)
                ?.name ?? "对象不存在，请重新选择"}
              。仅带入推荐，不代表对方同意，也不会发送邀请。请确认时间与公共地点。
            </p>
          )}
          <Field label="活动名称 *">
            <input
              name="title"
              aria-label="活动名称"
              required
              maxLength={40}
              placeholder="比如：周末江边慢慢走"
            />
          </Field>
          <Field label="带上哪位毛孩子？ *">
            <select name="pet" aria-label="主办宠物" required>
              {pets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="form-grid">
            <Field label="开始时间 *" hint="北京时间 UTC+8">
              <input
                aria-label="开始时间"
                name="startAt"
                type="datetime-local"
                required
              />
            </Field>
            <Field label="结束时间 *" hint="北京时间 UTC+8">
              <input
                aria-label="结束时间"
                name="endAt"
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
              defaultValue={6}
              required
            />
          </Field>
          <Field label="活动说明">
            <textarea
              name="description"
              maxLength={500}
              rows={4}
              placeholder="活动安排、需要带的物品、初次见面的注意事项…"
            />
          </Field>
          <Unavailable>AI 草稿尚未开放 · 不会发送真实邀请</Unavailable>
          {error && (
            <p role="alert" className="field-error">
              {error}
            </p>
          )}
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
