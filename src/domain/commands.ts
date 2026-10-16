import {
  activityInputSchema,
  DemoState,
  petInputSchema,
  postInputSchema,
  stateSchema,
} from "./schemas";
import { mutatePhase2, Phase2Command } from "./phase2";

export type Command =
  | Phase2Command
  | { type: "switch-user"; userId: string }
  | { type: "save-pet"; input: unknown; petId?: string }
  | { type: "delete-pet"; petId: string }
  | { type: "publish-post"; input: unknown }
  | { type: "toggle-like"; postId: string }
  | { type: "create-activity"; input: unknown }
  | { type: "join-activity"; activityId: string; petId: string }
  | { type: "leave-activity"; activityId: string }
  | { type: "cancel-activity"; activityId: string };

export function execute(
  state: DemoState,
  command: Command,
  now = new Date(),
): DemoState {
  const s = structuredClone(state),
    uid = s.activeUserId,
    at = now.toISOString();
  const base = () => ({
    id: crypto.randomUUID(),
    createdAt: at,
    updatedAt: at,
    revision: 1,
  });
  const mine = (pid: string) => {
    const p = s.pets.find((p) => p.id === pid && !p.archivedAt);
    if (!p || p.ownerId !== uid)
      throw new Error("请选择当前身份拥有的有效宠物");
    return p;
  };
  const touch = (v: { updatedAt: string; revision: number }) => {
    v.updatedAt = at;
    v.revision++;
  };
  switch (command.type) {
    case "switch-user": {
      if (!s.users.some((u) => u.id === command.userId && u.isSwitchable))
        throw new Error("该身份不可切换");
      s.activeUserId = command.userId;
      break;
    }
    case "save-pet": {
      const input = petInputSchema.parse(command.input);
      if (command.petId) {
        const p = mine(command.petId);
        Object.assign(p, input);
        touch(p);
      } else {
        if (s.pets.length >= 150)
          throw new Error("宠物档案已达上限，请重置演示数据");
        s.pets.push({ ...base(), ...input, ownerId: uid, archivedAt: null });
      }
      break;
    }
    case "delete-pet": {
      const p = mine(command.petId);
      if (
        s.activitySignups.some(
          (v) =>
            v.petId === p.id &&
            v.status === "joined" &&
            s.activities.some(
              (a) =>
                a.id === v.activityId &&
                a.status === "scheduled" &&
                Date.parse(a.endAt) > now.getTime(),
            ),
        )
      )
        throw new Error("该宠物还有未结束的活动，请先取消报名或取消主办活动");
      if (
        s.helpRequests.some(
          (h) =>
            h.petId === p.id &&
            (["assigned", "helper_done"].includes(h.status) ||
              (h.status === "open" && Date.parse(h.startAt) > now.getTime())),
        )
      )
        throw new Error("该宠物仍有关联的互助需求，暂不能删除");
      p.archivedAt = at;
      touch(p);
      break;
    }
    case "publish-post": {
      if (s.posts.length >= 100)
        throw new Error("动态已达 100 条上限，请重置演示数据");
      const input = postInputSchema.parse(command.input);
      input.petIds.forEach(mine);
      s.posts.unshift({
        ...base(),
        ...input,
        authorId: uid,
        likedByUserIds: [],
      });
      break;
    }
    case "toggle-like": {
      const p = s.posts.find((p) => p.id === command.postId);
      if (!p) throw new Error("动态不存在");
      p.likedByUserIds = p.likedByUserIds.includes(uid)
        ? p.likedByUserIds.filter((id) => id !== uid)
        : [...p.likedByUserIds, uid];
      touch(p);
      break;
    }
    case "create-activity": {
      if (s.activities.length >= 100)
        throw new Error("活动已达 100 场上限，请重置演示数据");
      const input = activityInputSchema.parse(command.input);
      mine(input.organizerPetId);
      if (Date.parse(input.startAt) <= now.getTime())
        throw new Error("请选择未来的活动时间");
      if (
        input.recommendedPetIds.some(
          (id) => !s.pets.some((p) => p.id === id && !p.archivedAt),
        )
      )
        throw new Error("推荐宠物不存在");
      const a = {
        ...base(),
        ...input,
        organizerId: uid,
        status: "scheduled" as const,
      };
      s.activities.unshift(a);
      s.activitySignups.push({
        ...base(),
        activityId: a.id,
        userId: uid,
        petId: a.organizerPetId,
        status: "joined",
      });
      break;
    }
    case "join-activity":
    case "leave-activity":
    case "cancel-activity": {
      const a = s.activities.find((a) => a.id === command.activityId);
      if (!a) throw new Error("活动不存在");
      if (a.status !== "scheduled" || Date.parse(a.startAt) <= now.getTime())
        throw new Error("活动已取消或已开始，不能变更报名");
      const signup = s.activitySignups.find(
        (v) => v.activityId === a.id && v.userId === uid,
      );
      if (command.type === "cancel-activity") {
        if (a.organizerId !== uid) throw new Error("只有组织者可以取消活动");
        a.status = "cancelled";
      } else if (command.type === "leave-activity") {
        if (a.organizerId === uid) throw new Error("组织者请使用取消活动");
        if (!signup || signup.status !== "joined")
          throw new Error("你尚未报名");
        signup.status = "cancelled";
        touch(signup);
      } else {
        mine(command.petId);
        if (signup?.status === "joined") throw new Error("当前身份已报名");
        if (
          s.activitySignups.filter(
            (v) => v.activityId === a.id && v.status === "joined",
          ).length >= a.capacity
        )
          throw new Error("活动名额已满");
        if (signup) {
          signup.status = "joined";
          signup.petId = command.petId;
          touch(signup);
        } else
          s.activitySignups.push({
            ...base(),
            activityId: a.id,
            userId: uid,
            petId: command.petId,
            status: "joined",
          });
      }
      touch(a);
      break;
    }
    default:
      mutatePhase2(s, command, now);
  }
  s.revision++;
  return stateSchema.parse(s);
}
