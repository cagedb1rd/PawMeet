"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { AiDraft, fillForm } from "@/features/ai/draft";
import { PhotoRecognize } from "@/features/ai/photo";
import { FormError, clearAiMarker } from "./feedback";
import { useDemo } from "@/features/demo/provider";
import {
  Empty,
  PhotoPicker,
  Title,
  usePhotoDraft,
  useUnsaved,
} from "@/components/ui";
import { interests, petInputSchema, temperaments } from "@/domain/schemas";
import { demoPlaces } from "@/data/seed";
import { Field } from "./field";

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
