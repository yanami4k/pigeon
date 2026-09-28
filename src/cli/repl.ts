// REPL 主循环（M3 决策 3：极简 CLI，单进程内联审批，不依赖 M2 TUI）。
// 读任务 → adapter.run() → 打印终态摘要（status/stopReason + ToolExecution 账本概览）。
// 同一 readline 问答函数由主循环与审批交互共享（避免双 interface 抢 stdin）。
// M4 S6（决策 3）：斜杠命令分发给 grant 治理面（/grants /revoke /grants save）。
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import {
  compactFocusOf,
  compactionNoticeText,
  manualCompactionText,
} from "../application/compaction-text.ts";
import { sanitizeTerminalText } from "../application/format.ts";
import { type GrantsCommandContext, runGrantCommand } from "../application/grants.ts";
import { runSearchCommand } from "../application/search.ts";
import type { PiRuntimeAdapter } from "../pi-runtime/adapter.ts";

// 提问函数：返回一行输入；EOF/流关闭返回 null
export type AskFn = (prompt: string) => Promise<string | null>;
export type WriteFn = (text: string) => void;

// 终端边界净化写（决策 036）：cli 唯一 stdout 出口组合子——REPL 问答、审批交互、
// grant 命令输出与 trace/replay/session list 只读视图全部经它写出。半信任内容
//（模型文本、审批块参数与 diff 预览、错误消息）携带的终端控制序列在边界统一
// 替换为可见标记 ␛/控制图形（M2 审计 P2-1），不做逐调用点修补
export function sanitizedWriter(write: WriteFn): WriteFn {
  return (text) => write(sanitizeTerminalText(text));
}

// 用同一条输入流构造问答函数。不用 rl.question：管道/预缓冲输入下 line 事件可能在
// question 挂起之前全部到达并被丢弃（测试模拟 stdin 即此形态）；改为自建行队列——
// line 先入队/交给等待者，ask 只负责打印提示并取下一行。EOF/关闭时返回 null。
export function createAsker(input: Readable, write: WriteFn): { ask: AskFn; close: () => void } {
  const rl = createInterface({ input, terminal: false });
  const queue: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  let closed = false;
  rl.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter(line);
    } else {
      queue.push(line);
    }
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length > 0) {
      waiters.shift()?.(null);
    }
  });
  const ask: AskFn = (prompt) => {
    write(prompt);
    const queued = queue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    if (closed) {
      return Promise.resolve(null);
    }
    const { promise, resolve } = Promise.withResolvers<string | null>();
    waiters.push(resolve);
    return promise;
  };
  return { ask, close: () => rl.close() };
}

export interface ReplOptions {
  adapter: PiRuntimeAdapter;
  ask: AskFn;
  write: WriteFn;
  // M4 S6（决策 3）：grant 命令上下文——缺省时 / 命令不可用（旧测试/最小装配不受影响）
  grants?: GrantsCommandContext;
  // M5 S2（决策 038）：/search 命令上下文（工作区根）；缺省时 /search 不可用
  search?: { root: string };
  // M7（决策 079）：/fork 手动分叉（命令层在 application/fork-command.ts，与 tui 同一份）；缺省时不可用
  fork?: (args: string) => Promise<string>;
  // 决策 245：/export 把沙箱里的改动手动交回成分支（只在沙箱里）；缺省时不可用
  exportChanges?: () => Promise<string>;
}

export async function runRepl(options: ReplOptions): Promise<void> {
  const { adapter, write } = options;
  write(
    "Pigeon M3 最小 CLI（内联审批 REPL）。输入任务回车运行；:quit 退出；" +
      "/grants 查看放权、/revoke <id> 撤销、/grants save <id> 升格固化。\n"
  );
  // D2 可见性：会话记录写入失败（listenerErrors）非空时显式警告——可见降级，绝不假装证据链完整。
  // 增量报数：同一批故障不重复刷屏，新故障出现时以累计数提醒。
  // 启动即查一次：覆盖未来冷恢复路径（resume 复用同一出口）
  let reportedListenerErrors = 0;
  const warnEvidenceGaps = (): void => {
    const count = adapter.listenerErrors().length;
    if (count > reportedListenerErrors) {
      write(`警告：本会话有 ${count} 条会话记录写入失败，证据链不完整。\n`);
      reportedListenerErrors = count;
    }
  };
  warnEvidenceGaps();
  // 决策 189：每次压缩（自动或手动）打印一行压缩前后的 token 数
  const unsubscribeCompaction = adapter.subscribeCompaction((notice) => {
    write(`${compactionNoticeText(notice)}\n`);
  });
  try {
    await replLoop(options, warnEvidenceGaps);
  } finally {
    unsubscribeCompaction();
  }
}

async function replLoop(options: ReplOptions, warnEvidenceGaps: () => void): Promise<void> {
  const { adapter, ask, write } = options;
  for (;;) {
    const line = await ask("pigeon> ");
    if (line === null) {
      break;
    }
    const task = line.trim();
    if (task === ":quit") {
      break;
    }
    if (task === "") {
      continue;
    }
    // M4 S6（决策 3）：斜杠命令——grant 治理面的唯一人机入口（/grants 唯一展示面）
    if (task.startsWith("/")) {
      const tokens = task
        .slice(1)
        .split(/\s+/)
        .filter((token) => token.length > 0);
      try {
        // M5 S2（决策 038）：/search 内容级检索——命令层与 tui 同一份
        if (tokens[0] === "search" && options.search !== undefined) {
          write(await runSearchCommand({ root: options.search.root, args: tokens.slice(1) }));
          continue;
        }
        if (tokens[0] === "export" && options.exportChanges !== undefined) {
          write(`${await options.exportChanges()}\n`);
          continue;
        }
        if (tokens[0] === "fork" && options.fork !== undefined) {
          write(`${await options.fork(task.slice("/fork".length))}\n`);
          continue;
        }
        // 决策 189：/compact [重点] 手动压缩——重点作为摘要的附加说明；压成时的一行提示由上面的订阅打印
        if (tokens[0] === "compact") {
          const text = manualCompactionText(await adapter.compact(compactFocusOf(task)));
          if (text !== undefined) {
            write(`${text}\n`);
          }
          continue;
        }
        const handled = options.grants !== undefined && runGrantCommand(tokens, options.grants);
        if (!handled) {
          write(
            `未知命令：${task}（可用 /compact [重点]、/search、/grants、/revoke <id>、/grants save <id>${options.exportChanges !== undefined ? "、/export" : ""}）\n`
          );
        }
      } catch (error) {
        write(`命令失败：${error instanceof Error ? error.message : String(error)}\n`);
      }
      continue;
    }
    try {
      const result = await adapter.run(task);
      warnEvidenceGaps();
      write(`\n终态：${result.status}（stopReason=${result.stopReason ?? "无"}）\n`);
      if (result.errorMessage !== undefined) {
        write(`错误：${result.errorMessage}\n`);
      }
      if (result.toolExecutions.length === 0) {
        write("工具执行：无\n");
      } else {
        write(`工具执行：${result.toolExecutions.length} 次\n`);
        for (const record of result.toolExecutions) {
          const decision = record.decision;
          write(
            `  ${record.toolName}：${decision?.outcome ?? "无决定"}（${decision?.approvedBy ?? "-"}）→ ${record.state}\n`
          );
        }
      }
    } catch (error) {
      write(`Run 失败：${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}
