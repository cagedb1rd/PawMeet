"use client";
import Link from "next/link";
import {
  HeartHandshake,
  Clock,
  MapPin,
  Footprints,
  Utensils,
} from "lucide-react";
import { useDemo } from "@/features/demo/provider";
import { PetImage, Title, Unavailable, formatTime } from "@/components/ui";
export function Help() {
  const { state } = useDemo();
  if (!state) return null;
  return (
    <>
      <Title
        eyebrow="A LITTLE HELP, A LOT OF LOVE"
        title="邻里之间，多一点照应。"
        description="偶尔的分身乏术，也可以被温柔接住。"
      />
      <div className="help-banner">
        <HeartHandshake size={42} />
        <div>
          <span className="eyebrow">COMING IN PHASE 02</span>
          <h2>让小小的善意，遇见需要它的人。</h2>
          <p>临时遛狗、喂食、双方确认与交接清单正在计划中。</p>
        </div>
        <span className="pill">尚未开放</span>
      </div>
      <Unavailable>
        以下为 8 条虚构需求预览 · 发布、申请和交接流程尚未开放
      </Unavailable>
      <div className="help-grid">
        {state.helpRequests.map((h) => {
          const p = state.pets.find((p) => p.id === h.petId)!;
          return (
            <article className="card help-card" key={h.id}>
              <div className="row-between">
                <span className="pill">
                  {h.type === "walk" ? (
                    <Footprints size={14} />
                  ) : (
                    <Utensils size={14} />
                  )}
                  {h.type === "walk" ? "临时遛狗" : "上门喂食"}
                </span>
                <span className="muted small">虚构需求预览</span>
              </div>
              <h3>{h.title}</h3>
              <p>
                <Clock size={14} />
                {formatTime(h.startAt)}
              </p>
              <p>
                <MapPin size={14} />
                {h.place.district} · 公共演示点
              </p>
              <div className="help-pet">
                <PetImage image={p.photo} alt={p.name} />
                <span>
                  {p.name}
                  <small>{p.breed}</small>
                </span>
                <Link href={`/pets/${p.id}`}>看看毛孩子 ↗</Link>
              </div>
              <button disabled className="button secondary">
                申请互助 · Phase 2 开放
              </button>
            </article>
          );
        })}
      </div>
    </>
  );
}
