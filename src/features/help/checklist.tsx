"use client";
import { useState } from "react";
import { useUnsaved } from "@/components/ui";
import {
  ChecklistInput,
  HelpRequest,
  Pet,
  checklistInputSchema,
} from "@/domain/schemas";
import { checklistTemplate } from "@/lib/ai/templates";
import { useDemo } from "@/features/demo/provider";

export function CareChecklist({
  h,
  p,
  mine,
  current,
}: {
  h: HelpRequest;
  p: Pet;
  mine: boolean;
  current: boolean;
}) {
  const { state, run, writable } = useDemo();
  const uid = state!.activeUserId,
    id = h.id,
    checklist = state!.careChecklists.find((c) => c.helpId === id);
  return (
    <section className="card form-card" id="care-checklist">
      <h2>宠物照看交接清单</h2>
      <p className={current ? "form-hint" : "conflict"}>
        {current
          ? "主人已确认当前版本；仍需核对标为待确认的细节。"
          : checklist
            ? "来源档案或需求已变更，请主人重新复核清单。"
            : "尚无已确认清单，请主人填写后确认。"}
      </p>
      {checklist && (
        <ol>
          {checklist.items.map((item, i) => (
            <li className="checklist-item" key={i}>
              <b>{item.title}</b>
              {item.needsConfirmation && (
                <span className="pill">细节待确认</span>
              )}
              <p className="pre-wrap">{item.detail || "尚未填写"}</p>
            </li>
          ))}
        </ol>
      )}
      {mine && ["open", "assigned"].includes(h.status) && (
        <ChecklistEditor
          facts={[
            p.socialNotes,
            ...p.temperamentTags,
            ...p.activityTags,
            h.type,
            h.details,
          ].join("\n")}
          key={`${uid}-${h.contentRevision}-${p.revision}-${checklist?.revision}`}
          initial={
            checklist ?? {
              items: [
                {
                  title: "照看方式与物品",
                  detail: "",
                  needsConfirmation: true,
                },
                { title: "饮食与习惯", detail: "", needsConfirmation: true },
                {
                  title: "交接与异常处理",
                  detail: "",
                  needsConfirmation: true,
                },
              ],
            }
          }
          save={(input) =>
            run({
              type: "save-checklist",
              helpId: id,
              petRevision: p.revision,
              requestRevision: h.contentRevision,
              input,
            })
          }
          writable={writable}
        />
      )}
    </section>
  );
}
function ChecklistEditor({
  facts,
  initial,
  save,
  writable,
}: {
  facts: string;
  initial: ChecklistInput;
  save: (input: ChecklistInput) => boolean;
  writable: boolean;
}) {
  const [items, setItems] = useState(initial.items),
    [error, setError] = useState("");
  const { setDirty } = useUnsaved();
  return (
    <form
      onChange={() => setDirty(true)}
      onSubmit={(e) => {
        e.preventDefault();
        const result = checklistInputSchema.safeParse({ items });
        if (!result.success) {
          setError("请填写 1–12 项；标题 1–60 字，详情最多 300 字。");
          return;
        }
        if (save(result.data)) {
          setDirty(false);
          setError("");
        }
      }}
    >
      <fieldset disabled={!writable}>
        <button
          type="button"
          className="button secondary"
          onClick={() => {
            setItems(checklistTemplate(facts).items);
            setDirty(true);
          }}
        >
          按已有资料填入交接模板
        </button>
        <p className="form-hint">
          只填写主人已知内容，不确定项保留“待确认”，不要填写门牌、联系方式或用药剂量。
        </p>
        {items.map((item, i) => (
          <div className="checklist-editor" key={i}>
            <label className="field">
              <span>清单标题 {i + 1}</span>
              <input
                maxLength={60}
                required
                value={item.title}
                onChange={(e) =>
                  setItems(
                    items.map((v, j) =>
                      j === i ? { ...v, title: e.target.value } : v,
                    ),
                  )
                }
              />
            </label>
            <label className="field">
              <span>清单详情 {i + 1}</span>
              <textarea
                aria-label={`清单详情 ${i + 1}`}
                maxLength={300}
                value={item.detail}
                onChange={(e) =>
                  setItems(
                    items.map((v, j) =>
                      j === i ? { ...v, detail: e.target.value } : v,
                    ),
                  )
                }
              />
            </label>
            <label className="check-line">
              <input
                type="checkbox"
                checked={item.needsConfirmation}
                onChange={(e) =>
                  setItems(
                    items.map((v, j) =>
                      j === i
                        ? { ...v, needsConfirmation: e.target.checked }
                        : v,
                    ),
                  )
                }
              />
              细节待确认
            </label>
            <button
              type="button"
              className="button secondary"
              disabled={items.length <= 1}
              onClick={() => {
                setItems(items.filter((_, j) => j !== i));
                setDirty(true);
              }}
            >
              删除第{i + 1}项
            </button>
          </div>
        ))}
        <div className="button-row">
          <button
            type="button"
            className="button secondary"
            disabled={items.length >= 12}
            onClick={() => {
              setItems([
                ...items,
                { title: "", detail: "", needsConfirmation: true },
              ]);
              setDirty(true);
            }}
          >
            添加清单项
          </button>
          <button className="button">主人确认保存清单</button>
        </div>
        {error && <p role="alert">{error}</p>}
      </fieldset>
    </form>
  );
}
