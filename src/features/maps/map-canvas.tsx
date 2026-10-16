"use client";
import { useEffect, useRef, useState } from "react";
import { loadAMap, pointFromLngLat } from "@/lib/maps/client";
import type {
  MapEvent,
  MapInstance,
  MapPoint,
  Overlay,
} from "@/lib/maps/contracts";

export interface MapMarker {
  id: string;
  label: string;
  point: MapPoint;
}
export function MapCanvas({
  center,
  markers,
  radiusM,
  selectedId,
  onSelect,
  onPoint,
}: {
  center: MapPoint;
  markers: MapMarker[];
  radiusM?: number;
  selectedId?: string;
  onSelect: (id: string) => void;
  onPoint?: (point: MapPoint) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<MapInstance | null>(null);
  const [status, setStatus] = useState("地图加载中…");
  const [retry, setRetry] = useState(0);
  const initialCenter = useRef(center);
  const destroyed = useRef(new WeakSet<MapInstance>());
  useEffect(() => {
    const retired = destroyed.current;
    let active = true,
      instance: MapInstance | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void loadAMap()
      .then((sdk) => {
        if (!active || !element.current) return;
        const c = initialCenter.current;
        instance = new sdk.Map(element.current, {
          center: [c.lng, c.lat],
          zoom: 13,
          viewMode: "2D",
          resizeEnable: true,
        });
        const current = instance;
        current.on("complete", () => {
          if (active) {
            clearTimeout(timer);
            setStatus("");
          }
        });
        current.on("error", () => {
          if (active) {
            clearTimeout(timer);
            setStatus("地图加载异常，请检查 Key、配额或网络，可继续使用列表。");
          }
        });
        timer = setTimeout(() => {
          if (active)
            setStatus("地图未能完成加载，请重试；列表与文字地点仍可使用。");
        }, 15000);
        setMap(current);
      })
      .catch((e) => {
        if (active) setStatus(e instanceof Error ? e.message : "地图加载失败");
      });
    return () => {
      active = false;
      clearTimeout(timer);
      if (instance) {
        retired.add(instance);
        instance.destroy();
      }
    };
  }, [retry]);
  useEffect(() => {
    if (!map || !window.AMap) return;
    const focus =
      markers.find((marker) => marker.id === selectedId)?.point ?? center;
    map.setCenter([focus.lng, focus.lat]);
    const overlays: Overlay[] = markers.map((marker) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `map-marker ${selectedId === marker.id ? "selected" : ""}`;
      button.textContent = marker.label;
      button.setAttribute("aria-label", `查看${marker.label}`);
      // DOM textContent keeps user and POI names out of HTML interpolation.
      button.addEventListener("click", (e) => {
        e.stopPropagation();
        onSelect(marker.id);
      });
      return new window.AMap!.Marker({
        position: [marker.point.lng, marker.point.lat],
        content: button,
        anchor: "bottom-center",
        bubble: false,
      });
    });
    overlays.push(
      new window.AMap.Marker({
        position: [center.lng, center.lat],
        title: "当前参考位置",
        label: { content: "参考位置" },
      }),
    );
    if (radiusM)
      overlays.push(
        new window.AMap.Circle({
          center: [center.lng, center.lat],
          radius: radiusM,
          strokeColor: "#40816a",
          fillColor: "#6ca88d",
          fillOpacity: 0.07,
        }),
      );
    map.add(overlays);
    const retired = destroyed.current;
    return () => {
      if (!retired.has(map)) map.remove(overlays);
    };
  }, [map, center, markers, radiusM, selectedId, onSelect]);
  useEffect(() => {
    if (!map || !onPoint) return;
    const click = (event: MapEvent) => onPoint(pointFromLngLat(event.lnglat));
    map.on("click", click);
    const retired = destroyed.current;
    return () => {
      if (!retired.has(map)) map.off("click", click);
    };
  }, [map, onPoint]);
  return (
    <div className="map-frame">
      <div ref={element} className="map-canvas" aria-label="高德交互地图" />
      {status && (
        <div className="map-status" role="status">
          <p>{status}</p>
          {status !== "地图加载中…" && (
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                setMap(null);
                setStatus("地图加载中…");
                setRetry((n) => n + 1);
              }}
            >
              重新加载地图
            </button>
          )}
        </div>
      )}
      <p className="map-legend">
        虚构宠友 · 公共演示区域 · 普通地点宠物准入未知
      </p>
    </div>
  );
}
