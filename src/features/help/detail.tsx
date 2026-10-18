"use client";
import Link from "next/link";
import { useState } from "react";
import { HelpRequest } from "@/domain/schemas";
import { useDemo } from "@/features/demo/provider";
import {
  Empty,
  PetImage,
  Title,
  formatTime,
  useUnsaved,
} from "@/components/ui";
import { checklistCurrent } from "@/domain/phase2";
import { PlaceDetails } from "@/features/maps/places";
import { CareChecklist } from "./checklist";
import { actions, appStatuses, helpStatus, statuses, useClock } from "./status";

export function HelpDetail({ id }: { id: string }) {
  const { state } = useDemo();
  if (!state) return null;
  return state.helpRequests.some((h) => h.id === id) ? (
    <Detail key={`${id}-${state.activeUserId}`} id={id} />
  ) : (
    <Empty title="这条求助不存在">
      <Link href="/help">返回互助</Link>
    </Empty>
  );
}
/** One-line hint for what the current viewer can do next. */
function nextStep(
  h: HelpRequest,
  v: {
    mine: boolean;
    helper: boolean;
    current: boolean;
    applied: boolean;
    now: number;
  },
) {
  if (h.status === "cancelled") return "求助已取消，历史记录保留。";
  if (h.status === "completed") return "双方已确认完成，可查看交接与历史记录。";
  if (h.status === "helper_done")
    return v.mine
      ? "帮助者已标记完成，请核实后确认完成。"
      : "已提交完成记录，等待求助人确认。";
  if (h.status === "assigned") {
    if (!v.current) return "交接资料已变更，需由求助人重新确认清单。";
    return v.helper
      ? "按交接清单提供帮助，结束后标记完成。"
      : "帮助者已确认，等待其完成帮助。";
  }
  if (Date.parse(h.startAt) <= v.now) return "求助已过期，不再接受申请。";
  if (v.mine)
    return v.current
      ? "清单已确认，可在申请人列表中选择帮助者。"
      : "请先确认交接清单，再选择帮助者。";
  return v.applied
    ? "申请已提交，等待求助人选择。"
    : "查看需求和宠物资料后，可以申请帮助。";
}
function Detail({ id }: { id: string }) {
  const { state, run, writable, notify } = useDemo();
  const now = useClock();
  const h = state!.helpRequests.find((h) => h.id === id)!,
    p = state!.pets.find((p) => p.id === h.petId)!;
  const uid = state!.activeUserId,
    mine = h.requesterId === uid,
    apps = state!.helpApplications.filter((a) => a.helpId === id);
  const myActive = apps.find(
    (a) => a.applicantId === uid && ["pending", "accepted"].includes(a.status),
  );
  const canApply =
    !mine &&
    h.status === "open" &&
    Date.parse(h.startAt) > now &&
    !p.archivedAt &&
    !myActive;
  const [message, setMessage] = useState("");
  const { setDirty } = useUnsaved();
  const current = checklistCurrent(state!, h);
  const name = (id: string | null) =>
    state!.users.find((u) => u.id === id)?.displayName ?? "尚未选择";
  return (
    <>
      <Link href="/help" className="back-link">
        ← 返回互助
      </Link>
      <Title eyebrow="A LITTLE TRUST" title={h.title} />
      <section className="help-next-step" aria-label="互助进度">
        <span className="pill">
          {mine ? "我是求助人" : h.helperId === uid ? "我是帮助者" : "我来帮忙"}
        </span>
        <p>
          {nextStep(h, {
            mine,
            helper: h.helperId === uid,
            current,
            applied: !!myActive,
            now,
          })}
        </p>
        {mine && ["open", "assigned"].includes(h.status) && !current && (
          <a className="text-link" href="#care-checklist">
            前往交接清单 →
          </a>
        )}
      </section>
      <div className="help-detail-grid">
        <section className="card form-card">
          <span className="pill" data-testid="help-status">
            {helpStatus(h, now)}
          </span>
          <h2>{h.type === "walk" ? "临时遛狗" : "简单喂食"}</h2>
          <p className="pre-wrap">{h.details}</p>
          <p>
            北京时间：{formatTime(h.startAt)} — {formatTime(h.endAt)}
          </p>
          <PlaceDetails place={h.place} />
          <p>
            求助人：{name(h.requesterId)} · 帮助者：{name(h.helperId)}
          </p>
          <Link href={`/pets/${p.id}`} className="help-pet">
            <PetImage image={p.photo} alt={p.name} />
            <span>
              {p.name}
              <small>
                {p.breed} · {p.temperamentTags.join(" / ")}
              </small>
            </span>
          </Link>
          <p className="muted">{p.socialNotes}</p>
          <Link href={`/pets/${p.id}/card`}>查看社交名片 →</Link>
          <div className="button-row">
            {mine &&
              h.status === "open" &&
              Date.parse(h.startAt) > now &&
              !apps.some((a) => ["pending", "accepted"].includes(a.status)) && (
                <Link className="button secondary" href={`/help/${id}/edit`}>
                  编辑求助
                </Link>
              )}
            {mine &&
              ["open", "assigned"].includes(h.status) &&
              Date.parse(h.startAt) > now && (
                <button
                  className="button danger-outline"
                  disabled={!writable}
                  onClick={() => {
                    if (
                      window.confirm(
                        "取消这条演示求助？待选申请将关闭，历史记录保留。",
                      )
                    )
                      run({ type: "cancel-help", helpId: id });
                  }}
                >
                  取消演示求助
                </button>
              )}
            {h.helperId === uid && h.status === "assigned" && (
              <button
                className="button"
                disabled={!writable || !current}
                onClick={() => run({ type: "helper-done", helpId: id })}
              >
                帮助者标记完成
              </button>
            )}
            {mine && h.status === "helper_done" && (
              <button
                className="button"
                disabled={!writable}
                onClick={() => run({ type: "complete-help", helpId: id })}
              >
                求助人确认完成
              </button>
            )}
          </div>
          {mine ? (
            <p className="form-hint">
              不能申请自己的求助；先确认清单，再从申请人中选择帮助者。
            </p>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (run({ type: "apply-help", helpId: id, message })) {
                  setMessage("");
                  setDirty(false);
                  notify("申请已保存，请等待求助人选择");
                }
              }}
            >
              <label className="field">
                <span>申请说明（选填，最多 200 字）</span>
                <textarea
                  aria-label="申请说明"
                  maxLength={200}
                  value={message}
                  disabled={!canApply || !writable}
                  onChange={(e) => {
                    setMessage(e.target.value);
                    setDirty(true);
                  }}
                />
              </label>
              <button className="button" disabled={!canApply || !writable}>
                {myActive
                  ? "已申请，不能重复申请"
                  : canApply
                    ? "申请帮助"
                    : "当前不能申请"}
              </button>
            </form>
          )}
          {myActive?.status === "pending" && (
            <button
              className="button secondary"
              disabled={!writable}
              onClick={() => run({ type: "withdraw-help", helpId: id })}
            >
              撤回申请
            </button>
          )}
        </section>
        <section className="card form-card">
          <h2>{mine ? "申请人列表" : "我的申请状态"}</h2>
          {(mine ? apps : apps.filter((a) => a.applicantId === uid)).map(
            (a) => (
              <div className="application-row" key={a.id}>
                <b>{name(a.applicantId)}</b>
                <span className="pill">{appStatuses[a.status]}</span>
                <p className="pre-wrap">{a.message || "未填写说明"}</p>
                {mine && a.status === "pending" && h.status === "open" && (
                  <button
                    className="button secondary"
                    disabled={
                      !writable || !current || Date.parse(h.startAt) <= now
                    }
                    onClick={() =>
                      run({
                        type: "assign-help",
                        helpId: id,
                        applicationId: a.id,
                      })
                    }
                  >
                    选择{name(a.applicantId)}为帮助者
                  </button>
                )}
              </div>
            ),
          )}
          {!(mine ? apps : apps.filter((a) => a.applicantId === uid))
            .length && <p className="muted">暂无申请记录。</p>}
          {mine && !current && (
            <p className="conflict">
              先在下方复核并确认交接清单，才能选择帮助者。
            </p>
          )}
        </section>
      </div>
      <CareChecklist h={h} p={p} mine={mine} current={current} />
      {(mine || apps.some((a) => a.applicantId === uid)) && (
        <details className="card form-card history-disclosure">
          <summary>
            <h2>互助历史记录</h2>
          </summary>
          <ol className="help-timeline">
            {state!.helpEvents
              .filter((e) => e.helpId === id)
              .map((e) => (
                <li key={e.id}>
                  <b>{actions[e.action]}</b>
                  <p>
                    {name(e.actorId)} · {formatTime(e.createdAt)} ·{" "}
                    {statuses[e.toState]}
                  </p>
                </li>
              ))}
          </ol>
          {!state!.helpEvents.some((e) => e.helpId === id) && (
            <p>种子需求尚无操作记录。</p>
          )}
        </details>
      )}
    </>
  );
}
