// Pigeon M3 极简 CLI 入口（决策 3：REPL 内联审批，单进程最小闭环，不依赖 M2 TUI）。
// 用法：node src/cli/index.ts [--yolo] [--root <工作区根>] --stream-fn <模块路径>
//   --stream-fn / PIGEON_STREAM_FN：默认导出 StreamFn 的模块
//   （形状 (model, context, options?) => AssistantMessageEventStream，与测试 fixtures 的 fake
//   streamFn 同型；provider 密钥等由该模块自行从环境变量读取）。
//   未配置时清晰报错退出，不静默失败。
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { JsonlLedger } from "../persistence/ledger.ts";
import { PiRuntimeAdapter } from "../pi-runtime/adapter.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { INJECTION_SNAPSHOT_VERSION } from "../pi-runtime/snapshot.ts";
import { createEditFileTool, EditFileParamsSchema } from "../tools/edit-file.ts";
import { createReadFileTool, ReadFileParamsSchema } from "../tools/read-file.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { createCliApprovalHandler } from "./approval-ui.ts";
import { createAsker, runRepl } from "./repl.ts";

// 加载用户提供的 StreamFn 模块（默认导出必须是函数）
export async function loadStreamFn(specifier: string): Promise<StreamFn> {
  // 说明符判定：磁盘上存在的相对/绝对路径一律按文件加载（tmp/x.mjs 这类含分隔符的
  // 相对路径也是文件，不能交给裸说明符解析）；否则按裸包名 import
  const asFile = path.resolve(specifier);
  const url = existsSync(asFile) ? pathToFileURL(asFile).href : specifier;
  let module: Record<string, unknown>;
  try {
    // 动态 import 的合理例外：模块说明符来自运行期旗标/环境变量（插件加载），静态 import 无法覆盖
    module = (await import(url)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `无法加载 streamFn 模块 ${specifier}：${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (typeof module.default !== "function") {
    throw new Error(`streamFn 模块 ${specifier} 没有默认导出函数`);
  }
  return module.default as StreamFn;
}

async function main(argv: string[]): Promise<void> {
  let yolo = false;
  let root = process.cwd();
  let streamFnSpec = process.env.PIGEON_STREAM_FN;
  let provider = "custom";
  let modelId = "cli";
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--yolo") {
      yolo = true;
    } else if (flag === "--root") {
      root = argv[++i] ?? root;
    } else if (flag === "--stream-fn") {
      streamFnSpec = argv[++i];
    } else if (flag === "--provider") {
      provider = argv[++i] ?? provider;
    } else if (flag === "--model") {
      modelId = argv[++i] ?? modelId;
    } else {
      throw new Error(
        `未知参数：${flag}（支持 --yolo / --root / --stream-fn / --provider / --model）`
      );
    }
  }
  if (streamFnSpec === undefined || streamFnSpec === "") {
    throw new Error(
      "未配置模型接入：请用 --stream-fn <模块路径> 或环境变量 PIGEON_STREAM_FN 指定一个默认导出 " +
        "StreamFn 的模块（形状 (model, context, options?) => AssistantMessageEventStream，" +
        "与测试 fixtures 的 fake streamFn 同型；provider 密钥由该模块自行从环境变量读取）"
    );
  }
  const streamFn = await loadStreamFn(streamFnSpec);
  // 工作区根：工具的路径围栏以它为准（realpath 规范化，见 paths.ts）
  const workspaceRoot = realpathSync(root);

  const registry = new ToolRegistry();
  registry.register({
    name: "read_file",
    description: "读取工作区内文件内容",
    parameters: ReadFileParamsSchema,
    tier: "read",
    pathConfinement: { kind: "workspace" },
    executionMode: "parallel",
  });
  registry.register({
    name: "edit_file",
    description: "hashline 锚定稀疏编辑",
    parameters: EditFileParamsSchema,
    tier: "write",
    pathConfinement: { kind: "workspace" },
    executionMode: "sequential",
  });

  const { ask, close } = createAsker(process.stdin, (text) => process.stdout.write(text));
  const adapter = new PiRuntimeAdapter({
    snapshot: {
      version: INJECTION_SNAPSHOT_VERSION,
      model: { provider, id: modelId },
      tools: {
        policy: {
          allow: ["read_file", "edit_file"],
          deny: [],
          approvalMode: yolo ? "yolo" : "prompt",
        },
        advertised: ["read_file", "edit_file"],
      },
      context: {
        systemPrompt:
          "你是 Pigeon 编程助手。用 read_file 读取文件（输出带 N#TAG 行锚点与 [PATH#TAG] 快照），" +
          "用 edit_file 按锚点编辑。写操作可能需要人工批准。",
      },
      memory: [],
      skills: [],
      createdAt: Date.now(),
    },
    streamFn,
    registry,
    tools: [createReadFileTool(workspaceRoot), createEditFileTool(workspaceRoot)],
    approvalHandler: createCliApprovalHandler(ask, (text) => process.stdout.write(text)),
    // 默认账本：<工作区根>/.pigeon/ledger.jsonl（ROADMAP §3.2 调用前意图 + 调用后 Receipt）
    ledger: new JsonlLedger(path.join(workspaceRoot, ".pigeon", "ledger.jsonl")),
  });
  try {
    await runRepl({ adapter, ask, write: (text) => process.stdout.write(text) });
  } finally {
    close();
    await adapter.dispose();
  }
}

// 仅作为入口直接运行时执行；被 import（如测试取 loadStreamFn）时不启动 REPL
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
