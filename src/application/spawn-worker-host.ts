// 派 worker 工具的会话侧绑定（决策 264–268）：编排器建好后，把它连同并行尝试的派发与本次运行的派出额度绑到工具槽上。
// 终端界面与 pigeon run 的主会话共用这一份；额度的持有方（pigeon run 的 token 上限）另用 stopAllWorkers 停掉在跑的 worker。
import type { WorkerOrchestrator, WorkerOutcome } from "../orchestration/workers.ts";
import type { VerifyConfig } from "../state/attempt-config.ts";
import type { SessionId } from "../state/ids.ts";
import { type HostStore, runAttemptGroup } from "./attempt-group.ts";
import { SpawnWorkerBudget, type SpawnWorkerSlot } from "./spawn-worker-tool.ts";

export interface BindSpawnWorkersInput {
  slot: SpawnWorkerSlot;
  orchestrator: WorkerOrchestrator;
  governanceRoot: string;
  // 宿主会话：并行尝试的验证记录落在这里
  hostSessionId: SessionId;
  hostStore: HostStore;
  // 会话级验证命令（并行尝试按它标签；未配置即未知）
  verify?: VerifyConfig;
  // 一次运行的标识（终端界面里每条输入是一次运行）；缺省整个会话算一次运行
  runKey?: () => string | undefined;
}

export function bindSpawnWorkers(input: BindSpawnWorkersInput): SpawnWorkerBudget {
  const budget = new SpawnWorkerBudget({
    maxAgentSpawns: input.slot.limits.maxAgentSpawns,
    ...(input.runKey !== undefined ? { runKey: input.runKey } : {}),
  });
  input.slot.bind({
    orchestrator: input.orchestrator,
    governanceRoot: input.governanceRoot,
    budget,
    spawnAttempts: async (request) => {
      const result = await runAttemptGroup({
        orchestrator: input.orchestrator,
        governanceRoot: input.governanceRoot,
        hostLog: { sessionId: input.hostSessionId },
        hostStore: input.hostStore,
        role: request.role,
        task: request.task,
        count: request.count,
        ...(input.verify !== undefined ? { verify: input.verify } : {}),
        onSpawned: request.onSpawned,
      });
      return {
        outcomes: result.outcomes,
        labels: new Map(result.attempts.map((attempt) => [attempt.sessionId, attempt.label])),
      };
    },
  });
  return budget;
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
