// Pigeon TUI 入口（M2 S2 壳 + S3 审批面板与 /grants 视图 + S4 会话列表与恢复入口）。
// 用法：node src/tui/main.ts [--yolo] [--root <工作区根>] --stream-fn <模块路径>
//   [--provider <名>] [--model <id>]
// 审批 handler（决策 025 的注入点）：面板版——prompt 档在消息区渲染审批块，四键
// [y/n/a/d] 决议（S3）；deny/grant/固化配置/yolo/read 五档在 Adapter 排律内求值，
// 不经过 handler（src/tools/policy.ts 六档排律）。
// 恢复入口（S4）：/resume <sessionId> 的对账流程在 application/resume.ts；本入口提供
// rebind 工厂——按 cli resume 同一配方（restoredGrants 种子 + buildRuntime + 旧运行面
// 释放）装配目标会话运行面，壳换绑后同 sessionId 续跑（重启 TUI 恢复已有会话的路径：
// 重启后进 /resume）。
// M5.5 S4（决策 040）：主会话与各 worker 的审批经同一队列汇聚到面板（一次一个）；每个会话运行面
// 配一个编排器（/spawn /cancel /workers）；恢复 worker 会话时回到它自己的工作树与委派策略，
// 且其编排器按深度 1 拒绝再派。一个窗口一个进程：退出时先取消在跑的 worker 并等其收尾记录落盘。
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import {
  type LaunchFlags,
  parseLaunchFlags,
  resolveStreamFnSpec,
  reviewConfigOf,
} from "../application/launch-flags.ts";
import { disposeRuntime, loadStreamFn, type RuntimeBundle } from "../application/runtime.ts";
import { openSessionRuntime } from "../application/session-runtime.ts";
import { sessionRuntimeScope } from "../application/worker-scope.ts";
import { createSessionWorkers } from "../application/workers.ts";
import { prepareWorkspace } from "../application/workspace.ts";
import type { SessionGrantStore } from "../approvals/grant-store.ts";
import { createApprovalQueue } from "../approvals/queue.ts";
import { newSessionId, type SessionId } from "../state/ids.ts";
import { createTuiApprovalHandler, type TuiApprovalFace } from "./approval.ts";
import { PigeonTuiShell, type TuiWorkersFace } from "./shell.ts";

// 退出时等 worker 收尾记录落盘的上限（毫秒）：超时仍退出，缺 settled 由冷侧如实标注
const WORKER_SHUTDOWN_GRACE_MS = 5000;

// 参数解析与装配都在 application 层（决策 067）：启动参数在 launch-flags.ts（与 cli、headless 同一份、
// 同一批缺省），会话运行面在 session-runtime.ts（作用域、grant 种子、MCP 启动、装配失败关 server）
const USAGE =
  "用法：node src/tui/main.ts [--yolo] [--no-persist-thinking] [--memory-budget <字符数>] [--history-limit <n>] [--root <dir>] --stream-fn <模块路径> " +
  "[--provider <名>] [--model <id>] [--thinking <档位>] [--max-output-tokens <n>] [--review-every <N>] [--no-review]";

async function main(argv: string[]): Promise<void> {
  const flags: LaunchFlags = parseLaunchFlags(argv, {
    usage: USAGE,
    historyLimit: true,
    review: true,
  });
  const streamFn = await loadStreamFn(resolveStreamFnSpec(flags, USAGE));
  // 工作区准备（决策 034）：realpath 规范化 + D8 旧账本一次性迁移，与 cli 入口同一份；
  // 它同时是治理根（.pigeon/ 恒在主仓库根，决策 040）
  const workspaceRoot = prepareWorkspace(flags.root);
  const sessionId = newSessionId();
  // S3 面板版审批 handler：face 晚绑定——buildRuntime 收 handler 工厂时壳尚未构造；
  // 壳未就位即收到审批请求属装配级故障，工厂内 fail-closed 按拒绝处理
  const faceHolder: { current: TuiApprovalFace | undefined } = { current: undefined };
  // M5.5 S3：主会话与各 worker 的审批经同一队列，一次一个
  const approvalQueue = createApprovalQueue();
  const createHandler = (grants: SessionGrantStore) =>
    approvalQueue.wrap(createTuiApprovalHandler(grants, () => faceHolder.current));
  const workersFor = (bundle: RuntimeBundle, parentSessionId?: SessionId) =>
    createSessionWorkers({
      governanceRoot: workspaceRoot,
      bundle,
      // worker 请求自带其会话的放权落点；此处绑定的父会话存储只是缺省
      approvals: createHandler(bundle.grantStore),
      streamFn,
      provider: flags.provider,
      modelId: flags.modelId,
      persistThinking: flags.persistThinking,
      ...(flags.thinkingLevel !== undefined ? { thinkingLevel: flags.thinkingLevel } : {}),
      ...(parentSessionId !== undefined ? { parentSessionId } : {}),
    });
  // 壳尚未接管终端：启动问题（单个 server 起不来不挡会话）与注解配置冲突（052）直接打到 stderr，
  // 冷侧另见 run.started 的工具集摘要与 server 状态
  const mainBundle = (
    await openSessionRuntime({
      governanceRoot: workspaceRoot,
      sessionId,
      streamFn,
      flags,
      // M6（决策 064）：主会话挂后台审阅
      review: reviewConfigOf(flags),
      createApprovalHandler: createHandler,
      onMcpNote: (note) => {
        console.error(`[mcp] ${note}`);
      },
    })
  ).bundle;
  // 当前运行面持有格（S4）：/resume 换绑整体替换；进程退出只释放当前格
  let slot: { sessionId: SessionId; bundle: RuntimeBundle; workers: TuiWorkersFace } = {
    sessionId,
    bundle: mainBundle,
    workers: workersFor(mainBundle),
  };
  const shell = new PigeonTuiShell({
    terminal: new ProcessTerminal(),
    runtime: slot.bundle.adapter,
    sessionId: slot.sessionId,
    logDir: path.join(workspaceRoot, ".pigeon"),
    // S3：/grants /revoke /grants save 的命令上下文（命令层在 application/grants.ts）；
    // 升格/移除留痕写本会话事件日志（M4 收口决策 ①）
    grants: {
      root: workspaceRoot,
      store: slot.bundle.grantStore,
      configRules: slot.bundle.configGrants,
      eventLog: slot.bundle.eventLog,
    },
    // S4：/sessions 会话列表（命令层在 application/session-list.ts，与 cli 同一份）
    sessions: { root: workspaceRoot },
    // M5 S2（决策 038 / 045）：/search 命令上下文与 /resume 历史渲染上限
    search: { root: workspaceRoot },
    ...(flags.historyLimit !== undefined ? { historyLimit: flags.historyLimit } : {}),
    // M5.5 S4：/spawn /cancel /workers
    workers: slot.workers,
    // S4：/resume <sessionId> 的换绑工厂——与 cli resume 的 enterRepl 同一配方：
    // restoredGrants 种子（决策 3b，物化目标会话的生效 grant，静默继续有效）+
    // buildRuntime + 旧运行面释放。先建后换：装配失败（如 grants.json 畸形）时
    // 旧运行面不受影响，壳继续留在原会话
    resume: {
      root: workspaceRoot,
      // M5.5 S4：worker 会话的确证读取根是其工作树
      workspaceRootFor: (targetId) => sessionRuntimeScope(workspaceRoot, targetId).workspaceRoot,
      rebind: async (targetId) => {
        // M5.5 S4：worker 会话回到它自己的工作树与委派策略（父会话或工作树缺失时响亮失败）；
        // 决策 3b：固化 grant 种子物化。两者与 MCP 启动一并在 session-runtime.ts（与 cli resume 同一份）
        const opened = await openSessionRuntime({
          governanceRoot: workspaceRoot,
          sessionId: targetId,
          streamFn,
          flags,
          // 恢复的主会话同样挂审阅；worker 会话作用域在装配内部排除
          review: reviewConfigOf(flags),
          createApprovalHandler: createHandler,
          restoreGrants: true,
        });
        const bundle = opened.bundle;
        const workers = workersFor(bundle, opened.scope.parentSessionId);
        const previous = slot;
        slot = { sessionId: targetId, bundle, workers };
        void disposeRuntime(previous.bundle);
        return {
          runtime: bundle.adapter,
          grants: {
            root: workspaceRoot,
            store: bundle.grantStore,
            configRules: bundle.configGrants,
            eventLog: bundle.eventLog,
          },
          workers,
        };
      },
    },
    // S5+（裁决 033）：双击 Ctrl+C / /quit 的真实退出路径——壳内已先 stop()
    //（dispose 对称、挂起审批 fail-closed），此处只释放当前运行面并退进程
    onExit: release,
  });
  faceHolder.current = shell;
  shell.start();
  // 进程级退出：先取消在跑的 worker 并等其收尾记录落盘（有上限），再释放当前运行面并退进程。
  // 壳已停止，worker 排队中的审批按拒绝处理，不会吊住取消
  function release(): void {
    const current = slot;
    void (async () => {
      const running = current.workers.status().filter((worker) => worker.state === "running");
      await Promise.allSettled(running.map((worker) => current.workers.cancel(worker.sessionId)));
      await Promise.race([
        Promise.allSettled(running.map((worker) => current.workers.awaitResult(worker.sessionId))),
        new Promise((resolve) => setTimeout(resolve, WORKER_SHUTDOWN_GRACE_MS)),
      ]);
      await disposeRuntime(current.bundle);
    })().finally(() => {
      process.exit(0);
    });
  }
  const shutdown = (): void => {
    shell.stop();
    release();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// 仅作为入口直接运行时执行；被 import 时不启动 TUI
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
