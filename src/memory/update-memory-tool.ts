// 记忆工具 update_memory（决策 217、328、329、331、332）：在项目级或用户级新增、按编号替换、按编号删除学到的记忆，
// 只写不读（两层记忆已在开工状态块的「记忆」一节里）。说明、参数说明与各情形的返回文字为记忆文字 v4（MEMORY_TEXT_VERSION）。
// - 只给有人对话的入口（终端界面主会话含沙箱会话、--line 命令行对话）；pigeon run、worker 与跑批器只推送、不注册（331）。
// - 写入不审批（331），写入后经 onWritten 交给入口在消息区显示一行（记下的内容与层级）。
// - agent 只写内容；编号、日期、来源（入口名）与会话编号由工具补在行内（332）。内容完全相同即不新增。
// - 写满判定在锁内：拿到锁后现读现判。新增被拒与替换被拒分开写（328）：新增写当前用量、该条字数与还差多少；替换写被替换
//   条目现有字数、新内容字数、替换后总数与超出多少；两种都附现有条目编号与各条字数。替换后不比替换前长（改短或等长）时
//   一律放行，即使该层已超上限（人手改出来的）。
// - 人把格式改坏时拒绝写入并指出行号，不覆盖人的修改。
import { type Static, Type } from "typebox";
import { ExclusiveLockError } from "../persistence/exclusive-lock.ts";
import type { MemoryLimits } from "../state/memory-config.ts";
import type { ToolRegistration } from "../tools/registry.ts";
import type { PigeonAgentTool, PigeonToolResult } from "../tools/wrap.ts";
import {
  entryChars,
  entryId,
  localDate,
  MEMORY_DISPLAY_PATHS,
  MEMORY_FILE_HEADERS,
  MEMORY_LAYER_LABELS,
  MEMORY_LAYER_PREFIX,
  MEMORY_LAYERS,
  type MemoryEntry,
  type MemoryLayer,
  nextId,
  parseMemory,
  renderForWrite,
  usedChars,
} from "./learned.ts";
import {
  type MemoryLocation,
  memoryLocation,
  readMemoryFile,
  readMemoryMaxId,
  withMemoryLock,
  writeMemoryFile,
  writeMemoryMaxId,
} from "./learned-store.ts";

export const UPDATE_MEMORY_TOOL = "update_memory";

// 写入的来源（哪个入口；沙箱会话按它所在的入口记）：补在每条的〔〕里
export type MemorySource = "tui" | "line";
export const MEMORY_SOURCE_LABELS: Readonly<Record<MemorySource, string>> = {
  tui: "终端界面",
  line: "命令行对话",
};

// 工具说明（记忆文字 v4；决策 383 加的"新增前去重"与"纠正过时条目"两句不升 MEMORY_TEXT_VERSION：跑批不注册
// update_memory，说明的变化到不了跑批，不影响实验条件）
export const UPDATE_MEMORY_DESCRIPTION = [
  `Add, rewrite, or delete learned memory entries. Memory has two layers: project applies only to this project (${MEMORY_DISPLAY_PATHS.project}), and user applies to all projects (${MEMORY_DISPLAY_PATHS.user}). This tool only writes and does not read: both layers are already in the startup status.`,
  "Record the user's preferences, the user's corrections to how you work, and project information that cannot be seen from the code or git history (where external material is, conventions, background). Do not record what can be seen from the code or git history (code structure, file locations, implementation details, what was changed), do not record the course of a task, and do not record secrets such as keys, tokens, or passwords (if needed, record only where to find them).",
  "One sentence per entry, content only; the tool adds the ID, date, source, and session ID. Record what holds only for this project in project, and what holds for all projects in user; if you are unsure which layer, ask the user first.",
  "Each layer has a character limit; when it is full, adding an entry or making one longer is rejected, so first merge similar entries or delete outdated ones.",
  "Before adding, check whether either layer already has an entry about the same thing; if so, rewrite that entry with replace instead of adding another.",
  "When you find that a memory entry is no longer right (it conflicts with the current state of the project or with what the user said most recently): for the kind the user explicitly asked for, point it out and ask the user; rewrite or delete the others directly, and say so in your reply.",
  "Rewrite or delete an entry the user explicitly asked for only when the user changes their mind.",
].join("\n");

// 参数（说明文字为记忆文字 v4）。必填与否随动作而定，由工具自己检查并按固定文字回话，schema 里 id 与 content 可选
export const UpdateMemoryParamsSchema = Type.Object({
  action: Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("remove")], {
    description:
      "add adds an entry; replace replaces the whole entry with the given id with new content; remove deletes the entry with the given id",
  }),
  layer: Type.Union([Type.Literal("project"), Type.Literal("user")], {
    description: "project applies only to this project; user applies to all projects",
  }),
  id: Type.Optional(
    Type.String({
      description:
        "Entry ID, such as P3 or U2; see the square brackets at the start of each entry in the memory text",
    })
  ),
  content: Type.Optional(
    Type.String({
      description:
        "One sentence stating what to remember (do not include the ID, date, or source; the tool adds them)",
    })
  ),
});
export type UpdateMemoryParams = Static<typeof UpdateMemoryParamsSchema>;

// 返回给 agent 的文字（记忆文字 v4）；layer 为层的键（project 或 user）
export const UPDATE_MEMORY_TEXTS = {
  added: (layer: string, id: string, used: number, limit: number) =>
    `Added ${id} to the ${layer} memory (now ${used}/${limit} characters).`,
  replaced: (layer: string, id: string, used: number, limit: number) =>
    `Replaced ${id} in the ${layer} memory (now ${used}/${limit} characters).`,
  removed: (layer: string, id: string, used: number, limit: number) =>
    `Removed ${id} from the ${layer} memory (now ${used}/${limit} characters).`,
  // 新增被拒（328）
  addFull: (input: {
    layer: string;
    used: number;
    limit: number;
    needed: number;
    short: number;
    entries: string;
  }) =>
    `The ${input.layer} memory is full, so this entry was not added: currently ${input.used}/${input.limit} characters; this entry needs ${input.needed} characters (including the ID, date, source, and session ID the tool adds), ${input.short} characters more than is left. Shorten this entry, or first merge similar entries with replace and delete outdated ones with remove, then add it. Existing entries (ID: characters): ${input.entries}.`,
  // 替换被拒（328）
  replaceFull: (input: {
    layer: string;
    id: string;
    oldChars: number;
    newChars: number;
    after: number;
    limit: number;
    over: number;
    entries: string;
  }) =>
    `Replacing would exceed the ${input.layer} memory limit, so ${input.id} was not replaced: ${input.id} currently has ${input.oldChars} characters, the new content has ${input.newChars} characters (including the ID, date, source, and session ID the tool adds), and after replacing the total would be ${input.after}/${input.limit} characters, ${input.over} characters over. Shorten the new content by at least ${input.over} characters, or first delete other outdated entries with remove, then replace it. Existing entries (ID: characters): ${input.entries}.`,
  duplicate: (layer: string, id: string) =>
    `Same content as ${id} in the ${layer} memory; not added.`,
  missingId: (layer: string, id: string, ids: string) =>
    `The ${layer} memory has no ${id}; existing entry IDs: ${ids}.`,
  missingContent: "add and replace need content: one sentence stating what to remember.",
  missingLayer:
    "layer is required: project (this project only) or user (all projects); if you are unsure, ask the user first.",
  broken: (path: string, line: number, layer: MemoryLayer) =>
    `${path} is malformed from line ${line} on, so the write was refused to avoid overwriting someone's manual edits; tell the user to fix it with /memory edit ${layer}.`,
  // 等锁超时：同一层正被别的会话写入，等满仍没拿到锁。这是记忆文字 v3 下新增的一种拒绝情形，不升 MEMORY_TEXT_VERSION：
  // 跑批不注册 update_memory，不影响实验条件
  busy: (layer: string) =>
    `The ${layer} memory file is being written by another session, so this write did not happen; you can retry later.`,
} as const;

// 没有条目时的编号列表
const NO_ENTRIES = "(no entries)";

function idList(entries: readonly MemoryEntry[], layer: MemoryLayer): string {
  return entries.length === 0
    ? NO_ENTRIES
    : entries.map((entry) => entryId(layer, entry.id)).join(", ");
}

// 编号与各条字数：P1: 120, P2: 88
function sizeList(entries: readonly MemoryEntry[], layer: MemoryLayer): string {
  return entries.length === 0
    ? NO_ENTRIES
    : entries.map((entry) => `${entryId(layer, entry.id)}: ${entryChars(entry, layer)}`).join(", ");
}

// 一处文字里的换行与首尾空白：每条只占一行，换行并成一个空格；〔〕留给工具补的来处，内容里换成普通括号
function oneLine(text: string): string {
  // 折叠一切换行（含 Unicode 行分隔符 \u2028/\u2029）：记忆一行一条
  return text
    .replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ")
    .replace(/〔/g, "（")
    .replace(/〕/g, "）")
    .trim();
}

// 编号的写法：P3、p3 或 3 都认（前缀须与层相符）
function parseId(raw: string | undefined, layer: MemoryLayer): number | undefined {
  const match = /^([PpUu])?([1-9]\d*)$/.exec((raw ?? "").trim());
  if (match === null) return undefined;
  if (match[1] !== undefined && match[1].toUpperCase() !== MEMORY_LAYER_PREFIX[layer]) {
    return undefined;
  }
  const id = Number(match[2]);
  return Number.isSafeInteger(id) ? id : undefined;
}

// 写入后交给入口显示的一行（331）
export interface MemoryWriteNotice {
  layer: MemoryLayer;
  action: UpdateMemoryParams["action"];
  id: string;
  // 新增与替换为写下的内容，删除为删掉的那条的内容
  content: string;
}

export function memoryWriteNoticeLine(notice: MemoryWriteNotice): string {
  const verb =
    notice.action === "add" ? "已记下" : notice.action === "replace" ? "已改写" : "已删除";
  return `[记忆] ${verb}（${MEMORY_LAYER_LABELS[notice.layer]} ${notice.id}）：${notice.content}`;
}

export interface UpdateMemoryDetails {
  action: UpdateMemoryParams["action"];
  layer?: MemoryLayer;
  // 这次调用改动了文件
  written: boolean;
  id?: string;
  usedChars?: number;
  limitChars?: number;
  // 拒绝的原因
  rejected?:
    | "full"
    | "duplicate"
    | "missing-id"
    | "missing-content"
    | "missing-layer"
    | "broken"
    | "busy";
}

export interface UpdateMemoryOptions {
  governanceRoot: string;
  // 用户级记忆所在的主目录（缺省 os.homedir()；测试注入临时目录）
  homeDir?: string;
  // 本会话编号与来源：补在每条的〔〕里
  sessionId: string;
  source: MemorySource;
  // 两层上限（字符，按码点计）
  limits: MemoryLimits;
  // 等锁上限（毫秒；缺省见 withMemoryLock，测试注入）
  lockWaitMs?: number;
  // 写入后（文件已改动）调用：入口在消息区显示一行
  onWritten?: (notice: MemoryWriteNotice) => void;
  // 记日期用的时钟（测试注入）
  now?: () => Date;
}

function isLayer(value: unknown): value is MemoryLayer {
  return (MEMORY_LAYERS as readonly unknown[]).includes(value);
}

// 一次调用：锁内现读、现判、现写
export async function applyMemoryUpdate(
  options: UpdateMemoryOptions,
  params: UpdateMemoryParams
): Promise<{ text: string; details: UpdateMemoryDetails }> {
  const { action } = params;
  if (!isLayer(params.layer)) {
    return {
      text: UPDATE_MEMORY_TEXTS.missingLayer,
      details: { action, written: false, rejected: "missing-layer" },
    };
  }
  const layer = params.layer;
  // 回话里的层名：参数里的键（project 或 user）
  const label = layer;
  const limit = options.limits[layer];
  const reply = (
    text: string,
    details: Omit<UpdateMemoryDetails, "action" | "layer" | "limitChars">
  ) => ({ text, details: { action, layer, limitChars: limit, ...details } });
  const content = oneLine(params.content ?? "");
  if (action !== "remove" && content === "") {
    return reply(UPDATE_MEMORY_TEXTS.missingContent, {
      written: false,
      rejected: "missing-content",
    });
  }
  const location: MemoryLocation = memoryLocation(layer, {
    governanceRoot: options.governanceRoot,
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
  });
  const origin = {
    date: localDate((options.now ?? (() => new Date()))()),
    source: MEMORY_SOURCE_LABELS[options.source],
    sessionId: options.sessionId,
  };
  let notice: MemoryWriteNotice | undefined;
  const result = await withMemoryLock(
    location.lock,
    () => {
      const current = readMemoryFile(location.file);
      const parsed = parseMemory(current.text, layer);
      if (!parsed.ok) {
        return reply(UPDATE_MEMORY_TEXTS.broken(location.display, parsed.line, layer), {
          written: false,
          rejected: "broken",
        });
      }
      const doc = current.exists
        ? parsed.doc
        : { ...parsed.doc, header: MEMORY_FILE_HEADERS[layer] };
      const entries = doc.entries;
      const used = usedChars(entries, layer);
      const commit = (next: MemoryEntry[]) => {
        writeMemoryFile(location.file, renderForWrite({ ...doc, entries: next }, layer));
        return usedChars(next, layer);
      };
      if (action === "add") {
        const duplicate = entries.find((entry) => entry.content === content);
        if (duplicate !== undefined) {
          return reply(UPDATE_MEMORY_TEXTS.duplicate(label, entryId(layer, duplicate.id)), {
            written: false,
            id: entryId(layer, duplicate.id),
            usedChars: used,
            rejected: "duplicate",
          });
        }
        // 决策 382：删掉的编号不再分配——新编号取现有最大加一与已分配过的最大编号加一的较大者
        const entry: MemoryEntry = {
          id: Math.max(nextId(entries), readMemoryMaxId(location.file) + 1),
          content,
          origin,
        };
        const needed = entryChars(entry, layer);
        if (used + needed > limit) {
          return reply(
            UPDATE_MEMORY_TEXTS.addFull({
              layer: label,
              used,
              limit,
              needed,
              short: used + needed - limit,
              entries: sizeList(entries, layer),
            }),
            { written: false, usedChars: used, rejected: "full" }
          );
        }
        const after = commit([...entries, entry]);
        writeMemoryMaxId(location.file, Math.max(readMemoryMaxId(location.file), entry.id));
        const id = entryId(layer, entry.id);
        notice = { layer, action, id, content };
        return reply(UPDATE_MEMORY_TEXTS.added(label, id, after, limit), {
          written: true,
          id,
          usedChars: after,
        });
      }
      const idNumber = parseId(params.id, layer);
      const existing =
        idNumber === undefined ? undefined : entries.find((entry) => entry.id === idNumber);
      if (existing === undefined) {
        return reply(
          UPDATE_MEMORY_TEXTS.missingId(label, (params.id ?? "").trim(), idList(entries, layer)),
          { written: false, usedChars: used, rejected: "missing-id" }
        );
      }
      const id = entryId(layer, existing.id);
      if (action === "remove") {
        const after = commit(entries.filter((entry) => entry !== existing));
        notice = { layer, action, id, content: existing.content };
        return reply(UPDATE_MEMORY_TEXTS.removed(label, id, after, limit), {
          written: true,
          id,
          usedChars: after,
        });
      }
      const replacement: MemoryEntry = { id: existing.id, content, origin };
      const oldChars = entryChars(existing, layer);
      const newChars = entryChars(replacement, layer);
      const afterChars = used - oldChars + newChars;
      // 写满时只拦改长：替换后不比替换前长即放行
      if (afterChars > limit && afterChars > used) {
        return reply(
          UPDATE_MEMORY_TEXTS.replaceFull({
            layer: label,
            id,
            oldChars,
            newChars,
            after: afterChars,
            limit,
            over: afterChars - limit,
            entries: sizeList(entries, layer),
          }),
          { written: false, id, usedChars: used, rejected: "full" }
        );
      }
      const after = commit(entries.map((entry) => (entry === existing ? replacement : entry)));
      notice = { layer, action, id, content };
      return reply(UPDATE_MEMORY_TEXTS.replaced(label, id, after, limit), {
        written: true,
        id,
        usedChars: after,
      });
    },
    options.lockWaitMs
  ).catch((error: unknown) => {
    // 等满仍没拿到锁：按固定文字回话，不写入；其余错误照常抛出
    if (error instanceof ExclusiveLockError) {
      return reply(UPDATE_MEMORY_TEXTS.busy(label), { written: false, rejected: "busy" });
    }
    throw error;
  });
  if (notice !== undefined) {
    options.onWritten?.(notice);
  }
  return result;
}

export function createUpdateMemoryTool(
  options: UpdateMemoryOptions
): PigeonAgentTool<typeof UpdateMemoryParamsSchema, UpdateMemoryDetails> {
  return {
    name: UPDATE_MEMORY_TOOL,
    label: UPDATE_MEMORY_TOOL,
    description: UPDATE_MEMORY_DESCRIPTION,
    parameters: UpdateMemoryParamsSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params): Promise<PigeonToolResult<UpdateMemoryDetails>> {
      const { text, details } = await applyMemoryUpdate(options, params);
      return { content: [{ type: "text", text }], details };
    },
  };
}

// 装配根注册用的元数据：写档、只写两层记忆所在的目录、免审批（331）
export function updateMemoryRegistration(input: {
  governanceRoot: string;
  homeDir?: string;
}): ToolRegistration {
  return {
    name: UPDATE_MEMORY_TOOL,
    description: `新增、替换或删除学到的记忆（${MEMORY_DISPLAY_PATHS.project}、${MEMORY_DISPLAY_PATHS.user}）`,
    parameters: UpdateMemoryParamsSchema,
    tier: "write",
    approvalFree: true,
    pathConfinement: {
      kind: "roots",
      roots: MEMORY_LAYERS.map((layer) => memoryLocation(layer, input).file),
    },
    executionMode: "sequential",
  };
}
