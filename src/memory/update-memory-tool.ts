// 记忆工具 update_memory（决策 217、228；施工默认 Q12、Q13）：新增、按编号替换、按编号删除学到的记忆，只写不读
// （记忆已在会话开始时整份推入系统提示）。说明、参数说明与各情形的返回文字都是冻结原文，一字不改（改一字即换条件）。
// - 治理档位为写，只写 .pigeon/learned/；日常使用免审批（Q12），不为它新增审批或放权。
// - refs 里的 user 由工具换成"用户要求（会话 {会话编号}）"；事实、引用、理由三项都相同即视为完全相同、不新增。
// - "引用为用户要求的条目只在用户改口时改写或删除"与"不记密钥"都只靠文字约束，工具不拦（228、232）；
//   引用存不存在也不做程序核对（228）。
// - 写满判定在锁内：拿到锁后现读现判（Q13）。人把格式改坏时拒绝写入并指出行号，不覆盖人的修改。
import { type Static, Type } from "typebox";
import type { ToolRegistration } from "../tools/registry.ts";
import type { PigeonAgentTool, PigeonToolResult } from "../tools/wrap.ts";
import {
  DEFAULT_MEMORY_LIMIT_CHARS,
  entryChars,
  entryId,
  MEMORY_FILE_HEADER,
  type MemoryEntry,
  nextIdFloor,
  parseMemory,
  renderForWrite,
  sameContent,
  usedChars,
} from "./learned.ts";
import {
  learnedDirOf,
  readMemoryFile,
  readStoredNextId,
  withMemoryLock,
  writeMemory,
} from "./learned-store.ts";

export const UPDATE_MEMORY_TOOL = "update_memory";

// 工具说明（B 第 2 节冻结原文）
export const UPDATE_MEMORY_DESCRIPTION = [
  "新增、改写或删除本项目的学到的记忆（.pigeon/learned/MEMORY.md）。只写不读：记忆已在会话开始时放进系统提示。",
  "每条是一句陈述句的事实，不写成对自己的命令；附至少一处引用：代码写成 文件 或 文件::函数，来自用户明确要求而指不到代码的写 user（工具会补上本会话编号）；再附一句理由，写明依据。",
  "只记以后在本项目仍然成立、会影响做法、又不容易从代码一眼看出的事实；不记任务经过、只在本次改动里才成立的事、环境一时的故障、通用常识、从代码一读就知道的内容，也不记密钥、令牌、密码等敏感信息（需要时只记去哪里找，不记值本身）。",
  "记忆有总量上限，写满时新增会被拒绝，须先合并相近条目或删除过时条目。",
  "引用为用户要求的条目，只有用户在本次会话里改口时才改写或删除。",
].join("\n");

// 参数（说明文字为 B 第 2 节冻结原文）。必填与否随动作而定，由工具自己检查并按冻结文字回话，schema 里一律可选
export const UpdateMemoryParamsSchema = Type.Object({
  action: Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("remove")], {
    description: "add 新增一条；replace 用新内容整条替换编号指定的一条；remove 删除编号指定的一条",
  }),
  id: Type.Optional(Type.String({ description: "条目编号，如 L3，见记忆全文里每条开头的方括号" })),
  fact: Type.Optional(Type.String({ description: "一句陈述句的事实、教训或做法" })),
  refs: Type.Optional(
    Type.Array(Type.String(), {
      description:
        '代码引用写成 path/to/file 或 path/to/file::symbol；来自用户明确要求、指不到代码的写 user，工具替换为"用户要求（会话 {会话编号}）"',
    })
  ),
  reason: Type.Optional(Type.String({ description: "一句理由：为什么这条值得记、依据是什么" })),
});
export type UpdateMemoryParams = Static<typeof UpdateMemoryParamsSchema>;

// 返回给 agent 的文字（B 第 2 节冻结原文）
export const UPDATE_MEMORY_TEXTS = {
  added: (id: string, used: number, limit: number) =>
    `已新增 ${id}（当前 ${used}/${limit} 字符）。`,
  replaced: (id: string, used: number, limit: number) =>
    `已替换 ${id}（当前 ${used}/${limit} 字符）。`,
  removed: (id: string, used: number, limit: number) =>
    `已删除 ${id}（当前 ${used}/${limit} 字符）。`,
  full: (used: number, limit: number, needed: number, ids: string) =>
    `记忆已满：当前 ${used}/${limit} 字符，这条需要 ${needed} 字符。先用 replace 合并相近条目，或用 remove 删掉过时条目，再新增。现有条目编号：${ids}。`,
  duplicate: (id: string) => `与 ${id} 完全相同，未新增。`,
  missingId: (id: string, ids: string) => `没有 ${id}；现有条目编号：${ids}。`,
  missingFields: "每条必须有 fact、reason 和至少一处 refs（文件、文件::函数，或 user）。",
  broken: (line: number) =>
    `MEMORY.md 第 ${line} 行起格式不对，已拒绝写入，以免覆盖人的修改；请告知用户修复。`,
} as const;

// 编号列表的写法：顿号相接
function idList(entries: readonly MemoryEntry[]): string {
  return entries.map((entry) => entryId(entry.id)).join("、");
}

// 一处文字里的换行与首尾空白：条目每项只占一行，换行并成一个空格
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

// refs 里的 user（不分大小写）换成用户要求加本会话编号
export function userRef(sessionId: string): string {
  return `用户要求（会话 ${sessionId}）`;
}

function normalizedRefs(refs: readonly string[] | undefined, sessionId: string): string[] {
  return (refs ?? [])
    .map(oneLine)
    .filter((ref) => ref !== "")
    .map((ref) => (ref.toLowerCase() === "user" ? userRef(sessionId) : ref));
}

// 编号的写法：L3、l3 或 3 都认
function parseId(raw: string | undefined): number | undefined {
  const match = /^[Ll]?([1-9]\d*)$/.exec((raw ?? "").trim());
  const id = match !== null ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(id) ? id : undefined;
}

export interface UpdateMemoryDetails {
  action: UpdateMemoryParams["action"];
  // 这次调用改动了文件
  written: boolean;
  id?: string;
  usedChars?: number;
  limitChars: number;
  // 拒绝的原因
  rejected?: "full" | "duplicate" | "missing-id" | "missing-fields" | "broken";
}

export interface UpdateMemoryOptions {
  governanceRoot: string;
  // 本会话编号：refs 里的 user 换成"用户要求（会话 {会话编号}）"
  sessionId: string;
  // 总量上限（字符，按码点计）；缺省 12,000
  limitChars?: number;
}

// 一次调用：锁内现读、现判、现写
export async function applyMemoryUpdate(
  options: UpdateMemoryOptions,
  params: UpdateMemoryParams
): Promise<{ text: string; details: UpdateMemoryDetails }> {
  const limit = options.limitChars ?? DEFAULT_MEMORY_LIMIT_CHARS;
  const { action } = params;
  const reply = (text: string, details: Omit<UpdateMemoryDetails, "action" | "limitChars">) => ({
    text,
    details: { action, limitChars: limit, ...details },
  });
  const fact = oneLine(params.fact ?? "");
  const reason = oneLine(params.reason ?? "");
  const refs = normalizedRefs(params.refs, options.sessionId);
  if (action !== "remove" && (fact === "" || reason === "" || refs.length === 0)) {
    return reply(UPDATE_MEMORY_TEXTS.missingFields, {
      written: false,
      rejected: "missing-fields",
    });
  }
  return withMemoryLock(options.governanceRoot, () => {
    const current = readMemoryFile(options.governanceRoot);
    const parsed = parseMemory(current.text);
    if (!parsed.ok) {
      return reply(UPDATE_MEMORY_TEXTS.broken(parsed.line), {
        written: false,
        rejected: "broken",
      });
    }
    const doc = current.exists ? parsed.doc : { ...parsed.doc, header: MEMORY_FILE_HEADER };
    const entries = doc.entries;
    const used = usedChars(entries);
    const nextId = Math.max(readStoredNextId(options.governanceRoot) ?? 1, nextIdFloor(entries));
    const commit = (next: MemoryEntry[], newNextId: number) => {
      writeMemory(
        options.governanceRoot,
        renderForWrite({ ...doc, entries: next, finalNewline: true }),
        newNextId
      );
      return usedChars(next);
    };
    if (action === "add") {
      const duplicate = entries.find((entry) => sameContent(entry, { fact, refs, reason }));
      if (duplicate !== undefined) {
        return reply(UPDATE_MEMORY_TEXTS.duplicate(entryId(duplicate.id)), {
          written: false,
          id: entryId(duplicate.id),
          usedChars: used,
          rejected: "duplicate",
        });
      }
      const entry: MemoryEntry = { id: nextId, fact, refs, reason };
      const next = [...entries, entry];
      if (usedChars(next) > limit) {
        return reply(UPDATE_MEMORY_TEXTS.full(used, limit, entryChars(entry), idList(entries)), {
          written: false,
          usedChars: used,
          rejected: "full",
        });
      }
      const after = commit(next, nextId + 1);
      return reply(UPDATE_MEMORY_TEXTS.added(entryId(entry.id), after, limit), {
        written: true,
        id: entryId(entry.id),
        usedChars: after,
      });
    }
    const id = parseId(params.id);
    const index = id === undefined ? -1 : entries.findIndex((entry) => entry.id === id);
    if (id === undefined || index < 0) {
      return reply(UPDATE_MEMORY_TEXTS.missingId((params.id ?? "").trim(), idList(entries)), {
        written: false,
        usedChars: used,
        rejected: "missing-id",
      });
    }
    const label = entryId(id);
    if (action === "remove") {
      const after = commit(
        entries.filter((entry) => entry.id !== id),
        nextId
      );
      return reply(UPDATE_MEMORY_TEXTS.removed(label, after, limit), {
        written: true,
        id: label,
        usedChars: after,
      });
    }
    const entry: MemoryEntry = { id, fact, refs, reason };
    const next = entries.map((existing) => (existing.id === id ? entry : existing));
    if (usedChars(next) > limit) {
      return reply(UPDATE_MEMORY_TEXTS.full(used, limit, entryChars(entry), idList(entries)), {
        written: false,
        id: label,
        usedChars: used,
        rejected: "full",
      });
    }
    const after = commit(next, nextId);
    return reply(UPDATE_MEMORY_TEXTS.replaced(label, after, limit), {
      written: true,
      id: label,
      usedChars: after,
    });
  });
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

// 装配根注册用的元数据：写档、只写 learned/ 目录、日常免审批（Q12）
export function updateMemoryRegistration(governanceRoot: string): ToolRegistration {
  return {
    name: UPDATE_MEMORY_TOOL,
    description: "新增、替换或删除学到的记忆（.pigeon/learned/MEMORY.md）",
    parameters: UpdateMemoryParamsSchema,
    tier: "write",
    approvalFree: true,
    pathConfinement: { kind: "roots", roots: [learnedDirOf(governanceRoot)] },
    executionMode: "sequential",
  };
}
