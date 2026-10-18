"use client";
import Link from "next/link";
import { PetCard, formatTime } from "@/components/ui";
import { formatDistance } from "@/domain/geo";
import { Pet, PlaceRef } from "@/domain/schemas";
import { ToolResult } from "@/lib/ai/contracts";
import { PlaceDetails } from "@/features/maps/places";

const titles: Record<string, string> = {
  search_activities: "推荐活动",
  search_pets: "推荐宠友",
  search_places: "候选地点",
  check_compatibility: "互动建议",
  create_activity_draft: "活动草稿",
};

/** Read-only card for one tool result in the companion workflow. */
export function CompanionResult({
  name,
  result,
  pets,
  queriedPlaces,
}: {
  name: string;
  result: ToolResult;
  pets: Pet[];
  queriedPlaces: PlaceRef[];
}) {
  return (
    <div
      className="card form-card companion-result"
      data-testid="companion-result"
      data-tool={name}
    >
      <h3>{titles[name]}</h3>
      {result.kind === "error" ? (
        <p role="alert">查询失败：{result.message}</p>
      ) : result.kind === "activities" ? (
        <>
          {!result.rows.length && <p>暂时没有合适的活动，试试自己组局。</p>}
          {result.rows.map((r) => (
            <article className="companion-activity" key={r.id}>
              <Link href={`/activities/${r.id}`}>{r.title} · 查看详情</Link>
              <p>
                {formatTime(r.startAt)} ·{" "}
                {r.distanceM === null
                  ? "距离未知"
                  : formatDistance(r.distanceM)}{" "}
                · 剩余{r.remaining}位
              </p>
              <p>{r.reasons?.join("；")}</p>
              {!!r.differences?.length && (
                <p className="result-difference">
                  待确认：{r.differences.join("；")}
                </p>
              )}
            </article>
          ))}
        </>
      ) : result.kind === "pets" ? (
        <>
          {!result.rows.length && (
            <p>暂时没有匹配宠友，可以调整范围或先发起活动。</p>
          )}
          {result.rows.map((r) => {
            const p = pets.find((p) => p.id === r.id && !p.archivedAt);
            return p ? (
              <div key={r.id}>
                <PetCard pet={p} distance={formatDistance(r.distanceM)} />
                <p>{r.reasons.join("；")}</p>
              </div>
            ) : null;
          })}
        </>
      ) : result.kind === "places" ? (
        <>
          {!result.rows.length && <p>没找到合适地点，换个关键词或手动选点。</p>}
          {result.rows.map((r) => (
            <div key={r.index}>
              <p>
                {r.name} · {formatDistance(r.distanceM)} ·{" "}
                {r.source === "demo" ? "演示地点" : "高德地图"}
              </p>
              {queriedPlaces[r.index] && (
                <PlaceDetails place={queriedPlaces[r.index]} />
              )}
            </div>
          ))}
        </>
      ) : result.kind === "compatibility" ? (
        result.rows.map((r) => (
          <div key={r.id}>
            <p>{r.conflicts.join("；") || "未发现明显的偏好冲突"}</p>
            <p>{r.advice.join("；")}</p>
            {r.incomplete && <p>名片信息待补充</p>}
          </div>
        ))
      ) : result.kind === "activity-draft" ? (
        <p>活动草稿已生成。</p>
      ) : null}
    </div>
  );
}
