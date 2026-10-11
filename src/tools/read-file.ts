// read_file（tier: read）：Pigeon 自有只读文件工具，AgentTool 兼容形状（上游类型经 wrap.ts 桥接）。
// 输出与 edit_file 协同（M3 切片 2）：头部带全文件快照标签 [PATH#TAG]，每行带 hashline 锚点
// N#TAG——edit_file 的快照预检与锚点寻址完全消费这里给出的标签。
// 行为参考 harness/tools/read 笔记：offset 1-based；窗口截断时给出下一窗口提示。
// 决策 357：单次正文至多 maxBytes 字节（缺省 50 KiB），单行超过 maxLineChars 字符（缺省 2000）截断并注明；按字节上限停下时
// 照翻页提示给出续读的 offset。
// 决策 356：pigeon://outputs/<会话号>/<编号> 是落盘的命令输出，在路径判定之前识别，直接从会话落盘目录流式读、只留需要的
// 那段行，不经执行端。
// 决策 358：成功读取（含分段）后在读取记录里记下整个文件字节的哈希，write_file 据此判断"读过且读后未变"；失败的读取不记。
// 决策 414：按文件头认出图片（PNG、JPEG、GIF、WebP）与其他二进制（判定见 file-kind.ts），整个文件一次交回、不分行：
// 模型能看图（imageInput，取自模型信息）且图片在上限以内时交出图片内容，附一行路径、类型、像素尺寸与字节数；其余只给这些
// 元信息与可用的命令行工具，不把解码出的乱码放进上下文。这类读取同样记进读取记录（读后改写的保护照旧）。
// 决策 416、417：要交出的图片先过关口（image-gate.ts）：完整解码一遍，超出单张上限的在进程内缩小；认不出尺寸、解不开、缩不下
// 或图像库载入失败时只给元信息。
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  DEFAULT_READ_FILE_MAX_BYTES,
  DEFAULT_READ_FILE_MAX_LINE_CHARS,
  type ReadFileLimits,
} from "../state/tools-config.ts";
import { type CommandOutputStore, isOutputsUri, OutputPathError } from "./command-output.ts";
import type { EditMode } from "./edit-mode.ts";
import { type BinaryInfo, detectBinary, detectImage, type ImageInfo } from "./file-kind.ts";
import { lineTag, snapshotTag, splitContent } from "./hashline.ts";
import { gateImage, IMAGE_MAX_EDGE, IMAGE_MAX_MB, resizedNote } from "./image-gate.ts";
import { type ImagePreparer, photonPreparer } from "./image-resize.ts";
import { asWorkspaceHost } from "./local-host.ts";
import { WorkspacePathError } from "./paths.ts";
import type { ReadTarget } from "./read-paths.ts";
import type { FileReadTracker } from "./read-tracker.ts";
import type { WorkspaceHost } from "./workspace-host.ts";
import type { PigeonAgentTool, PigeonToolResult } from "./wrap.ts";

// 单次默认最多返回行数，防止一次把大文件全塞进上下文
const DEFAULT_READ_LIMIT = 2000;

// 域错误类（M4 S2 错误分类判据）：offset 越界 / 目标非文件等模型侧错误，
// 与环境异常（fs ErrnoException）区分——error-kind.ts 按类归 domain
export class ReadFileError extends Error {}
export const ReadFileParamsSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  // 起始行，1-based；缺省从第 1 行开始
  offset: Type.Optional(Type.Integer({ minimum: 1 })),
  // 最多读取行数；缺省 2000
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
});
export type ReadFileParams = Static<typeof ReadFileParamsSchema>;

export interface ReadFileDetails {
  // 解析并围栏后的规范路径（本地为宿主绝对路径，容器工作区为容器内路径；落盘输出为宿主上的落盘文件）
  resolvedPath: string;
  // 全文件快照标签：edit_file 的 snapshot 参数来源
  snapshot: string;
  totalLines: number;
  offset: number;
  limit: number;
  returnedLines: number;
  // 决策 357：本次截断显示的超长行数；按字节上限提前停下
  truncatedLines?: number;
  byteLimited?: boolean;
}

// 决策 414：整个文件一次交回的读取（图片与其他二进制）
export interface ReadFileWholeDetails {
  resolvedPath: string;
  kind: "image" | "binary";
  bytes: number;
  // 图片：类型与像素尺寸（读不出尺寸时缺省）；交出了图片内容才有 imageSent
  mimeType?: string;
  width?: number;
  height?: number;
  imageSent?: true;
  // 决策 416：缩小后交出的那份
  resized?: { mimeType: string; width: number; height: number; bytes: number };
  // 二进制：认得的格式
  format?: string;
}

// 决策 355：工作区以外的读取怎样放行——放手模式自动放行（allowed）、非放手模式经人批准（approval）、
// 没有审批通道即拒（refused，缺省）。只决定工具说明的说法；实际放行由治理层按调用授予（authorizeOutsideRead），
// 没有授权一律拒读
export type OutsideReadMode = "allowed" | "approval" | "refused";

export interface ReadFileToolOptions {
  // 决策 061：replace 编辑模式下输出不带行标签与快照标签，每行 `行号| 内容`；缺省 hashline 输出不变
  editMode?: EditMode;
  outsideReads?: OutsideReadMode;
  // 决策 357：单次字节与单行字符上限；缺省 50 KiB 与 2000
  limits?: ReadFileLimits;
  // 决策 356：本会话的落盘目录（不给即不认虚拟路径）
  outputs?: CommandOutputStore;
  // 决策 358：本会话的读取记录
  reads?: FileReadTracker;
  // 决策 414：模型能看图（模型信息的 input 含 image）时图片以图片内容交回；缺省不能
  imageInput?: boolean;
  // 决策 416、417：交出前的核验与缩放；缺省用 photon
  prepareImage?: ImagePreparer;
}

// 读到的内容：总行数、按行号取行，与读取成功后的收尾
interface Loaded {
  resolvedPath: string;
  snapshot: string;
  totalLines: number;
  line(number: number): string;
  done(): void;
}

// 决策 414：认出是图片或其他二进制的文件，整个交回
interface WholeFile {
  whole: true;
  resolvedPath: string;
  bytes: Buffer;
  image?: ImageInfo;
  binary?: BinaryInfo;
}

// 工作区以外的文件未获授权：路径围栏错误的一种
export class OutsideReadNotApprovedError extends WorkspacePathError {}

// 可选能力（治理层使用）：只读检查这次调用是否读工作区以外的文件，并按调用授予，一次一用
export interface OutsideReadTool {
  // 解析后落在工作区以外时返回其真实路径；在工作区内、不存在或解析不了返回 undefined
  inspectOutsideRead(params: unknown): Promise<string | undefined>;
  authorizeOutsideRead(toolCallId: string): void;
}

// 放手模式下写工具也可写工作区以外（决策 407），allowed 的说法因此不说只读
const OUTSIDE_SENTENCES: Readonly<Record<OutsideReadMode, string>> = {
  allowed: "工作区以外的文件也可读（用绝对路径）。",
  approval: "工作区以外的文件也可读（用绝对路径），须经人批准（可按目录放权），只读、不能改。",
  refused: "",
};

// 决策 098：workspace 给目录即本地工作区，给执行端实现即由它承接读取；工具不判断自己在哪
export function createReadFileTool(
  workspace: string | WorkspaceHost,
  options: ReadFileToolOptions = {}
): PigeonAgentTool<typeof ReadFileParamsSchema, ReadFileDetails | ReadFileWholeDetails> &
  OutsideReadTool {
  const host = asWorkspaceHost(workspace);
  const replaceMode = options.editMode === "replace";
  const outsideReads = options.outsideReads ?? "refused";
  // 治理层授予的工作区外读取（toolCallId），执行时取用即删
  const outsideApproved = new Set<string>();
  // 执行端没有读档解析时只读工作区之内（照 resolveExisting）
  const resolveTarget = async (inputPath: string): Promise<ReadTarget> =>
    host.resolveForRead !== undefined
      ? host.resolveForRead(inputPath)
      : { path: await host.resolveExisting(inputPath), outside: false };
  const lead = outsideReads === "refused" ? "读取工作区内文本文件。" : "读取文本文件。";
  const maxBytes = options.limits?.maxBytes ?? DEFAULT_READ_FILE_MAX_BYTES;
  const maxLineChars = options.limits?.maxLineChars ?? DEFAULT_READ_FILE_MAX_LINE_CHARS;
  // 取内容：虚拟路径先于路径判定，流式读会话落盘目录、只留需要的那段行；其余经执行端围栏后按字节整读。
  // done 在读取成功（offset 合法、已排版）后才调用，那时才记进读取记录
  const load = async (
    inputPath: string,
    offset: number,
    limit: number,
    approved: boolean
  ): Promise<Loaded | WholeFile> => {
    if (isOutputsUri(inputPath)) {
      if (options.outputs === undefined) {
        throw new OutputPathError(`本会话没有落盘的命令输出：${inputPath}`);
      }
      const window = await options.outputs.readWindow(inputPath, offset, limit);
      return {
        resolvedPath: window.file,
        snapshot: window.sha256.slice(0, 16),
        totalLines: window.totalLines,
        line: (number) => window.lines[number - offset] ?? "",
        done: () => {},
      };
    }
    // 决策 355：工作区以外的文件须获授权
    const target = await resolveTarget(inputPath);
    if (target.outside && !approved) {
      throw new OutsideReadNotApprovedError(
        `路径越出工作区根：${inputPath}（工作区以外的文件须经批准才能读）`
      );
    }
    const resolvedPath = target.path;
    if (!(await host.isFile(resolvedPath))) {
      throw new ReadFileError(`不是常规文件：${inputPath}`);
    }
    const bytes =
      host.readBytes !== undefined
        ? await host.readBytes(resolvedPath)
        : Buffer.from(await host.readText(resolvedPath), "utf8");
    const image = detectImage(bytes);
    const binary = image === undefined ? detectBinary(bytes) : undefined;
    if (image !== undefined || binary !== undefined) {
      return {
        whole: true,
        resolvedPath,
        bytes,
        ...(image !== undefined ? { image } : {}),
        ...(binary !== undefined ? { binary } : {}),
      };
    }
    const raw = bytes.toString("utf8");
    const { lines } = splitContent(raw);
    return {
      resolvedPath,
      snapshot: snapshotTag(raw),
      totalLines: lines.length,
      line: (number) => lines[number - 1] ?? "",
      done: () => options.reads?.record(resolvedPath, bytes),
    };
  };
  return {
    name: "read_file",
    label: "read_file",
    description:
      (replaceMode
        ? `${lead}输出每行形如「行号| 内容」，头部 [PATH] 给出总行数与窗口。` +
          "edit_file 的 old_string 取自内容部分，不要带行号前缀；文件被截断时按提示的 offset 继续读取。"
        : `${lead}输出每行带锚点前缀 N#TAG（N 为行号，TAG 为内容哈希），` +
          "头部 [PATH#TAG] 是全文件快照。edit_file 编辑时必须使用本工具给出的锚点与快照；" +
          "文件被截断时按提示的 offset 继续读取。") +
      (options.imageInput === true ? IMAGE_SENTENCE : "") +
      OUTSIDE_SENTENCES[outsideReads],
    parameters: ReadFileParamsSchema,
    executionMode: "parallel",
    async inspectOutsideRead(params) {
      const target = (params as { path?: unknown } | null)?.path;
      if (host.resolveForRead === undefined || typeof target !== "string" || target === "") {
        return undefined;
      }
      try {
        const resolved = await host.resolveForRead(target);
        return resolved.outside ? resolved.path : undefined;
      } catch {
        return undefined;
      }
    },
    authorizeOutsideRead(toolCallId) {
      outsideApproved.add(toolCallId);
    },
    async execute(
      toolCallId,
      params
    ): Promise<PigeonToolResult<ReadFileDetails | ReadFileWholeDetails>> {
      const approved = outsideApproved.delete(toolCallId);
      const args = Value.Parse(ReadFileParamsSchema, params);
      const offset = args.offset ?? 1;
      const limit = args.limit ?? DEFAULT_READ_LIMIT;
      const loaded = await load(args.path, offset, limit, approved);
      if ("whole" in loaded) {
        options.reads?.record(loaded.resolvedPath, loaded.bytes);
        return wholeFileResult(
          args.path,
          loaded,
          options.imageInput === true,
          options.prepareImage ?? photonPreparer
        );
      }
      const { resolvedPath, snapshot, totalLines } = loaded;
      if (totalLines === 0) {
        loaded.done();
        return {
          content: [
            {
              type: "text",
              text: `[${replaceMode ? args.path : `${args.path}#${snapshot}`}] 空文件`,
            },
          ],
          details: {
            resolvedPath,
            snapshot,
            totalLines: 0,
            offset: 1,
            limit: args.limit ?? DEFAULT_READ_LIMIT,
            returnedLines: 0,
          },
        };
      }
      if (offset > totalLines) {
        throw new ReadFileError(
          `offset ${offset} 超出文件范围（共 ${totalLines} 行）；请给出 1-${totalLines} 之间的 offset`
        );
      }
      const last = Math.min(offset + limit - 1, totalLines);
      // 逐行排版：超长行截断并注明；累计字节超过上限即停（至少给一行）
      const rendered: string[] = [];
      let bytes = 0;
      let truncatedLines = 0;
      let byteLimited = false;
      for (let number = offset; number <= last; number += 1) {
        const line = loaded.line(number);
        const shown = line.length > maxLineChars ? clipLine(line, maxLineChars, number) : line;
        const text = replaceMode ? `${number}| ${shown}` : `${number}#${lineTag(line)}| ${shown}`;
        const size = Buffer.byteLength(text, "utf8") + 1;
        if (rendered.length > 0 && bytes + size > maxBytes) {
          byteLimited = true;
          break;
        }
        if (shown !== line) truncatedLines += 1;
        rendered.push(text);
        bytes += size;
      }
      const end = offset + rendered.length - 1;
      const remaining = totalLines - end;
      const hint =
        remaining > 0
          ? `\n${byteLimited ? `本次输出已达 ${maxBytes} 字节上限；` : ""}还有 ${remaining} 行未读，下一窗口参数 offset=${end + 1}`
          : "";
      loaded.done();
      return {
        content: [
          {
            type: "text",
            text: `[${replaceMode ? args.path : `${args.path}#${snapshot}`}] 共 ${totalLines} 行（窗口 ${offset}-${end}）\n${rendered.join("\n")}${hint}`,
          },
        ],
        details: {
          resolvedPath,
          snapshot,
          totalLines,
          offset,
          limit,
          returnedLines: rendered.length,
          ...(truncatedLines > 0 ? { truncatedLines } : {}),
          ...(byteLimited ? { byteLimited } : {}),
        },
      };
    },
  };
}

// 决策 414：模型能看图时工具说明另加的一句
const IMAGE_SENTENCE =
  "图片（PNG、JPEG、GIF、WebP）以图片交回，可直接看图，不必为看图另写脚本或装库；" +
  `长边超过 ${IMAGE_MAX_EDGE} 像素或编码后超过 ${IMAGE_MAX_MB} 的先自动缩小再交出。` +
  "其他二进制文件只给类型与大小。";

// 图片与其他二进制：一行元信息；能交出的图片附图片内容（决策 417：先过关口——完整解码一遍，超出单张上限的先缩小）
async function wholeFileResult(
  path: string,
  file: WholeFile,
  imageInput: boolean,
  prepare: ImagePreparer
): Promise<PigeonToolResult<ReadFileWholeDetails>> {
  const size = `${file.bytes.length} 字节`;
  const { image } = file;
  if (image === undefined) {
    const details: ReadFileWholeDetails = {
      resolvedPath: file.resolvedPath,
      kind: "binary",
      bytes: file.bytes.length,
      ...(file.binary?.format !== undefined ? { format: file.binary.format } : {}),
    };
    return { content: [{ type: "text", text: binaryText(path, size, file.binary) }], details };
  }
  const { width, height } = image;
  const dims = width !== undefined && height !== undefined ? ` ${width}×${height}` : "";
  const head = `[${path}] 图片 ${image.format}${dims}，${size}`;
  const details: ReadFileWholeDetails = {
    resolvedPath: file.resolvedPath,
    kind: "image",
    bytes: file.bytes.length,
    mimeType: image.mimeType,
    ...(width !== undefined && height !== undefined ? { width, height } : {}),
  };
  if (!imageInput) {
    return { content: [{ type: "text", text: `${head}。${NO_VISION_TEXT}` }], details };
  }
  const gated = await gateImage(file.bytes, prepare);
  if ("withheld" in gated) {
    return {
      content: [
        { type: "text", text: `${head}。${gated.withheld}，未交出图片内容；${WITHHELD_HINT}` },
      ],
      details,
    };
  }
  const sent = gated.image;
  return {
    content: [
      { type: "text", text: sent.resized ? `${head}；${resizedNote(gated.info, sent)}` : head },
      { type: "image", data: sent.data.toString("base64"), mimeType: sent.mimeType },
    ],
    details: {
      ...details,
      imageSent: true,
      ...(sent.resized
        ? {
            resized: {
              mimeType: sent.mimeType,
              width: sent.width,
              height: sent.height,
              bytes: sent.data.length,
            },
          }
        : {}),
    },
  };
}

const NO_VISION_TEXT =
  "当前模型不能看图，未交出图片内容；需要图片里的信息时可用命令行工具处理" +
  "（如 file、identify 看属性，tesseract 识别文字，python 的图像库分析像素）。";
const WITHHELD_HINT =
  "可用命令行工具查看或处理（如 file、identify 看属性，ImageMagick 或 python 的图像库修复、缩小）。";

function binaryText(path: string, size: string, binary: BinaryInfo | undefined): string {
  if (binary?.reason === "encoding") {
    const share = Math.round((binary.invalidShare ?? 0) * 100);
    return (
      `[${path}] 不是 UTF-8 文本（开头部分约 ${share}% 是非法字节序列），${size}，未显示内容。` +
      "若是其他编码的文本，可用 iconv 转成 UTF-8 后再读（如 iconv -f GBK -t UTF-8 文件）；其余可用 file、xxd 等命令行工具查看。"
    );
  }
  return (
    `[${path}] 二进制文件（${binary?.format ?? "类型未认出"}），${size}，未显示内容；` +
    "可用命令行工具查看（如 file 看类型、xxd 文件 | head 看开头字节、strings 取可读字符串）。"
  );
}

// 超长行只显示前 maxChars 个字符（不切断代理对），注明原长与看其余部分的办法
function clipLine(line: string, maxChars: number, number: number): string {
  let cut = maxChars;
  const code = line.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return (
    `${line.slice(0, cut)}…（本行共 ${line.length} 字符，超过 ${maxChars} 已截断；` +
    `其余部分可用 run_command 按字符截取，例如 sed -n '${number}p' 文件 | cut -c${cut + 1}-${cut + maxChars}）`
  );
}
