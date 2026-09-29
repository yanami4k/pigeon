// 脚本编排的会话侧装配（决策 309–314）：把运行器接到本会话的编排器与真实能力上——容器（日常沙箱的通用镜像）、主目录快照、
// 叠加收回、收回的请示（放手模式或已放权即直接做，否则经审批通道请示一次；没有审批通道即不批）、重启后从会话里找回，
// 以及结束汇总的去处（与 worker 完成通知同一条队列）。
import { join } from "node:path";
import type { ApprovalHandler } from "../approvals/handler.ts";
import { assertDockerAvailable } from "../execution/sandbox.ts";
import {
  ensureSandboxImage,
  loadSandboxConfig,
  resolveSandboxImage,
} from "../execution/sandbox-image.ts";
import { dockerScriptLauncher, type ScriptLauncher } from "../execution/script-sandbox.ts";
import {
  readScriptSnapshot,
  releaseScriptSnapshot,
  takeScriptSnapshot,
} from "../execution/script-snapshot.ts";
import { overlayWorkerChanges } from "../execution/worker-overlay.ts";
import type { WorkerOrchestrator } from "../orchestration/workers.ts";
import { loadSessionView } from "../persistence/session-catalog.ts";
import type { ConfigGrantRule } from "../state/grants.ts";
import type { SessionId } from "../state/ids.ts";
import type { SessionView } from "../state/session-view.ts";
import { matchConfigGrants } from "../tools/grants.ts";
import type { ScriptBudget } from "./script-naming.ts";
import {
  type RestoredScriptRun,
  type ScriptCallRecord,
  type ScriptRunnerDeps,
  ScriptRuns,
  type ScriptSpec,
} from "./script-runner.ts";
import { ORCHESTRATE_TOOL } from "./script-texts.ts";
import { emptyCostTally, mergeCostTally, sessionCostTally } from "./session-cost.ts";
import { TAKE_WORKER_TOOL } from "./spawn-worker-tool.ts";
import type { WorkerNotices } from "./worker-notices.ts";

// Docker 不可用或镜像准备不成：工具据此回"Docker 不可用"
export class ScriptLaunchError extends Error {}

// 容器：日常沙箱的通用镜像（含 Node 24）；项目的沙箱配置只取构建参数（改用的镜像不一定带 Node）。首次用时检查一次
export function dockerLauncherFor(
  governanceRoot: string,
  options: { docker?: readonly string[]; log?: (line: string) => void } = {}
): () => Promise<ScriptLauncher> {
  let ready: Promise<ScriptLauncher> | undefined;
  return () => {
    ready ??= (async () => {
      try {
        await assertDockerAvailable(options.docker);
        const config = loadSandboxConfig(governanceRoot);
        const spec = resolveSandboxImage(governanceRoot, {
          ...(config.build !== undefined ? { build: config.build } : {}),
        });
        const image = await ensureSandboxImage(spec, {
          ...(options.docker !== undefined ? { docker: options.docker } : {}),
          ...(options.log !== undefined ? { log: options.log } : {}),
        });
        return dockerScriptLauncher({
          image,
          ...(options.docker !== undefined ? { docker: options.docker } : {}),
        });
      } catch (error) {
        throw new ScriptLaunchError(error instanceof Error ? error.message : String(error));
      }
    })();
    const current = ready;
    current.catch(() => {
      // 失败不缓存：Docker 起来后下次再试
      if (ready === current) ready = undefined;
    });
    return current;
  };
}

// 收回的请示：放手模式或已放权（会话放权、固化规则，与 take_worker 同一工具名）即直接做；否则经审批通道请示一次
export interface CollectApproval {
  yolo: boolean;
  grants?: { match(toolName: string, args: unknown): unknown };
  configGrants?: readonly ConfigGrantRule[];
  handler?: ApprovalHandler;
}

export function collectApprover(
  governanceRoot: string,
  approval: CollectApproval
): ScriptRunnerDeps["approveCollect"] {
  return async ({ runId, title, workers }) => {
    if (approval.yolo) return true;
    const args = { workers };
    if (
      approval.grants?.match(TAKE_WORKER_TOOL, args) != null ||
      matchConfigGrants(
        approval.configGrants ?? [],
        governanceRoot,
        TAKE_WORKER_TOOL,
        args,
        false
      ) !== null
    ) {
      return true;
    }
    if (approval.handler === undefined) return false;
    const decision = await approval.handler({
      toolName: TAKE_WORKER_TOOL,
      toolCallId: `script-collect-${runId}`,
      args,
      tier: "write",
      script: { runId, title },
    });
    return decision.approved;
  };
}

// 重启后从会话找回一次脚本运行：派出与收尾条目上的运行号与指纹，提交脚本的工具结果里的脚本正文，各 worker 会话的花费
export function restoreScriptRun(
  sessionsDir: string,
  view: SessionView | undefined,
  runId: string
): RestoredScriptRun | undefined {
  if (view === undefined) return undefined;
  let spec: ScriptSpec | undefined;
  let budget: ScriptBudget | undefined;
  for (const message of view.messages) {
    if (message.role !== "toolResult" || message.toolName !== ORCHESTRATE_TOOL) continue;
    const details = (message.raw as { details?: unknown }).details as
      | { runId?: unknown; spec?: ScriptSpec; budget?: ScriptBudget }
      | undefined;
    if (details?.runId === runId && details.spec !== undefined) {
      spec = details.spec;
      budget = details.budget;
    }
  }
  if (spec === undefined) return undefined;
  const records: ScriptCallRecord[] = [];
  const names: string[] = [];
  const spent = emptyCostTally();
  for (const child of view.children) {
    const tag = child.spawned.script;
    if (tag?.runId !== runId) continue;
    names.push(child.spawned.name);
    mergeCostTally(spent, sessionCostTally(sessionsDir, child.spawned.childSessionId));
    const workspace = child.spawned.workspace;
    const settled = child.settled;
    if (
      settled === undefined ||
      workspace.kind !== "git-worktree" ||
      workspace.baseCommit === undefined
    ) {
      continue;
    }
    records.push({
      fingerprint: tag.fingerprint,
      sessionId: child.spawned.childSessionId as SessionId,
      name: child.spawned.name,
      worktree: workspace.path,
      branch: workspace.branch,
      base: workspace.baseCommit,
      ...(tag.relayFrom !== undefined ? { relayFrom: tag.relayFrom as SessionId } : {}),
      status: settled.status,
      ...(settled.errorKind !== undefined ? { errorKind: settled.errorKind } : {}),
      ...(settled.error !== undefined ? { error: settled.error } : {}),
      ...(settled.errorKind === "approval-timeout" || settled.errorKind === "approval-unattended"
        ? { blockedAction: settled.error ?? "" }
        : {}),
      summary: settled.result?.summary ?? "",
      changedFiles: settled.result?.changedFiles ?? [],
      ...(settled.script?.structured !== undefined
        ? { structured: settled.script.structured }
        : {}),
    });
  }
  return { spec, ...(budget !== undefined ? { budget } : {}), records, names, spent };
}

export interface SessionScriptsInput {
  orchestrator: ScriptRunnerDeps["orchestrator"] & Pick<WorkerOrchestrator, "status">;
  governanceRoot: string;
  // 本会话（主会话）：重启后从它的会话文件找回
  sessionId: SessionId;
  // 读会话文件之前先把写者缓冲落盘
  flush?: () => Promise<void>;
  // 结束汇总的去处（与 worker 完成通知同一条队列）；没有即只在消息区显示
  notices?: Pick<WorkerNotices, "hold">;
  approval: CollectApproval;
  provider?: string;
  emit?: (line: string) => void;
  onChange?: () => void;
  hostExhausted?: () => boolean;
  // 测试注入（缺省为 Docker 容器）
  launcher?: () => Promise<ScriptLauncher>;
  newRunId?: () => string;
  restore?: ScriptRunnerDeps["restore"];
}

export function createSessionScripts(input: SessionScriptsInput): ScriptRuns {
  const root = input.governanceRoot;
  const sessionsDir = join(root, ".pigeon", "sessions");
  return new ScriptRuns({
    orchestrator: input.orchestrator,
    launcher: input.launcher ?? dockerLauncherFor(root),
    snapshot: (runId) => takeScriptSnapshot(root, runId),
    readSnapshot: (runId) => readScriptSnapshot(root, runId),
    releaseSnapshot: (runId) => releaseScriptSnapshot(root, runId),
    overlay: (target) =>
      overlayWorkerChanges({ repoRoot: root, base: target.base, worktreePath: target.worktree }),
    approveCollect: collectApprover(root, input.approval),
    restore:
      input.restore ??
      (async (runId) => {
        await input.flush?.();
        return restoreScriptRun(sessionsDir, loadSessionView(sessionsDir, input.sessionId), runId);
      }),
    announce: () => {
      const post = input.notices?.hold();
      return (text) => {
        if (post !== undefined) post(text);
        else input.emit?.(text);
      };
    },
    ...(input.emit !== undefined ? { emit: input.emit } : {}),
    ...(input.onChange !== undefined ? { onChange: input.onChange } : {}),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.hostExhausted !== undefined ? { hostExhausted: input.hostExhausted } : {}),
    ...(input.newRunId !== undefined ? { newRunId: input.newRunId } : {}),
  });
}
