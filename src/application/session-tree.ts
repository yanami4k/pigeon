// 会话树的重建与写穿（M7 S6，决策 077）：树是派生缓存，账本与内容文件是唯一权威。
// - 重建：删掉树文件后从根会话的账本导入 main 通道，再沿每条分叉记录在分叉条目上建分支通道、导入分支会话，逐层递归；
// - 写穿：条目落盘时按批缓冲（助手消息连同其工具结果），下一条助手消息、用户消息或 Run 结束时连同停止原因、用量与工具参数一起投影入队——
//   与重建共用同一投影，结果逐条一致；追加在后台队列里执行，不 fsync、不阻塞主循环。
//   写穿失败不进账本（决策 077 修订 + 080：树是可重建的派生缓存，失败的后果由重建入口补齐，不需事后取证），
//   改为去重的标准错误告警，不影响运行。
import { existsSync } from "node:fs";
import path from "node:path";
import {
  JsonlEventLog,
  materializeSession,
  readEventLogFile,
  readMessageContentFileDetailed,
} from "../persistence/event-log.ts";
import { acquireExclusiveLock } from "../persistence/exclusive-lock.ts";
import {
  ledgerTreeMessages,
  openSessionTree,
  projectLedgerMessage,
  type SessionTree,
  TREE_MAIN_LANE,
  type TreeMessage,
} from "../pi-runtime/session-tree.ts";
import type { EntryRecord } from "../state/event-log.ts";
import type { SessionId } from "../state/ids.ts";
import type { MessageContentRecord } from "../state/message-content.ts";
import type { TurnCompletedPayload } from "../state/runtime-events.ts";
import type { RuntimeBundle } from "./runtime.ts";
import { dedupedWarner, failureDetail } from "./warnings.ts";
import { sessionsDirOf } from "./workspace.ts";

// 一个会话文件的账本 → 树消息
export function readLedgerTreeMessages(
  governanceRoot: string,
  sessionId: SessionId
): TreeMessage[] {
  const dir = sessionsDirOf(governanceRoot);
  const records = readEventLogFile(JsonlEventLog.filePathFor(dir, sessionId));
  const contents = readMessageContentFileDetailed(JsonlEventLog.contentFilePathFor(dir, sessionId));
  return ledgerTreeMessages({
    records,
    contentByEntryId: new Map(contents.records.map((record) => [record.entryId, record])),
  });
}

// 会话所在树的根会话：沿分支会话头逐级回溯到非分支会话
export function treeRootOf(governanceRoot: string, sessionId: SessionId): SessionId {
  const dir = sessionsDirOf(governanceRoot);
  let current = sessionId;
  for (let depth = 0; depth < 1000; depth++) {
    if (!existsSync(JsonlEventLog.filePathFor(dir, current))) {
      return current;
    }
    const header = materializeSession(dir, current, { content: false }).branchHeader;
    if (header === undefined) {
      return current;
    }
    current = header.sourceSessionId;
  }
  throw new Error(`分支链过深或成环：${sessionId}`);
}

// 会话在树里的通道：根会话走 main，分支会话以自己的会话号为通道
export function treeLaneOf(governanceRoot: string, sessionId: SessionId): string {
  return treeRootOf(governanceRoot, sessionId) === sessionId ? TREE_MAIN_LANE : sessionId;
}

// 把一个会话导入指定通道，再沿它的分叉记录递归导入分支
export async function importSessionIntoTree(
  tree: SessionTree,
  governanceRoot: string,
  sessionId: SessionId,
  lane: string
): Promise<void> {
  await tree.append(lane, readLedgerTreeMessages(governanceRoot, sessionId));
  const dir = sessionsDirOf(governanceRoot);
  const session = materializeSession(dir, sessionId, { content: false });
  for (const forked of session.sessionForkeds) {
    const forkEntry = session.entries.find(
      (entry) => entry.runId === forked.forkPoint.runId && entry.runSeq === forked.forkPoint.runSeq
    );
    if (forkEntry === undefined || (await tree.hasLane(forked.branchSessionId))) {
      continue;
    }
    await tree.createLane(forked.branchSessionId, forkEntry.id);
    if (existsSync(JsonlEventLog.filePathFor(dir, forked.branchSessionId))) {
      await importSessionIntoTree(
        tree,
        governanceRoot,
        forked.branchSessionId,
        forked.branchSessionId
      );
    }
  }
}

// 进程内共享的树句柄：同一树文件在进程里只开一个 Session（多个实例各自持有内存序号，交错追加会写坏文件）
const openTrees = new Map<string, Promise<SessionTree>>();
const treeKey = (input: { governanceRoot: string; rootSessionId: SessionId }) =>
  `${path.resolve(input.governanceRoot)}::${input.rootSessionId}`;

export function acquireSessionTree(input: {
  governanceRoot: string;
  rootSessionId: SessionId;
}): Promise<SessionTree> {
  const key = treeKey(input);
  let tree = openTrees.get(key);
  if (tree === undefined) {
    tree = openSessionTree(input);
    openTrees.set(key, tree);
    tree.catch(() => openTrees.delete(key));
  }
  return tree;
}

// 一棵树上的重建锁：按根会话号取，跨进程有效
export function treeLockPath(governanceRoot: string, rootSessionId: SessionId): string {
  return path.join(governanceRoot, ".pigeon", "tree-locks", `${rootSessionId}.lock`);
}

// 由账本重建树：删掉旧树文件后整棵重新导入；替换进程内共享句柄。
// 取锁再删（并发缺口修复）：重建是"先删整棵再重导"，而另一个进程的写穿队列可能正在追加同一棵树。
// 树文件本身没有任何跨进程保护，写穿失败又只告警不进账本（080），撞上就是树错乱且无人知晓。
// 只锁重建侧不锁写穿侧：见本次审计里的取舍说明
export async function rebuildSessionTree(input: {
  governanceRoot: string;
  rootSessionId: SessionId;
}): Promise<SessionTree> {
  const release = acquireExclusiveLock(
    treeLockPath(input.governanceRoot, input.rootSessionId),
    `会话树 ${input.rootSessionId} 正被另一个进程写入或重建：等它收尾后再重建`
  );
  try {
    const existing = await acquireSessionTree(input);
    await existing.remove();
    openTrees.delete(treeKey(input));
    const tree = await acquireSessionTree(input);
    await importSessionIntoTree(tree, input.governanceRoot, input.rootSessionId, TREE_MAIN_LANE);
    return tree;
  } finally {
    release();
  }
}

export interface SessionTreeBinding {
  // 本会话已在树里（有分叉记录或是分支会话）时接上写穿；已接上则无操作
  ensureAttached(): Promise<void>;
  idle(): Promise<void>;
  stop(): void;
}

// 会话运行面的树绑定（077"此后该会话实时写穿"）：打开或恢复一个已在树里的会话时接上写穿；分叉发生后由分叉入口再调一次
export function bindSessionTree(input: {
  bundle: RuntimeBundle;
  governanceRoot: string;
}): SessionTreeBinding {
  const sessionId = input.bundle.adapter.sessionId;
  let writer: TreeWriteThrough | undefined;
  let attaching: Promise<void> | undefined;
  return {
    ensureAttached: () => {
      if (writer !== undefined) {
        return Promise.resolve();
      }
      attaching ??= (async () => {
        const dir = sessionsDirOf(input.governanceRoot);
        if (!existsSync(JsonlEventLog.filePathFor(dir, sessionId))) {
          return;
        }
        const session = materializeSession(dir, sessionId, { content: false });
        if (session.sessionForkeds.length === 0 && session.branchHeader === undefined) {
          return;
        }
        const rootSessionId = treeRootOf(input.governanceRoot, sessionId);
        const tree = await acquireSessionTree({
          governanceRoot: input.governanceRoot,
          rootSessionId,
        });
        if ((await tree.laneLeaf(TREE_MAIN_LANE)) === null) {
          await importSessionIntoTree(tree, input.governanceRoot, rootSessionId, TREE_MAIN_LANE);
        }
        writer = attachTreeWriteThrough({
          bundle: input.bundle,
          tree,
          lane: rootSessionId === sessionId ? TREE_MAIN_LANE : sessionId,
        });
      })().finally(() => {
        attaching = undefined;
      });
      return attaching;
    },
    idle: async () => {
      await attaching;
      await writer?.idle();
    },
    stop: () => writer?.stop(),
  };
}

export interface TreeWriteThrough {
  // 等队列里的追加全部落完
  idle(): Promise<void>;
  stop(): void;
}

export function attachTreeWriteThrough(input: {
  bundle: RuntimeBundle;
  tree: Pick<SessionTree, "rootSessionId" | "append">;
  lane: string;
}): TreeWriteThrough {
  const { bundle, tree, lane } = input;
  const model = bundle.adapter.snapshot().model;
  const toolArgs = new Map<string, unknown>();
  // 待入队的一批：助手消息与其后的工具结果；turn.completed 由助手消息的 message_end 归一化而来，早于该轮工具调用，
  // 故收到时只记事实，等下一条助手消息、用户消息或 Run 结束再整批投影入队（此时本批工具参数都已到齐）
  let pending: Array<{
    record: EntryRecord;
    content: MessageContentRecord;
    turn?: TurnCompletedPayload;
  }> = [];
  let queue: Promise<void> = Promise.resolve();
  // 写穿失败只告警一次同类：同一个故障（磁盘满、文件被占）会在每一批上复发
  const warn = dedupedWarner();

  const enqueue = (messages: TreeMessage[]) => {
    if (messages.length === 0) {
      return;
    }
    queue = queue
      .then(() => tree.append(lane, messages))
      .catch((error: unknown) => {
        warn(
          error,
          `会话树写穿告警：${failureDetail(error)}（会话树落后于账本，可用 pigeon tree rebuild ${tree.rootSessionId} 补齐）`
        );
      });
  };

  const flush = () => {
    const batch = pending;
    pending = [];
    const messages = batch.map(({ record, content, turn }) => {
      const facts: Parameters<typeof projectLedgerMessage>[1] = {
        model: { provider: model.provider, id: model.id },
        toolArgs,
      };
      if (record.role === "assistant" && turn !== undefined) {
        facts.stopReason = turn.stopReason;
        if (turn.usage !== undefined) {
          facts.usage = turn.usage;
        }
        if (turn.errorMessage !== undefined) {
          facts.errorMessage = turn.errorMessage;
        }
      }
      return { id: record.id, message: projectLedgerMessage(content, facts) };
    });
    enqueue(messages);
  };

  const unsubscribeEntries = bundle.eventLog.onEntry((record, content) => {
    if (content === undefined || content.role === "system") {
      return;
    }
    if (record.role === "assistant" || record.role === "user") {
      flush();
    }
    pending.push({ record, content });
    if (record.role === "user") {
      flush();
    }
  });
  const unsubscribeEvents = bundle.adapter.subscribe((event) => {
    if (event.kind === "tool.proposed") {
      const payload = event.payload as { toolCallId: string; args: unknown };
      toolArgs.set(payload.toolCallId, payload.args);
    } else if (event.kind === "turn.completed") {
      // 与重建同口径：本 Run 第几条助手消息对第几次 turn.completed——事实挂在尚未挂事实的第一条助手消息上
      const target = pending.find(
        (item) => item.record.role === "assistant" && item.turn === undefined
      );
      if (target !== undefined) {
        target.turn = event.payload as TurnCompletedPayload;
      }
    } else if (event.kind === "run.ended") {
      flush();
    }
  });
  return {
    idle: async () => {
      let current: Promise<void>;
      do {
        current = queue;
        await current;
      } while (current !== queue);
    },
    stop: () => {
      unsubscribeEntries();
      unsubscribeEvents();
    },
  };
}

// 由账本重建树的命令入口（pigeon tree rebuild <sessionId>）：可给树里任一会话，按其根会话整棵重建
export async function runTreeRebuildCommand(input: {
  governanceRoot: string;
  sessionId: SessionId;
}): Promise<string> {
  const rootSessionId = treeRootOf(input.governanceRoot, input.sessionId);
  const tree = await rebuildSessionTree({ governanceRoot: input.governanceRoot, rootSessionId });
  const lanes = [TREE_MAIN_LANE];
  const dir = sessionsDirOf(input.governanceRoot);
  const queue: SessionId[] = [rootSessionId];
  while (queue.length > 0) {
    const current = queue.shift() as SessionId;
    if (!existsSync(JsonlEventLog.filePathFor(dir, current))) {
      continue;
    }
    for (const forked of materializeSession(dir, current, { content: false }).sessionForkeds) {
      lanes.push(forked.branchSessionId);
      queue.push(forked.branchSessionId);
    }
  }
  const lines = [`已由账本重建会话树：根会话 ${rootSessionId}`];
  for (const lane of lanes) {
    lines.push(`  通道 ${lane}：${(await tree.lanePath(lane)).length} 条`);
  }
  return lines.join("\n");
}
