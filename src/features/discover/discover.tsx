"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useDemo } from "@/features/demo/provider";
import { PetCard, Title, Empty } from "@/components/ui";
import {
  defaultFilters,
  DiscoverFilters,
  discoverQuery,
} from "@/domain/discover";
import { DEFAULT_REFERENCE, formatDistance } from "@/domain/geo";
import { interests, sizeLabels, temperaments } from "@/domain/schemas";
import type { MapPoint } from "@/lib/maps/contracts";
import { currentPosition, normalizeGps } from "@/lib/maps/client";
import { MapCanvas } from "@/features/maps/map-canvas";
import { PlaceExplorer } from "@/features/maps/places";
import { AiSearch } from "@/features/ai/search";
import { MatchIntent } from "@/lib/ai/contracts";
import { matchQuery } from "@/domain/matching";
export function Discover() {
  const params = useSearchParams();
  const [filters, setFilters] = useState<DiscoverFilters>({
    ...defaultFilters,
    search: (params.get("q") ?? "").slice(0, 100),
  });
  const [reference, setReference] = useState<MapPoint>(DEFAULT_REFERENCE);
  const [referenceLabel, setReferenceLabel] =
    useState("杭州滨江 · 沿江公共参考点（演示）");
  const [view, setView] = useState("list");
  const [picking, setPicking] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [message, setMessage] = useState("");
  const [locating, setLocating] = useState(false);
  const [aiFilter, setAiFilter] = useState<{
    intent: MatchIntent;
    ownId: string;
    actor: string;
  } | null>(null);
  const locationRequest = useRef(0);
  useEffect(
    () => () => {
      locationRequest.current = -1;
    },
    [],
  );
  const { state } = useDemo();
  if (!state) return null;
  const activeAi = aiFilter?.actor === state.activeUserId ? aiFilter : null;
  const results = activeAi
    ? matchQuery(state, reference, activeAi.intent, activeAi.ownId)
    : discoverQuery(state, reference, filters);
  const selected = results.find((r) => r.pet.id === selectedId);
  function toggle<K extends "breeds" | "sizes" | "temperaments" | "activities">(
    key: K,
    value: DiscoverFilters[K][number],
  ) {
    setFilters((f) => ({
      ...f,
      [key]: f[key].includes(value as never)
        ? f[key].filter((v) => v !== value)
        : [...f[key], value],
    }));
  }
  const filterGroup = <
    K extends "breeds" | "sizes" | "temperaments" | "activities",
  >(
    key: K,
    title: string,
    values: readonly DiscoverFilters[K][number][],
    labels?: Record<string, string>,
  ) => (
    <fieldset className="discover-filter">
      <legend>{title}</legend>
      <div className="filter-tags">
        {values.map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={filters[key].includes(v as never)}
            className={filters[key].includes(v as never) ? "selected" : ""}
            onClick={() => toggle(key, v)}
          >
            {labels?.[v] ?? v}
          </button>
        ))}
      </div>
    </fieldset>
  );
  return (
    <>
      <Title
        eyebrow="NICE TO MEET YOU"
        title="总有一个朋友，和它同频。"
        description="从认识开始，让每次散步多一点期待。这里的宠友均为虚构档案。"
      />
      <Link href="/assistant" className="button secondary">
        AI 助手 · 查宠友、活动与互助草稿
      </Link>
      <AiSearch
        key={state.activeUserId}
        onApply={(intent, ownId) => {
          setAiFilter({ intent, ownId, actor: state.activeUserId });
          setSelectedId("");
        }}
      />
      {activeAi && (
        <section className="card form-card">
          <p>
            AI 条件已应用 · {activeAi.intent.radiusKm ?? 5} 公里 ·{" "}
            {activeAi.intent.sort === "match" ? "偏好匹配优先" : "距离优先"} ·
            以下列表与地图共用查询。偏好分由程序计算，不是安全概率。
          </p>
          <p>
            {[
              activeAi.intent.district,
              ...activeAi.intent.breeds,
              ...activeAi.intent.sizes,
              ...activeAi.intent.temperaments,
              ...activeAi.intent.activities,
              ...activeAi.intent.excludedSizes.map((s) => `排除${s}`),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <button type="button" onClick={() => setAiFilter(null)}>
            退出 AI 筛选
          </button>
        </section>
      )}
      <section className="card reference-panel">
        <span className="eyebrow">从一处公共地点，认识附近的它</span>
        <h3 data-testid="reference-label">{referenceLabel}</h3>
        <p>坐标仅代表虚构区域。参考位置只保留于当前页面，不保存为宠物位置。</p>
        <div className="button-row">
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              ++locationRequest.current;
              setLocating(false);
              setPicking(!picking);
            }}
          >
            手动选择参考位置
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={locating}
            onClick={async () => {
              const id = ++locationRequest.current;
              setLocating(true);
              setMessage(
                "请求浏览器定位；仅作本页参考。定位坐标将交由高德转换。",
              );
              try {
                const position = await currentPosition();
                if (id !== locationRequest.current) return;
                const point = await normalizeGps({
                  lng: position.coords.longitude,
                  lat: position.coords.latitude,
                  crs: "WGS84",
                });
                if (id === locationRequest.current) {
                  setReference(point);
                  setSelectedId("");
                  setReferenceLabel("浏览器定位参考点（本页临时使用）");
                  setMessage("参考位置已更新，距离已重新计算。");
                }
              } catch (e) {
                if (id === locationRequest.current)
                  setMessage(
                    e instanceof Error
                      ? e.message
                      : "定位失败，参考点保持不变。",
                  );
              } finally {
                if (id === locationRequest.current) setLocating(false);
              }
            }}
          >
            {locating ? "定位处理中…" : "使用当前位置"}
          </button>
          <button
            type="button"
            onClick={() => {
              ++locationRequest.current;
              setLocating(false);
              setReference(DEFAULT_REFERENCE);
              setSelectedId("");
              setReferenceLabel("杭州滨江 · 沿江公共参考点（演示）");
              setMessage("");
            }}
          >
            恢复滨江默认位置
          </button>
        </div>
        {message && <p role="status">{message}</p>}
        {picking && (
          <PlaceExplorer
            center={reference}
            onChoose={(p) => {
              if (p.location) {
                ++locationRequest.current;
                setReference(p.location);
                setSelectedId("");
                setReferenceLabel(p.name);
                setPicking(false);
                setMessage("已切换参考位置，按大致直线距离重新筛选。");
              }
            }}
          />
        )}
      </section>
      <section
        className="card discover-filters"
        aria-label="宠友筛选"
        onClick={() => {
          if (activeAi) setAiFilter(null);
        }}
      >
        <input
          aria-label="按名称品种或区域搜索"
          maxLength={100}
          placeholder="搜名字、品种或区域"
          value={filters.search}
          onChange={(e) =>
            setFilters((f) => ({ ...f, search: e.target.value }))
          }
        />
        <fieldset className="discover-filter">
          <legend>范围 · 大致直线距离</legend>
          <div className="filter-tags">
            {([1, 3, 5, 10] as const).map((km) => (
              <button
                key={km}
                type="button"
                aria-pressed={filters.radiusKm === km}
                className={filters.radiusKm === km ? "selected" : ""}
                onClick={() => setFilters((f) => ({ ...f, radiusKm: km }))}
              >
                {km} 公里
              </button>
            ))}
          </div>
        </fieldset>
        <details>
          <summary>品种、体型和偏好筛选</summary>
          {filterGroup(
            "breeds",
            "品种",
            [...new Set(state.pets.map((p) => p.breed))].slice(0, 8),
          )}
          {filterGroup(
            "sizes",
            "体型",
            ["small", "medium", "large", "unknown"],
            sizeLabels,
          )}
          {filterGroup("temperaments", "性格标签", temperaments)}
          {filterGroup("activities", "活动偏好", interests)}
          <p className="form-hint">
            同一类多选满足任一，类别之间同时满足。自由文字仅搜索，不推断性格。
          </p>
        </details>
        <button type="button" onClick={() => setFilters({ ...defaultFilters })}>
          清除筛选
        </button>
      </section>
      <div className="tabs">
        <button
          className={view === "list" ? "selected" : ""}
          onClick={() => setView("list")}
        >
          宠友列表
        </button>
        <button
          className={view === "map" ? "selected" : ""}
          onClick={() => setView("map")}
        >
          宠友地图
        </button>
        <span className="tabs-right" data-testid="result-count">
          {results.length} 位宠友 ·{" "}
          {activeAi?.intent.sort === "match" ? "偏好匹配优先" : "距离优先"}
        </span>
      </div>
      {view === "map" && (
        <>
          <MapCanvas
            center={reference}
            radiusM={filters.radiusKm * 1000}
            markers={results.map((r) => ({
              id: r.pet.id,
              label: r.pet.name,
              point: r.pet.demoLocation,
            }))}
            selectedId={selected?.pet.id}
            onSelect={setSelectedId}
            onPoint={(p) => {
              ++locationRequest.current;
              setLocating(false);
              setReference(p);
              setSelectedId("");
              setReferenceLabel("地图手选公共参考点");
              setMessage("参考位置已更新；不保存精确位置。");
            }}
          />
          {selected && (
            <div className="card selected-pet">
              <b>
                {selected.pet.name} · {formatDistance(selected.distanceM)}
              </b>
              <Link href={`/pets/${selected.pet.id}/card`}>查看社交名片 →</Link>
              <Link
                href={`/activities/new?recommendedPetId=${selected.pet.id}`}
              >
                和它约伴 →
              </Link>
            </div>
          )}
        </>
      )}
      <div className="pet-grid" data-testid="discover-results">
        {results.map((row) => {
          const { pet, distanceM } = row;
          return (
            <div key={pet.id}>
              <PetCard
                key={pet.id}
                pet={pet}
                distance={formatDistance(distanceM)}
                selected={selected?.pet.id === pet.id}
                onSelect={() => {
                  setSelectedId(pet.id);
                  setView("map");
                }}
              />
              {"score" in row && (
                <p className="card form-hint">
                  偏好匹配分：{String(row.score)} / 100 ·{" "}
                  {"reasons" in row ? (row.reasons as string[]).join("；") : ""}
                  。不是安全保证。
                </p>
              )}
            </div>
          );
        })}
      </div>
      {!results.length && (
        <Empty title="没有找到这样的宠友">
          <button
            className="button secondary"
            onClick={() => {
              setFilters({ ...defaultFilters });
              setAiFilter(null);
            }}
          >
            清除筛选
          </button>
        </Empty>
      )}
    </>
  );
}
