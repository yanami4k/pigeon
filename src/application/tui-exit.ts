// 终端界面退出（决策 283、331）：/quit、双击 Ctrl+C、SIGINT/SIGTERM 等正常退出一律立即收尾，不调用模型。
// 收尾顺序：取消在跑的 worker 并等其收尾记录落盘（有上限）→ 释放运行面 → 沙箱会话交回并删除容器。
// 决策 331 删除补做复盘后，退出时不再拍工作目录快照、不再写退出条目（它们只供补做读代码）；旧会话里已有的退出条目照常可读。
import type { SandboxExport } from "../execution/sandbox.ts";
import type { SessionId } from "../state/ids.ts";
import { handbackJobsNotice } from "./background-jobs.ts";
import { disposeRuntime, type RuntimeBundle } from "./runtime.ts";
import type { WarnSink } from "./warnings.ts";

// 退出时取消的 worker：编排器面的最小子集
export interface ExitWorkers {
  status(): ReadonlyArray<{ sessionId: SessionId; state: string }>;
  cancel(id: SessionId): Promise<unknown>;
  awaitResult(id: SessionId): Promise<unknown>;
}

export interface CloseTuiSessionInput {
  governanceRoot: string;
  sessionId: SessionId;
  bundle: RuntimeBundle;
  workers?: ExitWorkers;
  // 等 worker 收尾记录落盘的上限（毫秒）：超时仍退出，缺 settled 由冷侧如实标注
  workerGraceMs: number;
  // 沙箱会话：交回并删除容器（决策 245），返回给人看的一句话与交回结果
  closeSandbox?: () => Promise<{ notice: string; exported?: SandboxExport }>;
  // 沙箱交回的提示（壳已停，打到标准输出）
  log?: (line: string) => void;
  warn?: WarnSink;
}

// 终端界面会话的收尾：不调用模型（283）
export async function closeTuiSession(input: CloseTuiSessionInput): Promise<void> {
  const workers = input.workers;
  if (workers !== undefined) {
    const running = workers
      .status()
      .filter((worker) => worker.state === "running" || worker.state === "queued");
    await Promise.allSettled(running.map((worker) => workers.cancel(worker.sessionId)));
    await Promise.race([
      Promise.allSettled(running.map((worker) => workers.awaitResult(worker.sessionId))),
      new Promise((resolve) => setTimeout(resolve, input.workerGraceMs)),
    ]);
  }
  // 决策 365：交回沙箱前有后台作业在跑先提示（随后随运行面释放停掉）
  if (input.closeSandbox !== undefined) {
    const warning = handbackJobsNotice(input.bundle.jobs, "close");
    if (warning !== undefined) input.log?.(warning);
  }
  await disposeRuntime(input.bundle);
  if (input.closeSandbox !== undefined) {
    const closed = await input.closeSandbox();
    input.log?.(closed.notice);
  }
}
