"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useDemo } from "@/features/demo/provider";
import { Empty, PetImage, Title, useUnsaved } from "@/components/ui";
import { behaviors, cardFor, comparePets } from "@/domain/social";
import { SocialCardInput, socialCardInputSchema } from "@/domain/schemas";
import { exportCard } from "./export";

const blocks = {
  traits: "社交性格标签",
  likes: "喜欢的互动行为",
  dislikes: "不喜欢的行为",
  cautions: "需要注意的习惯",
} as const;
export function CardPage({ id }: { id: string }) {
  const { state } = useDemo();
  if (!state) return null;
  const p = state.pets.find((p) => p.id === id && !p.archivedAt);
  if (!p) return <Empty title="宠物档案不存在" />;
  return <CardView key={`${id}-${state.activeUserId}`} id={id} />;
}
function CardView({ id }: { id: string }) {
  const { state, run, writable, notify } = useDemo();
  const p = state!.pets.find((p) => p.id === id)!;
  const c = state!.socialCards.find((c) => c.petId === id),
    current = cardFor(state!, p);
  const mine = p.ownerId === state!.activeUserId;
  const [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false);
  return (
    <>
      <Link href={`/pets/${id}`} className="back-link">
        ← 返回宠物档案
      </Link>
      <Title
        eyebrow="A LITTLE GUIDE TO ME"
        title={`${p.name}的社交名片`}
        description="把喜欢与边界说清楚，让第一次相遇更从容。"
      />
      <article className="social-card card" data-testid="social-card">
        <div className="social-cover">
          <PetImage image={p.photo} alt={p.name} />
          <div>
            <span className="eyebrow">PAWMEET · FRIENDSHIP NOTES</span>
            <h2>{p.name}</h2>
            <p>
              {p.breed} · {p.district}
            </p>
            <span className="pill">
              {current
                ? "主人已确认 · 已复核内容"
                : c
                  ? "档案已变更 · 待重新确认"
                  : "尚未确认名片"}
            </span>
          </div>
        </div>
        <div className="social-blocks">
          {Object.entries(blocks).map(([key, label]) => (
            <section key={key}>
              <h3>{label}</h3>
              <div className="tags">
                {c?.[key as keyof typeof blocks].length ? (
                  c[key as keyof typeof blocks].map((t, i) => (
                    <span key={i}>{t}</span>
                  ))
                ) : (
                  <p className="muted">尚未补充，请先向主人确认。</p>
                )}
              </div>
            </section>
          ))}
        </div>
        <section className="meeting-note">
          <h3>初次见面建议</h3>
          <p className="pre-wrap">
            {c?.meetingAdvice || "先保持牵引和距离，由双方主人确认互动方式。"}
          </p>
        </section>
        <p className="form-hint">
          虚构宠物 · 偏好由主人描述，仅供沟通参考，不是专业行为诊断或安全保证。
          {!current && "当前内容不可作为有效名片分享或用于偏好冲突判断。"}
        </p>
      </article>
      <div className="button-row">
        {mine && (
          <button
            className="button"
            disabled={!writable}
            onClick={() => setEditing(!editing)}
          >
            {editing ? "收起编辑" : "编辑与确认名片"}
          </button>
        )}
        <Link
          className="button secondary"
          href={`/discover/compare?petId=${id}`}
        >
          比较社交偏好
        </Link>
        <button
          className="button secondary"
          disabled={!current || busy}
          onClick={async () => {
            if (!current) return;
            setBusy(true);
            try {
              await exportCard(p, current, false);
              notify("名片 PNG 已生成");
            } catch (e) {
              notify(e instanceof Error ? e.message : "导出失败");
            } finally {
              setBusy(false);
            }
          }}
        >
          下载 PNG
        </button>
        <button
          className="button secondary"
          disabled={!current || busy}
          onClick={async () => {
            if (!current) return;
            setBusy(true);
            try {
              await exportCard(p, current, true);
            } catch (e) {
              notify(e instanceof Error ? e.message : "分享失败");
            } finally {
              setBusy(false);
            }
          }}
        >
          分享名片文件
        </button>
      </div>
      {editing && mine && (
        <CardEditor
          key={`${p.revision}-${c?.revision}`}
          initial={
            c ?? {
              traits: [...p.temperamentTags],
              likes: [],
              dislikes: [],
              cautions: [],
              meetingAdvice: "",
            }
          }
          save={(input) => {
            if (
              run({
                type: "save-card",
                petId: id,
                petRevision: p.revision,
                input,
              })
            ) {
              setEditing(false);
              notify("主人已确认社交名片");
              return true;
            }
            return false;
          }}
          writable={writable}
        />
      )}
    </>
  );
}
function CardEditor({
  initial,
  save,
  writable,
}: {
  initial: SocialCardInput;
  save: (input: SocialCardInput) => boolean;
  writable: boolean;
}) {
  const form = useRef<HTMLFormElement>(null);
  const { setDirty } = useUnsaved(),
    [error, setError] = useState("");
  return (
    <form
      ref={form}
      className="card form-card"
      onChange={() => setDirty(true)}
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const result = socialCardInputSchema.safeParse({
          ...Object.fromEntries(
            Object.keys(blocks).map((k) => [
              k,
              String(f.get(k) ?? "")
                .split("\n")
                .map((t) => t.trim())
                .filter(Boolean),
            ]),
          ),
          meetingAdvice: f.get("meetingAdvice"),
        });
        if (!result.success) {
          setError("每块最多 6 项，每项 60 字；初见建议最多 300 字。");
          return;
        }
        if (save(result.data)) setDirty(false);
      }}
    >
      <fieldset disabled={!writable}>
        <h2>主人复核后确认</h2>
        <p className="form-hint">
          每行一项，未知可留空。规则比较仅识别这些完整词条：
          {behaviors.join("、")}；自由说明仍展示给主人，不能推断为确定冲突。
        </p>
        {Object.entries(blocks).map(([k, label]) => (
          <label className="field" key={k}>
            <span>{label}</span>
            <textarea
              aria-label={label}
              name={k}
              rows={3}
              defaultValue={initial[k as keyof typeof blocks].join("\n")}
            />
          </label>
        ))}
        <label className="field">
          <span>初次见面建议</span>
          <textarea
            name="meetingAdvice"
            aria-label="初次见面建议"
            maxLength={300}
            defaultValue={initial.meetingAdvice}
          />
        </label>
        <label className="check-line">
          <input type="checkbox" required />
          我已逐项复核，这是我对宠物的描述
        </label>
        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
        <button className="button form-submit">确认保存社交名片</button>
      </fieldset>
    </form>
  );
}
export function Compare() {
  const { state } = useDemo(),
    params = useSearchParams();
  if (!state) return null;
  return (
    <Comparison
      key={`${state.activeUserId}-${params.get("petId")}`}
      target={params.get("petId") ?? ""}
    />
  );
}
function Comparison({ target }: { target: string }) {
  const { state } = useDemo();
  const pets = state!.pets.filter((p) => !p.archivedAt);
  const [aId, setA] = useState(
    pets.find((p) => p.ownerId === state!.activeUserId && p.id !== target)
      ?.id ??
      pets[0]?.id ??
      "",
  );
  const [bId, setB] = useState(
    target || pets.find((p) => p.id !== aId)?.id || "",
  );
  const a = pets.find((p) => p.id === aId),
    b = pets.find((p) => p.id === bId);
  const result = a && b && a.id !== b.id ? comparePets(state!, a, b) : null;
  return (
    <>
      <Title
        eyebrow="GET TO KNOW EACH OTHER"
        title="先了解彼此，再慢慢靠近。"
        description="仅使用当前有效名片和明确性格标签识别偏好差异，不生成安全评分。"
      />
      <div className="card form-card form-grid">
        {[
          ["第一位宠物", aId, setA],
          ["第二位宠物", bId, setB],
        ].map(([label, value, set]) => (
          <label className="field" key={String(label)}>
            <span>{String(label)}</span>
            <select
              value={String(value)}
              onChange={(e) => (set as (v: string) => void)(e.target.value)}
            >
              {pets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ·{" "}
                  {state!.users.find((u) => u.id === p.ownerId)!.displayName}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {!result ? (
        <Empty title="请选择两只不同的宠物" />
      ) : (
        <>
          <div className="comparison-grid">
            {[a!, b!].map((p) => (
              <section className="card comparison-pet" key={p.id}>
                <PetImage image={p.photo} alt={p.name} />
                <h2>{p.name}</h2>
                <p>{p.temperamentTags.join(" · ")}</p>
                <Link href={`/pets/${p.id}/card`}>查看名片与完整偏好 →</Link>
              </section>
            ))}
          </div>
          <section className="card form-card">
            <p className="form-hint">
              社交适配采用确定性偏好规则，无需模型调用。
            </p>
            <h2>明确的偏好冲突</h2>
            {result.conflicts.length ? (
              result.conflicts.map((t) => (
                <p className="conflict" key={t}>
                  {t}
                </p>
              ))
            ) : (
              <p>未识别到明确词条冲突；这不代表适合互动或不存在风险。</p>
            )}
            {result.incomplete && (
              <p className="conflict">
                至少一份名片缺失或待重新确认，仅参考有效名片与档案中的明确标签；信息不足请先向主人核对。
              </p>
            )}
            <p>共同喜欢：{result.shared.join("、") || "尚无明确共同词条"}</p>
            <h3>谨慎的初见建议</h3>
            {result.advice.map((t) => (
              <p key={t}>{t}</p>
            ))}
            <p className="form-hint">不是专业行为诊断或安全保证。</p>
          </section>
          <Link
            className="button"
            href={`/activities/new?recommendedPetId=${b!.id}`}
          >
            以此宠友为推荐对象发起约伴
          </Link>
        </>
      )}
    </>
  );
}
