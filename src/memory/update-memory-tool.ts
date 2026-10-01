// 记忆工具 update_memory（决策 217、328、329、331、332）：在项目级或用户级新增、按编号替换、按编号删除学到的记忆，
// 只写不读（两层记忆已在会话开始时推入系统提示）。说明、参数说明与各情形的返回文字为记忆文字 v2（MEMORY_TEXT_VERSION）。
// - 只给有人对话的入口（终端界面主会话含沙箱会话、--line 命令行对话）；pigeon run、worker 与跑批器只推送、不注册（331）。
// - 写入不审批（331），写入后经 onWritten 交给入口在消息区显示一行（记下的内容与层级）。
// - agent 只写内容；编号、日期、来源（入口名）与会话编号由工具补在行内（332）。内容完全相同即不新增。
// - 写满判定在锁内：拿到锁后现读现判。新增被拒与替换被拒分开写（328）：新增写当前用量、该条字数与还差多少；替换写被替换
//   条目现有字数、新内容字数、替换后总数与超出多少；两种都附现有条目编号与各条字数。替换后不比替换前长（改短或等长）时
//   一律放行，即使该层已超上限（人手改出来的）。
// - 人把格式改坏时拒绝写入并指出行号，不覆盖人的修改。
import { type Static, Type } from "typebox";
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
  withMemoryLock,
  writeMemoryFile,
} from "./learned-store.ts";

export const UPDATE_MEMORY_TOOL = "update_memory";

// 写入的来源（哪个入口；沙箱会话按它所在的入口记）：补在每条的〔〕里
export type MemorySource = "tui" | "line";
export const MEMORY_SOURCE_LABELS: Readonly<Record<MemorySource, string>> = {
  tui: "终端界面",
  line: "命令行对话",
};

// 工具说明（记忆文字 v2）
export const UPDATE_MEMORY_DESCRIPTION = [
  `新增、改写或删除学到的记忆。记忆分两层：project 只对本项目（${MEMORY_DISPLAY_PATHS.project}），user 对所有项目（${MEMORY_DISPLAY_PATHS.user}）。只写不读：两层记忆已在会话开始时放进系统提示。`,
  "记用户的偏好、用户对你做法的纠正，以及从代码和 git 历史看不出的项目信息（外部资料在哪里、约定、背景）；不记能从代码或 git 历史看出的内容（代码结构、文件位置、实现细节、改过什么），不记任务经过，也不记密钥、令牌、密码等敏感信息（需要时只记去哪里找）。",
  "每条一句话，只写内容；编号、日期、来源与会话编号由工具补上。只对本项目成立的记在 project，对所有项目都成立的记在 user；拿不准记在哪一层时，先问用户。",
  "每层有字符上限，写满时新增或改长都会被拒绝，须先合并相近条目或删除过时条目。",
  "用户亲口要求的条目，只有用户改口时才改写或删除。",
].join("\n");

// 参数（说明文字为记忆文字 v2）。必填与否随动作而定，由工具自己检查并按固定文字回话，schema 里 id 与 content 可选
export const UpdateMemoryParamsSchema = Type.Object({
  action: Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("remove")], {
    description: "add 新增一条；replace 用新内容整条替换编号指定的一条；remove 删除编号指定的一条",
  }),
  layer: Type.Union([Type.Literal("project"), Type.Literal("user")], {
    description: "project 只对本项目；user 对所有项目",
  }),
  id: Type.Optional(
    Type.String({ description: "条目编号，如 P3 或 U2，见记忆全文里每条开头的方括号" })
  ),
  content: Type.Optional(
    Type.String({ description: "一句话写明要记的内容（不写编号、日期与来源，工具会补上）" })
  ),
});
export type UpdateMemoryParams = Static<typeof UpdateMemoryParamsSchema>;

// 返回给 agent 的文字（记忆文字 v2）
export const UPDATE_MEMORY_TEXTS = {
  added: (layer: string, id: string, used: number, limit: number) =>
    `已在${layer}新增 ${id}（当前 ${used}/${limit} 字符）。`,
  replaced: (layer: string, id: string, used: number, limit: number) =>
    `已替换${layer} ${id}（当前 ${used}/${limit} 字符）。`,
  removed: (layer: string, id: string, used: number, limit: number) =>
    `已删除${layer} ${id}（当前 ${used}/${limit} 字符）。`,
  // 新增被拒（328）
  addFull: (input: {
    layer: string;
    used: number;
    limit: number;
    needed: number;
    short: number;
    entries: string;
  }) =>
    `${input.layer}记忆已满，这条没有新增：当前 ${input.used}/${input.limit} 字符，这条需要 ${input.needed} 字符（含工具补上的编号、日期、来源与会话编号），还差 ${input.short} 字符。把这条写短，或先用 replace 合并相近条目、用 remove 删除过时条目，再新增。现有条目（编号：字符数）：${input.entries}。`,
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
    `替换后超出${input.layer}上限，${input.id} 没有替换：${input.id} 现有 ${input.oldChars} 字符，新内容 ${input.newChars} 字符（含工具补上的编号、日期、来源与会话编号），替换后共 ${input.after}/${input.limit} 字符，超出 ${input.over} 字符。把新内容至少写短 ${input.over} 字符，或先用 remove 删除别的过时条目，再替换。现有条目（编号：字符数）：${input.entries}。`,
  duplicate: (layer: string, id: string) => `与${layer} ${id} 内容相同，未新增。`,
  missingId: (layer: string, id: string, ids: string) =>
    `${layer}没有 ${id}；现有条目编号：${ids}。`,
  missingContent: "add 与 replace 需要 content：一句话写明要记的内容。",
  missingLayer: "需要 layer：project（只对本项目）或 user（对所有项目）；拿不准时先问用户。",
  broken: (path: string, line: number, layer: MemoryLayer) =>
    `${path} 第 ${line} 行起格式不对，已拒绝写入，以免覆盖人的修改；请告知用户用 /memory edit ${layer} 修复。`,
} as const;

// 没有条目时的编号列表
const NO_ENTRIES = "（没有条目）";

function idList(entries: readonly MemoryEntry[], layer: MemoryLayer): string {
  return entries.length === 0
    ? NO_ENTRIES
    : entries.map((entry) => entryId(layer, entry.id)).join("、");
}

// 编号与各条字数：P1：120、P2：88
function sizeList(entries: readonly MemoryEntry[], layer: MemoryLayer): string {
  return entries.length === 0
    ? NO_ENTRIES
    : entries.map((entry) => `${entryId(layer, entry.id)}：${entryChars(entry, layer)}`).join("、");
}

// 一处文字里的换行与首尾空白：每条只占一行，换行并成一个空格；〔〕留给工具补的来处，内容里换成普通括号
function oneLine(text: string): string {
  return text
    .replace(/\s*[\r\n]+\s*/g, " ")
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
  rejected?: "full" | "duplicate" | "missing-id" | "missing-content" | "missing-layer" | "broken";
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
  const label = MEMORY_LAYER_LABELS[layer];
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
  const result = await withMemoryLock(location.lock, () => {
    const current = readMemoryFile(location.file);
    const parsed = parseMemory(current.text, layer);
    if (!parsed.ok) {
      return reply(UPDATE_MEMORY_TEXTS.broken(location.display, parsed.line, layer), {
        written: false,
        rejected: "broken",
      });
    }
    const doc = current.exists ? parsed.doc : { ...parsed.doc, header: MEMORY_FILE_HEADERS[layer] };
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
      const entry: MemoryEntry = { id: nextId(entries), content, origin };
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
