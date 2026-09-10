// REPL 主循环（M3 决策 3：极简 CLI，单进程内联审批，不依赖 M2 TUI）。
// 读任务 → adapter.run() → 打印终态摘要（status/stopReason + ToolExecution 账本概览）。
// 同一 readline 问答函数由主循环与审批交互共享（避免双 interface 抢 stdin）。
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { PiRuntimeAdapter } from "../pi-runtime/adapter.ts";

// 提问函数：返回一行输入；EOF/流关闭返回 null
export type AskFn = (prompt: string) => Promise<string | null>;
export type WriteFn = (text: string) => void;

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
}

export async function runRepl(options: ReplOptions): Promise<void> {
  const { adapter, ask, write } = options;
  write("Pigeon M3 最小 CLI（内联审批 REPL）。输入任务回车运行；:quit 退出。\n");
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
    try {
      const result = await adapter.run(task);
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
