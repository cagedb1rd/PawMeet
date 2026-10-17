import { describe, expect, it } from "vitest";
import { createSeed } from "../../src/data/seed";
import { activityStatus } from "../../src/features/activities/presentation";
import { describeFormError } from "../../src/features/forms/feedback";
import { activityInputSchema, petInputSchema } from "../../src/domain/schemas";

describe("活动展示与表单反馈", () => {
  const now = Date.parse("2026-10-17T02:00:00Z");
  const state = createSeed(new Date(now));
  const activity = state.activities[0];
  it("按取消、结束、进行中、已满、开放显示状态，并包含时间边界", () => {
    expect(activityStatus(activity, 1, now).label).toBe("报名开放中");
    expect(activityStatus(activity, activity.capacity, now).label).toBe(
      "名额已满",
    );
    expect(
      activityStatus(activity, activity.capacity, Date.parse(activity.startAt))
        .label,
    ).toBe("进行中");
    expect(
      activityStatus(activity, activity.capacity, Date.parse(activity.endAt))
        .label,
    ).toBe("已结束");
    expect(
      activityStatus(
        { ...activity, status: "cancelled" },
        1,
        Date.parse(activity.endAt),
      ).label,
    ).toBe("已取消");
  });
  it("跨字段时间错误映射到结束时间，保留业务中文约束", () => {
    const {
      organizerId: _owner,
      status: _status,
      id: _id,
      createdAt: _created,
      updatedAt: _updated,
      revision: _revision,
      ...input
    } = activity;
    void [_owner, _status, _id, _created, _updated, _revision];
    const result = activityInputSchema.safeParse({
      ...input,
      endAt: input.startAt,
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(describeFormError(result.error)).toEqual([
        { name: "endAt", message: "结束时间必须晚于开始时间" },
      ]);
  });
  it("原生校验错误使用中文字段名，不暴露 Schema 英文消息", () => {
    const result = petInputSchema.safeParse({ name: "", ageMonths: -1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const errors = describeFormError(result.error);
      expect(errors).toContainEqual({
        name: "age",
        message: "月龄未填写或低于允许的最小值",
      });
      expect(
        errors.every(
          (e) => !e.message.includes("Invalid") && !e.message.includes("Too"),
        ),
      ).toBe(true);
    }
  });
});
