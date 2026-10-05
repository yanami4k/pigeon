// /memory（决策 331）：查看与编辑两层学到的记忆。终端界面的命令面在 tui/commands.ts，这里是与界面无关的命令层。
// - 查看：两层各列文件位置（展示写法与绝对路径）、条数与用量，后接条目原文；格式不对时照原文列出并指出行号。
// - 编辑（/memory edit project|user）：把这一层复制到同目录的编辑稿，用 $VISUAL（其次 $EDITOR）打开；编辑器退出后校验格式
//   与上限，合格才在记忆锁内换掉原文件；不合格、编辑器出错或编辑期间原文件被另一处改过，一律报错并保留原内容，改过的
//   内容留在编辑稿里供人取回。没有设置编辑器时给出文件路径，请人直接编辑。
// - 保存时别处正在写这一层：排队等，不设上限；等待超过 1 秒才提示，人可取消，取消时原文件不动、编辑稿保留。
// - 改动从下一条消息起生效：每个 Run 开始时重读，变了即在开工状态块里整节追加（决策 363）。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  entriesSection,
  MEMORY_FILE_HEADERS,
  MEMORY_LAYER_LABELS,
  MEMORY_LAYERS,
  type MemoryLayer,
  memoryFactsOfText,
  parseMemory,
  usedChars,
} from "../memory/learned.ts";
import {
  type MemoryLocation,
  MemoryLockAbortedError,
  memoryLocation,
  readMemoryFile,
  withMemoryLock,
  writeMemoryFile,
} from "../memory/learned-store.ts";
import type { MemoryLimits } from "../state/memory-config.ts";

export const MEMORY_COMMAND_USAGE =
  "用法：/memory 查看两层记忆；/memory edit project|user 用编辑器修改一层";

export interface MemoryCommandContext {
  governanceRoot: string;
  // 用户级记忆所在的主目录（缺省 os.homedir()；测试注入临时目录）
  homeDir?: string;
  limits: MemoryLimits;
}

function locationOf(ctx: MemoryCommandContext, layer: MemoryLayer): MemoryLocation {
  return memoryLocation(layer, {
    governanceRoot: ctx.governanceRoot,
    ...(ctx.homeDir !== undefined ? { homeDir: ctx.homeDir } : {}),
  });
}

// 一层的查看文字
function layerView(ctx: MemoryCommandContext, layer: MemoryLayer): string {
  const location = locationOf(ctx, layer);
  const read = readMemoryFile(location.file);
  const limit = ctx.limits[layer];
  const title = `${MEMORY_LAYER_LABELS[layer]}（${location.display}，${location.file}）`;
  const section = entriesSection(read.text).trimEnd();
  if (section === "") {
    return `${title}：没有条目，上限 ${limit} 字符`;
  }
  const facts = memoryFactsOfText(read.text);
  const parsed = parseMemory(read.text, layer);
  const broken = parsed.ok
    ? ""
    : `\n（第 ${parsed.line} 行起格式不对：update_memory 拒绝写入这一层，请用 /memory edit ${layer} 修复）`;
  return `${title}：共 ${facts.entries} 条，${facts.entryChars}/${limit} 字符\n${section}${broken}`;
}

export function memoryViewText(ctx: MemoryCommandContext): string {
  return [
    "学到的记忆（改动从下一条消息起生效）",
    ...MEMORY_LAYERS.map((layer) => layerView(ctx, layer)),
  ].join("\n\n");
}

// 编辑器：$VISUAL 优先，其次 $EDITOR；都没有为 undefined
export function resolveEditor(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of ["VISUAL", "EDITOR"] as const) {
    const value = env[name]?.trim();
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

// 编辑器的执行：命令可以带参数（如 "code -w"），交给 shell，文件路径加引号
export type EditorRunner = (
  editor: string,
  file: string
) => { ok: true } | { ok: false; error: string };

function shellQuote(file: string): string {
  return process.platform === "win32" ? `"${file}"` : `'${file.replace(/'/g, "'\\''")}'`;
}

export const spawnEditor: EditorRunner = (editor, file) => {
  const result = spawnSync(`${editor} ${shellQuote(file)}`, { shell: true, stdio: "inherit" });
  if (result.error !== undefined) {
    return { ok: false, error: result.error.message };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      error: `编辑器以退出码 ${result.status ?? `信号 ${result.signal ?? "未知"}`} 结束`,
    };
  }
  return { ok: true };
};

// 编辑稿：与记忆文件同目录（不进会话快照与仓库），一层一份
export function memoryDraftPathOf(file: string): string {
  return `${file}.edit.md`;
}

// 保存时排队等别处写完：等待超过 1 秒才提示（一闪而过的不提示）；人取消时草稿保留
export const MEMORY_SAVE_WAITING_TEXT = "正在保存记忆…（Esc 取消）";
export const MEMORY_SAVE_WAITING_DELAY_MS = 1000;
export function memorySaveCancelledText(draft: string): string {
  return `没有保存，你改的内容留在 ${draft}。`;
}

export interface EditMemoryOptions {
  editor?: string;
  // 执行编辑器（终端界面在调用前后暂停与恢复界面；测试注入）
  run?: EditorRunner;
  // 保存时排队不设上限：取消信号（终端界面接 Esc）
  signal?: AbortSignal;
  // 排队超过 waitingDelayMs 仍没轮到时回调一次（终端界面显示 MEMORY_SAVE_WAITING_TEXT）
  onWaiting?: () => void;
  // 缺省 MEMORY_SAVE_WAITING_DELAY_MS（测试注入）
  waitingDelayMs?: number;
}

export async function editMemoryLayer(
  ctx: MemoryCommandContext,
  layer: MemoryLayer,
  options: EditMemoryOptions = {}
): Promise<string> {
  const location = locationOf(ctx, layer);
  const label = MEMORY_LAYER_LABELS[layer];
  const editor = options.editor;
  if (editor === undefined) {
    return `没有设置编辑器（$VISUAL 或 $EDITOR）：请直接编辑 ${location.file}（${label}，一行一条，见文件头的说明），改动从下一条消息起生效`;
  }
  const original = readMemoryFile(location.file);
  const draft = memoryDraftPathOf(location.file);
  mkdirSync(path.dirname(draft), { recursive: true });
  writeFileSync(draft, original.exists ? original.text : MEMORY_FILE_HEADERS[layer]);
  const ran = (options.run ?? spawnEditor)(editor, draft);
  const keep = `改过的内容留在 ${draft}`;
  if (!ran.ok) {
    return `${label}记忆没有保存：${ran.error}；原内容未动，${keep}`;
  }
  const edited = existsSync(draft) ? readFileSync(draft, "utf8") : "";
  const before = original.exists ? original.text : MEMORY_FILE_HEADERS[layer];
  if (edited === before) {
    rmSync(draft, { force: true });
    return `${label}记忆没有改动`;
  }
  const parsed = parseMemory(edited, layer);
  if (!parsed.ok) {
    return `${label}记忆没有保存：第 ${parsed.line} 行起格式不对（一行一条：- [${layer === "project" ? "P" : "U"}编号] 内容，〔〕里的来处可省）；原内容未动，${keep}`;
  }
  const used = usedChars(parsed.doc.entries, layer);
  const limit = ctx.limits[layer];
  if (used > limit) {
    return `${label}记忆没有保存：条目共 ${used} 字符，超出上限 ${limit} 字符 ${used - limit} 字符；原内容未动，${keep}`;
  }
  // 别处正在写这一层时排队等，不设上限；等满 waitingDelayMs 才提示，轮到或取消即撤掉计时
  let waitingTimer: NodeJS.Timeout | undefined;
  try {
    return await withMemoryLock(
      location.lock,
      () => {
        // 编辑期间原文件被另一处（另一个会话的 update_memory）改过：不覆盖
        if (readMemoryFile(location.file).hash !== original.hash) {
          return `${label}记忆没有保存：编辑期间这一层被另一处改过；原内容未动，${keep}`;
        }
        writeMemoryFile(location.file, edited);
        rmSync(draft, { force: true });
        return `已保存${label}记忆（${location.display}）：共 ${parsed.doc.entries.length} 条，${used}/${limit} 字符，从下一条消息起生效`;
      },
      Number.POSITIVE_INFINITY,
      {
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        onContended: () => {
          if (options.onWaiting === undefined) return;
          waitingTimer = setTimeout(
            options.onWaiting,
            options.waitingDelayMs ?? MEMORY_SAVE_WAITING_DELAY_MS
          );
        },
      }
    );
  } catch (error) {
    // 人取消：原文件不动，草稿保留
    if (error instanceof MemoryLockAbortedError) {
      return memorySaveCancelledText(draft);
    }
    throw error;
  } finally {
    clearTimeout(waitingTimer);
  }
}
