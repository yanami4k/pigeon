// 图片交出前的关口（决策 414、416、417）：交给模型的图片——read_file 读到的与其他工具（MCP）返回的——都先按文件头认类型与
// 尺寸，再经 photon 完整解码一遍、超出单张上限的缩小（image-resize.ts）；认不出、解不开、缩不下或图像库载入失败的不交出，
// 换成一行说明。read_file 自己排版那一行；其他工具的结果经 withImageGate 逐个图片块过关。
import type { TSchema } from "typebox";
import { detectImage, type ImageInfo } from "./file-kind.ts";
import type { ImagePreparer, PreparedImage, PrepareFailure } from "./image-resize.ts";
import type { PigeonAgentTool, PigeonToolResult } from "./wrap.ts";

// 单张上限：长边像素与 base64 编码后的字节数（依据见审计 2026-10-11-read-file-images）
export const IMAGE_MAX_EDGE = 2000;
export const IMAGE_MAX_BASE64_BYTES = 5_000_000;
export const IMAGE_MAX_MB = `${IMAGE_MAX_BASE64_BYTES / 1_000_000} MB`;

const FAILURES: Readonly<Record<PrepareFailure, string>> = {
  unavailable: "图像库载入失败，无法核验与缩放",
  undecodable: "图片解不开（文件可能损坏或截断）",
  failed: "图片处理出错",
  "too-large": `超出单张图片上限（长边 ${IMAGE_MAX_EDGE} 像素、编码后 ${IMAGE_MAX_MB}），自动缩小后仍超限`,
};

export type GateResult =
  | { info: ImageInfo; image: PreparedImage }
  | { info?: ImageInfo; withheld: string };

// 一张图过关：交出的那份，或不交出的原因（一句话，不带句号）
export async function gateImage(bytes: Uint8Array, prepare: ImagePreparer): Promise<GateResult> {
  const info = detectImage(bytes);
  if (info === undefined) return { withheld: "不是 PNG、JPEG、GIF、WebP 图片" };
  const { width, height } = info;
  if (width === undefined || height === undefined) {
    return { info, withheld: "读不出像素尺寸（文件头不完整或已损坏）" };
  }
  const result = await prepare(
    bytes,
    { mimeType: info.mimeType, width, height },
    { maxEdge: IMAGE_MAX_EDGE, maxBase64Bytes: IMAGE_MAX_BASE64_BYTES }
  );
  return "image" in result
    ? { info, image: result.image }
    : { info, withheld: FAILURES[result.failure] };
}

// 交出的图缩过时的说明：交出的格式、尺寸、字节数与坐标换算倍数
export function resizedNote(info: ImageInfo, image: PreparedImage): string {
  const format = image.mimeType.slice("image/".length).toUpperCase();
  const scale = Math.round(((info.width ?? image.width) / image.width) * 100) / 100;
  return (
    `超出单张上限，已缩小为 ${format} ${image.width}×${image.height}（${image.data.length} 字节）交出` +
    (scale !== 1 ? `，图中坐标乘以 ${scale} 即原图坐标` : "")
  );
}

type Block = PigeonToolResult<unknown>["content"][number];

// 其他工具结果里的图片块逐个过关：交出的换成核验或缩小后的那份（缩过的前面加一行说明），不过关的换成一行说明
async function gateBlocks(content: readonly Block[], prepare: ImagePreparer): Promise<Block[]> {
  const out: Block[] = [];
  for (const block of content) {
    if (block.type !== "image") {
      out.push(block);
      continue;
    }
    const bytes = Buffer.from(block.data, "base64");
    const gated = await gateImage(bytes, prepare);
    if ("image" in gated) {
      if (gated.image.resized)
        out.push({ type: "text", text: `[${resizedNote(gated.info, gated.image)}]` });
      out.push({
        type: "image",
        data: gated.image.resized ? gated.image.data.toString("base64") : block.data,
        mimeType: gated.image.mimeType,
      });
      continue;
    }
    const what =
      gated.info !== undefined
        ? `${gated.info.format}${gated.info.width !== undefined ? ` ${gated.info.width}×${gated.info.height}` : ""}，`
        : `声明为 ${block.mimeType}，`;
    out.push({
      type: "text",
      text: `[图片未交出：${gated.withheld}（${what}${bytes.length} 字节）]`,
    });
  }
  return out;
}

// 给工具套上图片关口（只改执行结果里的图片块，其余属性照旧）
export function withImageGate<TParameters extends TSchema, TDetails>(
  tool: PigeonAgentTool<TParameters, TDetails>,
  prepare: ImagePreparer
): PigeonAgentTool<TParameters, TDetails> {
  return {
    ...tool,
    async execute(...args) {
      const result = await tool.execute(...args);
      if (!result.content.some((block) => block.type === "image")) return result;
      return { ...result, content: await gateBlocks(result.content, prepare) };
    },
  };
}
