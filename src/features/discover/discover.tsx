"use client";
import { NearbyTabs } from "@/components/nearby-tabs";
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
  const [locationOpen, setLocationOpen] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [message, setMessage] = useState("");
  const [locating, setLocating] = useState(false);
  const locationRequest = useRef(0);
  useEffect(
    () => () => {
      locationRequest.current = -1;
    },
    [],
  );
  const { state } = useDemo();
  if (!state) return null;
  const results = discoverQuery(state, reference, filters);
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
      <NearbyTabs />
      <div className="nearby-page-title">
        <Title
          eyebrow="NICE TO MEET YOU"
          title="附近宠友"
          description="从一次散步开始，认识附近的毛孩子。"
        />
      </div>
      <section className="card reference-panel compact-reference">
        <div className="row-between">
          <div>
            <span className="small muted">参考位置</span>
            <h3 data-testid="reference-label">{referenceLabel}</h3>
          </div>
          <button
            className="text-link"
            aria-expanded={locationOpen}
            aria-controls="reference-controls"
            onClick={() => setLocationOpen(!locationOpen)}
          >
            {locationOpen ? "收起位置" : "调整位置"}
          </button>
        </div>
        <div id="reference-controls" hidden={!locationOpen}>
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
                setMessage("正在获取当前位置…");
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
        </div>
      </section>
      <section className="card discover-filters" aria-label="宠友筛选">
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
          <legend className="filter-range-heading">
            <span>范围 · 大致直线距离</span>
            <button
              type="button"
              className="text-link"
              onClick={() => setFilters({ ...defaultFilters })}
            >
              清除筛选
            </button>
          </legend>
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
          <p className="form-hint">同类条件可多选。</p>
        </details>
        <div className="active-filters" aria-label="已选筛选条件">
          {(["breeds", "sizes", "temperaments", "activities"] as const).flatMap(
            (key) =>
              filters[key].map((value) => (
                <button
                  key={`${key}-${value}`}
                  type="button"
                  aria-label={`移除条件：${sizeLabels[value as keyof typeof sizeLabels] ?? value}`}
                  onClick={() => toggle(key, value)}
                >
                  {sizeLabels[value as keyof typeof sizeLabels] ?? value}
                  <span aria-hidden="true"> ×</span>
                </button>
              )),
          )}
        </div>
      </section>
      <div className="tabs">
        <button
          className={view === "list" ? "selected" : ""}
          aria-pressed={view === "list"}
          onClick={() => setView("list")}
        >
          宠友列表
        </button>
        <button
          className={view === "map" ? "selected" : ""}
          aria-pressed={view === "map"}
          onClick={() => setView("map")}
        >
          宠友地图
        </button>
        <span className="tabs-right" data-testid="result-count">
          {results.length} 位宠友 · 距离优先
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
            }}
          >
            清除筛选
          </button>
        </Empty>
      )}
    </>
  );
}
