// 派 worker 工具的会话侧绑定（决策 264–268、297）：编排器建好后，把它连同并行尝试的派发、本次运行的派出额度与完成通知绑到工具槽上。
// 终端界面与 pigeon run 的主会话共用这一份（层数放开时各层 worker 也各绑一份，派出方为它自己）；额度的持有方（pigeon run 的
// token 上限）另用 stopAllWorkers 停掉在跑的 worker。
// 决策 322：并行尝试不再执行验证命令、不再贴标签——各份的改动与摘要交回，由主 agent 或人比较
import type { WorkerOrchestrator, WorkerOutcome } from "../orchestration/workers.ts";
import type { SessionId } from "../state/ids.ts";
import { runAttemptGroup } from "./attempt-group.ts";
import { SpawnWorkerBudget, type SpawnWorkerSlot, workerNoticeText } from "./spawn-worker-tool.ts";
import { type NoticeTarget, WorkerNotices } from "./worker-notices.ts";

export interface BindSpawnWorkersInput {
  slot: SpawnWorkerSlot;
  orchestrator: WorkerOrchestrator;
  governanceRoot: string;
  // 宿主会话：通知的派出方会话（派出方是 worker 时为它自己）
  hostSessionId: SessionId;
  // 一次运行的标识（终端界面里每条输入是一次运行）；缺省整个会话算一次运行
  runKey?: () => string | undefined;
  // 决策 297：通知的去处（派出方的运行面）；不给即不发通知
  target?: NoticeTarget;
  // 派出方空闲时叫醒它（终端界面给；pigeon run 与嵌套 worker 由 drainWorkers 处理）
  wake?: () => void;
  onNotice?: (text: string) => void;
  // 决策 299：派出方是 worker 时为它的会话号
  from?: SessionId;
}

export interface BoundSpawnWorkers {
  budget: SpawnWorkerBudget;
  notices?: WorkerNotices;
}

export function bindSpawnWorkers(input: BindSpawnWorkersInput): BoundSpawnWorkers {
  const settings = input.slot.settings;
  const budget = new SpawnWorkerBudget({
    ...(settings.maxAgentSpawns !== undefined ? { maxAgentSpawns: settings.maxAgentSpawns } : {}),
    ...(input.runKey !== undefined ? { runKey: input.runKey } : {}),
  });
  const notices =
    input.target !== undefined
      ? new WorkerNotices({
          orchestrator: input.orchestrator,
          parentSessionId: input.from ?? input.hostSessionId,
          target: input.target,
          text: (outcome) => workerNoticeText(outcome, budget.exhausted, settings),
          ...(input.wake !== undefined ? { wake: input.wake } : {}),
          ...(input.onNotice !== undefined ? { onNotice: input.onNotice } : {}),
        })
      : undefined;
  input.slot.bind({
    orchestrator: input.orchestrator,
    governanceRoot: input.governanceRoot,
    budget,
    ...(notices !== undefined ? { notices } : {}),
    ...(input.from !== undefined ? { from: input.from } : {}),
    spawnAttempts: async (request) => {
      const result = await runAttemptGroup({
        orchestrator: input.orchestrator,
        role: request.role,
        task: request.task,
        count: request.count,
        origin: "agent",
        ...(request.label !== undefined ? { label: request.label } : {}),
        ...(input.from !== undefined ? { from: input.from } : {}),
        ...(request.tools !== undefined ? { tools: request.tools } : {}),
        ...(request.scopes !== undefined ? { scopes: request.scopes } : {}),
        onSpawned: request.onSpawned,
      });
      return { outcomes: result.outcomes };
    },
  });
  return { budget, ...(notices !== undefined ? { notices } : {}) };
}

// 停掉排队中与在跑的 worker，并等它们收尾（收尾记录写进父会话，须在父会话释放之前）
export async function stopAllWorkers(
  orchestrator: Pick<WorkerOrchestrator, "status" | "cancel" | "awaitResult">
): Promise<WorkerOutcome[]> {
  const live = orchestrator
    .status()
    .filter((worker) => worker.state === "running" || worker.state === "queued");
  await Promise.allSettled(live.map((worker) => orchestrator.cancel(worker.sessionId)));
  const settled = await Promise.allSettled(
    live.map((worker) => orchestrator.awaitResult(worker.sessionId))
  );
  return settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
}
