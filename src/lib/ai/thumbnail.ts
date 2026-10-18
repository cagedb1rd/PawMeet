import { PHOTO_MAX_EDGE } from "./contracts";
import { inspectJpeg } from "./jpeg";

/** Longest edge scaled down to `max` (never up), integer pixels, at least 1px. */
export function thumbnailSize(
  width: number,
  height: number,
  max = PHOTO_MAX_EDGE,
) {
  if (!(width > 0 && height > 0)) throw new Error("无法读取照片尺寸");
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

type Bitmap = { width: number; height: number; close?: () => void };
type Canvas = {
  width: number;
  height: number;
  getContext(type: "2d"): {
    drawImage(image: never, x: number, y: number, w: number, h: number): void;
  } | null;
  toBlob(
    callback: (blob: Blob | null) => void,
    type: string,
    quality: number,
  ): void;
};
export type ThumbnailDeps = {
  decode: (blob: Blob) => Promise<Bitmap>;
  createCanvas: () => Canvas;
};
const browserDeps = (): ThumbnailDeps => ({
  // from-image applies the Exif orientation before the metadata is dropped by re-encoding.
  decode: (blob) => createImageBitmap(blob, { imageOrientation: "from-image" }),
  createCanvas: () => document.createElement("canvas") as unknown as Canvas,
});
/** Keeps the request well under the route's 170KB body limit. */
const MAX_BYTES = 100 * 1024;

export type Thumbnail = {
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
};

/**
 * Draws the photo onto a fresh canvas (longest edge ≤512px) and re-encodes it as JPEG, so the
 * original file, its Exif / GPS block and any other metadata never leave the browser. The
 * result is inspected again before it may be sent.
 */
export async function makeThumbnail(
  source: Blob,
  deps: ThumbnailDeps = browserDeps(),
): Promise<Thumbnail> {
  const bitmap = await deps.decode(source).catch(() => {
    throw new Error("无法解码照片，请换一张再识别");
  });
  try {
    const size = thumbnailSize(bitmap.width, bitmap.height);
    const canvas = deps.createCanvas();
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("当前浏览器无法处理照片");
    ctx.drawImage(bitmap as never, 0, 0, size.width, size.height);
    for (const quality of [0.85, 0.7, 0.55]) {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", quality),
      );
      if (!blob || blob.type !== "image/jpeg") continue;
      if (blob.size > MAX_BYTES) continue;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const info = inspectJpeg(bytes);
      if (
        !info ||
        info.metadata ||
        Math.max(info.width, info.height) > PHOTO_MAX_EDGE
      )
        throw new Error("缩略图检查未通过，已停止识别");
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return {
        dataUrl: `data:image/jpeg;base64,${btoa(binary)}`,
        width: info.width,
        height: info.height,
        bytes: bytes.length,
      };
    }
    throw new Error("照片压缩后仍过大，请换一张再识别");
  } finally {
    bitmap.close?.();
  }
}
