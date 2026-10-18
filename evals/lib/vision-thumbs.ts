import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { PRIVATE_DIR, PUBLIC_DIR, type VisionCase } from "../cases/vision";

/**
 * Builds the same thumbnail the browser sends: decoded with Exif orientation, drawn on a
 * canvas with the longest edge ≤512px and re-encoded as JPEG (quality 0.85 → 0.7 → 0.55 until
 * ≤100KB), mirroring src/lib/ai/thumbnail.ts in a real Chromium. Originals (which may carry
 * Exif / GPS) are never sent; the server-side thumbnailPart check runs on every result.
 * Cache: .local/ai-eval/vision-thumbs (git-ignored).
 */
export async function buildThumbnails(
  cases: VisionCase[],
  cacheDir = ".local/ai-eval/vision-thumbs",
): Promise<Map<string, string>> {
  await mkdir(cacheDir, { recursive: true });
  const out = new Map<string, string>();
  const missing: VisionCase[] = [];
  for (const c of cases) {
    try {
      const cached = await readFile(path.join(cacheDir, `${c.id}.jpg`));
      out.set(c.id, `data:image/jpeg;base64,${cached.toString("base64")}`);
    } catch {
      missing.push(c);
    }
  }
  if (!missing.length) return out;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (const c of missing) {
      const file = path.join(
        c.source === "public" ? PUBLIC_DIR : PRIVATE_DIR,
        c.file,
      );
      const original = (await readFile(file)).toString("base64");
      const base64 = await page.evaluate(
        async ({ original, type }) => {
          const bytes = Uint8Array.from(atob(original), (ch) =>
            ch.charCodeAt(0),
          );
          const bitmap = await createImageBitmap(new Blob([bytes], { type }), {
            imageOrientation: "from-image",
          });
          const scale = Math.min(
            1,
            512 / Math.max(bitmap.width, bitmap.height),
          );
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(bitmap.width * scale));
          canvas.height = Math.max(1, Math.round(bitmap.height * scale));
          canvas
            .getContext("2d")!
            .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          bitmap.close();
          for (const quality of [0.85, 0.7, 0.55]) {
            const blob = await new Promise<Blob | null>((r) =>
              canvas.toBlob(r, "image/jpeg", quality),
            );
            if (!blob || blob.size > 100 * 1024) continue;
            const buf = new Uint8Array(await blob.arrayBuffer());
            let s = "";
            for (let i = 0; i < buf.length; i += 0x8000)
              s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
            return btoa(s);
          }
          throw Error("thumbnail too large");
        },
        {
          original,
          type: /\.png$/i.test(c.file)
            ? "image/png"
            : /\.webp$/i.test(c.file)
              ? "image/webp"
              : "image/jpeg",
        },
      );
      await writeFile(
        path.join(cacheDir, `${c.id}.jpg`),
        Buffer.from(base64, "base64"),
      );
      out.set(c.id, `data:image/jpeg;base64,${base64}`);
    }
  } finally {
    await browser.close();
  }
  return out;
}
