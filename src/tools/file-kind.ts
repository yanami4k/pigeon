// 文件内容的类型判定（决策 414），供 read_file 决定按文本、图片还是二进制交回。纯函数，不做 IO。
// 图片：按文件头（不看扩展名）认 PNG、JPEG、GIF、WebP 四种，并从头部读出像素尺寸（读不出尺寸的不当作可交出的图片）。
// 二进制：不是这四种图片时，满足任一条即判为二进制——
//   1. 开头 8000 字节里有 NUL（与 git 同一口径；UTF-16/32 编码的文本也落在这里）；
//   2. 文件头是认得的二进制格式（PDF、ZIP、gzip 等，见 SIGNATURES；PDF 开头像文本，靠这一条认）；
//   3. 开头 8000 字节里非法 UTF-8 序列的个数超过字节数的一成（其他编码的文本或无 NUL 的二进制）。
//      少量非法字节（个别 Latin-1 重音字母、截在采样末尾的多字节字符不算）不妨碍阅读，仍按文本读。

export type ImageMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface ImageInfo {
  mimeType: ImageMimeType;
  // 简称（PNG、JPEG、GIF、WebP）
  format: string;
  // 像素尺寸；文件头不完整或损坏、读不出时缺省
  width?: number;
  height?: number;
}

export interface BinaryInfo {
  // nul：开头有 NUL；format：认得的二进制格式；encoding：非法 UTF-8 序列占比超过一成
  reason: "nul" | "format" | "encoding";
  // 认得的格式名称（没认出缺省）
  format?: string;
  // reason 为 encoding 时：非法序列个数占采样字节数的比例
  invalidShare?: number;
}

// 采样长度（与 git 判二进制同一口径）
export const SNIFF_BYTES = 8000;
// 非法 UTF-8 序列占比超过它即判为二进制
export const INVALID_UTF8_SHARE = 0.1;

// 认得的二进制格式：偏移、文件头字节与名称。只收文件头足够特别、不会是文本开头的
const SIGNATURES: ReadonlyArray<{ at: number; magic: readonly number[] | string; name: string }> = [
  { at: 0, magic: "%PDF-", name: "PDF" },
  { at: 0, magic: [0x50, 0x4b, 0x03, 0x04], name: "ZIP（含 docx、xlsx、jar 等）" },
  { at: 0, magic: [0x1f, 0x8b], name: "gzip" },
  { at: 0, magic: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], name: "xz" },
  { at: 0, magic: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], name: "7z" },
  { at: 0, magic: [0x7f, 0x45, 0x4c, 0x46], name: "ELF 可执行文件" },
  { at: 0, magic: "SQLite format 3\0", name: "SQLite 数据库" },
  { at: 0, magic: [0x00, 0x61, 0x73, 0x6d], name: "WebAssembly" },
  { at: 0, magic: [0x49, 0x49, 0x2a, 0x00], name: "TIFF" },
  { at: 0, magic: [0x4d, 0x4d, 0x00, 0x2a], name: "TIFF" },
];

function matches(bytes: Uint8Array, at: number, magic: readonly number[] | string): boolean {
  const expected =
    typeof magic === "string" ? Array.from(magic, (char) => char.charCodeAt(0)) : magic;
  if (bytes.length < at + expected.length) return false;
  return expected.every((byte, index) => bytes[at + index] === byte);
}

const u16be = (b: Uint8Array, at: number) => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u16le = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, at: number) => u16le(b, at) | ((b[at + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, at: number) => u16be(b, at) * 0x10000 + u16be(b, at + 2);

function sized(info: ImageInfo, width: number, height: number): ImageInfo {
  return width > 0 && height > 0 ? { ...info, width, height } : info;
}

// 按文件头认图片并读尺寸；不是这四种图片返回 undefined
export function detectImage(bytes: Uint8Array): ImageInfo | undefined {
  if (matches(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    const info: ImageInfo = { mimeType: "image/png", format: "PNG" };
    // 第一个块须是 IHDR：宽、高各 4 字节（大端）
    return matches(bytes, 12, "IHDR") ? sized(info, u32be(bytes, 16), u32be(bytes, 20)) : info;
  }
  if (matches(bytes, 0, "GIF87a") || matches(bytes, 0, "GIF89a")) {
    const info: ImageInfo = { mimeType: "image/gif", format: "GIF" };
    return bytes.length >= 10 ? sized(info, u16le(bytes, 6), u16le(bytes, 8)) : info;
  }
  if (matches(bytes, 0, [0xff, 0xd8, 0xff])) {
    return jpegSize(bytes, { mimeType: "image/jpeg", format: "JPEG" });
  }
  if (matches(bytes, 0, "RIFF") && matches(bytes, 8, "WEBP")) {
    return webpSize(bytes, { mimeType: "image/webp", format: "WebP" });
  }
  return undefined;
}

// JPEG：逐段跳过，读第一个帧头（SOF0–SOF15，除去 DHT、JPG、DAC 三个同区段的标记）里的高与宽
function jpegSize(bytes: Uint8Array, info: ImageInfo): ImageInfo {
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return info;
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // 不带长度的标记
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      at += 2;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return at + 9 <= bytes.length
        ? sized(info, u16be(bytes, at + 7), u16be(bytes, at + 5))
        : info;
    }
    // 到了扫描数据还没有帧头：读不出
    if (marker === 0xda) return info;
    at += 2 + u16be(bytes, at + 2);
  }
  return info;
}

// WebP：有损（VP8 ）、无损（VP8L）与扩展（VP8X）三种首块各有尺寸写法
function webpSize(bytes: Uint8Array, info: ImageInfo): ImageInfo {
  if (matches(bytes, 12, "VP8 ") && bytes.length >= 30 && matches(bytes, 23, [0x9d, 0x01, 0x2a])) {
    return sized(info, u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff);
  }
  if (matches(bytes, 12, "VP8L") && bytes.length >= 25 && bytes[20] === 0x2f) {
    const b1 = bytes[22] ?? 0;
    const b2 = bytes[23] ?? 0;
    const b3 = bytes[24] ?? 0;
    const width = 1 + (((b1 & 0x3f) << 8) | (bytes[21] ?? 0));
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return sized(info, width, height);
  }
  if (matches(bytes, 12, "VP8X") && bytes.length >= 30) {
    return sized(info, 1 + u24le(bytes, 24), 1 + u24le(bytes, 27));
  }
  return info;
}

// 不是图片时判是否二进制（规则见文件头注释）；按文本读返回 undefined
export function detectBinary(bytes: Uint8Array): BinaryInfo | undefined {
  const format = SIGNATURES.find((entry) => matches(bytes, entry.at, entry.magic))?.name;
  const named = format !== undefined ? { format } : {};
  const sample = bytes.subarray(0, SNIFF_BYTES);
  if (sample.includes(0)) return { reason: "nul", ...named };
  if (format !== undefined) return { reason: "format", format };
  if (sample.length === 0) return undefined;
  // 解码时每个非法序列换成一个 U+FFFD；文件里本就写着的 U+FFFD（EF BF BD）不算。采样截断处不完整的多字节字符不算
  const text = new TextDecoder("utf-8").decode(sample, { stream: bytes.length > SNIFF_BYTES });
  let replaced = 0;
  for (const char of text) if (char === "�") replaced += 1;
  let literal = 0;
  for (let at = sample.indexOf(0xef); at >= 0; at = sample.indexOf(0xef, at + 1)) {
    if (sample[at + 1] === 0xbf && sample[at + 2] === 0xbd) literal += 1;
  }
  const invalidShare = (replaced - literal) / sample.length;
  return invalidShare > INVALID_UTF8_SHARE ? { reason: "encoding", invalidShare } : undefined;
}
