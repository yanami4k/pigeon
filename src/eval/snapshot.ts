// Eval 快照准备（M6.5 S2，决策 057）：仓库根与治理根分开传——仓库根来自任务的 repo，治理根是输出目录；
// 经 WorkspaceProvider 从任务 ref 开 git 工作树，worker 名 <taskId>-<condition>-<n> 使分支唯一。
// 工作树里没有 node_modules，验证脚本与 run_command 的测试命令都要它：挂一个目录联接指向仓库根的 node_modules。
// 每次运行结束 release：先拆联接（绝不递归删除联接目标），再删工作树与分支；任一步失败不跳过后续，最后一并上抛。
import { existsSync, readdirSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import { gitWorktreeWorkspaces } from "../orchestration/workers.ts";
import { deleteBranch, removeWorktree, worktreeBranchFor } from "../orchestration/worktree.ts";
import { type GitWorktreeWorkspace, isGitWorktreeWorkspace } from "../state/event-log.ts";
import type { SessionId } from "../state/ids.ts";
import type { EvalCondition, LoadedEvalTask } from "./task.ts";

export interface PrepareTaskWorkspaceInput {
  task: LoadedEvalTask;
  governanceRoot: string;
  sessionId: SessionId;
  condition: EvalCondition;
  // 第几次（从 1 起）
  attempt: number;
}

export interface PreparedTaskWorkspace {
  name: string;
  // Eval 的工作区恒为 git 工作树（prepareTaskWorkspace 里以运行期断言收口）
  workspace: GitWorktreeWorkspace;
  // 删除工作树与分支；幂等
  release(): void;
}

export function evalWorkerName(taskId: string, condition: EvalCondition, attempt: number): string {
  return `${taskId}-${condition}-${attempt}`;
}

export function prepareTaskWorkspace(input: PrepareTaskWorkspaceInput): PreparedTaskWorkspace {
  const { task } = input;
  const name = evalWorkerName(task.spec.id, input.condition, input.attempt);
  const provider = gitWorktreeWorkspaces({
    repoRoot: task.repoRoot,
    governanceRoot: input.governanceRoot,
  });
  // Eval 的工作区恒为 git 工作树（任务快照从 ref 开出）；角色按 implementer 规划（M6 起 plan 收角色）
  const request = {
    sessionId: input.sessionId,
    name,
    role: "implementer" as const,
    baseRef: task.spec.repo.ref,
  };
  const workspace = provider.plan(request);
  if (!isGitWorktreeWorkspace(workspace)) {
    throw new Error("Eval 任务快照必须是 git 工作树工作区");
  }
  provider.create(workspace, request);
  const link = path.join(workspace.path, "node_modules");
  const target = path.join(task.repoRoot, "node_modules");
  let linked = false;
  let released = false;
  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    const errors: unknown[] = [];
    if (linked) {
      try {
        unlinkJunction(link);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      removeWorktree({ repoRoot: task.repoRoot, path: workspace.path, force: true });
    } catch (error) {
      errors.push(error);
    }
    try {
      deleteBranch({ repoRoot: task.repoRoot, branch: workspace.branch });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `清理工作树 ${name} 失败`);
    }
  };
  try {
    if (existsSync(target) && !existsSync(link)) {
      symlinkSync(target, link, "junction");
      linked = true;
    }
  } catch (error) {
    release();
    throw error;
  }
  return { name, workspace, release };
}

// 崩溃残留清理（M6.5 S5）：runner 进程死于一次运行中途时，治理根的 .pigeon/worktrees 下留有工作树、它检出的
// worker 分支与 node_modules 联接；续跑同一输出目录以同名 worker 重开工作树会撞分支。开跑前逐个拆联接、强制移除
// 工作树、删分支（分支本就不存在时跳过）。输出目录的治理根只属于这一份 Eval，同一输出目录不支持并发运行，
// 残留目录不会是别的进程正在用的工作树。返回清理掉的 worker 名
export function releaseStaleWorkspaces(input: {
  governanceRoot: string;
  repoRoot: string;
}): string[] {
  const root = path.join(input.governanceRoot, ".pigeon", "worktrees");
  if (!existsSync(root)) {
    return [];
  }
  const cleaned: string[] = [];
  const errors: unknown[] = [];
  for (const dirName of readdirSync(root).sort()) {
    const match = /^sess_[0-9A-HJKMNP-TV-Z]{26}-([a-z0-9][a-z0-9-]{0,39})$/.exec(dirName);
    const name = match?.[1];
    if (name === undefined) {
      continue;
    }
    const dir = path.join(root, dirName);
    try {
      const link = path.join(dir, "node_modules");
      if (existsSync(link)) {
        unlinkJunction(link);
      }
      removeWorktree({ repoRoot: input.repoRoot, path: dir, force: true });
    } catch (error) {
      errors.push(error);
      continue;
    }
    try {
      deleteBranch({ repoRoot: input.repoRoot, branch: worktreeBranchFor(name) });
    } catch (error) {
      if (!/not found/i.test(error instanceof Error ? error.message : String(error))) {
        errors.push(error);
      }
    }
    cleaned.push(name);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "清理残留工作树失败");
  }
  return cleaned;
}

// 只拆联接本身：Windows 上目录联接按目录删除，其他平台是符号链接
function unlinkJunction(link: string): void {
  try {
    unlinkSync(link);
  } catch {
    rmdirSync(link);
  }
}
