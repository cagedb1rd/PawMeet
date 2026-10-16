"use client";
import Link from "next/link";
import { NearbyTabs } from "@/components/nearby-tabs";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AiDraft, fillForm, petSummary } from "@/features/ai/draft";
import { HelpDraft } from "@/lib/ai/contracts";
import { useRouter } from "next/navigation";
import { useDemo } from "@/features/demo/provider";
import {
  Empty,
  PetImage,
  Title,
  formatTime,
  useUnsaved,
} from "@/components/ui";
import {
  ChecklistInput,
  HelpRequest,
  helpInputSchema,
  checklistInputSchema,
  PlaceRef,
} from "@/domain/schemas";
import { checklistTemplate } from "@/lib/ai/templates";
import { checklistCurrent } from "@/domain/phase2";
import { demoPlaces } from "@/data/seed";
import { shanghaiTime } from "@/features/forms/forms";
import { PlaceDetails, PlacePicker } from "@/features/maps/places";

const statuses = {
  open: "等待帮助",
  assigned: "已确认帮助者",
  helper_done: "等待求助人确认",
  completed: "双方已完成",
  cancelled: "已取消",
};
const appStatuses = {
  pending: "待选择",
  accepted: "已接受",
  rejected: "未被选择 / 已关闭",
  withdrawn: "已撤回",
};
const actions = {
  publish: "发布求助",
  edit: "编辑求助",
  apply: "申请帮助",
  withdraw: "撤回申请",
  assign: "确认帮助者",
  "helper-done": "帮助者标记完成",
  complete: "求助人确认完成",
  cancel: "取消演示求助",
  checklist: "主人确认交接清单",
};
function useClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
function status(h: HelpRequest, now: number) {
  return h.status === "open" && Date.parse(h.startAt) <= now
    ? "已过期 · 不再接受申请"
    : statuses[h.status];
}
export function Help() {
  const params = useSearchParams();
  return (
    <HelpList
      key={params.get("tab") ?? "all"}
      initialTab={params.get("tab") === "mine" ? "mine" : "all"}
    />
  );
}
function HelpList({ initialTab }: { initialTab: string }) {
  const { state } = useDemo();
  const [tab, setTab] = useState(initialTab);
  const now = useClock();
  if (!state) return null;
  const list = state.helpRequests.filter(
    (h) =>
      tab === "all" ||
      h.requesterId === state.activeUserId ||
      state.helpApplications.some(
        (a) => a.helpId === h.id && a.applicantId === state.activeUserId,
      ),
  );
  return (
    <>
      <NearbyTabs help />
      <Title
        eyebrow="A LITTLE HELP, A LOT OF LOVE"
        title="临时互助"
        description="临时遛狗、简单喂食，从说清楚需求开始。仅为虚构演示，不涉及真实寄养或交易。"
        action={
          <Link className="button" href="/help/new">
            发布求助
          </Link>
        }
      />
      <div className="filter-tags help-tabs">
        <button
          className={tab === "all" ? "selected" : ""}
          onClick={() => setTab("all")}
        >
          全部需求
        </button>
        <button
          className={tab === "mine" ? "selected" : ""}
          onClick={() => setTab("mine")}
        >
          我的互助记录
        </button>
      </div>
      <p className="form-hint">
        当前按发布时间浏览本地需求；发布时可在地图选择公共交接点。
      </p>
      <div className="help-grid">
        {list.map((h) => {
          const p = state.pets.find((p) => p.id === h.petId)!;
          return (
            <article className="card help-card" key={h.id}>
              <div className="row-between">
                <span className="pill">
                  {h.type === "walk" ? "临时遛狗" : "简单喂食"}
                </span>
                <span className="small muted">{status(h, now)}</span>
              </div>
              <h3>{h.title}</h3>
              <p>{formatTime(h.startAt)} · 北京时间</p>
              <p>{h.place.name} · 宠物准入未知</p>
              <div className="help-pet">
                <PetImage image={p.photo} alt={p.name} />
                <span>
                  {p.name}
                  <small>
                    {p.breed} · {p.temperamentTags.join(" / ") || "性格待补充"}
                  </small>
                </span>
              </div>
              <Link href={`/help/${h.id}`} className="button secondary">
                查看求助与交接
              </Link>
            </article>
          );
        })}
      </div>
      {!list.length && (
        <Empty title="还没有互助记录">
          <Link href="/help/new">发布第一条求助</Link>
        </Empty>
      )}
    </>
  );
}
export function HelpDetail({ id }: { id: string }) {
  const { state } = useDemo();
  if (!state) return null;
  return state.helpRequests.some((h) => h.id === id) ? (
    <Detail key={`${id}-${state.activeUserId}`} id={id} />
  ) : (
    <Empty title="这条求助不存在">
      <Link href="/help">返回互助</Link>
    </Empty>
  );
}
function Detail({ id }: { id: string }) {
  const { state, run, writable, notify } = useDemo();
  const now = useClock();
  const h = state!.helpRequests.find((h) => h.id === id)!,
    p = state!.pets.find((p) => p.id === h.petId)!;
  const uid = state!.activeUserId,
    mine = h.requesterId === uid,
    apps = state!.helpApplications.filter((a) => a.helpId === id);
  const myActive = apps.find(
    (a) => a.applicantId === uid && ["pending", "accepted"].includes(a.status),
  );
  const canApply =
    !mine &&
    h.status === "open" &&
    Date.parse(h.startAt) > now &&
    !p.archivedAt &&
    !myActive;
  const [message, setMessage] = useState("");
  const { setDirty } = useUnsaved();
  const checklist = state!.careChecklists.find((c) => c.helpId === id),
    current = checklistCurrent(state!, h);
  const name = (id: string | null) =>
    state!.users.find((u) => u.id === id)?.displayName ?? "尚未选择";
  return (
    <>
      <Link href="/help" className="back-link">
        ← 返回互助
      </Link>
      <Title
        eyebrow="A LITTLE TRUST"
        title={h.title}
        description="虚构需求 · 仅保存于当前浏览器 · 不涉及真实服务承诺"
      />
      <div className="help-detail-grid">
        <section className="card form-card">
          <span className="pill" data-testid="help-status">
            {status(h, now)}
          </span>
          <h2>{h.type === "walk" ? "临时遛狗" : "简单喂食"}</h2>
          <p className="pre-wrap">{h.details}</p>
          <p>
            北京时间：{formatTime(h.startAt)} — {formatTime(h.endAt)}
          </p>
          <PlaceDetails place={h.place} />
          <p>
            求助人：{name(h.requesterId)} · 帮助者：{name(h.helperId)}
          </p>
          <Link href={`/pets/${p.id}`} className="help-pet">
            <PetImage image={p.photo} alt={p.name} />
            <span>
              {p.name}
              <small>
                {p.breed} · {p.temperamentTags.join(" / ")}
              </small>
            </span>
          </Link>
          <p className="muted">{p.socialNotes}</p>
          <Link href={`/pets/${p.id}/card`}>查看社交名片 →</Link>
          <div className="button-row">
            {mine &&
              h.status === "open" &&
              Date.parse(h.startAt) > now &&
              !apps.some((a) => ["pending", "accepted"].includes(a.status)) && (
                <Link className="button secondary" href={`/help/${id}/edit`}>
                  编辑求助
                </Link>
              )}
            {mine &&
              ["open", "assigned"].includes(h.status) &&
              Date.parse(h.startAt) > now && (
                <button
                  className="button danger-outline"
                  disabled={!writable}
                  onClick={() => {
                    if (
                      window.confirm(
                        "取消这条演示求助？待选申请将关闭，历史记录保留。",
                      )
                    )
                      run({ type: "cancel-help", helpId: id });
                  }}
                >
                  取消演示求助
                </button>
              )}
            {h.helperId === uid && h.status === "assigned" && (
              <button
                className="button"
                disabled={!writable || !current}
                onClick={() => run({ type: "helper-done", helpId: id })}
              >
                帮助者标记完成
              </button>
            )}
            {mine && h.status === "helper_done" && (
              <button
                className="button"
                disabled={!writable}
                onClick={() => run({ type: "complete-help", helpId: id })}
              >
                求助人确认完成
              </button>
            )}
          </div>
          {mine ? (
            <p className="form-hint">
              不能申请自己的求助；先确认清单，再从申请人中选择帮助者。
            </p>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (run({ type: "apply-help", helpId: id, message })) {
                  setMessage("");
                  setDirty(false);
                  notify("申请已保存，请等待求助人选择");
                }
              }}
            >
              <label className="field">
                <span>申请说明（选填，最多 200 字）</span>
                <textarea
                  aria-label="申请说明"
                  maxLength={200}
                  value={message}
                  disabled={!canApply || !writable}
                  onChange={(e) => {
                    setMessage(e.target.value);
                    setDirty(true);
                  }}
                />
              </label>
              <button className="button" disabled={!canApply || !writable}>
                {myActive
                  ? "已申请，不能重复申请"
                  : canApply
                    ? "申请帮助"
                    : "当前不能申请"}
              </button>
            </form>
          )}
          {myActive?.status === "pending" && (
            <button
              className="button secondary"
              disabled={!writable}
              onClick={() => run({ type: "withdraw-help", helpId: id })}
            >
              撤回申请
            </button>
          )}
        </section>
        <section className="card form-card">
          <h2>{mine ? "申请人列表" : "我的申请状态"}</h2>
          {(mine ? apps : apps.filter((a) => a.applicantId === uid)).map(
            (a) => (
              <div className="application-row" key={a.id}>
                <b>{name(a.applicantId)}</b>
                <span className="pill">{appStatuses[a.status]}</span>
                <p className="pre-wrap">{a.message || "未填写说明"}</p>
                {mine && a.status === "pending" && h.status === "open" && (
                  <button
                    className="button secondary"
                    disabled={
                      !writable || !current || Date.parse(h.startAt) <= now
                    }
                    onClick={() =>
                      run({
                        type: "assign-help",
                        helpId: id,
                        applicationId: a.id,
                      })
                    }
                  >
                    选择{name(a.applicantId)}为帮助者
                  </button>
                )}
              </div>
            ),
          )}
          {!(mine ? apps : apps.filter((a) => a.applicantId === uid))
            .length && <p className="muted">暂无申请记录。</p>}
          {mine && !current && (
            <p className="conflict">
              先在下方复核并确认交接清单，才能选择帮助者。
            </p>
          )}
        </section>
      </div>
      <section className="card form-card">
        <h2>宠物照看交接清单</h2>
        <p className={current ? "form-hint" : "conflict"}>
          {current
            ? "主人已确认当前版本；仍需核对标为待确认的细节。"
            : checklist
              ? "来源档案或需求已变更，请主人重新复核清单。"
              : "尚无已确认清单，请主人填写后确认。"}
        </p>
        {checklist && (
          <ol>
            {checklist.items.map((item, i) => (
              <li className="checklist-item" key={i}>
                <b>{item.title}</b>
                {item.needsConfirmation && (
                  <span className="pill">细节待确认</span>
                )}
                <p className="pre-wrap">{item.detail || "尚未填写"}</p>
              </li>
            ))}
          </ol>
        )}
        {mine && ["open", "assigned"].includes(h.status) && (
          <ChecklistEditor
            facts={[
              p.socialNotes,
              ...p.temperamentTags,
              ...p.activityTags,
              h.type,
              h.details,
            ].join("\n")}
            key={`${uid}-${h.contentRevision}-${p.revision}-${checklist?.revision}`}
            initial={
              checklist ?? {
                items: [
                  {
                    title: "照看方式与物品",
                    detail: "",
                    needsConfirmation: true,
                  },
                  { title: "饮食与习惯", detail: "", needsConfirmation: true },
                  {
                    title: "交接与异常处理",
                    detail: "",
                    needsConfirmation: true,
                  },
                ],
              }
            }
            save={(input) =>
              run({
                type: "save-checklist",
                helpId: id,
                petRevision: p.revision,
                requestRevision: h.contentRevision,
                input,
              })
            }
            writable={writable}
          />
        )}
      </section>
      {(mine || apps.some((a) => a.applicantId === uid)) && (
        <section className="card form-card">
          <h2>互助历史记录</h2>
          <ol className="help-timeline">
            {state!.helpEvents
              .filter((e) => e.helpId === id)
              .map((e) => (
                <li key={e.id}>
                  <b>{actions[e.action]}</b>
                  <p>
                    {name(e.actorId)} · {formatTime(e.createdAt)} ·{" "}
                    {statuses[e.toState]}
                  </p>
                </li>
              ))}
          </ol>
          {!state!.helpEvents.some((e) => e.helpId === id) && (
            <p>种子需求尚无操作记录。</p>
          )}
        </section>
      )}
    </>
  );
}
function ChecklistEditor({
  facts,
  initial,
  save,
  writable,
}: {
  facts: string;
  initial: ChecklistInput;
  save: (input: ChecklistInput) => boolean;
  writable: boolean;
}) {
  const [items, setItems] = useState(initial.items),
    [error, setError] = useState("");
  const { setDirty } = useUnsaved();
  return (
    <form
      onChange={() => setDirty(true)}
      onSubmit={(e) => {
        e.preventDefault();
        const result = checklistInputSchema.safeParse({ items });
        if (!result.success) {
          setError("请填写 1–12 项；标题 1–60 字，详情最多 300 字。");
          return;
        }
        if (save(result.data)) {
          setDirty(false);
          setError("");
        }
      }}
    >
      <fieldset disabled={!writable}>
        <button
          type="button"
          className="button secondary"
          onClick={() => {
            setItems(checklistTemplate(facts).items);
            setDirty(true);
          }}
        >
          按已有资料填入交接模板
        </button>
        <p className="form-hint">
          只填写主人已知内容，不确定项保留“待确认”，不要填写门牌、联系方式或用药剂量。
        </p>
        {items.map((item, i) => (
          <div className="checklist-editor" key={i}>
            <label className="field">
              <span>清单标题 {i + 1}</span>
              <input
                maxLength={60}
                required
                value={item.title}
                onChange={(e) =>
                  setItems(
                    items.map((v, j) =>
                      j === i ? { ...v, title: e.target.value } : v,
                    ),
                  )
                }
              />
            </label>
            <label className="field">
              <span>清单详情 {i + 1}</span>
              <textarea
                aria-label={`清单详情 ${i + 1}`}
                maxLength={300}
                value={item.detail}
                onChange={(e) =>
                  setItems(
                    items.map((v, j) =>
                      j === i ? { ...v, detail: e.target.value } : v,
                    ),
                  )
                }
              />
            </label>
            <label className="check-line">
              <input
                type="checkbox"
                checked={item.needsConfirmation}
                onChange={(e) =>
                  setItems(
                    items.map((v, j) =>
                      j === i
                        ? { ...v, needsConfirmation: e.target.checked }
                        : v,
                    ),
                  )
                }
              />
              细节待确认
            </label>
            <button
              type="button"
              className="button secondary"
              disabled={items.length <= 1}
              onClick={() => {
                setItems(items.filter((_, j) => j !== i));
                setDirty(true);
              }}
            >
              删除第{i + 1}项
            </button>
          </div>
        ))}
        <div className="button-row">
          <button
            type="button"
            className="button secondary"
            disabled={items.length >= 12}
            onClick={() => {
              setItems([
                ...items,
                { title: "", detail: "", needsConfirmation: true },
              ]);
              setDirty(true);
            }}
          >
            添加清单项
          </button>
          <button className="button">主人确认保存清单</button>
        </div>
        {error && <p role="alert">{error}</p>}
      </fieldset>
    </form>
  );
}
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
  const [error, setError] = useState("");
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
        description="只演示临时遛狗与简单喂食。明确时间和公共交接点，不填写真实住址。"
      />
      <form
        ref={form}
        className="card form-card"
        onChange={() => setDirty(true)}
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          if (needsPlace) {
            setError("请通过下方地点选择器明确确认公共交接地点");
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
          } catch {
            setError(
              "请检查标题、需求说明和起止时间；结束时间必须晚于开始时间。",
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
          <p className="form-hint">
            宠物准入未知。发布后请确认照看交接清单；已有有效申请时需取消重建。
          </p>
          {error && (
            <p role="alert" className="field-error">
              {error}
            </p>
          )}
          <button className="button form-submit" disabled={!pets.length}>
            {h ? "确认保存求助" : "确认发布求助"}
          </button>
          {!pets.length && <Link href="/me/pets/new">请先创建宠物档案 →</Link>}
        </fieldset>
      </form>
    </div>
  );
}
