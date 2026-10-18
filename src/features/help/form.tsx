"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AiDraft, fillForm, petSummary } from "@/features/ai/draft";
import { HelpDraft } from "@/lib/ai/contracts";
import { useDemo } from "@/features/demo/provider";
import { Empty, Title, useUnsaved } from "@/components/ui";
import { helpInputSchema, PlaceRef } from "@/domain/schemas";
import { demoPlaces } from "@/data/seed";
import { shanghaiTime } from "@/features/forms/field";
import { PlacePicker } from "@/features/maps/places";
import { FormError, clearAiMarker } from "@/features/forms/feedback";

const localTime = (iso?: string) =>
  iso ? new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 16) : "";
export function HelpForm({
  id,
  initialDraft,
}: {
  id?: string;
  initialDraft?: HelpDraft;
}) {
  const { state } = useDemo();
  if (!state) return null;
  const h = state.helpRequests.find((h) => h.id === id);
  if (
    id &&
    (!h ||
      h.requesterId !== state.activeUserId ||
      h.status !== "open" ||
      state.helpApplications.some(
        (a) => a.helpId === id && ["pending", "accepted"].includes(a.status),
      ))
  )
    return (
      <Empty title="无法编辑这条求助">
        <Link href="/help">返回互助</Link>
      </Empty>
    );
  return (
    <HelpEditor
      key={`${state.activeUserId}-${id ?? "new"}`}
      id={id}
      initialDraft={initialDraft}
    />
  );
}
function HelpEditor({
  id,
  initialDraft,
}: {
  id?: string;
  initialDraft?: HelpDraft;
}) {
  const form = useRef<HTMLFormElement>(null);
  const { state, run, writable } = useDemo(),
    router = useRouter();
  const h = state!.helpRequests.find((h) => h.id === id);
  const [place, setPlace] = useState<PlaceRef>(h?.place ?? demoPlaces[0]);
  const [error, setError] = useState<Error | null>(null);
  const [aiDraft, setAiDraft] = useState<HelpDraft | undefined>(initialDraft);
  const [needsPlace, setNeedsPlace] = useState(!!initialDraft);
  const { setDirty } = useUnsaved();
  const pets = state!.pets.filter(
    (p) => p.ownerId === state!.activeUserId && !p.archivedAt,
  );
  useEffect(() => {
    if (initialDraft)
      fillForm(form.current, {
        title: initialDraft.title,
        details: initialDraft.details,
        pet: initialDraft.petId,
        type: initialDraft.type,
        startAt: localTime(initialDraft.startAt ?? undefined),
        endAt: localTime(initialDraft.endAt ?? undefined),
      });
  }, [initialDraft]);
  return (
    <div className="form-container">
      <Link href="/help" className="back-link">
        ← 返回互助
      </Link>
      <Title
        eyebrow="A SMALL REQUEST"
        title={h ? "编辑求助" : "为毛孩子找一点照应。"}
        description="说说需要怎样的帮助。"
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
          const f = new FormData(e.currentTarget);
          if (needsPlace) {
            setError(new Error("请通过下方地点选择器明确确认公共交接地点"));
            return;
          }
          try {
            const input = helpInputSchema.parse({
              title: f.get("title"),
              details: f.get("details"),
              petId: f.get("pet"),
              type: f.get("type"),
              startAt: shanghaiTime(f.get("startAt")),
              endAt: shanghaiTime(f.get("endAt")),
              place,
            });
            if (
              run({
                type: "save-help",
                helpId: id,
                expectedRevision: h?.revision,
                input,
              })
            ) {
              setDirty(false);
              router.push(id ? `/help/${id}` : "/help");
            }
          } catch (error) {
            setError(
              error instanceof Error
                ? error
                : new Error("请检查标题、需求说明和起止时间"),
            );
          }
        }}
      >
        <fieldset disabled={!writable}>
          <AiDraft
            key={`${state!.activeUserId}-${h?.contentRevision}`}
            task="help-intent"
            title="AI 临时互助需求"
            context={{ pets: pets.slice(0, 3).map(petSummary) }}
            disabled={!writable}
            onApply={(data) => {
              fillForm(form.current, {
                title: data.title,
                details: data.details,
                pet: data.petId,
                type: data.type,
                startAt: localTime(data.startAt ?? undefined),
                endAt: localTime(data.endAt ?? undefined),
              });
              setAiDraft(data);
              setNeedsPlace(true);
              setDirty(true);
            }}
          />
          {aiDraft && (
            <div className="meeting-note">
              <p>
                AI 草稿 · 时间描述：{aiDraft.timeText ?? "未提供"} · 时长：
                {aiDraft.durationMinutes ?? "未知"}分钟 · 地点线索：
                {aiDraft.locationQuery ?? "未提供"}
              </p>
              {aiDraft.clarifications.map((t, i) => (
                <p key={i}>{t}</p>
              ))}
              <p>请补齐并复核下方表单，重新选择公共交接地点。</p>
              <label className="check-line">
                <input type="checkbox" required />
                我已复核 AI 草稿中的宠物、时间与特别要求
              </label>
            </div>
          )}
          <h2 className="form-section-title">求助内容</h2>
          <label className="field">
            <span>求助标题</span>
            <input
              name="title"
              maxLength={40}
              required
              defaultValue={h?.title}
            />
          </label>
          <div className="form-grid">
            <label className="field">
              <span>关联宠物</span>
              <select
                name="pet"
                required
                defaultValue={h?.petId ?? pets[0]?.id}
              >
                <option value="">请选择本人宠物</option>
                {pets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>互助类型</span>
              <select name="type" required defaultValue={h?.type ?? "walk"}>
                <option value="">请选择互助类型</option>
                <option value="walk">临时遛狗</option>
                <option value="feed">简单喂食</option>
              </select>
            </label>
            <h2 className="form-section-title">时间与交接地点</h2>
            <label className="field">
              <span>开始时间（北京时间）</span>
              <input
                name="startAt"
                type="datetime-local"
                required
                defaultValue={localTime(h?.startAt)}
              />
            </label>
            <label className="field">
              <span>结束时间（北京时间）</span>
              <input
                name="endAt"
                type="datetime-local"
                required
                defaultValue={localTime(h?.endAt)}
              />
            </label>
          </div>
          <PlacePicker
            label="公共交接地点"
            value={place}
            onChange={(p) => {
              setPlace(p);
              setNeedsPlace(false);
              setDirty(true);
            }}
          />
          <label className="field">
            <span>需求说明</span>
            <textarea
              name="details"
              aria-label="需求说明"
              rows={5}
              maxLength={1000}
              required
              defaultValue={h?.details}
            />
          </label>
          {error && <FormError error={error} />}
          <button className="button form-submit" disabled={!pets.length}>
            {h ? "确认保存求助" : "确认发布求助"}
          </button>
          {!pets.length && <Link href="/me/pets/new">请先创建宠物档案 →</Link>}
        </fieldset>
      </form>
    </div>
  );
}
