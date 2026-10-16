"use client";
import Link from "next/link";
import { useState } from "react";
import {
  Heart,
  CalendarDays,
  PawPrint,
  RotateCcw,
  HardDrive,
  ShieldCheck,
} from "lucide-react";
import { useDemo } from "@/features/demo/provider";
import { Dialog, Empty, PetCard, PetImage, Title } from "@/components/ui";
import { PublishLink } from "@/components/shell";
export function Me() {
  const { state, writable, reset, clean } = useDemo();
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false);
  if (!state) return null;
  const u = state.users.find((u) => u.id === state.activeUserId)!,
    pets = state.pets.filter((p) => p.ownerId === u.id && !p.archivedAt);
  return (
    <>
      <Title
        eyebrow="MY LITTLE WORLD"
        title="我和我的毛孩子"
        description="认真收藏，属于你们的小日常。"
      />
      <section className="profile-card card">
        <PetImage image={u.avatar} alt={u.displayName} />
        <div>
          <span className="pill">模拟身份 · 非真实账号</span>
          <h2>{u.displayName}</h2>
          <p>杭州 · 这里是我和毛孩子的小小世界</p>
        </div>
        <div className="profile-stats">
          <div>
            <PawPrint size={18} />
            <b>{pets.length}</b>
            <span>毛孩子</span>
          </div>
          <div>
            <Heart size={18} />
            <b>{state.posts.filter((p) => p.authorId === u.id).length}</b>
            <span>日常分享</span>
          </div>
          <Link href="/activities">
            <CalendarDays size={18} />
            <b>
              {
                state.activitySignups.filter(
                  (s) =>
                    s.userId === u.id &&
                    s.status === "joined" &&
                    state.activities.some(
                      (a) => a.id === s.activityId && a.status === "scheduled",
                    ),
                ).length
              }
            </b>
            <span>活动报名</span>
          </Link>
        </div>
      </section>
      <div className="section-heading">
        <h2>
          我的毛孩子 <span>{pets.length} 位专属快乐</span>
        </h2>
        <PublishLink href="/me/pets/new">添加宠物</PublishLink>
      </div>
      <div className="pet-grid my-pets">
        {pets.map((p) => (
          <PetCard key={p.id} pet={p} />
        ))}
      </div>
      {!pets.length && (
        <Empty title="等一位毛孩子入住">
          <Link href="/me/pets/new" className="button">
            创建宠物档案
          </Link>
        </Empty>
      )}
      <div className="section-heading">
        <h2>演示与本地数据</h2>
      </div>
      <div className="settings-card card">
        <div className="setting-row">
          <ShieldCheck />
          <div>
            <h3>一台浏览器，一个小世界</h3>
            <p>
              模拟身份共享本地数据；另一浏览器或无痕窗口是独立副本。没有真实登录或跨设备数据同步；名片可导出图片分享。
            </p>
          </div>
          <span className="pill">{writable ? "当前可编辑" : "只读模式"}</span>
        </div>
        <div className="setting-row">
          <HardDrive />
          <div>
            <h3>清理未引用照片</h3>
            <p>移除未保存或已替换的上传照片，已保存记录使用的照片会保留。</p>
          </div>
          <button
            className="button secondary"
            disabled={!writable || busy}
            onClick={async () => {
              setBusy(true);
              await clean();
              setBusy(false);
            }}
          >
            清理照片
          </button>
        </div>
        <div className="setting-row">
          <RotateCcw />
          <div>
            <h3>重新开始演示</h3>
            <p>
              恢复 25 个宠物档案、12 条动态、6
              场活动和默认身份，清除本地修改与上传照片。
            </p>
          </div>
          <button
            className="button danger-outline"
            disabled={!writable}
            onClick={() => setConfirm(true)}
          >
            重置演示数据
          </button>
        </div>
      </div>
      {confirm && (
        <Dialog title="重置当前浏览器的数据？" close={() => setConfirm(false)}>
          <p>
            所有新增档案、名片、互助与清单、动态、活动、点赞、报名和上传照片都将清除，此操作无法撤销。其他浏览器不受影响。
          </p>
          <div className="button-row">
            <button
              className="button secondary"
              onClick={() => setConfirm(false)}
            >
              保留数据
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                if (await reset()) setConfirm(false);
                setBusy(false);
              }}
            >
              确认重置
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
