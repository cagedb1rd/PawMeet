import { z } from "zod";
import {
  checklistInputSchema,
  DemoState,
  HelpRequest,
  helpInputSchema,
  socialCardInputSchema,
} from "./schemas";

export type Phase2Command =
  | { type: "save-card"; petId: string; petRevision: number; input: unknown }
  | {
      type: "save-help";
      helpId?: string;
      expectedRevision?: number;
      input: unknown;
    }
  | { type: "apply-help"; helpId: string; message: string }
  | { type: "withdraw-help"; helpId: string }
  | { type: "assign-help"; helpId: string; applicationId: string }
  | { type: "helper-done" | "complete-help" | "cancel-help"; helpId: string }
  | {
      type: "save-checklist";
      helpId: string;
      petRevision: number;
      requestRevision: number;
      input: unknown;
    };

export function checklistCurrent(s: DemoState, h: HelpRequest) {
  const c = s.careChecklists.find((c) => c.helpId === h.id);
  return (
    !!c &&
    c.petRevision === s.pets.find((p) => p.id === h.petId)?.revision &&
    c.requestRevision === h.contentRevision
  );
}

export function mutatePhase2(s: DemoState, command: Phase2Command, now: Date) {
  const uid = s.activeUserId,
    at = now.toISOString();
  const base = () => ({
    id: crypto.randomUUID(),
    createdAt: at,
    updatedAt: at,
    revision: 1,
  });
  const touch = (v: { revision: number; updatedAt: string }) => {
    v.revision++;
    v.updatedAt = at;
  };
  if (command.type === "save-card") {
    const p = s.pets.find((p) => p.id === command.petId && !p.archivedAt);
    if (!p || p.ownerId !== uid) throw Error("只有主人可以确认名片");
    if (p.revision !== command.petRevision)
      throw Error("档案已变更，请重新复核名片");
    const input = socialCardInputSchema.parse(command.input);
    const old = s.socialCards.find((c) => c.petId === p.id);
    const values = {
      ...input,
      petId: p.id,
      petRevision: p.revision,
      source: "manual" as const,
      confirmedAt: at,
      confirmedBy: uid,
    };
    if (old) {
      Object.assign(old, values);
      touch(old);
    } else s.socialCards.push({ ...base(), ...values });
    return;
  }
  if (command.type === "save-help" && !command.helpId) {
    if (s.helpRequests.length >= 100) throw Error("互助需求已达 100 条上限");
    const input = helpInputSchema.parse(command.input);
    if (
      !s.pets.some(
        (p) => p.id === input.petId && p.ownerId === uid && !p.archivedAt,
      )
    )
      throw Error("请选择本人的有效宠物");
    if (Date.parse(input.startAt) <= now.getTime())
      throw Error("请选择未来的互助时间");
    const h: HelpRequest = {
      ...base(),
      ...input,
      requesterId: uid,
      status: "open",
      helperId: null,
      acceptedApplicationId: null,
      contentRevision: 1,
    };
    s.helpRequests.unshift(h);
    s.helpEvents.push({
      ...base(),
      helpId: h.id,
      actorId: uid,
      action: "publish",
      fromState: "open",
      toState: "open",
    });
    return;
  }
  const h = s.helpRequests.find((h) => h.id === command.helpId);
  if (!h) throw Error("求助不存在");
  const owner = () => {
    if (uid !== h.requesterId) throw Error("只有求助人可以操作");
  };
  const before = h.status;
  const apps = s.helpApplications.filter((a) => a.helpId === h.id);
  const open = () => {
    if (h.status !== "open" || Date.parse(h.startAt) <= now.getTime())
      throw Error("求助已关闭或过期，不能申请或选择帮助者");
    if (s.pets.find((p) => p.id === h.petId)?.archivedAt)
      throw Error("宠物档案已归档");
  };
  const record = (action: DemoState["helpEvents"][number]["action"]) => {
    if (s.helpEvents.length >= 3000)
      throw Error("互助事件已达上限，请重置演示数据");
    s.helpEvents.push({
      ...base(),
      helpId: h.id,
      actorId: uid,
      action,
      fromState: before,
      toState: h.status,
    });
  };
  switch (command.type) {
    case "save-help": {
      owner();
      open();
      if (h.revision !== command.expectedRevision)
        throw Error("求助已更新，请重新打开表单");
      if (apps.some((a) => ["pending", "accepted"].includes(a.status)))
        throw Error("已有有效申请，请取消后重新发布");
      const input = helpInputSchema.parse(command.input);
      if (
        !s.pets.some(
          (p) => p.id === input.petId && p.ownerId === uid && !p.archivedAt,
        )
      )
        throw Error("请选择本人的有效宠物");
      if (Date.parse(input.startAt) <= now.getTime())
        throw Error("请选择未来的互助时间");
      Object.assign(h, input);
      h.contentRevision++;
      touch(h);
      record("edit");
      break;
    }
    case "apply-help": {
      open();
      if (uid === h.requesterId) throw Error("不能申请自己的求助");
      if (
        apps.some(
          (a) =>
            a.applicantId === uid && ["pending", "accepted"].includes(a.status),
        )
      )
        throw Error("不能重复申请");
      if (s.helpApplications.length >= 500) throw Error("申请记录已达上限");
      const message = z.string().trim().max(200).parse(command.message);
      s.helpApplications.push({
        ...base(),
        helpId: h.id,
        applicantId: uid,
        message,
        status: "pending",
      });
      record("apply");
      break;
    }
    case "withdraw-help": {
      const a = apps.find(
        (a) => a.applicantId === uid && a.status === "pending",
      );
      if (h.status !== "open" || !a) throw Error("只能撤回本人待确认申请");
      a.status = "withdrawn";
      touch(a);
      record("withdraw");
      break;
    }
    case "assign-help": {
      owner();
      if (
        h.acceptedApplicationId === command.applicationId &&
        h.status !== "cancelled"
      )
        return;
      open();
      const a = apps.find(
        (a) => a.id === command.applicationId && a.status === "pending",
      );
      if (!a) throw Error("申请无效或已撤回");
      if (!checklistCurrent(s, h)) throw Error("请先复核并确认当前交接清单");
      h.status = "assigned";
      h.helperId = a.applicantId;
      h.acceptedApplicationId = a.id;
      for (const item of apps.filter((a) => a.status === "pending")) {
        item.status = item.id === a.id ? "accepted" : "rejected";
        touch(item);
      }
      touch(h);
      record("assign");
      break;
    }
    case "helper-done": {
      if (uid !== h.helperId) throw Error("只有被选帮助者可以标记完成");
      if (["helper_done", "completed"].includes(h.status)) return;
      if (h.status !== "assigned") throw Error("当前状态不能标记完成");
      if (!checklistCurrent(s, h))
        throw Error("交接清单已失效，请求助人重新确认");
      h.status = "helper_done";
      touch(h);
      record("helper-done");
      break;
    }
    case "complete-help": {
      owner();
      if (h.status === "completed") return;
      if (h.status !== "helper_done")
        throw Error("请等待帮助者标记完成，不能跳过状态");
      h.status = "completed";
      touch(h);
      record("complete");
      break;
    }
    case "cancel-help": {
      owner();
      if (h.status === "cancelled") return;
      if (
        !["open", "assigned"].includes(h.status) ||
        Date.parse(h.startAt) <= now.getTime()
      )
        throw Error("仅能取消未开始的开放或已指派求助");
      h.status = "cancelled";
      for (const a of apps.filter((a) => a.status === "pending")) {
        a.status = "rejected";
        touch(a);
      }
      touch(h);
      record("cancel");
      break;
    }
    case "save-checklist": {
      owner();
      if (!["open", "assigned"].includes(h.status))
        throw Error("当前状态不能编辑交接清单");
      const p = s.pets.find((p) => p.id === h.petId)!;
      if (
        p.revision !== command.petRevision ||
        h.contentRevision !== command.requestRevision
      )
        throw Error("来源已变更，请重新复核清单");
      const input = checklistInputSchema.parse(command.input);
      const c = s.careChecklists.find((c) => c.helpId === h.id);
      const values = {
        ...input,
        helpId: h.id,
        petRevision: p.revision,
        requestRevision: h.contentRevision,
        source: "manual" as const,
        confirmedBy: uid,
        confirmedAt: at,
      };
      if (c) {
        Object.assign(c, values);
        touch(c);
      } else s.careChecklists.push({ ...base(), ...values });
      record("checklist");
      break;
    }
  }
}
