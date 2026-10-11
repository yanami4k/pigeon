// 图片的核验与缩放（决策 416、417）：用 photon（Rust 编译成的 WASM，npm 包 @silvia-odwyer/photon-node）在进程内把要交给模型的
// 图片完整解码一遍；解不开的不交（坏图交出去，服务方拒收整条请求，且它留在历史里之后每次请求都会被拒）；超出单张上限的缩到
// 上限以内。首次用到时才载入（同步编译约 1.9 MB 的 wasm），载入失败记住、不再重试。
// 缩放：长边超过上限时等比缩到长边恰为上限（Lanczos3）；缩过的尽量保持原格式（PNG、WebP 照原格式编码，GIF 取第一帧编码为
// PNG）；编码后仍超字节上限，或只是字节超限（尺寸在限内），转 JPEG 并按质量 85、70、55、40 逐级降（原图是 JPEG 的直接从这里
// 开始）；都超即放弃。不处理 EXIF 方向；转 JPEG 时透明部分不保留。在限内又解得开的图原字节照交。
// 打包后的产物里 photon 按产物所在目录找 wasm（见 scripts/build-bundle.mjs）。
import type { ImageMimeType } from "./file-kind.ts";

export interface ImageLimits {
  // 长边像素上限
  maxEdge: number;
  // base64 编码后的字节数上限
  maxBase64Bytes: number;
}

// 要交出的那份：resized 为假即原字节
export interface PreparedImage {
  data: Buffer;
  mimeType: ImageMimeType;
  width: number;
  height: number;
  resized: boolean;
}

// 原图的类型与像素尺寸（取自文件头）
export interface SourceImage {
  mimeType: ImageMimeType;
  width: number;
  height: number;
}

// unavailable 图像库载入失败；undecodable 解不开；failed 缩放或编码出错；too-large 降到最低质量仍超限
export type PrepareFailure = "unavailable" | "undecodable" | "failed" | "too-large";

export type PrepareResult = { image: PreparedImage } | { failure: PrepareFailure };

export type ImagePreparer = (
  bytes: Uint8Array,
  source: SourceImage,
  limits: ImageLimits
) => Promise<PrepareResult>;

export type PhotonModule = typeof import("@silvia-odwyer/photon-node");
type PhotonImage = InstanceType<PhotonModule["PhotonImage"]>;

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
export function createPhotonPreparer(
  load: () => Promise<PhotonModule> = importPhoton
): ImagePreparer {
  let photon: Promise<PhotonModule> | undefined;
  return async (bytes, source, limits) => {
    photon ??= load();
    let lib: PhotonModule;
    try {
      lib = await photon;
    } catch {
      return { failure: "unavailable" };
    }
    let decoded: PhotonImage;
    try {
      decoded = lib.PhotonImage.new_from_byteslice(bytes);
    } catch {
      return { failure: "undecodable" };
    }
    try {
      return prepareDecoded(lib, decoded, bytes, source, limits);
    } catch {
      return { failure: "failed" };
    } finally {
      decoded.free();
    }
  };
}

function prepareDecoded(
  lib: PhotonModule,
  decoded: PhotonImage,
  bytes: Uint8Array,
  source: SourceImage,
  limits: ImageLimits
): PrepareResult {
  const longEdge = Math.max(source.width, source.height);
  const resized = longEdge > limits.maxEdge;
  if (!resized && base64Length(bytes.length) <= limits.maxBase64Bytes) {
    return {
      image: {
        data: Buffer.from(bytes),
        mimeType: source.mimeType,
        width: decoded.get_width(),
        height: decoded.get_height(),
        resized: false,
      },
    };
  }
  let image = decoded;
  try {
    if (resized) {
      const scale = limits.maxEdge / longEdge;
      const width = Math.max(1, Math.round(decoded.get_width() * scale));
      const height = Math.max(1, Math.round(decoded.get_height() * scale));
      image = lib.resize(decoded, width, height, lib.SamplingFilter.Lanczos3);
    }
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
          image: {
            data: Buffer.from(data),
            mimeType,
            width: image.get_width(),
            height: image.get_height(),
            resized: true,
          },
        };
      }
    }
    return { failure: "too-large" };
  } finally {
    if (image !== decoded) image.free();
  }
}

// 照原格式编码（JPEG 之外）：GIF 没有编码器，取第一帧编为 PNG
function sameFormat(image: PhotonImage, mimeType: ImageMimeType): [Uint8Array, ImageMimeType] {
  return mimeType === "image/webp"
    ? [image.get_bytes_webp(), "image/webp"]
    : [image.get_bytes(), "image/png"];
}

// 缺省的核验与缩放（整个进程共用一份载入）
export const photonPreparer: ImagePreparer = createPhotonPreparer();
