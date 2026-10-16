"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useDemo } from "@/features/demo/provider";
import { aiAssistant } from "@/lib/ai/client";
import { AssistantRequest, HelpDraft, ToolResult } from "@/lib/ai/contracts";
import { executeTool } from "@/lib/ai/tools";
import { DEFAULT_REFERENCE, formatDistance } from "@/domain/geo";
import { Title, PetCard, formatTime } from "@/components/ui";
import { HelpForm } from "@/features/help/help";
import { AiPreview, petSummary } from "./draft";
import { PlacePicker } from "@/features/maps/places";
import { demoPlaces } from "@/data/seed";
import { PlaceRef } from "@/domain/schemas";
export function AssistantPage() {
  const { state } = useDemo();
  return state ? (
    <Assistant key={`${state.activeUserId}-${state.revision}`} />
  ) : null;
}
function Assistant() {
  const { state } = useDemo();
  const [text, setText] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [continuation, setContinuation] = useState<string | undefined>();
  const [messages, setMessages] = useState<{ role: string; text: string }[]>(
    [],
  );
  const [results, setResults] = useState<
    { callId: string; name: string; result: ToolResult }[]
  >([]);
  const [draft, setDraft] = useState<HelpDraft>();
  const [place, setPlace] = useState<PlaceRef>(demoPlaces[0]);
  const [ownId, setOwn] = useState(
    state!.pets.find((p) => p.ownerId === state!.activeUserId && !p.archivedAt)
      ?.id ?? "",
  );
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const pets = state!.pets.filter(
    (p) => p.ownerId === state!.activeUserId && !p.archivedAt,
  );
  const send = async () => {
    if (!text.trim() || busy) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError("");
    setDraft(undefined);
    const input = text;
    setText("");
    setMessages((m) => [...m, { role: "你", text: input }]);
    try {
      let request: AssistantRequest = {
        text: input,
        ...(continuation
          ? { continuation }
          : { pets: pets.slice(0, 3).map(petSummary) }),
      };
      for (let round = 0; round < 4; round++) {
        const response = await aiAssistant(request, controller.signal);
        if (controller.signal.aborted) return;
        const step = response.data;
        if (!step.toolCalls.length) {
          setContinuation(step.continuation);
          setMessages((m) => [
            ...m,
            { role: "AI", text: step.answer?.summary ?? "未得到有效回答" },
          ]);
          return;
        }
        const toolResults = await Promise.all(
          step.toolCalls.map(async (call) => {
            // Synchronous, bounded local queries. Deadline still reported explicitly.
            const start = performance.now();
            let result = executeTool(
              call,
              state!,
              place.location ?? DEFAULT_REFERENCE,
              ownId,
              new Date(),
              [
                ...messages.filter((m) => m.role === "你").map((m) => m.text),
                input,
              ].join("\n"),
            );
            if (performance.now() - start > 2000)
              result = {
                kind: "error",
                code: "TIMEOUT",
                message: "本地工具执行超时",
              };
            return { callId: call.id, name: call.function.name, result };
          }),
        );
        setResults((old) => [...old, ...toolResults].slice(-12));
        request = {
          continuation: step.continuation,
          results: toolResults.map((r) => ({
            toolCallId: r.callId,
            result: r.result,
          })),
        };
      }
      throw Error("已达工具轮次上限，请缩小查询条件后重新开始");
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(e instanceof Error ? e.message : "AI助手失败");
        setContinuation(undefined);
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <>
      <Link href="/discover" className="back-link">
        ← 返回发现
      </Link>
      <Title
        eyebrow="PAWMEET AI"
        title="一句话，找到一点帮助。"
        description="查找当前浏览器的宠友与活动，或整理互助草稿。所有结果均为本地演示，不代表安全保证。"
      />
      <section className="card form-card">
        <label className="field">
          <span>参考宠物</span>
          <select
            aria-label="助手参考宠物"
            disabled={busy || !!continuation}
            value={ownId}
            onChange={(e) => setOwn(e.target.value)}
          >
            <option value="">未选择</option>
            {pets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <details>
          <summary>查询参考地点：{place.name} · 默认滨江公共参考点</summary>
          <PlacePicker
            label="助手查询参考点"
            value={place}
            onChange={(p) => {
              if (p.location) {
                setPlace(p);
                setContinuation(undefined);
              } else setError("距离查询需要有坐标的公共参考点");
            }}
          />
        </details>
        <p className="form-hint">
          参考坐标仅在浏览器计算距离。每次最多展示5张结果卡；未指定半径默认5公里。必要的筛选结果会发送
          GLM，图片和完整数据表不会发送。
        </p>
        <div aria-live="polite">
          {messages.map((m, i) => (
            <p key={i}>
              <b>{m.role}：</b>
              {m.text}
            </p>
          ))}
        </div>
        <label className="field">
          <span>告诉助手你的需求</span>
          <textarea
            aria-label="AI 助手需求"
            value={text}
            disabled={busy}
            maxLength={1500}
            rows={3}
            onChange={(e) => setText(e.target.value)}
            placeholder="找5公里内温和、喜欢散步的狗狗，也看看附近已有活动。"
          />
        </label>
        <div className="button-row">
          <button
            type="button"
            className="button"
            disabled={busy || !text.trim()}
            onClick={send}
          >
            {busy ? "AI 正在查询…" : "发送给 AI 助手"}
          </button>
          <button
            type="button"
            onClick={() => {
              abort.current?.abort();
              setBusy(false);
              setContinuation(undefined);
              setMessages([]);
              setResults([]);
              setDraft(undefined);
              setError("");
            }}
          >
            重新开始 / 取消
          </button>
        </div>
        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
      </section>
      {results.map(({ callId, name, result }) => (
        <section
          key={callId}
          className="card form-card"
          data-testid="tool-result"
        >
          <h3>实际工具结果 · {name}</h3>
          {result.kind === "error" ? (
            <p role="status">
              {result.message}（{result.code}）
            </p>
          ) : result.kind === "help-draft" ? (
            <>
              <AiPreview data={result.draft} />
              <button
                type="button"
                className="button secondary"
                onClick={() => setDraft(result.draft)}
              >
                打开可编辑互助表单（尚未发布）
              </button>
            </>
          ) : (
            <>
              {!result.rows.length && <p>没有符合条件的记录，未扩大范围。</p>}
              {result.kind === "pets" ? (
                <div className="pet-grid">
                  {result.rows.map((row) => {
                    const pet = state!.pets.find(
                      (p) => p.id === row.id && !p.archivedAt,
                    );
                    return pet ? (
                      <div key={row.id}>
                        <PetCard
                          pet={pet}
                          distance={formatDistance(row.distanceM)}
                        />
                        <p>
                          程序偏好匹配分 {row.score}/100 ·{" "}
                          {row.reasons.join("；")}
                        </p>
                      </div>
                    ) : null;
                  })}
                </div>
              ) : (
                result.rows.map((row) => (
                  <article className="meeting-note" key={row.id}>
                    <h3>{row.title}</h3>
                    <p>
                      {row.district} · {formatTime(row.startAt)} ·{" "}
                      {row.distanceM === null
                        ? "地点距离未知"
                        : formatDistance(row.distanceM)}
                    </p>
                    <Link href={`/activities/${row.id}`}>查看活动</Link>
                  </article>
                ))
              )}
            </>
          )}
        </section>
      ))}
      {draft && <HelpForm key={JSON.stringify(draft)} initialDraft={draft} />}
    </>
  );
}
