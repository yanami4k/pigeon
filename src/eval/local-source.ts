// 任务源的自造题实现（决策 100 / 102）：冒烟用途。实例来自入库的 eval/tasks/<id>/ 任务目录；环境准备是从任务 ref
// 开 git 工作树（宿主本地工作区）；判据命令是任务目录里的验证脚本，判分前先回填验证资产；元数据取自 task.json。
import { prepareTaskWorkspace, releaseStaleWorkspaces } from "./snapshot.ts";
import type { LoadedEvalTask } from "./task.ts";
import type { EvalInstance, TaskSource } from "./task-source.ts";
import { localJudge, verifierCommand } from "./verify.ts";

export function localTaskSource(tasks: readonly LoadedEvalTask[]): TaskSource {
  const byId = new Map(tasks.map((task) => [task.spec.id, task]));
  return {
    name: "local",
    instances: (): EvalInstance[] =>
      tasks.map((task) => ({
        id: task.spec.id,
        instructions: task.instructions,
        budget: { ...task.spec.budget },
        holdout: task.spec.holdout,
        tags: task.spec.tags,
      })),
    async prepare(instance, context) {
      const task = byId.get(instance.id);
      if (task === undefined) {
        throw new Error(`任务源里没有这个实例：${instance.id}`);
      }
      const prepared = prepareTaskWorkspace({
        task,
        governanceRoot: context.governanceRoot,
        sessionId: context.sessionId,
        condition: context.condition,
        attempt: context.attempt,
      });
      const workspaceRoot = prepared.workspace.path;
      return {
        workspaceRoot,
        judge: localJudge(task, workspaceRoot),
        judgeCommandHint: verifierCommand(task),
        release: async () => prepared.release(),
      };
    },
    // 续跑前清理上次进程死于中途留下的工作树与分支（同名 worker 会撞分支）
    async cleanupStale(governanceRoot) {
      for (const repoRoot of new Set(tasks.map((task) => task.repoRoot))) {
        releaseStaleWorkspaces({ governanceRoot, repoRoot });
      }
    },
  };
}
