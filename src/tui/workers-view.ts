// worker 命令与刷新（决策 067 拆分自 shell.ts）：/spawn、/cancel、/workers 与 worker 状态的刷新（M5.5 S4，决策 040）。
// 解析与收尾摘要在 application/workers-commands.ts，本模块只做壳侧投影；定时器由壳持有，经窄接口读写。
// 决策 301：原先输入框上方的 worker 状态行由编排面板（worker-panel.ts）取代；/workers 的每行与面板同一排版（列全部 worker）。
import {
  parseSpawnCommand,
  renderAttemptGroupOutcome,
  renderWorkerOutcome,
  resolveWorkerRef,
  type SpawnRequest,
  TAKE_USAGE,
  type WorkerActivity,
  type WorkerLifecycleEvent,
  type WorkerOutcome,
  type WorkerStatus,
  workerStateLabel,
} from "../application/workers-commands.ts";
import type { SessionId } from "../state/ids.ts";
import type { WorkerActivityTracker } from "./worker-activity.ts";
import { columnsOf, workerRowText } from "./worker-panel.ts";

// M5.5 S4（决策 040）：worker 编排面——orchestration 的四动作（WorkerOrchestrator 结构满足）。
// 壳只提交意图与投影状态：派出、取消、状态、等结果
export interface TuiWorkersFace {
  spawn(request: SpawnRequest): SessionId;
  cancel(sessionId: SessionId): Promise<void>;
  status(): WorkerStatus[];
  awaitResult(sessionId: SessionId): Promise<WorkerOutcome>;
  // 决策 279：/take <worker 名> 把已收尾 worker 自己的改动叠进工作目录，返回与 take_worker 工具同一套文字；主会话才有
  take?(name: string): Promise<string>;
  // M7（决策 069）：并行派发同一任务的 N 个尝试，全部收尾后交回各份的结果（322：不再贴标签）；主会话才有
  spawnAttempts?(request: {
    role: string;
    task: string;
    count: number;
  }): Promise<Parameters<typeof renderAttemptGroupOutcome>[0]>;
  // M7（决策 079）：/fork 手动分叉（主会话才有；命令层在 application/fork-command.ts）
  fork?(args: string): Promise<string>;
  // 决策 294：worker 生命周期事件（派出、开跑、收尾等）的订阅——壳据此刷新编排面板；缺省即只在命令后刷新
  subscribe?(listener: (event?: WorkerLifecycleEvent) => void): () => void;
  // 决策 301：worker 的运行事件、流式正文与工具结果（编排器的只读观察口）；缺省即面板没有正在做什么与实时花费
  observe?(listener: (activity: WorkerActivity) => void): () => void;
  // 决策 301：进入 worker 会话后发消息（进它的下一轮，交回是否送达）与续做（补批时 approve 为真）；缺省即不支持
  send?(sessionId: SessionId, text: string): Promise<"delivered" | "undelivered">;
  resume?(sessionId: SessionId, options: { approve?: boolean; message?: string }): void;
}

// 壳侧窄接口：worker 视图需要的壳动作与壳持有的状态
export interface WorkersViewHost {
  isStarted(): boolean;
  addSystem(line: string): void;
  render(): void;
  // 决策 301：worker 状态刷新后（面板重绘、收尾的花费计入）与是否要定时刷新（有在跑的或还有在淡出期内的）
  workersRefreshed(workers: readonly WorkerStatus[]): void;
  workersNeedTicking(workers: readonly WorkerStatus[]): boolean;
  workerActivity(): WorkerActivityTracker;
  clock(): number;
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

// 决策 279：/take <worker 名>——把已收尾 worker 自己的改动叠进工作目录，结果（与 take_worker 工具同一套文字）落消息区
export function handleTakeCommand(
  host: WorkersViewHost,
  workers: TuiWorkersFace,
  name: string | undefined
): void {
  if (workers.take === undefined) {
    host.addSystem("当前会话不支持取用 worker 的改动（worker 会话不能再派、也不取用）");
    return;
  }
  if (name === undefined || name === "") {
    host.addSystem(TAKE_USAGE);
    return;
  }
  workers.take(name).then(
    (text) => {
      if (!host.isStarted()) return;
      host.addSystem(text);
      host.render();
    },
    (error: unknown) => {
      if (!host.isStarted()) return;
      host.addSystem(
        `取用 worker ${name} 的改动失败：${error instanceof Error ? error.message : String(error)}`
      );
      host.render();
    }
  );
}

// /workers 的清单：每个 worker 一行与编排面板同一排版（名字、状态、耗时、轮数、花费、正在做什么），列全部 worker、不淡出，
// 下一行是分支与会话号（/take 与 trace 用）
export function renderWorkersTable(
  statuses: readonly WorkerStatus[],
  tracker: WorkerActivityTracker,
  now: number
): string {
  if (statuses.length === 0) {
    return "本会话尚未派出 worker（用 /spawn 派出）";
  }
  const columns = columnsOf(statuses);
  return [
    `workers (${statuses.length}):`,
    ...statuses.flatMap((status) => [
      `  ${workerRowText(status, tracker, now, columns)}`,
      `    ${status.role} | ${status.branch !== undefined ? `branch ${status.branch}` : "no workspace"} | session ${status.sessionId}`,
    ]),
  ].join("\n");
}

// /workers：清单落消息区并刷新面板
export function showWorkersStatus(host: WorkersViewHost, workers: TuiWorkersFace): void {
  host.addSystem(renderWorkersTable(workers.status(), host.workerActivity(), host.clock()));
  refreshWorkers(host);
}

// worker 状态刷新：面板随之重绘；有 worker 在跑或还有结束的在淡出期内时定时刷新（耗时在走、到点淡出），否则停表
export function refreshWorkers(host: WorkersViewHost): void {
  const workers = host.workers()?.status() ?? [];
  host.workersRefreshed(workers);
  const running = host.workersNeedTicking(workers);
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
