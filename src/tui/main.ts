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
import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { buildRuntime, loadStreamFn, type RuntimeBundle } from "../application/runtime.ts";
import { prepareWorkspace, restoreGrantSeed } from "../application/workspace.ts";
import type { SessionGrantStore } from "../approvals/grant-store.ts";
import { newSessionId, type SessionId } from "../state/ids.ts";
import { createTuiApprovalHandler, type TuiApprovalFace } from "./approval.ts";
import { PigeonTuiShell } from "./shell.ts";

interface TuiFlags {
  root: string;
  streamFnSpec: string | undefined;
  yolo: boolean;
  provider: string;
  modelId: string;
  // M5 S1（决策 045）：--no-persist-thinking 关闭 thinking 正文持久化（缺省开）
  persistThinking: boolean;
  // M5 S2（决策 045）：--history-limit <n> /resume 历史渲染安全上限（缺省 500）
  historyLimit?: number;
  // M5 S3（决策 042）：--memory-budget <字符数> 常驻 Memory 预算（缺省 8000）
  memoryBudgetChars?: number;
}

function parseFlags(argv: string[]): TuiFlags {
  const flags: TuiFlags = {
    root: process.cwd(),
    streamFnSpec: process.env.PIGEON_STREAM_FN,
    yolo: false,
    provider: "unknown",
    modelId: "unknown",
    persistThinking: true,
  };
  const usage =
    "用法：node src/tui/main.ts [--yolo] [--no-persist-thinking] [--memory-budget <字符数>] [--history-limit <n>] [--root <dir>] --stream-fn <模块路径> " +
    "[--provider <名>] [--model <id>]";
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--yolo") {
      flags.yolo = true;
    } else if (flag === "--no-persist-thinking") {
      flags.persistThinking = false;
    } else if (flag === "--memory-budget") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`--memory-budget 需要非负整数（字符数）（${usage}）`);
      }
      flags.memoryBudgetChars = value;
    } else if (flag === "--history-limit") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`--history-limit 需要正整数（${usage}）`);
      }
      flags.historyLimit = value;
    } else if (flag === "--root") {
      flags.root = argv[++i] ?? flags.root;
    } else if (flag === "--stream-fn") {
      flags.streamFnSpec = argv[++i];
    } else if (flag === "--provider") {
      flags.provider = argv[++i] ?? flags.provider;
    } else if (flag === "--model") {
      flags.modelId = argv[++i] ?? flags.modelId;
    } else {
      throw new Error(`未知参数：${flag}（${usage}）`);
    }
  }
  return flags;
}

async function main(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  if (flags.streamFnSpec === undefined || flags.streamFnSpec === "") {
    throw new Error(
      "未配置模型接入：请用 --stream-fn <模块路径> 或环境变量 PIGEON_STREAM_FN 指定一个默认导出 " +
        "StreamFn 的模块（provider 密钥由该模块自行从环境变量读取）"
    );
  }
  const streamFn = await loadStreamFn(flags.streamFnSpec);
  // 工作区准备（决策 034）：realpath 规范化 + D8 旧账本一次性迁移，与 cli 入口同一份
  const workspaceRoot = prepareWorkspace(flags.root);
  const sessionId = newSessionId();
  // S3 面板版审批 handler：face 晚绑定——buildRuntime 收 handler 工厂时壳尚未构造；
  // 壳未就位即收到审批请求属装配级故障，工厂内 fail-closed 按拒绝处理
  const faceHolder: { current: TuiApprovalFace | undefined } = { current: undefined };
  const createHandler = (grants: SessionGrantStore) =>
    createTuiApprovalHandler(grants, () => faceHolder.current);
  // 当前运行面持有格（S4）：/resume 换绑整体替换；进程退出只释放当前格
  let slot: { sessionId: SessionId; bundle: RuntimeBundle } = {
    sessionId,
    bundle: buildRuntime({
      streamFn,
      workspaceRoot,
      sessionId,
      yolo: flags.yolo,
      provider: flags.provider,
      modelId: flags.modelId,
      persistThinking: flags.persistThinking,
      ...(flags.memoryBudgetChars !== undefined
        ? { memoryBudgetChars: flags.memoryBudgetChars }
        : {}),
      createApprovalHandler: createHandler,
    }),
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
    // S4：/resume <sessionId> 的换绑工厂——与 cli resume 的 enterRepl 同一配方：
    // restoredGrants 种子（决策 3b，物化目标会话的生效 grant，静默继续有效）+
    // buildRuntime + 旧运行面释放。先建后换：装配失败（如 grants.json 畸形）时
    // 旧运行面不受影响，壳继续留在原会话
    resume: {
      root: workspaceRoot,
      rebind: (targetId) => {
        const restoredGrants = restoreGrantSeed(workspaceRoot, targetId);
        const bundle = buildRuntime({
          streamFn,
          workspaceRoot,
          sessionId: targetId,
          yolo: flags.yolo,
          provider: flags.provider,
          modelId: flags.modelId,
          persistThinking: flags.persistThinking,
          ...(flags.memoryBudgetChars !== undefined
            ? { memoryBudgetChars: flags.memoryBudgetChars }
            : {}),
          createApprovalHandler: createHandler,
          restoredGrants,
        });
        const previous = slot;
        slot = { sessionId: targetId, bundle };
        void previous.bundle.adapter.dispose().finally(() => {
          previous.bundle.eventLog.close();
        });
        return {
          runtime: bundle.adapter,
          grants: {
            root: workspaceRoot,
            store: bundle.grantStore,
            configRules: bundle.configGrants,
            eventLog: bundle.eventLog,
          },
        };
      },
    },
    // S5+（裁决 033）：双击 Ctrl+C / /quit 的真实退出路径——壳内已先 stop()
    //（dispose 对称、挂起审批 fail-closed），此处只释放当前运行面并退进程
    onExit: release,
  });
  faceHolder.current = shell;
  shell.start();
  // 进程级退出（OS 信号 SIGINT/SIGTERM）：停壳 + 释放当前运行面。注意这不是 S5 的
  // 运行取消键——取消键是壳内输入语义；壳内双击 Ctrl+C / /quit 走 onExit（033）
  function release(): void {
    void slot.bundle.adapter.dispose().finally(() => {
      slot.bundle.eventLog.close();
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
