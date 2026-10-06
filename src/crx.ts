export interface CrxInfo {
  zip: ArrayBuffer;
  /** Extension id recovered from the CRX header, when present. */
  crxId: string | null;
  publicKey: Uint8Array | null;
}

export function crxToZip(buffer: ArrayBuffer): ArrayBuffer {
  return parseCrx(buffer).zip;
}

export function parseCrx(buffer: ArrayBuffer): CrxInfo {
  const view = new DataView(buffer);
  if (buffer.byteLength < 12) return { zip: buffer, crxId: null, publicKey: null };
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== "Cr24") return { zip: buffer, crxId: null, publicKey: null };
  const version = view.getUint32(4, true);
  if (version === 2) {
    const pubKeyLen = view.getUint32(8, true);
    const sigLen = view.getUint32(12, true);
    const publicKey = new Uint8Array(buffer.slice(16, 16 + pubKeyLen));
    return { zip: buffer.slice(16 + pubKeyLen + sigLen), crxId: null, publicKey };
  }
  if (version === 3) {
    const headerSize = view.getUint32(8, true);
    const header = new Uint8Array(buffer, 12, headerSize);
    return { zip: buffer.slice(12 + headerSize), crxId: crx3Id(header), publicKey: null };
  }
  throw new Error(`unknown CRX version: ${version}`);
}

// CrxFileHeader { ...; bytes signed_header_data = 10000; }
// SignedData { bytes crx_id = 1; }   (crx_id is the first 16 bytes of the id hash)
function crx3Id(header: Uint8Array): string | null {
  const signed = protoField(header, 10000);
  if (!signed) return null;
  const crxId = protoField(signed, 1);
  if (!crxId || crxId.length !== 16) return null;
  return bytesToExtensionId(crxId);
}

function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  while (pos < buf.length) {
    const b = buf[pos++];
    result += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return [result, pos];
}

function protoField(buf: Uint8Array, wanted: number): Uint8Array | null {
  let pos = 0;
  while (pos < buf.length) {
    const [key, afterKey] = readVarint(buf, pos);
    pos = afterKey;
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === 2) {
      const [len, afterLen] = readVarint(buf, pos);
      if (field === wanted) return buf.subarray(afterLen, afterLen + len);
      pos = afterLen + len;
    } else if (wire === 0) {
      pos = readVarint(buf, pos)[1];
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else {
      return null;
    }
  }
  return null;
}

/** Chrome ids are the first 128 bits of a SHA-256, hex-encoded with a-p for 0-f. */
function bytesToExtensionId(bytes: Uint8Array): string {
  let id = "";
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (bytes[i] >> 4)) + String.fromCharCode(97 + (bytes[i] & 15));
  }
  return id;
}

export async function extensionIdFromPublicKey(key: Uint8Array | string): Promise<string> {
  const bytes = typeof key === "string" ? Uint8Array.from(atob(key.replace(/\s+/g, "")), (c) => c.charCodeAt(0)) : key;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return bytesToExtensionId(digest);
}

/** Unpacked extensions in Chrome get an id hashed from their path; the name is our stand-in. */
export async function extensionIdFromSeed(seed: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)));
  return bytesToExtensionId(digest);
}

/** Kept for API compatibility with older hosts; not an a-p id. */
export function generateExtensionId(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  const chars = "abcdefghijklmnopqrstuvwxyz";
  let id = "";
  let n = Math.abs(hash);
  for (let i = 0; i < 32; i++) {
    id += chars[n % 26];
    n = Math.floor(n / 26) + i * 7;
  }
  return id.substring(0, 32);
}

const MIME_TYPES: Record<string, string> = {
  js: "application/javascript",
  mjs: "application/javascript",
  cjs: "application/javascript",
  css: "text/css",
  html: "text/html",
  htm: "text/html",
  xhtml: "application/xhtml+xml",
  json: "application/json",
  map: "application/json",
  txt: "text/plain",
  xml: "application/xml",
  csv: "text/csv",
  md: "text/markdown",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  cur: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  wasm: "application/wasm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  mp4: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  pdf: "application/pdf",
  zip: "application/zip",
};

export function guessMime(path: string): string {
  const ext = path.split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? "";
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

export function isTextMime(mime: string): boolean {
  return /^text\/|javascript|json|xml|svg/.test(mime);
}
