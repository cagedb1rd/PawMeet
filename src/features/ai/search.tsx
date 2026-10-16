"use client";
import { useState } from "react";
import { useDemo } from "@/features/demo/provider";
import { AiDraft, petSummary } from "./draft";
import { MatchIntent } from "@/lib/ai/contracts";
export function AiSearch({
  onApply,
}: {
  onApply: (intent: MatchIntent, petId: string) => void;
}) {
  const { state } = useDemo();
  const pets = state!.pets.filter(
    (p) => p.ownerId === state!.activeUserId && !p.archivedAt,
  );
  const [ownId, setOwn] = useState(pets[0]?.id ?? "");
  const [error, setError] = useState("");
  return (
    <section className="card form-card">
      <label className="field">
        <span>为哪位毛孩子找朋友？</span>
        <select
          aria-label="推荐参考宠物"
          value={ownId}
          onChange={(e) => setOwn(e.target.value)}
        >
          <option value="">尚无本人宠物</option>
          {pets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <AiDraft
        key={ownId}
        task="match-intent"
        title="AI 智能推荐宠友"
        context={{ pets: pets.filter((p) => p.id === ownId).map(petSummary) }}
        applyLabel="应用条件并查询"
        onApply={(data) => {
          if (data.clarifications.length || data.unmappedTerms.length) {
            setError("请先修改描述，解决上方澄清项");
            return;
          }
          setError("");
          onApply(data, ownId);
        }}
      />
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
