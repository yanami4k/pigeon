// 图片缩放（决策 416）：用 photon（Rust 编译成的 WASM，npm 包 @silvia-odwyer/photon-node）在进程内把超出单张上限的图片缩到
// 上限以内，供 read_file 交给能看图的模型。首次用到时才载入（同步编译约 1.9 MB 的 wasm），载入失败记住、不再重试；载入或处理
// 失败一律返回 undefined，由 read_file 退回只给元信息。
// 做法：长边超过上限时等比缩到长边恰为上限（Lanczos3）；缩过的尽量保持原格式（PNG、WebP 照原格式编码，JPEG 质量 85，GIF 取
// 第一帧编码为 PNG）；编码后仍超字节上限，或只是字节超限（尺寸在限内），转 JPEG 并按质量 85、70、55、40 逐级降；都超即放弃。
// 不处理 EXIF 方向；转 JPEG 时透明部分不保留。
// 打包后的产物里 photon 按产物所在目录找 wasm（见 scripts/build-bundle.mjs）。
import type { ImageMimeType } from "./file-kind.ts";

export interface ImageLimits {
  // 长边像素上限
  maxEdge: number;
  // base64 编码后的字节数上限
  maxBase64Bytes: number;
}

export interface ResizedImage {
  data: Buffer;
  mimeType: ImageMimeType;
  width: number;
  height: number;
}

// 原图的类型与像素尺寸（取自文件头）
export interface SourceImage {
  mimeType: ImageMimeType;
  width: number;
  height: number;
}

export type ImageResizer = (
  bytes: Uint8Array,
  source: SourceImage,
  limits: ImageLimits
) => Promise<ResizedImage | undefined>;

export type PhotonModule = typeof import("@silvia-odwyer/photon-node");

// 转 JPEG 时依次试的质量
const JPEG_QUALITIES = [85, 70, 55, 40] as const;

export const base64Length = (bytes: number): number => Math.ceil(bytes / 3) * 4;

async function importPhoton(): Promise<PhotonModule> {
  const loaded = (await import("@silvia-odwyer/photon-node")) as PhotonModule & {
    default?: PhotonModule;
  };
  // CommonJS 包：命名导出取不到时取 default
  return typeof loaded.PhotonImage === "function" ? loaded : (loaded.default as PhotonModule);
}

// load 供测试注入（例如模拟载入失败）
export function createPhotonResizer(
  load: () => Promise<PhotonModule> = importPhoton
): ImageResizer {
  let photon: Promise<PhotonModule> | undefined;
  return async (bytes, source, limits) => {
    photon ??= load();
    let lib: PhotonModule;
    try {
      lib = await photon;
    } catch {
      return undefined;
    }
    try {
      return resizeWith(lib, bytes, source, limits);
    } catch {
      return undefined;
    }
  };
}

function resizeWith(
  lib: PhotonModule,
  bytes: Uint8Array,
  source: SourceImage,
  limits: ImageLimits
): ResizedImage | undefined {
  const decoded = lib.PhotonImage.new_from_byteslice(bytes);
  let image = decoded;
  try {
    const longEdge = Math.max(source.width, source.height);
    const resized = longEdge > limits.maxEdge;
    if (resized) {
      const scale = limits.maxEdge / longEdge;
      const width = Math.max(1, Math.round(decoded.get_width() * scale));
      const height = Math.max(1, Math.round(decoded.get_height() * scale));
      image = lib.resize(decoded, width, height, lib.SamplingFilter.Lanczos3);
    }
    // 原图是 JPEG 的，照原格式即从下面的质量梯度开始
    const keepFormat = resized && source.mimeType !== "image/jpeg";
    const encodings: Array<() => [Uint8Array, ImageMimeType]> = [
      ...(keepFormat ? [() => sameFormat(image, source.mimeType)] : []),
      ...JPEG_QUALITIES.map((quality) => (): [Uint8Array, ImageMimeType] => [
        image.get_bytes_jpeg(quality),
        "image/jpeg",
      ]),
    ];
    for (const encode of encodings) {
      const [data, mimeType] = encode();
      if (base64Length(data.length) <= limits.maxBase64Bytes) {
        return {
          data: Buffer.from(data),
          mimeType,
          width: image.get_width(),
          height: image.get_height(),
        };
      }
    }
    return undefined;
  } finally {
    if (image !== decoded) image.free();
    decoded.free();
  }
}

// 照原格式编码（JPEG 之外）：GIF 没有编码器，取第一帧编为 PNG
function sameFormat(
  image: InstanceType<PhotonModule["PhotonImage"]>,
  mimeType: ImageMimeType
): [Uint8Array, ImageMimeType] {
  return mimeType === "image/webp"
    ? [image.get_bytes_webp(), "image/webp"]
    : [image.get_bytes(), "image/png"];
}

// 缺省的缩放器（整个进程共用一份载入）
export const photonResizer: ImageResizer = createPhotonResizer();
