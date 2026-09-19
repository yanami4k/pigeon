// worker 命令与状态行（决策 067 拆分自 shell.ts，零行为变化）：/spawn、/cancel、/workers 与
// 状态栏下方的 worker 行（M5.5 S4，决策 040）。解析与排版在 application/workers-commands.ts，
// 本模块只做壳侧投影；定时器与状态行组件由壳持有，经窄接口读写。
import {
  parseSpawnCommand,
  renderAttemptGroupOutcome,
  renderWorkerOutcome,
  renderWorkersStatus,
  resolveWorkerRef,
  type SpawnRequest,
  type WorkerOutcome,
  type WorkerStatus,
  workerStateLabel,
  workerStatusBar,
} from "../application/workers-commands.ts";
import type { SessionId } from "../state/ids.ts";

// M5.5 S4（决策 040）：worker 编排面——orchestration 的四动作（WorkerOrchestrator 结构满足）。
// 壳只提交意图与投影状态：派出、取消、状态、等结果
export interface TuiWorkersFace {
  spawn(request: SpawnRequest): SessionId;
  cancel(sessionId: SessionId): Promise<void>;
  status(): WorkerStatus[];
  awaitResult(sessionId: SessionId): Promise<WorkerOutcome>;
  // M7（决策 069 / 074）：并行派发同一任务的 N 个尝试，全部收尾后验证、选对并自动提炼；主会话才有
  spawnAttempts?(request: {
    role: string;
    task: string;
    count: number;
  }): Promise<Parameters<typeof renderAttemptGroupOutcome>[0]>;
  // M7（决策 079）：/fork 手动分叉（主会话才有；命令层在 application/fork-command.ts）
  fork?(args: string): Promise<string>;
}

// 壳侧窄接口：worker 视图需要的壳动作与壳持有的状态
export interface WorkersViewHost {
  isStarted(): boolean;
  addSystem(line: string): void;
  render(): void;
  setWorkerStatusLine(text: string): void;
  workers(): TuiWorkersFace | undefined;
  workerTimer(): ReturnType<typeof setInterval> | null;
  setWorkerTimer(timer: ReturnType<typeof setInterval> | null): void;
  workerRefreshMs(): number;
}

// /spawn <角色> [--name <名>] "<任务>"：派出即回显，收尾摘要经 awaitResult 投影到消息区。
// 解析与派出的异常由斜杠命令分发统一呈现为「命令失败」
export function handleSpawnCommand(
  host: WorkersViewHost,
  workers: TuiWorkersFace,
  raw: string
): void {
  const request = parseSpawnCommand(raw);
  if (request.attempts !== undefined) {
    if (workers.spawnAttempts === undefined) {
      host.addSystem("当前会话不支持并行同任务派发（worker 会话不能再派）");
      return;
    }
    host.addSystem(`并行派出 ${request.attempts} 个尝试（${request.role}）：${request.task}`);
    workers.spawnAttempts({ role: request.role, task: request.task, count: request.attempts }).then(
      (result) => {
        if (!host.isStarted()) return;
        host.addSystem(renderAttemptGroupOutcome(result));
        refreshWorkers(host);
        host.render();
      },
      (error: unknown) => {
        if (!host.isStarted()) return;
        host.addSystem(
          `并行尝试收尾异常：${error instanceof Error ? error.message : String(error)}`
        );
        host.render();
      }
    );
    refreshWorkers(host);
    return;
  }
  const sessionId = workers.spawn(request);
  const spawned = workers.status().find((worker) => worker.sessionId === sessionId);
  host.addSystem(
    `已派出 worker ${spawned?.name ?? sessionId}（${request.role}）｜ 会话 ${sessionId} ｜ ` +
      `分支 ${spawned?.branch ?? "未知"}`
  );
  refreshWorkers(host);
  workers.awaitResult(sessionId).then(
    (outcome) => {
      if (!host.isStarted()) return;
      host.addSystem(renderWorkerOutcome(outcome));
      refreshWorkers(host);
      host.render();
    },
    (error: unknown) => {
      if (!host.isStarted()) return;
      host.addSystem(
        `worker ${sessionId} 收尾异常：${error instanceof Error ? error.message : String(error)}`
      );
      refreshWorkers(host);
      host.render();
    }
  );
}

// /cancel <worker 名或会话 id>：走编排器的 cancel（interrupt）；收尾摘要由 spawn 时挂的 awaitResult 落
export function handleCancelCommand(
  host: WorkersViewHost,
  workers: TuiWorkersFace,
  ref: string | undefined
): void {
  if (ref === undefined) {
    host.addSystem("用法：/cancel <worker 名或会话 id>");
    return;
  }
  const target = resolveWorkerRef(workers.status(), ref);
  if (target.state !== "running") {
    host.addSystem(`worker ${target.name} 已收尾（${workerStateLabel(target.state)}），无需取消`);
    return;
  }
  host.addSystem(`[cancel] worker ${target.name} interrupt requested`);
  workers.cancel(target.sessionId).then(
    () => {
      refreshWorkers(host);
      host.render();
    },
    (error: unknown) => {
      host.addSystem(
        `取消 worker ${target.name} 失败：${error instanceof Error ? error.message : String(error)}`
      );
      host.render();
    }
  );
}

// /workers：状态清单落消息区并刷新状态行
export function showWorkersStatus(host: WorkersViewHost, workers: TuiWorkersFace): void {
  host.addSystem(renderWorkersStatus(workers.status()));
  refreshWorkers(host);
}

// worker 状态行：状态栏下方一行纯 ASCII；有 worker 在跑时定时刷新（轮次在变），全部收尾即停表
export function refreshWorkers(host: WorkersViewHost): void {
  const workers = host.workers()?.status() ?? [];
  host.setWorkerStatusLine(workerStatusBar(workers));
  const running = workers.some((worker) => worker.state === "running");
  if (running && host.isStarted() && host.workerTimer() === null) {
    const timer = setInterval(() => {
      refreshWorkers(host);
      host.render();
    }, host.workerRefreshMs());
    timer.unref();
    host.setWorkerTimer(timer);
  } else if (!running && host.workerTimer() !== null) {
    clearInterval(host.workerTimer() as ReturnType<typeof setInterval>);
    host.setWorkerTimer(null);
  }
}
