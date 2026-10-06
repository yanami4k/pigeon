// 脚本编排的会话侧装配（决策 309–314）：把运行器接到本会话的编排器与真实能力上——容器（日常沙箱的通用镜像）、主目录快照、
// 叠加收回、收回的请示（放手模式或已放权即直接做，否则经审批通道请示一次；没有审批通道即不批）、重启后从会话里找回，
// 以及结束汇总的去处（与 worker 完成通知同一条队列）。
import type { ApprovalHandler } from "../approvals/handler.ts";
import { assertDockerAvailable } from "../execution/sandbox.ts";
import { ensureSandboxImage, resolveSandboxImage } from "../execution/sandbox-image.ts";
import { dockerScriptLauncher, type ScriptLauncher } from "../execution/script-sandbox.ts";
import {
  readScriptSnapshot,
  releaseScriptSnapshot,
  takeScriptSnapshot,
} from "../execution/script-snapshot.ts";
import { overlayWorkerChanges } from "../execution/worker-overlay.ts";
import type { WorkerOrchestrator } from "../orchestration/workers.ts";
import { loadSessionView } from "../persistence/session-catalog.ts";
import { DEEPSEEK_PROVIDER } from "../pi-runtime/deepseek-model.ts";
import type { ConfigGrantRule } from "../state/grants.ts";
import type { SessionId } from "../state/ids.ts";
import { sessionsDirOf } from "../state/paths.ts";
import type { SandboxBuildParams } from "../state/sandbox-config.ts";
import type { SessionView } from "../state/session-view.ts";
import type { SettingsSnapshot } from "../state/settings.ts";
import { untrackedLimitsOf } from "../state/snapshot-config.ts";
import { matchConfigGrants } from "../tools/grants.ts";
import type { ScriptBudget } from "./script-naming.ts";
import {
  type RestoredScriptRun,
  type ScriptCallRecord,
  type ScriptPricing,
  type ScriptRunnerDeps,
  ScriptRuns,
  type ScriptSpec,
} from "./script-runner.ts";
import { ORCHESTRATE_TOOL } from "./script-texts.ts";
import { emptyCostTally, mergeCostTally, sessionCostTally } from "./session-cost.ts";
import { TAKE_WORKER_TOOL } from "./spawn-worker-tool.ts";
import { protectedOverlayPaths } from "./take-worker-tool.ts";
import type { WorkerNotices } from "./worker-notices.ts";

// Docker 不可用或镜像准备不成：工具据此回"Docker 不可用"
export class ScriptLaunchError extends Error {}

// 容器：日常沙箱的通用镜像（含 Node 24）；项目的沙箱配置只取构建参数（改用的镜像不一定带 Node）。首次用时检查一次
// 决策 325：构建参数取自本会话设置快照的 sandbox 一节（会话开始时冻结，不在每次开跑时重读）
export function dockerLauncherFor(
  governanceRoot: string,
  options: {
    docker?: readonly string[];
    log?: (line: string) => void;
    build?: SandboxBuildParams;
  } = {}
): () => Promise<ScriptLauncher> {
  let ready: Promise<ScriptLauncher> | undefined;
  return () => {
    ready ??= (async () => {
      try {
        await assertDockerAvailable(options.docker);
        const spec = resolveSandboxImage(governanceRoot, {
          ...(options.build !== undefined ? { build: options.build } : {}),
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
  workspaceRoot: string,
  approval: CollectApproval
): ScriptRunnerDeps["approveCollect"] {
  return async ({ runId, title, workers, targets }) => {
    if (approval.yolo) return true;
    const args = { workers };
    // 决策 340：叠回内容写到 .pigeon 下时按受保护路径请示——放权不算，逐次问人，请示里列出这些路径
    const protectedPaths = (targets ?? []).flatMap((target) =>
      protectedOverlayPaths(target, workspaceRoot)
    );
    if (
      protectedPaths.length === 0 &&
      (approval.grants?.match(TAKE_WORKER_TOOL, args) != null ||
        matchConfigGrants(
          approval.configGrants ?? [],
          workspaceRoot,
          TAKE_WORKER_TOOL,
          args,
          false
        ) !== null)
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
      ...(protectedPaths.length > 0
        ? { protectedPath: [...new Set(protectedPaths)].join("、") }
        : {}),
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
  // 治理根：会话文件与沙箱配置在它下面
  governanceRoot: string;
  // 主工作区根（git 仓库）：主目录快照、收回叠加与收回请示看它（pigeon run --governance-root 时不是治理根）
  workspaceRoot: string;
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
  // 模型的计价口径（金额额度开跑前核对）与脚本卡住的判定时长
  pricing?: () => ScriptPricing;
  stallMs?: number;
  // 决策 325：本会话的设置快照（容器镜像的构建参数取自它的 sandbox 一节）
  settings?: SettingsSnapshot;
}

export function createSessionScripts(input: SessionScriptsInput): ScriptRuns {
  const root = input.workspaceRoot;
  const sessionsDir = sessionsDirOf(input.governanceRoot);
  const limits = untrackedLimitsOf(input.settings?.merged.snapshot);
  return new ScriptRuns({
    orchestrator: input.orchestrator,
    launcher:
      input.launcher ??
      dockerLauncherFor(input.governanceRoot, {
        ...(input.settings?.merged.sandbox?.build !== undefined
          ? { build: input.settings.merged.sandbox.build }
          : {}),
      }),
    // 决策 381：主目录快照与收回时写 worker 的树，未跟踪文件的上限取自设置的 snapshot 一节
    snapshot: (runId) => takeScriptSnapshot(root, runId, limits),
    readSnapshot: (runId) => readScriptSnapshot(root, runId),
    releaseSnapshot: (runId) => releaseScriptSnapshot(root, runId),
    overlay: (target) =>
      overlayWorkerChanges({
        repoRoot: root,
        base: target.base,
        worktreePath: target.worktree,
        limits,
      }),
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
    ...(input.pricing !== undefined ? { pricing: input.pricing } : {}),
    ...(input.stallMs !== undefined ? { stallMs: input.stallMs } : {}),
  });
}

// 模型的计价口径（与状态栏同一口径）：DeepSeek 按官方人民币价目；其余看本会话最近一条带用量的回复自带的价格，为 0 即没有价格；
// 还没有回复即看不出来
export function modelPricing(
  provider: string | undefined,
  transcript: readonly unknown[]
): ScriptPricing {
  if (provider === DEEPSEEK_PROVIDER) return "cny";
  const last = transcript.findLast((message) => {
    const entry = message as { role?: unknown; usage?: { totalTokens?: unknown } };
    return (
      entry.role === "assistant" &&
      typeof entry.usage?.totalTokens === "number" &&
      entry.usage.totalTokens > 0
    );
  }) as { usage: { cost?: { total?: number } } } | undefined;
  if (last === undefined) return undefined;
  return (last.usage.cost?.total ?? 0) > 0 ? "usd" : "none";
}
