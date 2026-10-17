"use client";
import Link from "next/link";
import { CalendarDays, MapPin, Users, ArrowUpRight, Check } from "lucide-react";
import { useEffect, useState } from "react";
import { useDemo } from "@/features/demo/provider";
import { useSearchParams } from "next/navigation";
import {
  DEFAULT_REFERENCE,
  distanceMeters,
  formatDistance,
} from "@/domain/geo";
import { Activity } from "@/domain/schemas";
import { Dialog, Empty, PetImage, Title, formatTime } from "@/components/ui";
import { PublishLink } from "@/components/shell";
import { Companion } from "@/features/ai/companion";
import { PlaceDetails } from "@/features/maps/places";
function ActivityCard({
  activity: a,
  index,
}: {
  activity: Activity;
  index: number;
}) {
  const { state } = useDemo();
  if (!state) return null;
  const joined = state.activitySignups.filter(
    (s) => s.activityId === a.id && s.status === "joined",
  );
  const me = joined.some((s) => s.userId === state.activeUserId);
  return (
    <Link href={`/activities/${a.id}`} className="activity-card card">
      <div className="activity-photo">
        <PetImage
          image={{ kind: "static", path: `/images/dog-${(index % 6) + 1}.jpg` }}
          alt={a.title}
        />

        <div className="date-badge">
          <b>
            {new Intl.DateTimeFormat("zh-CN", {
              timeZone: "Asia/Shanghai",
              day: "numeric",
            }).format(new Date(a.startAt))}
          </b>
          <small>
            {new Intl.DateTimeFormat("zh-CN", {
              timeZone: "Asia/Shanghai",
              month: "long",
            }).format(new Date(a.startAt))}
          </small>
        </div>
      </div>
      <div className="activity-body">
        <div className="row-between">
          <span className="pill">
            {a.status === "cancelled" ? "已取消" : me ? "已报名" : "线下相遇"}
          </span>
          <ArrowUpRight size={18} />
        </div>
        <h3>{a.title}</h3>
        <p>
          <CalendarDays size={15} />
          {formatTime(a.startAt)}
        </p>
        <p>
          <MapPin size={15} />
          {a.place.name}
        </p>
        <p className="activity-distance">
          {a.place.location
            ? `${formatDistance(distanceMeters(DEFAULT_REFERENCE, a.place.location))} · 大致直线距离`
            : "距离未知 · 文字地点"}
        </p>
        <p className="small muted">
          发起人：{state.users.find((u) => u.id === a.organizerId)?.displayName}
        </p>
        <div className="tags">
          <span>宠友约伴</span>
          <span>{a.place.district}</span>
        </div>
        <div className="activity-bottom">
          <div className="avatar-stack">
            {joined.slice(0, 3).map((s) => (
              <PetImage
                key={s.id}
                image={state.users.find((u) => u.id === s.userId)!.avatar}
                alt="模拟参与者"
              />
            ))}
          </div>
          <span>
            {joined.length}/{a.capacity} 位主人
          </span>
          <b>{me ? "查看报名" : "活动详情"} →</b>
        </div>
      </div>
    </Link>
  );
}
export function Activities() {
  const params = useSearchParams();
  return (
    <ActivityList
      key={params.get("tab") ?? "all"}
      initialTab={params.get("tab") === "mine" ? "mine" : "all"}
    />
  );
}
function ActivityList({ initialTab }: { initialTab: string }) {
  const { state } = useDemo();
  const [tab, setTab] = useState(initialTab);
  if (!state) return null;
  const activities =
    tab === "all"
      ? state.activities
      : state.activities.filter(
          (a) =>
            state.activitySignups.some(
              (s) => s.activityId === a.id && s.userId === state.activeUserId,
            ) || a.organizerId === state.activeUserId,
        );
  return (
    <>
      <Title
        eyebrow="MORE PAWS, MORE JOY"
        title="一起出发"
        description="一段散步、一片草地，和毛孩子一起积攒新回忆。"
        action={<PublishLink href="/activities/new">发起活动</PublishLink>}
      />
      <Companion />
      <div className="tabs">
        <button
          className={tab === "all" ? "selected" : ""}
          onClick={() => setTab("all")}
        >
          全部活动
        </button>
        <button
          className={tab === "mine" ? "selected" : ""}
          onClick={() => setTab("mine")}
        >
          我的活动
        </button>
        <span className="tabs-right">时间均为北京时间</span>
      </div>
      <div className="activity-grid">
        {activities.map((a, i) => (
          <ActivityCard key={a.id} activity={a} index={i} />
        ))}
      </div>
      {!activities.length && (
        <Empty title="还没有报名活动">
          <Link href="/activities" onClick={() => setTab("all")}>
            看看全部活动 →
          </Link>
        </Empty>
      )}
    </>
  );
}
export function ActivityDetail({ id }: { id: string }) {
  const { state, run, writable, notify } = useDemo();
  const [petId, setPetId] = useState(""),
    [confirm, setConfirm] = useState<"leave" | "cancel" | null>(null),
    [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);
  if (!state) return null;
  const a = state.activities.find((a) => a.id === id);
  if (!a)
    return (
      <Empty title="活动不存在">
        <Link href="/activities">返回活动</Link>
      </Empty>
    );
  const joined = state.activitySignups.filter(
      (s) => s.activityId === a.id && s.status === "joined",
    ),
    me = joined.some((s) => s.userId === state.activeUserId),
    own = a.organizerId === state.activeUserId;
  const pets = state.pets.filter(
      (p) => p.ownerId === state.activeUserId && !p.archivedAt,
    ),
    closed = a.status === "cancelled" || Date.parse(a.startAt) <= now;
  const selected = pets.some((p) => p.id === petId) ? petId : pets[0]?.id;
  return (
    <>
      <Link href="/activities" className="back-link">
        ← 返回活动
      </Link>
      <div className="detail-columns">
        <article className="card detail-content">
          <div className="detail-cover">
            <PetImage
              image={state.pets.find((p) => p.id === a.organizerPetId)!.photo}
              alt={a.title}
            />
          </div>
          <div className="detail-padding">
            <span className="pill">
              {a.status === "cancelled"
                ? "已取消"
                : closed
                  ? "已开始 / 已结束"
                  : "报名开放中"}
            </span>
            <h1>{a.title}</h1>
            <div className="detail-facts">
              <p>
                <CalendarDays />
                {formatTime(a.startAt)} — {formatTime(a.endAt)}
                <small>北京时间 Asia/Shanghai</small>
              </p>
              <p>
                <MapPin />
                {a.place.name}
              </p>
            </div>
            <PlaceDetails place={a.place} />
            <h3>这次一起做什么</h3>
            <p className="pre-wrap">
              {a.description || "一起轻松散步，由主人确认各自宠物的互动方式。"}
            </p>
            <h3>
              已经加入的小伙伴{" "}
              <span className="muted">
                {joined.length}/{a.capacity}
              </span>
            </h3>
            <div className="participants">
              {joined.map((s) => {
                const p = state.pets.find((p) => p.id === s.petId)!;
                return (
                  <Link href={`/pets/${p.id}`} key={s.id}>
                    <PetImage image={p.photo} alt={p.name} />
                    <b>{p.name}</b>
                    <small>
                      {state.users.find((u) => u.id === s.userId)!.displayName}{" "}
                      · 模拟身份
                    </small>
                    {s.userId === a.organizerId && (
                      <span className="pill">组织者</span>
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        </article>
        <aside className="card signup-panel">
          <span className="eyebrow">A LITTLE ADVENTURE</span>
          <h2>{me ? "这场快乐，有你一份" : "给日常加一点新鲜"}</h2>
          <p>
            <Users size={17} /> {joined.length} / {a.capacity} 位主人已报名
          </p>
          <p className="muted">
            每个模拟身份携带一只自己的宠物。组织者占用一个名额。
          </p>
          {!me && !closed && (
            <label>
              带哪位毛孩子？
              <select
                aria-label="报名宠物"
                value={selected ?? ""}
                onChange={(e) => setPetId(e.target.value)}
              >
                {pets.map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {closed ? (
            <div className="unavailable">
              {a.status === "cancelled"
                ? "活动已取消，保留历史报名"
                : "活动已开始，报名操作已关闭"}
            </div>
          ) : own ? (
            <>
              <span className="joined-state">
                <Check size={17} />
                你是本次组织者，已自动报名
              </span>
              <button
                className="button danger-outline"
                disabled={!writable}
                onClick={() => setConfirm("cancel")}
              >
                取消活动
              </button>
            </>
          ) : me ? (
            <>
              <span className="joined-state">
                <Check size={17} />
                已报名，刷新后仍保留
              </span>
              <button
                className="button secondary"
                disabled={!writable}
                onClick={() => setConfirm("leave")}
              >
                取消报名
              </button>
            </>
          ) : (
            <button
              className="button"
              disabled={!writable || !selected || joined.length >= a.capacity}
              onClick={() => {
                if (
                  run({
                    type: "join-activity",
                    activityId: a.id,
                    petId: selected,
                  })
                )
                  notify("报名成功，已保存到当前浏览器");
              }}
            >
              {joined.length >= a.capacity
                ? "名额已满"
                : !selected
                  ? "请先创建宠物档案"
                  : "确认报名"}
            </button>
          )}
        </aside>
      </div>
      {confirm && (
        <Dialog
          title={confirm === "leave" ? "取消这次报名？" : "取消这场活动？"}
          close={() => setConfirm(null)}
        >
          <p>
            {confirm === "leave"
              ? "取消后将释放名额，活动开始前仍可重新报名。"
              : "活动将停止接受报名，历史参与者记录会保留。"}
          </p>
          <div className="button-row">
            <button
              className="button secondary"
              onClick={() => setConfirm(null)}
            >
              再想想
            </button>
            <button
              className="button danger"
              onClick={() => {
                if (
                  run({
                    type:
                      confirm === "leave"
                        ? "leave-activity"
                        : "cancel-activity",
                    activityId: a.id,
                  })
                ) {
                  setConfirm(null);
                  notify("已取消并保存");
                }
              }}
            >
              确认取消
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
