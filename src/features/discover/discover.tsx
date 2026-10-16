"use client";
import { useState } from "react";
import { Compass, Search, SlidersHorizontal } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useDemo } from "@/features/demo/provider";
import { PetCard, Title, Unavailable, Empty } from "@/components/ui";
export function Discover() {
  const params = useSearchParams();
  const [search, setSearch] = useState(params.get("q") ?? ""),
    [tag, setTag] = useState("全部");
  const { state } = useDemo();
  if (!state) return null;
  const pets = state.pets.filter(
    (p) =>
      !p.archivedAt &&
      p.ownerId !== state.activeUserId &&
      `${p.name} ${p.breed} ${p.district}`.includes(search.trim()) &&
      (tag === "全部" || p.temperamentTags.some((t) => t === tag)),
  );
  return (
    <>
      <Title
        eyebrow="NICE TO MEET YOU"
        title="总有一个朋友，和它同频。"
        description="从认识开始，让每次散步多一点期待。这里的宠友均为虚构档案。"
      />
      <div className="discover-intro card">
        <Compass size={27} />
        <div>
          <h3>以好奇心，打开毛孩子的世界</h3>
          <p>
            当前展示本地宠友，不代表真实附近的人。地图、距离和偏好匹配将在 Phase
            3 开放。
          </p>
        </div>
      </div>
      <div className="filter-bar">
        <label className="search-field">
          <Search size={18} />
          <input
            aria-label="按名称品种或区域搜索"
            placeholder="搜名字、品种或区域"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className="filter-tags">
          {["全部", "温和", "慢热", "活泼"].map((t) => (
            <button
              key={t}
              className={t === tag ? "selected" : ""}
              onClick={() => setTag(t)}
            >
              {t}
            </button>
          ))}
        </div>
        <span className="muted filter-count">
          <SlidersHorizontal size={16} />
          {pets.length} 位宠友
        </span>
      </div>
      <Unavailable>地图与距离筛选尚未开放 · 当前为本地档案浏览</Unavailable>
      <div className="pet-grid">
        {pets.map((p) => (
          <PetCard key={p.id} pet={p} />
        ))}
      </div>
      {!pets.length && (
        <Empty title="没有找到这样的宠友">
          <button
            className="button secondary"
            onClick={() => {
              setSearch("");
              setTag("全部");
            }}
          >
            清除筛选
          </button>
        </Empty>
      )}
    </>
  );
}
