// 新会话存储的写者（决策 176–181 / 184 / 206 / 210）：以 pi-agent-core 0.84.4 的 JsonlSessionRepo 为存储，
// 会话根为 .pigeon/state/sessions，照 pi 原生布局按工作目录编码分子目录、文件名为创建时间加会话号；以 Pigeon 自己的会话号创建。
// - 写者用 pi 的打开；跨进程单写者锁由调用方注入（persistence/session-lock.ts，按会话文件加锁）。不注入 fsync（178）。
// - 消息以 pi 消息条目完整存储，不截断、不写旁置正文文件（179）；写入前剥掉值为 undefined 的键（上游序列化会拒绝）。
// - 只写 custom 条目（state/session-entries.ts 的七种），不写未知的 entry 或 record 类型（上游写时不报、读时整个文件打不开）。
// - 写者从不抛：打开、加锁、每一条写入的失败都交给 onFault，由调用方按内部故障告警；打开失败后这个写者不再写任何东西。
// - 写入经内部队列串行、按调用顺序落盘；调用方不等待（不拖慢运行），需要落盘确认时 flush。
// - 上下文压缩（188）：读主分支与写压缩条目同样排进队列（排在此前的写入之后）；压缩条目是 pi 原生条目，原始消息不动（179）。
// - 撞上限续跑（367）：被截断的回复移出主分支——用 pi 的 moveLane 把主分支的叶子退回它之前，消息留在文件里成为一条
//   废弃的分支；之后的写入接在它之前，按主分支还原的上下文（续跑、压缩、分叉）都不再含它。同样排进队列。
// - 同进程对同一会话只有一个 pi 会话实例：再开写者时共用，最后一个关闭才释放锁（同一文件两个实例会各自持有 seq，交错写坏文件）。
// 读非本进程所写的会话一律用 persistence/session-reader.ts 的只读读取器，不用这里。
import path from "node:path";
import {
  type AgentMessage,
  buildSessionContext,
  type CompactionEntry,
  type CompactResult,
  type CustomEntry,
  type Entry,
  type JsonlSessionMetadata,
  JsonlSessionRepo,
  type MessageEntry,
  type Session,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  HEADER_METADATA_KEY,
  type SessionEntrySink,
  type SessionHeaderMetadata,
} from "../state/session-entries.ts";
import {
  danglingToolCalls,
  INTERRUPTED_TOOL_RESULT_MARK,
  INTERRUPTED_TOOL_RESULT_TEXT,
  type StoreMessage,
} from "../state/session-judge.ts";
import { omitThinking } from "../state/thinking-omission.ts";

// 与写者同一套配置的仓库（契约测试与分叉共用）
export function createSessionRepo(sessionsRoot: string): JsonlSessionRepo {
  return new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: sessionsRoot }), sessionsRoot });
}

// 剥掉对象里值为 undefined 的键（上游 assertJsonSerializable 拒绝它们）；数组里的 undefined 按 JSON 语义记为 null。
// 返回新对象，原对象不动；其余值原样交给上游校验
export function stripUndefined<T>(value: T): T {
  return strip(value) as T;
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : strip(item)));
  }
  if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        if (item !== undefined) {
          result[key] = strip(item);
        }
      }
      return result;
    }
  }
  return value;
}

// 新存储的一次失败：action 说明是哪一步（打开、写入某种条目、分叉），cause 为原始错误
export class SessionStoreFault extends Error {
  override name = "SessionStoreFault";
  readonly action: string;
  constructor(action: string, cause: unknown) {
    super(`新会话存储${action}失败：${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.action = action;
  }
}

export interface SessionStoreWriterOptions {
  // 会话根（.pigeon/state/sessions）
  sessionsRoot: string;
  sessionId: string;
  // 会话的工作目录：新建文件时决定子目录，并记进文件头
  cwd: string;
  // 已有的会话文件（调用方按会话号列目录找到）：在场即打开续写，否则新建
  existingPath?: string;
  // 新建时写进文件头（之后不能改）
  parentSessionId?: string;
  metadata?: SessionHeaderMetadata;
  // 跨进程单写者锁：拿到文件路径后取锁，返回释放函数；取不到时抛错（该写者即不打开）
  lock?: (filePath: string) => () => void;
  onFault?: (fault: SessionStoreFault) => void;
  // 思考是否持久化（045，缺省 true）：false 时助手消息的思考块在写入前剥去，只留略去标记（state/thinking-omission.ts）
  persistThinking?: boolean;
}

// 运行面写消息与自定义条目的写入面（Adapter 经它写，结构类型便于测试注入）。
// 上下文压缩要用的两项可缺省：缺了即不压缩（只写不读的测试替身）
export interface SessionStoreSink extends SessionEntrySink {
  appendMessage(message: AgentMessage): void;
  // 读主分支（从根到叶）：排在此前的写入之后；会话没打开或读失败时为 undefined
  branch?(): Promise<Entry[] | undefined>;
  // 写一条压缩条目（排在此前的写入之后），返回写入后的主分支；失败时为 undefined
  appendCompaction?(result: CompactResult): Promise<Entry[] | undefined>;
  // 把主分支上最后一条消息（须是撞输出上限的助手回复）移出主分支（排在此前的写入之后）：叶子退回它之前，
  // 它之后挂的自定义条目重写到退回后的叶子上。主分支末条消息不是撞上限的回复时不动，按写入失败报告
  dropTruncatedReply?(): void;
}

export interface SessionStoreWriter extends SessionStoreSink {
  readonly sessionId: string;
  branch(): Promise<Entry[] | undefined>;
  appendCompaction(result: CompactResult): Promise<Entry[] | undefined>;
  // 等此前排队的写入全部落盘（写失败已交给 onFault，这里不拒绝）
  flush(): Promise<void>;
  // 会话文件路径；打开或新建失败时为 undefined
  filePath(): Promise<string | undefined>;
  // flush 后关闭；同进程最后一个写者关闭时释放锁
  close(): Promise<void>;
}

interface WriterCore {
  key: string;
  refs: number;
  tail: Promise<void>;
  session: Session | undefined;
  path: string | undefined;
  release: (() => void) | undefined;
}

const openCores = new Map<string, WriterCore>();

function report(onFault: SessionStoreWriterOptions["onFault"], action: string, error: unknown) {
  try {
    onFault?.(error instanceof SessionStoreFault ? error : new SessionStoreFault(action, error));
  } catch {
    // 告警口自身的异常不外泄：写者从不抛
  }
}

function startCore(key: string, options: SessionStoreWriterOptions): WriterCore {
  const core: WriterCore = {
    key,
    refs: 1,
    tail: Promise.resolve(),
    session: undefined,
    path: undefined,
    release: undefined,
  };
  // 先登记再开始打开：打开失败（含同步抛出的加锁失败）时的摘除总在登记之后
  openCores.set(key, core);
  core.tail = (async () => {
    const repo = createSessionRepo(options.sessionsRoot);
    try {
      if (options.existingPath !== undefined) {
        core.release = options.lock?.(options.existingPath);
        core.session = await repo.open({
          id: options.sessionId,
          path: options.existingPath,
        } as JsonlSessionMetadata);
        core.path = options.existingPath;
      } else {
        const session = await repo.create({
          id: options.sessionId,
          cwd: options.cwd,
          ...(options.parentSessionId !== undefined
            ? { parentSessionId: options.parentSessionId }
            : {}),
          ...(options.metadata !== undefined
            ? { metadata: { [HEADER_METADATA_KEY]: stripUndefined(options.metadata) } as never }
            : {}),
        });
        const filePath = (await session.getMetadata()).path;
        core.release = options.lock?.(filePath);
        core.session = session;
        core.path = filePath;
      }
    } catch (error) {
      core.release?.();
      core.release = undefined;
      core.session = undefined;
      // 打开失败即从注册表摘除：此后同一会话的打开总是重新尝试，不共用这个失效的核心
      if (openCores.get(key) === core) {
        openCores.delete(key);
      }
      report(options.onFault, "打开", error);
    }
  })();
  return core;
}

// 开一个写者：同进程已有同一会话的写者时共用它的 pi 会话实例
export function openSessionStoreWriter(options: SessionStoreWriterOptions): SessionStoreWriter {
  const key = `${path.resolve(options.sessionsRoot)}\0${options.sessionId}`;
  let core = openCores.get(key);
  if (core === undefined) {
    core = startCore(key, options);
  } else {
    core.refs += 1;
  }
  const shared = core;
  let closed = false;
  const enqueue = (action: string, write: (session: Session) => Promise<unknown>): void => {
    if (closed) {
      report(options.onFault, action, new Error("写者已关闭"));
      return;
    }
    shared.tail = shared.tail.then(async () => {
      const session = shared.session;
      if (session === undefined) {
        return;
      }
      try {
        await write(session);
      } catch (error) {
        report(options.onFault, action, error);
      }
    });
  };
  // 排进队列并取回结果：会话没打开、写者已关闭或失败时为 undefined（失败交给 onFault）
  const request = <T>(action: string, work: (session: Session) => Promise<T>) => {
    const { promise, resolve } = Promise.withResolvers<T | undefined>();
    if (closed) {
      report(options.onFault, action, new Error("写者已关闭"));
      resolve(undefined);
      return promise;
    }
    shared.tail = shared.tail.then(async () => {
      const session = shared.session;
      if (session === undefined) {
        resolve(undefined);
        return;
      }
      try {
        resolve(await work(session));
      } catch (error) {
        report(options.onFault, action, error);
        resolve(undefined);
      }
    });
    return promise;
  };
  const readBranch = (session: Session) => session.findEntriesOnBranch({ order: "oldestFirst" });
  return {
    sessionId: options.sessionId,
    appendMessage: (message) => {
      let clean: AgentMessage;
      try {
        clean = stripUndefined(options.persistThinking === false ? omitThinking(message) : message);
      } catch (error) {
        report(options.onFault, "写入消息", error);
        return;
      }
      enqueue("写入消息", (session) => session.appendMessage(clean));
    },
    append: (entry) => {
      const action = `写入 ${entry.customType} 条目`;
      let data: unknown;
      try {
        data = stripUndefined(entry.data);
      } catch (error) {
        report(options.onFault, action, error);
        return;
      }
      enqueue(action, (session) => session.appendCustomEntry(entry.customType, data));
    },
    branch: () => request("读主分支", readBranch),
    dropTruncatedReply: () => {
      enqueue("移出截断的回复", (session) => dropTruncatedReply(session));
    },
    appendCompaction: (result) => {
      let entry: Omit<CompactionEntry, "id" | "parentId" | "seq" | "timestamp">;
      try {
        // 保留段与消息同一口径：思考不持久化时剥去，值为 undefined 的键剥掉
        entry = stripUndefined({
          type: "compaction",
          summary: result.summary,
          retainedTail: result.retainedTail.map((message) =>
            options.persistThinking === false ? omitThinking(message) : message
          ),
          tokensBefore: result.tokensBefore,
          ...(result.details !== undefined ? { details: result.details } : {}),
          ...(result.usage !== undefined ? { usage: result.usage } : {}),
        });
      } catch (error) {
        report(options.onFault, "写入压缩条目", error);
        return Promise.resolve(undefined);
      }
      return request("写入压缩条目", async (session) => {
        await session.appendEntry({ ...entry, id: session.idGenerator.next() }, "main");
        return readBranch(session);
      });
    },
    flush: () => shared.tail,
    filePath: async () => {
      await shared.tail;
      return shared.session !== undefined ? shared.path : undefined;
    },
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      shared.refs -= 1;
      await shared.tail;
      if (shared.refs === 0 && openCores.get(shared.key) === shared) {
        openCores.delete(shared.key);
        try {
          shared.release?.();
        } catch (error) {
          report(options.onFault, "释放锁", error);
        }
        shared.release = undefined;
        shared.session = undefined;
      }
    },
  };
}

async function dropTruncatedReply(session: Session): Promise<void> {
  const trailing: CustomEntry[] = [];
  let reply: MessageEntry | undefined;
  for (const entry of await session.findEntriesOnBranch({ order: "newestFirst" })) {
    if (entry.type === "message") {
      reply = entry;
      break;
    }
    if (entry.type !== "custom") {
      throw new Error(`主分支末条消息之后有 ${entry.type} 条目`);
    }
    trailing.push(entry);
  }
  const message = reply?.message;
  if (reply === undefined || message?.role !== "assistant" || message.stopReason !== "length") {
    throw new Error("主分支末条消息不是撞输出上限的助手回复");
  }
  await session.moveLane("main", reply.parentId);
  for (const entry of trailing.reverse()) {
    await session.appendCustomEntry(entry.customType, entry.data);
  }
}

// 分叉（177 / 210）：用 pi 的 fork 把来源会话里从根到 entryId（含，须是消息条目）的历史复制进分支会话的新文件，
// 新文件头的 parentSessionId 记来源会话、metadata 记分支来历。调用方负责来源文件此刻没有别的进程在写
// （来源写者在本进程且已 flush，或已按文件取锁）。失败抛错，由调用方按内部故障处理
export async function forkSessionFile(input: {
  sessionsRoot: string;
  source: { sessionId: string; path: string };
  entryId: string;
  branchSessionId: string;
  cwd: string;
  metadata?: SessionHeaderMetadata;
}): Promise<string> {
  const repo = createSessionRepo(input.sessionsRoot);
  const session = await repo.fork(
    { id: input.source.sessionId, path: input.source.path } as JsonlSessionMetadata,
    {
      scope: "branch",
      entryId: input.entryId,
      position: "at",
      id: input.branchSessionId,
      cwd: input.cwd,
      ...(input.metadata !== undefined
        ? { metadata: { [HEADER_METADATA_KEY]: stripUndefined(input.metadata) } as never }
        : {}),
    }
  );
  return (await session.getMetadata()).path;
}

// 由一条分支（根到叶的条目，只读读取器读出）用 pi 的 buildSessionContext 还原消息（决策 183 续跑、177 分叉续跑的初始消息）：
// 自定义条目不产生消息，压缩条目换成摘要加保留段（上游口径）
export function sessionContextMessages(pathEntries: readonly object[]): AgentMessage[] {
  return buildSessionContext(pathEntries as readonly Entry[]).messages;
}

// 续跑时还原的对话上下文（决策 183）：messages 是 buildSessionContext 还原的消息；末条助手消息里有没配上结果的工具调用时，
// interrupted 为每个悬空调用补的一条工具结果（"进程在执行途中中断、结果未知、请自行核实"，details 带标记供读者认出），
// 由调用方写进会话并接在 messages 之后交给 Agent——上游 continue 与 provider 都要求工具调用有结果
export function restoreSessionContext(pathEntries: readonly object[]): {
  messages: AgentMessage[];
  interrupted: AgentMessage[];
} {
  const messages = sessionContextMessages(pathEntries);
  const interrupted = danglingToolCalls(messages as unknown as StoreMessage[]).map(
    (call) =>
      ({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT_TEXT }],
        details: { [INTERRUPTED_TOOL_RESULT_MARK]: true },
        isError: true,
        timestamp: Date.now(),
      }) as AgentMessage
  );
  return { messages, interrupted };
}
