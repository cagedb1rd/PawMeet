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
  confirmedIntent,
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
import { ActivityInput, PlaceRef } from "@/domain/schemas";
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
  const [start, setStart] = useState(""),
    [end, setEnd] = useState("");
  const [results, setResults] = useState<
    { name: string; result: ToolResult }[]
  >([]);
  const [queriedPlaces, setQueriedPlaces] = useState<PlaceRef[]>([]);
  const [draft, setDraft] = useState<ActivityInput>();
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
      confirmedIntent(i);
      if (!reference.location)
        throw Error("参考地点缺少坐标，请重新选择公共参考点");
      setPhase(next === "search" ? "searching" : "organizing");
      let req: AssistantRequest = {
        text:
          next === "search"
            ? "按已确认条件优先查询已有活动。"
            : "用户已选择自己组局，按已确认条件查询必要宠友与地点并生成活动草稿。",
        pets: pets.filter((p) => p.id === ownId).map(petSummary),
        workflow: { stage: next, intent: i },
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
      setIntent(response.data);
      setStart("");
      setEnd("");
      setPhase("clarifying");
    } catch (e) {
      if (!abort.signal.aborted) {
        setError(e instanceof Error ? e.message : "需求提取失败");
        setPhase("error");
      }
    }
  }
  return (
    <section className="ai-companion" aria-label="AI 智能约伴" id="companion">
      <h2>AI 智能约伴</h2>
      <p>
        先找已有活动，再由你决定是否组局。所有宠友和活动来自当前浏览器演示数据；大致直线距离，场地准入需核实。
      </p>
      <fieldset disabled={busy}>
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
        <details>
          <summary>
            参考地点：{reference.name}（
            {reference.source === "demo" ? "演示点" : "公共点"}）
          </summary>
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
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="周六下午带史宾格找3公里内温和的狗狗散步，最好有草坪。"
          />
        </label>
        <div className="button-row">
          <button
            className="button secondary"
            disabled={!text.trim() || !ownId}
            onClick={understand}
          >
            理解约伴需求
          </button>
          <Link href="/activities/new" className="text-link">
            手动发起活动
          </Link>
        </div>
      </fieldset>
      <p role="status">
        {
          {
            idle: "请输入需求，查询前会请你复核条件。",
            extracting: "正在理解需求…",
            clarifying: "请补齐具体时间并复核条件。",
            searching: "正在优先查询已有活动…",
            recommendations: "已有活动查询完成，可进入详情自行报名。",
            organizing: "正在寻找宠友与地点，整理组局草稿…",
            draft: "可编辑草稿已准备好，尚未创建。",
            error: "工作流未完成，可重试或手动操作。",
          }[phase]
        }
      </p>
      {intent && !busy && (
        <div className="card form-card">
          <h3>复核约伴条件</h3>
          <p>
            {intent.timeText ?? "未提供时间"} · {intent.match.radiusKm ?? 5}{" "}
            公里（未指定默认5公里） · {intent.activityType ?? "活动类型未提供"}
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
              ...intent.match.excludedSizes.map((t) => `排除${t}`),
              ...intent.match.excludedBreeds.map((t) => `排除${t}`),
              ...intent.match.excludedTemperaments.map((t) => `排除${t}`),
              ...intent.match.excludedActivities.map((t) => `排除${t}`),
              ...intent.match.sizes,
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
          <p>
            日期和时间必须由你确认；模型提议不会自动执行。其他条件有误请修改描述重新提取。只改距离可说“扩大到5公里”，其他已确认条件会保留。
          </p>
          <label className="field">
            计划开始（北京时间）
            <input
              aria-label="约伴开始时间"
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label className="field">
            计划结束（北京时间）
            <input
              aria-label="约伴结束时间"
              type="datetime-local"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
          <button
            className="button secondary"
            onClick={() => {
              try {
                const i = confirmedIntent({
                  ...intent,
                  startAt: start
                    ? new Date(`${start}:00+08:00`).toISOString()
                    : null,
                  endAt: end ? new Date(`${end}:00+08:00`).toISOString() : null,
                });
                setIntent(i);
                void query(i, i.mode === "create" ? "organize" : "search");
              } catch (e) {
                setError(e instanceof Error ? e.message : "请填写时间");
              }
            }}
          >
            确认条件并{intent.mode === "create" ? "自己组局" : "查询已有活动"}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      {results.map(({ name, result }) => (
        <div
          className="card form-card"
          key={name}
          data-testid="companion-result"
        >
          <h3>实际工具结果 · {name}</h3>
          {result.kind === "error" ? (
            <p role="alert">
              工具失败：{result.message}（{result.code}
              ）。未当作空结果；可重试或手动操作。
            </p>
          ) : result.kind === "activities" ? (
            <>
              {!result.rows.length && (
                <p>
                  没有满足时间、距离、名额及已知硬约束的活动；未扩大条件，可选择自己组局。
                </p>
              )}
              {result.rows.map((r) => (
                <article key={r.id}>
                  <Link href={`/activities/${r.id}`}>{r.title} · 查看详情</Link>
                  <p>
                    {formatTime(r.startAt)} ·{" "}
                    {r.distanceM === null
                      ? "距离未知"
                      : formatDistance(r.distanceM)}{" "}
                    · 剩余{r.remaining}位
                  </p>
                  <p>{r.reasons?.join("；")}</p>
                  <p>差异 / 未核实：{r.differences?.join("；")}</p>
                </article>
              ))}
            </>
          ) : result.kind === "pets" ? (
            <>
              {!result.rows.length && (
                <p>
                  没有匹配宠友。可明确输入“扩大到5公里”等调整范围；未经同意不会放宽硬约束。也可先创建活动等待参与。
                </p>
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
                <p>地点查询成功但没有范围内候选，可改关键词或手动选点。</p>
              )}
              {result.rows.map((r) => (
                <div key={r.index}>
                  <p>
                    {r.name} · {formatDistance(r.distanceM)} ·{" "}
                    {r.source === "demo" ? "明确演示地点" : "高德查询"} ·
                    宠物准入未知
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
                <p>
                  {r.conflicts.join("；") || "未识别明确冲突，不代表安全保证"}
                </p>
                <p>{r.advice.join("；")}</p>
                {r.incomplete && <p>名片信息不完整，需向主人核实</p>}
              </div>
            ))
          ) : result.kind === "activity-draft" ? (
            <p>活动草稿已生成，仍须编辑并确认创建。</p>
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
          <button onClick={() => query(intent, stage)}>重试当前阶段</button>
          {stage === "organize" && (
            <button
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
      <button type="button" onClick={reset}>
        {busy ? "取消查询" : "重新开始"}
      </button>
      <p className="form-hint">
        高德周边搜索最多5公里，候选并非全量场地。仅上传选中宠物摘要和最多5条查询结果，不上传图片、完整数据或参考坐标。每阶段最多4轮模型、9次工具；自动有限重试由现有服务控制。
      </p>
    </section>
  );
}
