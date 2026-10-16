import { describe, expect, it } from "vitest";
import { createSeed } from "@/data/seed";
import { execute } from "@/domain/commands";
import { communityPosts, postTitle } from "@/domain/community";
import { stateSchema } from "@/domain/schemas";
import { commit, readState, STATE_KEY } from "@/lib/storage/repository";

describe("社区关注、搜索与兼容数据", () => {
  it("旧 v2 快照只补默认值，不覆盖存储或原有帖子", () => {
    const old = JSON.parse(JSON.stringify(createSeed()));
    delete old.follows;
    old.posts.forEach((p: { title?: string }) => delete p.title);
    const raw = JSON.stringify(old);
    const store = {
      getItem: () => raw,
      setItem: () => {
        throw Error("不能自动写入");
      },
    };
    const next = readState(store);
    expect(next.follows).toEqual([]);
    expect(next.posts.map((p) => p.text)).toEqual(
      old.posts.map((p: { text: string }) => p.text),
    );
    expect(next.posts.every((p) => p.title === "")).toBe(true);
    expect(postTitle(next.posts[0])).toBe(next.posts[0].text.split("\n")[0]);
  });
  it("关注实际约束流、每身份隔离、取消和刷新保留", () => {
    let raw = JSON.stringify(createSeed());
    const store = {
      getItem: (key: string) => (key === STATE_KEY ? raw : null),
      setItem: (_key: string, value: string) => {
        raw = value;
      },
    };
    const original = readState(store);
    expect(communityPosts(original, true)).toEqual([]);
    const followed = commit(store, original, {
      type: "toggle-follow",
      userId: "user-2",
    });
    expect(communityPosts(readState(store), true)).toEqual(
      original.posts.filter((p) => p.authorId === "user-2"),
    );
    expect(communityPosts(followed)).toEqual(original.posts);
    const switched = commit(store, followed, {
      type: "switch-user",
      userId: "user-3",
    });
    expect(communityPosts(switched, true)).toEqual([]);
    const returned = commit(store, switched, {
      type: "switch-user",
      userId: "user-1",
    });
    const removed = commit(store, returned, {
      type: "toggle-follow",
      userId: "user-2",
    });
    expect(readState(store)).toEqual(removed);
    expect(removed.follows).toEqual([]);
  });
  it("拒绝自己、未知身份、重复及无效关注引用；写失败保留原数据", () => {
    const s = createSeed();
    for (const userId of [s.activeUserId, "missing"])
      expect(() => execute(s, { type: "toggle-follow", userId })).toThrow();
    const relation = { followerId: "user-1", followingId: "user-2" };
    expect(
      stateSchema.safeParse({ ...s, follows: [relation, relation] }).success,
    ).toBe(false);
    expect(
      stateSchema.safeParse({
        ...s,
        follows: [{ ...relation, followerId: "user-6" }],
      }).success,
    ).toBe(false);
    const raw = JSON.stringify(s);
    expect(() =>
      commit(
        {
          getItem: () => raw,
          setItem: () => {
            throw Error("quota");
          },
        },
        s,
        { type: "toggle-follow", userId: "user-2" },
      ),
    ).toThrow("保存失败");
    expect(s.follows).toEqual([]);
  });
  it("标题和正文搜索均命中，大小写与空白不影响结果，空结果不放宽", () => {
    const s = execute(createSeed(), {
      type: "publish-post",
      input: {
        title: "草地 PAWS",
        text: "今天拍到了蝴蝶",
        images: [],
        petIds: [],
      },
    });
    const post = s.posts[0];
    expect(communityPosts(s, false, " paws ")).toEqual([post]);
    expect(communityPosts(s, false, "蝴蝶")).toEqual([post]);
    expect(communityPosts(s, false, "不存在的内容")).toEqual([]);
    expect(communityPosts(s, true, "蝴蝶")).toEqual([]);
  });
});
