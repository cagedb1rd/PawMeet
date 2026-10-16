import { beforeEach, describe, expect, it, vi } from "vitest";
import { indexedDB, IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { createSeed } from "@/data/seed";
import {
  commit,
  MAX_STATE_BYTES,
  readState,
  STATE_KEY,
  writeState,
} from "@/lib/storage/repository";
import {
  cleanUnusedImages,
  clearImages,
  compressImage,
  getImage,
  storeImage,
} from "@/lib/storage/images";
function memory() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}
describe("结构化存储", () => {
  it("首次初始化、刷新恢复与重置", () => {
    const store = memory();
    const s = readState(store);
    const next = commit(store, s, {
      type: "toggle-like",
      postId: s.posts[0].id,
    });
    expect(readState(store)).toEqual(next);
    writeState(store, createSeed());
    expect(readState(store).posts).toHaveLength(12);
  });
  it("损坏 / 未来版本保留原文，禁止静默重建", () => {
    const store = memory();
    for (const raw of [
      "{bad",
      JSON.stringify({ ...createSeed(), schemaVersion: 9 }),
    ]) {
      store.setItem(STATE_KEY, raw);
      expect(() => readState(store)).toThrow("损坏或版本");
      expect(store.getItem(STATE_KEY)).toBe(raw);
    }
  });
  it("存储读取 / 写入失败不报告成功，不改变原快照", () => {
    expect(() =>
      readState({
        getItem: () => {
          throw Error();
        },
        setItem: () => {},
      }),
    ).toThrow("不允许读取");
    const store = memory();
    const s = readState(store);
    const old = store.getItem(STATE_KEY);
    const broken = {
      getItem: store.getItem,
      setItem: () => {
        throw Error("quota");
      },
    };
    expect(() =>
      commit(broken, s, { type: "toggle-like", postId: s.posts[0].id }),
    ).toThrow("保存失败");
    expect(store.getItem(STATE_KEY)).toBe(old);
    expect(s.revision).toBe(0);
  });
  it("外部变更与清除拒绝旧 revision 写入", () => {
    const store = memory();
    const s = readState(store);
    commit(store, s, { type: "switch-user", userId: "user-2" });
    expect(() =>
      commit(store, s, { type: "switch-user", userId: "user-3" }),
    ).toThrow("其他页面");
    const empty = memory();
    expect(() =>
      commit(empty, s, { type: "switch-user", userId: "user-2" }),
    ).toThrow("已被清除");
    expect(empty.getItem(STATE_KEY)).toBeNull();
  });
  it("超过 2MiB 预算的合法数据不能写入", () => {
    const store = memory(),
      s = createSeed();
    for (let i = 0; i < 75; i++)
      s.users.push({ ...s.users[0], id: `large-${i}-${"x".repeat(90)}` });
    const likes = s.users.map((u) => u.id);
    for (const p of s.posts) {
      p.likedByUserIds = likes;
      p.text = "文".repeat(1000);
    }
    for (let i = 0; i < 88; i++)
      s.posts.push({ ...s.posts[0], id: `big-${i}` });
    for (let i = 0; i < 100; i++)
      s.pets.push({
        ...s.pets[0],
        id: `large-${i}`,
        socialNotes: "大".repeat(500),
      });
    expect(JSON.stringify(s).length * 2).toBeGreaterThan(MAX_STATE_BYTES);
    expect(() => writeState(store, s)).toThrow("2MiB");
    expect(store.getItem(STATE_KEY)).toBeNull();
  });
});
describe("图片存储与输入故障", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
  });
  it("图片 Blob 单独存放，清理只删除未引用照片", async () => {
    const ref = await storeImage(new Blob(["photo"], { type: "image/webp" }));
    expect(ref.kind).toBe("upload");
    if (ref.kind !== "upload") throw Error();
    expect((await getImage(ref.imageId))?.size).toBe(5);
    const s = createSeed();
    s.pets[0].photo = ref;
    await cleanUnusedImages(s);
    expect(await getImage(ref.imageId)).toBeDefined();
    await clearImages();
    expect(await getImage(ref.imageId)).toBeUndefined();
  });
  it("限制 30 张与单图大小", async () => {
    await expect(
      storeImage(new Blob([new Uint8Array(256001)])),
    ).rejects.toThrow("250KiB");
    for (let i = 0; i < 30; i++) await storeImage(new Blob(["a"]));
    await expect(storeImage(new Blob(["a"]))).rejects.toThrow("30 张");
  });
  it("IndexedDB 写入中止与不可用明确失败", async () => {
    vi.stubGlobal("indexedDB", {
      open() {
        const request: { onerror?: () => void } = {};
        queueMicrotask(() => request.onerror?.());
        return request;
      },
    });
    await expect(storeImage(new Blob(["a"]))).rejects.toThrow("不可用");
    vi.stubGlobal("indexedDB", indexedDB);
  });
  it("图片事务中止不能返回 ImageRef", async () => {
    const original = IDBObjectStore.prototype.add;
    const spy = vi
      .spyOn(IDBObjectStore.prototype, "add")
      .mockImplementation(function (this: IDBObjectStore, value, key) {
        const req = original.call(this, value, key);
        this.transaction.abort();
        return req;
      });
    try {
      await expect(storeImage(new Blob(["a"]))).rejects.toThrow("写入失败");
    } finally {
      spy.mockRestore();
    }
  });
  it("拒绝错误类型、超大原图、无法解码文件", async () => {
    await expect(
      compressImage(new File(["a"], "a.txt", { type: "text/plain" })),
    ).rejects.toThrow("仅支持");
    await expect(
      compressImage(
        new File([new Uint8Array(8388609)], "a.png", { type: "image/png" }),
      ),
    ).rejects.toThrow("8MiB");
    vi.stubGlobal("createImageBitmap", () => Promise.reject(Error("decode")));
    await expect(
      compressImage(new File(["bad"], "bad.png", { type: "image/png" })),
    ).rejects.toThrow("无法解码");
  });
});
