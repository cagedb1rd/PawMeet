"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { FormError, clearAiMarker } from "./feedback";
import { useDemo } from "@/features/demo/provider";
import { Title, useUnsaved } from "@/components/ui";
import { activityInputSchema, PlaceRef, ActivityInput } from "@/domain/schemas";
import { demoPlaces } from "@/data/seed";
import { PlacePicker } from "@/features/maps/places";
import { Field, shanghaiTime } from "./field";

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
