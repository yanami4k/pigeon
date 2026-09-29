// 脚本编排的斜杠命令（决策 309、312、314、301）：/orchestrate <任务> [额度 …] 以人的输入点名发起（交给模型的文字带关键词，
// 见 script-texts.ts 的 commandInputText，由壳按人的输入提交）；/orchestrate resume <运行号> [额度 …] 由程序直接续跑（沿用该次
// 的脚本与快照，给了额度即换成它）；/orchestrate stop [运行号] 停止整个脚本（不给运行号即停在跑的全部）；/orchestrate drop
// <运行号> 放弃，删掉它的快照引用。终端界面与命令行共用这里的文字。
import type { WorkerOrchestrator } from "../orchestration/workers.ts";
import type { SessionId } from "../state/ids.ts";
import { parseScriptBudget, SCRIPT_COMMAND } from "./script-naming.ts";
import type { ScriptRuns } from "./script-runner.ts";
import { ORCHESTRATE_TEXTS } from "./script-texts.ts";

export const SCRIPT_COMMAND_USAGE = `/${SCRIPT_COMMAND} <任务> [额度 ¥5|$2|300k]`;

export const SCRIPT_COMMAND_TEXTS = {
  usage: `用法：${SCRIPT_COMMAND_USAGE}；/${SCRIPT_COMMAND} resume <运行号> [额度 …]；/${SCRIPT_COMMAND} stop [运行号]；/${SCRIPT_COMMAND} drop <运行号>`,
  stopped: (runIds: readonly string[]) =>
    `已停止脚本 ${runIds.join("、")}：在跑的 worker 停下，结果照常交回。`,
  noneRunning: "没有在跑的脚本。",
  dropped: (runId: string) => `已放弃脚本 ${runId}，删掉了它的快照引用；之后不能再续跑。`,
} as const;

export interface ScriptCommands {
  resume(runId: string, rest: string): Promise<string>;
  stop(runId?: string): Promise<string>;
  drop(runId: string): string;
  // 树形视图里选中的 worker 所属的脚本：停止整个脚本；不属于脚本即 undefined
  stopOfWorker(sessionId: SessionId): Promise<string | undefined>;
}

export function scriptCommands(
  runs: ScriptRuns,
  orchestrator: Pick<WorkerOrchestrator, "status">
): ScriptCommands {
  const stop = async (runId?: string): Promise<string> => {
    const targets = runId !== undefined ? [runId] : runs.running();
    if (runId !== undefined && !runs.has(runId)) return ORCHESTRATE_TEXTS.unknownRun(runId);
    const stopped: string[] = [];
    for (const id of targets) {
      if (await runs.stop(id)) stopped.push(id);
    }
    return stopped.length > 0
      ? SCRIPT_COMMAND_TEXTS.stopped(stopped)
      : SCRIPT_COMMAND_TEXTS.noneRunning;
  };
  return {
    resume: async (runId, rest) => {
      const budget = parseScriptBudget(rest);
      const result = await runs.resume(runId, budget !== undefined ? { budget } : {});
      if (result === "unknown") return ORCHESTRATE_TEXTS.unknownRun(runId);
      if (result === "running") return ORCHESTRATE_TEXTS.stillRunning(runId);
      return ORCHESTRATE_TEXTS.resumed(runs.spec(runId)?.name ?? runId, runId);
    },
    stop,
    drop: (runId) => {
      const result = runs.drop(runId);
      return result === "dropped"
        ? SCRIPT_COMMAND_TEXTS.dropped(runId)
        : result === "running"
          ? ORCHESTRATE_TEXTS.stillRunning(runId)
          : ORCHESTRATE_TEXTS.unknownRun(runId);
    },
    stopOfWorker: async (sessionId) => {
      const runId = orchestrator.status().find((status) => status.sessionId === sessionId)
        ?.script?.runId;
      return runId !== undefined ? stop(runId) : undefined;
    },
  };
}
