// Pigeon TUI 入口（M2 S2）：ProcessTerminal + Application Shell（pi-tui TuiMainScreen）。
// 用法：node src/tui/main.ts [--yolo] [--root <工作区根>] --stream-fn <模块路径>
//   [--provider <名>] [--model <id>]
// 审批 handler（决策 025 的注入点）：S3 审批面板落地前注入 fail-closed 版——prompt 一律拒绝
// 且理由如实；deny/grant/固化配置/yolo/read 五档在 Adapter 排律内求值，不经过 handler，
// 不受影响（src/tools/policy.ts 六档排律）。
import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { buildRuntime, loadStreamFn } from "../application/runtime.ts";
import { migrateLegacyLedger } from "../persistence/legacy-migration.ts";
import { newSessionId } from "../state/ids.ts";
import { PigeonTuiShell } from "./shell.ts";

interface TuiFlags {
  root: string;
  streamFnSpec: string | undefined;
  yolo: boolean;
  provider: string;
  modelId: string;
}

function parseFlags(argv: string[]): TuiFlags {
  const flags: TuiFlags = {
    root: process.cwd(),
    streamFnSpec: process.env.PIGEON_STREAM_FN,
    yolo: false,
    provider: "unknown",
    modelId: "unknown",
  };
  const usage =
    "用法：node src/tui/main.ts [--yolo] [--root <dir>] --stream-fn <模块路径> " +
    "[--provider <名>] [--model <id>]";
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--yolo") {
      flags.yolo = true;
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
  // 工作区根：工具的路径围栏以它为准（realpath 规范化，见 paths.ts）
  const workspaceRoot = realpathSync(flags.root);
  // D8：M3 旧账本一次性迁移（不存在即 no-op；损坏响亮失败，启动中止）
  migrateLegacyLedger(
    path.join(workspaceRoot, ".pigeon", "ledger.jsonl"),
    path.join(workspaceRoot, ".pigeon", "sessions")
  );
  const sessionId = newSessionId();
  const bundle = buildRuntime({
    streamFn,
    workspaceRoot,
    sessionId,
    yolo: flags.yolo,
    provider: flags.provider,
    modelId: flags.modelId,
    // S3 审批面板落地前 fail-closed：prompt 一律拒绝，理由逐字回模型（决策 001 的闭环不中断）
    createApprovalHandler: () => async (request) => ({
      approved: false,
      reason: `TUI 审批面板尚未落地（M2 S3），prompt 一律拒绝：${request.toolName}`,
    }),
  });
  const shell = new PigeonTuiShell({
    terminal: new ProcessTerminal(),
    runtime: bundle.adapter,
    sessionId,
    logDir: path.join(workspaceRoot, ".pigeon"),
  });
  shell.start();
  // 进程级退出（Ctrl+C / SIGTERM）：停壳 + 释放 adapter。注意这不是 S5 的运行取消键——
  // 取消键是壳内输入语义，本处只处理 OS 信号
  const shutdown = (): void => {
    shell.stop();
    void bundle.adapter.dispose().finally(() => {
      bundle.eventLog.close();
      process.exit(0);
    });
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
