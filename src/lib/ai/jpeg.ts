/**
 * Minimal JPEG inspector shared by the browser (checks its own thumbnail) and the server
 * (re-checks what it receives). Reads segment markers only; never decodes pixels.
 */
export type JpegInfo = {
  width: number;
  height: number;
  /** APP1 Exif or XMP metadata (camera, time, GPS) is present. */
  metadata: boolean;
};
const SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
const ascii = (b: Uint8Array, at: number, text: string) =>
  [...text].every((c, i) => b[at + i] === c.charCodeAt(0));

/** Returns null for anything that is not a well-formed baseline/progressive JPEG header. */
export function inspectJpeg(bytes: Uint8Array): JpegInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let metadata = false;
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // no frame header before scan
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length < 2 || i + 2 + length > bytes.length) return null;
    const start = i + 4;
    if (
      marker === 0xe1 &&
      (ascii(bytes, start, "Exif\0") || ascii(bytes, start, "http://ns.adobe"))
    )
      metadata = true;
    if (SOF.has(marker)) {
      if (length < 7) return null;
      const height = (bytes[start + 1] << 8) | bytes[start + 2];
      const width = (bytes[start + 3] << 8) | bytes[start + 4];
      if (!width || !height) return null;
      // Keep scanning would need the scan data; metadata segments precede SOF in practice.
      return { width, height, metadata };
    }
    i += 2 + length;
  }
  return null;
}

export function base64ToBytes(base64: string): Uint8Array {
  if (typeof Buffer !== "undefined")
    return new Uint8Array(Buffer.from(base64, "base64"));
  const raw = atob(base64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Parses a `data:image/jpeg;base64,…` URL; null when it is not one. */
export function inspectJpegDataUrl(dataUrl: string): JpegInfo | null {
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+=*)$/.exec(dataUrl);
  return match ? inspectJpeg(base64ToBytes(match[1])) : null;
}
