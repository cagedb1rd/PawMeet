"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useDemo } from "@/features/demo/provider";
import { aiAssistant, aiTask } from "@/lib/ai/client";
import {
  AssistantRequest,
  CompanionIntent,
  ToolResult,
} from "@/lib/ai/contracts";
import {
  CompanionCache,
  WorkflowPhase,
  WORKFLOW_LIMITS,
  queryIntent,
  radiusEdit,
  executeCompanionTool,
  activityInputFromDraft,
} from "@/lib/ai/companion";
import {
  DEFAULT_REFERENCE,
  distanceMeters,
  formatDistance,
} from "@/domain/geo";
import { PetCard, formatTime } from "@/components/ui";
import { resolveAvailability } from "@/lib/ai/availability";
import { ActivityInput, PlaceRef, sizeLabels } from "@/domain/schemas";
import { PlacePicker, PlaceDetails } from "@/features/maps/places";
import { demoPlaces } from "@/data/seed";
import { ActivityEditor } from "@/features/forms/forms";
import { petSummary } from "./draft";
export function Companion() {
  const { state } = useDemo();
  return state ? (
    <CompanionFlow key={`${state.activeUserId}-${state.revision}`} />
  ) : null;
}
function CompanionFlow() {
  const { state } = useDemo();
  const pets = state!.pets.filter(
    (p) => p.ownerId === state!.activeUserId && !p.archivedAt,
  );
  const [ownId, setOwn] = useState(pets[0]?.id ?? "");
  const [reference, setReference] = useState<PlaceRef>(demoPlaces[0]);
  const [text, setText] = useState("");
  const [intent, setIntent] = useState<CompanionIntent>();
  const [phase, setPhase] = useState<WorkflowPhase>("idle");
  const [error, setError] = useState("");
  const [day, setDay] = useState("");
  const [periods, setPeriods] = useState<string[]>([]);
  const [timeEdited, setTimeEdited] = useState(false);
  const [timeLabel, setTimeLabel] = useState("");
  const [results, setResults] = useState<
    { name: string; result: ToolResult }[]
  >([]);
  const [queriedPlaces, setQueriedPlaces] = useState<PlaceRef[]>([]);
  const [draft, setDraft] = useState<Partial<ActivityInput>>();
  const [stage, setStage] = useState<"search" | "organize">("search");
  const cache = useRef<CompanionCache>({});
  const controller = useRef<AbortController | null>(null);
  const busy = ["extracting", "searching", "organizing"].includes(phase);
  useEffect(() => () => controller.current?.abort(), []);
  function reset() {
    controller.current?.abort();
    cache.current = {};
    setQueriedPlaces([]);
    setResults([]);
    setDraft(undefined);
    setError("");
    setIntent(undefined);
    setPhase("idle");
  }
  async function query(
    i: CompanionIntent,
    next: "search" | "organize",
    reusePlaces = false,
  ) {
    const abort = new AbortController();
    controller.current?.abort();
    controller.current = abort;
    const localCache: CompanionCache = reusePlaces
      ? { places: cache.current.places }
      : {};
    cache.current = localCache;
    setQueriedPlaces([]);
    setResults([]);
    setDraft(undefined);
    setError("");
    setStage(next);
    try {
      queryIntent(i);
      const availability = resolveAvailability(i);
      setTimeLabel(availability.label);
      if (!reference.location)
        throw Error("参考地点缺少坐标，请重新选择公共参考点");
      setPhase(next === "search" ? "searching" : "organizing");
      let req: AssistantRequest = {
        text:
          next === "search"
            ? "按用户的大概时间和偏好优先查询已有活动，不要求精确分钟。"
            : "用户已选择自己组局，按已确认条件查询必要宠友与地点并生成活动草稿。",
        pets: pets.filter((p) => p.id === ownId).map(petSummary),
        workflow: { stage: next, intent: i, availability },
      };
      let calls = 0,
        queried = false;
      const failures = new Set<string>();
      for (let round = 0; round < WORKFLOW_LIMITS.rounds; round++) {
        const { data: step } = await aiAssistant(req, abort.signal);
        if (abort.signal.aborted) return;
        if (!step.toolCalls.length) {
          if (failures.size)
            throw Error("工具执行失败尚未解决，请查看错误后重试或手动操作");
          if (!queried) throw Error("模型未执行必要查询，请重试或使用手动操作");
          if (next === "organize" && !localCache.draft)
            throw Error("尚未形成有效活动草稿，请检查工具提示，或手动创建");
          if (localCache.draft) {
            setDraft(activityInputFromDraft(localCache, i, ownId));
            setPhase("draft");
          } else setPhase("recommendations");
          return;
        }
        calls += step.toolCalls.length;
        if (calls > WORKFLOW_LIMITS.calls)
          throw Error("已达9次工具调用上限，请手动操作或重新开始");
        const returned = await Promise.all(
          step.toolCalls.map(async (call) => ({
            callId: call.id,
            name: call.function.name,
            result: await executeCompanionTool(
              call,
              state!,
              reference.location ?? DEFAULT_REFERENCE,
              ownId,
              i,
              next,
              localCache,
            ),
          })),
        );
        if (abort.signal.aborted) return;
        setQueriedPlaces([...(localCache.places ?? [])]);
        returned.forEach((r) => {
          if (r.result.kind === "error") failures.add(r.name);
          else failures.delete(r.name);
        });
        queried ||= returned.some(
          (r) =>
            r.result.kind === "activities" ||
            r.result.kind === "pets" ||
            r.result.kind === "places",
        );
        setResults((old) => [
          ...old.filter((r) => !returned.some((n) => n.name === r.name)),
          ...returned,
        ]);
        req = {
          continuation: step.continuation,
          results: returned.map((r) => ({
            toolCallId: r.callId,
            result: r.result,
          })),
        };
      }
      throw Error("已达4轮模型上限，未保存活动；请缩小任务或手动操作");
    } catch (e) {
      if (!abort.signal.aborted) {
        setError(e instanceof Error ? e.message : "工作流失败");
        setPhase("error");
      }
    }
  }
  async function understand() {
    if (!text.trim() || busy) return;
    const edit = intent && radiusEdit(text, intent);
    if (edit) {
      setIntent(edit);
      setText("");
      await query(edit, stage);
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    setPhase("extracting");
    setError("");
    setResults([]);
    setDraft(undefined);
    cache.current = {};
    try {
      const response = await aiTask(
        "companion-intent",
        {
          text,
          context: { pets: pets.filter((p) => p.id === ownId).map(petSummary) },
        },
        abort.signal,
      );
      if (abort.signal.aborted) return;
      const extracted = response.data;
      setIntent(extracted);
      setTimeEdited(false);
      setTimeLabel("");
      setPeriods([...(extracted.timeText?.match(/上午|下午|晚上/g) ?? [])]);
      try {
        const availability = resolveAvailability(extracted);
        setDay(
          new Date(Date.parse(availability.windows[0].startAt) + 8 * 3600000)
            .toISOString()
            .slice(0, 10),
        );
        queryIntent(extracted);
        await query(
          extracted,
          extracted.mode === "create" ? "organize" : "search",
        );
      } catch {
        setDay("");
        setPhase("clarifying");
      }
    } catch (e) {
      if (!abort.signal.aborted) {
        setError(e instanceof Error ? e.message : "需求提取失败");
        setPhase("error");
      }
    }
  }
  return (
    <section
      className="ai-companion"
      aria-label="AI 智能约伴"
      id="companion"
      aria-busy={busy}
    >
      <div className="companion-heading">
        <h2>AI 智能约伴</h2>
        {phase !== "idle" && (
          <button type="button" className="text-link" onClick={reset}>
            {busy ? "取消查询" : "重新开始"}
          </button>
        )}
      </div>
      <fieldset disabled={busy}>
        <details className="companion-settings">
          <summary>
            {pets.find((p) => p.id === ownId)?.name ?? "选择参考宠物"} ·{" "}
            {reference.name}
            <span className="settings-edit">调整</span>
          </summary>
          <label className="field">
            <span>参考宠物</span>
            <select
              aria-label="约伴参考宠物"
              value={ownId}
              onChange={(e) => {
                reset();
                setOwn(e.target.value);
              }}
            >
              {pets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <PlacePicker
            label="约伴参考地点"
            value={reference}
            onChange={(p) => {
              reset();
              setReference(p);
            }}
          />
        </details>
        <label className="field">
          <span>说说你的约伴计划</span>
          <textarea
            aria-label="智能约伴需求"
            maxLength={1500}
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="周六下午带史宾格找3公里内温和的狗狗散步，最好有草坪。"
          />
        </label>
        <div className="button-row">
          <button
            className="button"
            disabled={!text.trim() || !ownId}
            onClick={understand}
          >
            帮我找活动
          </button>
          <Link href="/activities/new" className="text-link">
            手动发起活动
          </Link>
        </div>
        {!pets.length && (
          <Link className="text-link" href="/me/pets/new">
            先添加宠物档案 →
          </Link>
        )}
      </fieldset>
      {!["idle", "recommendations", "draft", "error"].includes(phase) && (
        <p role="status" className="workflow-status">
          {
            {
              idle: "",
              extracting: "正在理解需求…",
              clarifying: "想哪天出发？",
              searching: "正在优先查询已有活动…",
              recommendations: "",
              organizing: "正在寻找宠友与地点，整理组局草稿…",
              draft: "",
              error: "",
            }[phase]
          }
        </p>
      )}
      {intent && !busy && (
        <div className="card form-card companion-plan">
          <h3>你的约伴计划</h3>
          <p>
            {intent.timeText ?? "未提供时间"} · {intent.match.radiusKm ?? 5}{" "}
            公里 · {intent.activityType ?? "活动类型未提供"}
          </p>
          <p>
            偏好：
            {[
              ...intent.preferences,
              ...intent.match.temperaments,
              ...intent.match.activities,
            ].join("、") || "未指定"}
          </p>
          <p>
            硬约束：
            {[
              ...intent.hardRequirements,
              ...intent.match.excludedSizes.map((t) => `排除${sizeLabels[t]}`),
              ...intent.match.excludedBreeds.map((t) => `排除${t}`),
              ...intent.match.excludedTemperaments.map((t) => `排除${t}`),
              ...intent.match.excludedActivities.map((t) => `排除${t}`),
              ...intent.match.sizes.map((t) => sizeLabels[t]),
              ...intent.match.breeds,
              intent.match.district,
            ]
              .filter(Boolean)
              .join("、") || "以确认的日期与距离为准"}
          </p>
          {[
            ...intent.clarifications,
            ...intent.match.clarifications,
            ...intent.match.unmappedTerms,
            ...intent.warnings,
          ].map((t, i) => (
            <p key={i}>{t}</p>
          ))}
          <p data-testid="availability-label">
            {timeLabel || "还需要一个大概日期"}
          </p>
          <details open={phase === "clarifying"}>
            <summary>调整日期与时段</summary>
            <label className="field">
              哪一天
              <input
                aria-label="约伴日期"
                type="date"
                value={day}
                onChange={(e) => {
                  setDay(e.target.value);
                  setTimeEdited(true);
                }}
              />
            </label>
            <div className="button-row">
              {["上午", "下午", "晚上"].map((p) => (
                <label className="check-line" key={p}>
                  <input
                    type="checkbox"
                    checked={periods.includes(p)}
                    onChange={() => {
                      setPeriods((old) =>
                        old.includes(p)
                          ? old.filter((v) => v !== p)
                          : [...old, p],
                      );
                      setTimeEdited(true);
                    }}
                  />
                  {p}
                </label>
              ))}
            </div>
            <button
              className="button secondary"
              onClick={() => {
                const adjusted = timeEdited
                  ? {
                      ...intent,
                      startAt: null,
                      endAt: null,
                      timeText: day
                        ? `${day} ${periods.join("或") || "当天"}`
                        : null,
                    }
                  : intent;
                try {
                  queryIntent(adjusted);
                  setIntent(adjusted);
                  void query(
                    adjusted,
                    adjusted.mode === "create" ? "organize" : "search",
                  );
                } catch (e) {
                  setError(e instanceof Error ? e.message : "选个大概日期就行");
                }
              }}
            >
              {intent.mode === "create"
                ? "按这个时段自己组局"
                : "按这个时段找活动"}
            </button>
          </details>
        </div>
      )}
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      {results.map(({ name, result }) => (
        <div
          className="card form-card companion-result"
          key={name}
          data-testid="companion-result"
          data-tool={name}
        >
          <h3>
            {
              {
                search_activities: "推荐活动",
                search_pets: "推荐宠友",
                search_places: "候选地点",
                check_compatibility: "互动建议",
                create_activity_draft: "活动草稿",
              }[name]
            }
          </h3>
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
                const p = state!.pets.find(
                  (p) => p.id === r.id && !p.archivedAt,
                );
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
              {!result.rows.length && (
                <p>没找到合适地点，换个关键词或手动选点。</p>
              )}
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
      ))}
      {!busy &&
        intent &&
        results.some((r) => r.result.kind === "activities") && (
          <button className="button" onClick={() => query(intent, "organize")}>
            自己组局
          </button>
        )}
      {!busy && intent && phase === "error" && (
        <div className="button-row">
          <button
            className="button secondary"
            onClick={() => query(intent, stage)}
          >
            重试当前阶段
          </button>
          {stage === "organize" && (
            <button
              className="button secondary"
              onClick={() => {
                cache.current.places = demoPlaces
                  .filter(
                    (p) =>
                      p.location &&
                      distanceMeters(
                        reference.location ?? DEFAULT_REFERENCE,
                        p.location,
                      ) <=
                        (intent.match.radiusKm ?? 5) * 1000,
                  )
                  .slice(0, 5);
                void query(intent, "organize", true);
              }}
            >
              改用明确演示地点重新组局
            </button>
          )}
        </div>
      )}
      {draft && <ActivityEditor initialInput={draft} />}
    </section>
  );
}
