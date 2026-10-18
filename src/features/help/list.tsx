"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { NearbyTabs } from "@/components/nearby-tabs";
import { Empty, PetImage, Title, formatTime } from "@/components/ui";
import { useDemo } from "@/features/demo/provider";
import { helpStatus, useClock } from "./status";

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
        description="临时遛狗、简单喂食，从说清楚需求开始。"
        action={
          <Link className="button" href="/help/new">
            发布求助
          </Link>
        }
      />
      <div className="filter-tags help-tabs">
        <button
          className={tab === "all" ? "selected" : ""}
          aria-pressed={tab === "all"}
          onClick={() => setTab("all")}
        >
          全部需求
        </button>
        <button
          className={tab === "mine" ? "selected" : ""}
          aria-pressed={tab === "mine"}
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
                <span className="small muted">{helpStatus(h, now)}</span>
              </div>
              <h3>{h.title}</h3>
              <p>{formatTime(h.startAt)} · 北京时间</p>
              <p>{h.place.name}</p>
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
