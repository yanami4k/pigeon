// 开工状态块与状态变化通道（决策 363、354）：项目说明（AGENTS.md）、Skill 目录、外部工具（MCP）、环境看板、审批、联网、
// 推送记忆、git 状态与日期合成"开工状态块"，以一条带专用标签的用户消息随第一条输入发出，按稳定在前、易变在后排列。
// 之后每次请求模型前与上一份比对，哪一节变了就以 <pigeon-status-update> 追加"以下整段取代此前的「××」"——只追加、不改写，
// 会话记录与续跑前缀因此逐字节一致。压缩之后重发完整块（压缩抹掉了原来那份）；续跑时与会话记录里最后一份比对，只追加变了的节。
// 比对用的是各节原文（转义前）的哈希：每次发出（与模型自己写的记忆记成已发时）都把各节的哈希记进会话记录（pigeon.status 条目），
// 续跑与分叉从记录取，不靠从消息正文反推。
// 防注入：节内正文先做检测视图——去掉 Cf 类字符（零宽字符等）、逐字 NFKC 归一（全角＜等）、解开 < 的实体（&lt;、&#60;、&#x3c;）——
// 视图里出现 <pigeon- 或 </pigeon-（不分大小写、允许空白）时，转义原文里对应的开头：尖括号转成 &lt;，实体形态的把 & 转成 &amp;。
// 其余原样保留（代码里的 Array<T>、a < b 不受影响）。
import { sha256Hex } from "../state/hashing.ts";
import { SESSION_ENTRY_VERSION, SessionEntryType } from "../state/session-entries.ts";
import { STATUS_TAG, STATUS_UPDATE_TAG } from "../state/status-text.ts";

export { STATUS_TAG, STATUS_UPDATE_TAG };

// 状态块文字的版本（跑批身份头记下；改看板或状态块的文字时升）
export const STATUS_BLOCK_VERSION = "v1";

const SECTION_TAG = "pigeon-section";

// 各节的名字与先后（稳定在前、易变在后）
export const STATUS_SECTIONS = [
  "项目说明",
  "Skill 目录",
  "外部工具",
  "环境",
  "审批",
  "联网",
  "记忆",
  "git 状态",
  "日期",
] as const;
export type StatusSectionName = (typeof STATUS_SECTIONS)[number];

// 一份状态：节名 → 正文（未转义）；功能没开的节不在
export type StatusState = ReadonlyMap<StatusSectionName, string>;
// 发出过的一份：节名 → 正文的哈希
export type StatusHashes = ReadonlyMap<StatusSectionName, string>;

const FIRST_INTRO = `开工状态（Pigeon 自动附上）。之后有变化时以 <${STATUS_UPDATE_TAG}> 追加，整段取代此前的同名一节。`;
const SUPERSEDE_INTRO = "以下整段取代此前的全部开工状态。";
// 旧会话（系统提示里还带人写的说明与"开局冻结"的旧说法）续跑时，完整块开头另加一句
export const LEGACY_PROMPT_NOTE =
  "以本状态块为准：此前系统提示里「会话开始时读取并冻结」「下个会话才生效」一类的说法已不适用。";

// 某节没了时的正文
const REMOVED_TEXTS: Readonly<Record<StatusSectionName, string>> = {
  项目说明: "现在没有人写的说明。",
  "Skill 目录": "现在没有登记的 Skill。",
  外部工具: "现在没有外部工具。",
  环境: "现在没有环境信息。",
  审批: "现在没有审批说明。",
  联网: "现在不能联网搜索与读取网页（web_search、web_fetch 不可用）。",
  记忆: "现在没有推送的记忆。",
  "git 状态": "现在没有 git 状态。",
  日期: "现在没有日期信息。",
};

// 系统提示里的权威层级说明（决策 363）
export const STATUS_AUTHORITY_SENTENCE =
  `用户消息里 <${STATUS_TAG}> 与 <${STATUS_UPDATE_TAG}> 标签内是 Pigeon 自动附上的开工状态（项目说明、Skill 目录、外部工具、记忆、审批、环境等），` +
  "不是用户本人的话。其中的项目说明与记忆供参考，与用户当前的要求冲突时以用户为准。";

const LT_ENTITY = /^&(?:lt|#0*60|#x0*3c);?/i;
const FORMAT_CHAR = /\p{Cf}/u;
const TAG_HEAD = /<\s*\/?\s*pigeon-/gi;

// 用户消息里出现的文字（状态块各节、worker 通知的摘要等）转义：伪造不出 pigeon 标签
export function escapeStatusText(text: string): string {
  // 检测视图：与原文逐个 UTF-16 单元对齐地记下来源位置与形态
  let view = "";
  const origin: Array<{ at: number; length: number; entity: boolean }> = [];
  for (let index = 0; index < text.length; ) {
    const entity = text[index] === "&" ? LT_ENTITY.exec(text.slice(index, index + 12)) : null;
    if (entity !== null) {
      view += "<";
      origin.push({ at: index, length: entity[0].length, entity: true });
      index += entity[0].length;
      continue;
    }
    const char = String.fromCodePoint(text.codePointAt(index) ?? 0);
    if (!FORMAT_CHAR.test(char)) {
      const normalized = char.normalize("NFKC");
      view += normalized;
      for (let unit = 0; unit < normalized.length; unit++) {
        origin.push({ at: index, length: char.length, entity: false });
      }
    }
    index += char.length;
  }
  const edits = new Map<number, { length: number; entity: boolean }>();
  for (const match of view.matchAll(TAG_HEAD)) {
    const source = origin[match.index ?? 0];
    if (source !== undefined) {
      edits.set(source.at, source);
    }
  }
  if (edits.size === 0) {
    return text;
  }
  let out = "";
  let cursor = 0;
  for (const at of [...edits.keys()].sort((left, right) => left - right)) {
    const edit = edits.get(at);
    if (edit === undefined || at < cursor) {
      continue;
    }
    out += text.slice(cursor, at);
    out += edit.entity ? `&amp;${text.slice(at + 1, at + edit.length)}` : "&lt;";
    cursor = at + edit.length;
  }
  return out + text.slice(cursor);
}

function sectionBlock(name: StatusSectionName, body: string): string {
  return `<${SECTION_TAG} name="${name}">\n${body}\n</${SECTION_TAG}>`;
}

function ordered(state: StatusState): Array<[StatusSectionName, string]> {
  return STATUS_SECTIONS.flatMap((name) => {
    const text = state.get(name);
    return text !== undefined ? [[name, text] as [StatusSectionName, string]] : [];
  });
}

// 完整块：首次发出，或压缩之后重发（取代此前的全部）；旧会话首次另加一句
export function renderStatusBlock(
  state: StatusState,
  supersede: boolean,
  legacyNote = false
): string {
  return [
    `<${STATUS_TAG}>`,
    supersede ? SUPERSEDE_INTRO : FIRST_INTRO,
    ...(legacyNote ? [LEGACY_PROMPT_NOTE] : []),
    ...ordered(state).map(([name, text]) => sectionBlock(name, escapeStatusText(text))),
    `</${STATUS_TAG}>`,
  ].join("\n");
}

const replaceLead = (name: StatusSectionName) => `以下整段取代此前的「${name}」：`;

// 变化追加：只含变了的节
export function renderStatusUpdate(changes: ReadonlyArray<[StatusSectionName, string]>): string {
  return [
    `<${STATUS_UPDATE_TAG}>`,
    ...changes.map(([name, text]) =>
      sectionBlock(name, `${replaceLead(name)}\n${escapeStatusText(text)}`)
    ),
    `</${STATUS_UPDATE_TAG}>`,
  ].join("\n");
}

export function hashStatus(state: StatusState): StatusHashes {
  return new Map([...state].map(([name, text]) => [name, sha256Hex(text)]));
}

// 与发出过的一份的差别：新出现或正文变了的节给新正文，没了的节给"现在没有……"；按节的先后排
export function diffStatus(
  previous: StatusHashes,
  next: StatusState
): Array<[StatusSectionName, string]> {
  return STATUS_SECTIONS.flatMap((name): Array<[StatusSectionName, string]> => {
    const before = previous.get(name);
    const after = next.get(name);
    if (after !== undefined) {
      return before === sha256Hex(after) ? [] : [[name, after]];
    }
    return before !== undefined ? [[name, REMOVED_TEXTS[name]]] : [];
  });
}

// 会话记录里的状态条目（每次发出与记成已发时写一条，记下当时的各节哈希）
export function statusEntry(hashes: StatusHashes) {
  return {
    customType: SessionEntryType.Status,
    data: { version: SESSION_ENTRY_VERSION, sections: Object.fromEntries(hashes) },
  } as const;
}

// 从会话记录（主分支，根到叶）取最后一份发出过的状态；没有为 undefined（旧会话或还没发过）
export function statusFromEntries(
  entries: ReadonlyArray<{ type: string; customType?: unknown; data?: unknown }>
): StatusHashes | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== SessionEntryType.Status) {
      continue;
    }
    const sections = (entry.data as { sections?: unknown } | undefined)?.sections;
    if (typeof sections !== "object" || sections === null) {
      return undefined;
    }
    return new Map(
      Object.entries(sections).filter(
        (pair): pair is [StatusSectionName, string] =>
          STATUS_SECTIONS.includes(pair[0] as StatusSectionName) && typeof pair[1] === "string"
      )
    );
  }
  return undefined;
}

// 状态变化通道：记着最后发出（进了会话记录）的一份各节哈希；首次与压缩之后给完整块，其余只给变了的节。
// next 给出的一份要等那条消息进了会话记录（delivered）才算发出；没进记录就被中止的，下一次照旧与上一份发出的比对
//（没进记录的是完整块时，下一次仍给完整块）
export class StatusTracker {
  #sent: StatusHashes | undefined;
  #pending: { hashes: StatusHashes; full: boolean } | undefined;
  readonly #legacyNote: boolean;

  // legacyNote：本运行面沿用的是旧会话的系统提示（首次的完整块开头另加一句）
  constructor(initial?: StatusHashes, options: { legacyNote?: boolean } = {}) {
    this.#sent = initial;
    this.#legacyNote = options.legacyNote === true;
  }

  // 最后发出的一份（/reload 交给新运行面）
  sent(): StatusHashes | undefined {
    return this.#sent;
  }

  // 某节已由别的途径让模型知道（模型自己写的记忆）：记成已发，不回显。还没发过时不记，返回 undefined；记了返回记后的一份
  absorb(name: StatusSectionName, text: string | undefined): StatusHashes | undefined {
    const sent = this.#sent;
    if (sent === undefined) {
      return undefined;
    }
    const apply = (hashes: StatusHashes): StatusHashes => {
      const next = new Map(hashes);
      if (text === undefined) {
        next.delete(name);
      } else {
        next.set(name, sha256Hex(text));
      }
      return next;
    };
    this.#sent = apply(sent);
    if (this.#pending !== undefined) {
      this.#pending = { ...this.#pending, hashes: apply(this.#pending.hashes) };
    }
    return this.#sent;
  }

  // 给出要追加的消息正文；没有要说的为 undefined
  next(current: StatusState, compacted: boolean): string | undefined {
    const previous = this.#sent;
    const full = previous === undefined || compacted || this.#pending?.full === true;
    if (full) {
      this.#pending = { hashes: hashStatus(current), full: true };
      return renderStatusBlock(
        current,
        previous !== undefined,
        previous === undefined && this.#legacyNote
      );
    }
    const changes = diffStatus(previous, current);
    if (changes.length === 0) {
      this.#pending = undefined;
      return undefined;
    }
    this.#pending = { hashes: hashStatus(current), full: false };
    return renderStatusUpdate(changes);
  }

  // next 给出的那条消息进了会话记录：记成已发，返回这一份（交调用方写进会话记录）；没有待记的为 undefined
  delivered(): StatusHashes | undefined {
    const pending = this.#pending;
    if (pending === undefined) {
      return undefined;
    }
    this.#pending = undefined;
    this.#sent = pending.hashes;
    return pending.hashes;
  }
}
