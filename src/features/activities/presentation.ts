import type { Activity } from "@/domain/schemas";

// Display state only; command validation remains authoritative for signup.
export function activityStatus(
  activity: Activity,
  joined: number,
  now: number,
) {
  if (activity.status === "cancelled")
    return { label: "已取消", tone: "neutral" };
  if (Date.parse(activity.endAt) <= now)
    return { label: "已结束", tone: "neutral" };
  if (Date.parse(activity.startAt) <= now)
    return { label: "进行中", tone: "warm" };
  if (joined >= activity.capacity) return { label: "名额已满", tone: "warm" };
  return { label: "报名开放中", tone: "green" };
}
