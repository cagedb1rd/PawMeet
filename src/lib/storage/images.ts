import { DemoState, ImageRef } from "@/domain/schemas";

export const IMAGE_LIMIT = 30,
  IMAGE_BYTES = 10 * 1024 * 1024;
type Record = { id: string; blob: Blob };
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("pawmeet-images", 1);
    req.onupgradeneeded = () =>
      req.result.createObjectStore("images", { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error("图片存储不可用，请检查浏览器设置"));
    req.onblocked = () =>
      reject(new Error("图片数据库升级被其他页面阻止，请关闭其他页面重试"));
  });
}
async function transaction<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("images", mode),
      req = work(tx.objectStore("images"));
    tx.oncomplete = () => {
      db.close();
      resolve(req.result);
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(new Error("图片保存或读取失败，请重试"));
    };
  });
}
export async function getImage(id: string): Promise<Blob | undefined> {
  return (await transaction<Record | undefined>("readonly", (s) => s.get(id)))
    ?.blob;
}
export async function removeImage(id: string) {
  await transaction("readwrite", (s) => s.delete(id));
}
export async function clearImages() {
  await transaction("readwrite", (s) => s.clear());
}
export async function storeImage(blob: Blob): Promise<ImageRef> {
  if (blob.size > 250 * 1024)
    throw new Error("压缩后图片仍超过 250KiB，请选择更简单或更小的照片");
  const db = await database();
  return new Promise((resolve, reject) => {
    // Quota check and insert share one readwrite transaction; no concurrent quota race.
    const tx = db.transaction("images", "readwrite"),
      store = tx.objectStore("images"),
      req = store.getAll();
    const id = crypto.randomUUID();
    let reason = "图片写入失败，请检查浏览器空间并重试";
    req.onsuccess = () => {
      const records: Record[] = req.result;
      if (
        records.length >= IMAGE_LIMIT ||
        records.reduce((n, r) => n + r.blob.size, 0) + blob.size > IMAGE_BYTES
      ) {
        reason =
          "上传图片已达 30 张或 10MiB 上限，请在“我的”清理未引用照片或重置";
        tx.abort();
        return;
      }
      store.add({ id, blob });
    };
    tx.oncomplete = () => {
      db.close();
      resolve({ kind: "upload", imageId: id });
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(new Error(reason));
    };
  });
}
export function uploadedIds(s: DemoState): Set<string> {
  const refs = [
    ...s.pets.map((p) => p.photo),
    ...s.posts.flatMap((p) => p.images),
    ...s.users.map((u) => u.avatar),
  ];
  return new Set(refs.flatMap((r) => (r.kind === "upload" ? [r.imageId] : [])));
}
export async function cleanUnusedImages(s: DemoState) {
  const used = uploadedIds(s),
    all = await transaction<Record[]>("readonly", (store) => store.getAll());
  for (const r of all) if (!used.has(r.id)) await removeImage(r.id);
}
export async function compressImage(file: File): Promise<Blob> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
    throw new Error("仅支持 JPEG、PNG 或 WebP 图片");
  if (file.size > 8 * 1024 * 1024) throw new Error("原图不能超过 8MiB");
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("无法解码图片，请选择有效的照片文件");
  });
  try {
    if (
      !bitmap.width ||
      !bitmap.height ||
      bitmap.width * bitmap.height > 50000000
    )
      throw new Error("图片尺寸过大，请先缩小后重试");
    const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("当前浏览器无法处理图片");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.82, 0.65, 0.48]) {
      const blob = await new Promise<Blob | null>((r) =>
        canvas.toBlob(r, "image/webp", quality),
      );
      if (blob && blob.size <= 250 * 1024) return blob;
    }
    throw new Error("照片压缩后仍过大，请更换照片");
  } finally {
    bitmap.close();
  }
}
