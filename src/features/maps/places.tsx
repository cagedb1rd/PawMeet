"use client";
import { useEffect, useRef, useState } from "react";
import { demoPlaces } from "@/data/seed";
import { DEFAULT_REFERENCE } from "@/domain/geo";
import { PlaceRef } from "@/domain/schemas";
import type { MapPoint } from "@/lib/maps/contracts";
import { reversePlace, searchPlaces } from "@/lib/maps/client";
import { navigationUrl } from "@/lib/maps/navigation";
import { MapCanvas } from "./map-canvas";

export function PlaceDetails({ place }: { place: PlaceRef }) {
  const url = navigationUrl(place);
  return (
    <div className="place-details">
      <b>{place.name}</b>
      <p>{place.address || place.district}</p>
      <small>
        {place.source === "demo"
          ? "虚构演示点"
          : place.source === "amap"
            ? "高德普通地点 / 地图选点"
            : "手动填写，未核实"}{" "}
        · 宠物准入未知
      </small>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="navigation-link"
        >
          在高德导航 ↗
        </a>
      ) : (
        <p className="muted">文字地点无坐标，暂不能导航。</p>
      )}
    </div>
  );
}
export function PlaceExplorer({
  center = DEFAULT_REFERENCE,
  onChoose,
}: {
  center?: MapPoint;
  onChoose: (place: PlaceRef) => void;
}) {
  const [keyword, setKeyword] = useState("");
  const [searchRevision, setSearchRevision] = useState(0);
  const [results, setResults] = useState<PlaceRef[]>([]);
  const [selected, setSelected] = useState<PlaceRef | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  useEffect(() => {
    const id = ++sequence.current;
    if (!keyword.trim()) return;
    const timer = setTimeout(() => {
      if (id !== sequence.current) return;
      setBusy(true);
      setMessage("搜索中…");
      setResults([]);
      setSelected(null);
      void searchPlaces(keyword, center)
        .then((places) => {
          if (id !== sequence.current) return;
          setResults(places);
          setMessage(
            places.length
              ? `找到 ${places.length} 个普通地点`
              : "附近没有搜索结果，请换关键词或手动输入。",
          );
        })
        .catch((e) => {
          if (id === sequence.current)
            setMessage(e instanceof Error ? e.message : "地点搜索失败");
        })
        .finally(() => {
          if (id === sequence.current) setBusy(false);
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      ++sequence.current;
    };
  }, [keyword, center, searchRevision]);
  useEffect(
    () => () => {
      sequence.current = -1;
    },
    [],
  );
  const changeKeyword = (value: string) => {
    ++sequence.current;
    setKeyword(value);
    setSearchRevision((n) => n + 1);
    setSelected(null);
    setResults([]);
    setBusy(false);
    setMessage("");
  };
  const selectPoint = async (point: MapPoint) => {
    const id = ++sequence.current;
    setBusy(true);
    setSelected(null);
    setMessage("正在查询所选点的地址…");
    try {
      const place = await reversePlace(point);
      if (id === sequence.current) {
        setSelected(place);
        setResults([place]);
        setMessage("请核对公共地点后确认。");
      }
    } catch {
      if (id === sequence.current) {
        setSelected({
          source: "manual",
          name: "手动地图约定点",
          district: "地图选点",
          location: point,
          petAccess: "unknown",
        });
        setMessage("地址查询失败；可确认此手动坐标点，或改用文字地点。");
      }
    } finally {
      if (id === sequence.current) setBusy(false);
    }
  };
  return (
    <div className="place-explorer">
      <p className="form-hint">
        点击地图空白处选公共地点，或搜索参考位置 5km 内的普通
        POI；准入须自行核实。
      </p>
      <input
        aria-label="搜索附近地点"
        maxLength={60}
        value={keyword}
        placeholder="地点名称或类别"
        onChange={(e) => changeKeyword(e.target.value)}
      />
      <div className="filter-tags">
        {["公园", "宠物医院", "宠物店", "咖啡店"].map((t) => (
          <button key={t} type="button" onClick={() => changeKeyword(t)}>
            {t}
          </button>
        ))}
      </div>
      <MapCanvas
        center={center}
        markers={results
          .filter((p) => p.location)
          .map((p, i) => ({
            id: String(i),
            label: p.name,
            point: p.location!,
          }))}
        selectedId={String(results.indexOf(selected!))}
        onSelect={(id) => setSelected(results[Number(id)])}
        onPoint={selectPoint}
      />
      {message && <p role="status">{message}</p>}
      <div className="poi-results">
        {results.map((p, i) => (
          <button
            key={i}
            type="button"
            className={p === selected ? "selected" : ""}
            onClick={() => setSelected(p)}
          >
            <b>{p.name}</b>
            <small>{p.address || p.district}</small>
          </button>
        ))}
      </div>
      {selected && (
        <>
          <PlaceDetails place={selected} />
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => onChoose(selected)}
          >
            确认使用该地点
          </button>
        </>
      )}
    </div>
  );
}
export function PlacePicker({
  value,
  onChange,
  label,
}: {
  value: PlaceRef;
  onChange: (place: PlaceRef) => void;
  label: string;
}) {
  const [mode, setMode] = useState("demo");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  return (
    <section className="place-picker">
      <h3>{label}</h3>
      <PlaceDetails place={value} />
      <div className="filter-tags">
        {[
          ["demo", "演示公共点"],
          ["map", "地图搜索与选点"],
          ["text", "文字地点"],
        ].map(([key, text]) => (
          <button
            key={key}
            type="button"
            className={mode === key ? "selected" : ""}
            onClick={() => setMode(key)}
          >
            {text}
          </button>
        ))}
      </div>
      {mode === "demo" && (
        <select
          aria-label={label}
          value={
            value.source === "demo"
              ? demoPlaces.findIndex((p) => p.name === value.name)
              : -1
          }
          onChange={(e) => onChange(demoPlaces[Number(e.target.value)])}
        >
          <option value={-1} disabled>
            已选择其他地点
          </option>
          {demoPlaces.map((p, i) => (
            <option value={i} key={p.name}>
              {p.name}
            </option>
          ))}
        </select>
      )}
      {mode === "map" && (
        <PlaceExplorer
          center={value.location ?? DEFAULT_REFERENCE}
          onChoose={(p) => {
            onChange(p);
            setMode("demo");
          }}
        />
      )}
      {mode === "text" && (
        <div className="manual-place">
          <label>
            公共地点名称
            <input
              aria-label="文字地点名称"
              maxLength={60}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            公共地点说明
            <input
              aria-label="文字地点说明"
              maxLength={200}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="如公园南门，请勿填写家庭住址"
            />
          </label>
          <button
            type="button"
            className="button secondary"
            disabled={!name.trim()}
            onClick={() =>
              onChange({
                source: "manual",
                name: name.trim(),
                address: address.trim(),
                district: "手动约定公共点",
                location: null,
                petAccess: "unknown",
              })
            }
          >
            确认文字地点
          </button>
        </div>
      )}
      <p className="form-hint">
        选点只更新本页草稿；提交活动或求助后才保存。不需要提供家庭位置。
      </p>
    </section>
  );
}
