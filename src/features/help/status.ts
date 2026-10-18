import { useEffect, useState } from "react";
import { HelpRequest } from "@/domain/schemas";

export const statuses = {
  open: "等待帮助",
  assigned: "已确认帮助者",
  helper_done: "等待求助人确认",
  completed: "双方已完成",
  cancelled: "已取消",
};
export const appStatuses = {
  pending: "待选择",
  accepted: "已接受",
  rejected: "未被选择 / 已关闭",
  withdrawn: "已撤回",
};
export const actions = {
  publish: "发布求助",
  edit: "编辑求助",
  apply: "申请帮助",
  withdraw: "撤回申请",
  assign: "确认帮助者",
  "helper-done": "帮助者标记完成",
  complete: "求助人确认完成",
  cancel: "取消演示求助",
  checklist: "主人确认交接清单",
};
export function useClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
export function helpStatus(h: HelpRequest, now: number) {
  return h.status === "open" && Date.parse(h.startAt) <= now
    ? "已过期 · 不再接受申请"
    : statuses[h.status];
}
