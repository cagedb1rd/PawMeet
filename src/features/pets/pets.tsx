"use client";
import Link from "next/link";
import { useState } from "react";
import { Edit3, MapPin, PawPrint, Heart, Trash2 } from "lucide-react";
import { useDemo } from "@/features/demo/provider";
import { Dialog, Empty, PetImage, Unavailable } from "@/components/ui";
import { sizeLabels } from "@/domain/schemas";

export function PetDetail({ id }: { id: string }) {
  const { state, run, writable, notify } = useDemo();
  const [deleting, setDeleting] = useState(false);
  if (!state) return null;
  const p = state.pets.find((p) => p.id === id && !p.archivedAt);
  if (!p)
    return (
      <Empty title="这份档案不存在或已删除">
        <Link href="/me">回到我的宠物</Link>
      </Empty>
    );
  const owner = state.users.find((u) => u.id === p.ownerId)!;
  const mine = p.ownerId === state.activeUserId;
  return (
    <>
      <Link href={mine ? "/me" : "/discover"} className="back-link">
        ← {mine ? "我的毛孩子" : "返回发现"}
      </Link>
      <div className="pet-detail card">
        <div className="pet-detail-image">
          <PetImage
            key={JSON.stringify(p.photo)}
            image={p.photo}
            alt={p.name}
          />
          <span className="photo-label">虚构宠物档案</span>
          <span className="pet-image-note">
            照片不可用时，请主人编辑档案补充照片。
          </span>
        </div>
        <div className="pet-detail-info">
          <span className="eyebrow">A VERY GOOD FRIEND</span>
          <div className="row-between">
            <h1>{p.name}</h1>
            <span className="paw-medallion">
              <PawPrint size={25} />
            </span>
          </div>
          <p className="pet-subtitle">
            {p.breed} ·{" "}
            {p.ageMonths === null ? "年龄未知" : `${p.ageMonths}个月`} ·{" "}
            {sizeLabels[p.size]}
          </p>
          <p className="location">
            <MapPin size={16} />
            {p.city} · {p.district} · 公共演示区域
          </p>
          <div className="owner-line">
            <PetImage image={owner.avatar} alt={owner.displayName} />
            <div>
              <b>{owner.displayName}</b>
              <small>主人 · 模拟身份</small>
            </div>
            {mine && <span className="pill">我的毛孩子</span>}
          </div>
          <h3>一点点关于我</h3>
          <div className="tags large">
            {p.temperamentTags.map((t) => (
              <span key={t}>{t}</span>
            ))}
          </div>
          <h3>一起做这些吧</h3>
          <div className="tags peach">
            {p.activityTags.map((t) => (
              <span key={t}>
                <Heart size={12} />
                {t}
              </span>
            ))}
          </div>
          <h3>见面前的小提醒</h3>
          <p className="pre-wrap muted">
            {p.socialNotes || "主人尚未补充，请在互动前确认。"}
          </p>
          <Unavailable>社交名片与偏好比较将在 Phase 2 开放</Unavailable>
          {mine && (
            <div className="button-row">
              <Link href={`/me/pets/${p.id}/edit`} className="button">
                <Edit3 size={16} />
                编辑档案
              </Link>
              <button
                className="button danger-outline"
                disabled={!writable}
                onClick={() => setDeleting(true)}
              >
                <Trash2 size={16} />
                删除档案
              </button>
            </div>
          )}
        </div>
      </div>
      {deleting && (
        <Dialog
          title={`删除${p.name}的档案？`}
          close={() => setDeleting(false)}
        >
          <p>
            档案将从发现和我的列表移除。历史动态仍保留引用；有未结束活动或开放互助的宠物不能删除。
          </p>
          <div className="button-row">
            <button
              className="button secondary"
              onClick={() => setDeleting(false)}
            >
              保留档案
            </button>
            <button
              className="button danger"
              onClick={() => {
                if (run({ type: "delete-pet", petId: p.id })) {
                  setDeleting(false);
                  notify("宠物档案已删除");
                }
              }}
            >
              确认删除
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
