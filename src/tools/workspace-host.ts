// 执行端接口（决策 098）：把"在工作区内读写文件、执行命令"抽成一层，本地进程与容器各一份实现，由工作区形状决定
// 注入哪一份；工具只调本接口，不判断自己运行在何处。路径围栏、进程终止、退出码、输出截断都是实现的职责——
// 跨边界的失败模式（超时后的孤儿进程、退出码保真、输出截断、路径映射）各由实现自己保证并各有测试。
// 快照与分叉与读写、执行同属"在该工作区上做事"，挂在同一层（096 ①）：本轮只留占位，见 snapshot / fork 的说明。
// 本文件只放接口与不依赖实现的包装；本地实现在 local-host.ts，容器实现在 execution/container-host.ts。
import { WorkspacePathNotFoundError } from "./paths.ts";

// 一次执行的进程参数：direct 直接给出程序与参数；shell 与 cmd.exe 启动器由工具按平台拼好后同样以此形态交来
export interface HostExecPlan {
  program: string;
  args: string[];
  // Windows 下按原样拼接命令行（cmd.exe 的引号规则不同于 CreateProcess 的参数转义）；其他平台忽略
  verbatim: boolean;
}

export interface HostExecOptions {
  // 已过白名单的环境变量；实现可以不采用（容器内的环境由镜像与容器配置决定，宿主环境不应渗入）
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  // 只保留输出开头的这么多字节；字节数与哈希按全量计
  maxOutputBytes: number;
  signal: AbortSignal | undefined;
}

export interface HostExecResult {
  // 进程是否已启动（启动后出错或超时，副作用都可能已经发生）
  spawned: boolean;
  // 拉不起来：code 为 ENOENT 表示程序不存在
  spawnError?: NodeJS.ErrnoException;
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  outputBytes: number;
  // 全量输出（stdout 与 stderr 按到达顺序）的 sha256
  outputHash: string;
  // 截断后的输出文本（开头部分）
  output: string;
}

// 工作区文件清单：相对路径（正斜杠）→ 大小与修改时间签名；不含版本库元数据与依赖目录
export interface HostFileSnapshot {
  files: Map<string, string>;
  // 清单超过上限，不完整
  truncated: boolean;
}

// 这一步的起点（决策 154②）：开工时的提交
export interface StepStartMark {
  commit: string;
  // "开工时的树"挂在起点提交之下的提交（含开工时未提交的改动，如跑批器预置的人写测试；不含被忽略的文件）：
  // 验证前据它还原受保护的文件，结构化记忆据它与起点提交之差认定开工时的脏文件
  baseCommit?: string;
}

// 快照引用（占位）：实现自定的不透明标识（宿主为独立 GIT_DIR 里的提交，容器为容器内同构提交加镜像提交）
export interface WorkspaceSnapshotRef {
  id: string;
}

export interface WorkspaceHost {
  // 命令在哪种平台上执行：决定 shell 程序与 .cmd / .bat 启动器规则
  readonly platform: NodeJS.Platform;
  // 工作区根（展示给人与模型；本地为宿主路径，容器为容器内路径）
  readonly root: string;
  // 路径围栏：把模型给的路径解析成工作区内既有目标的规范路径；不存在或解析后越出工作区根抛 WorkspacePathError
  resolveExisting(inputPath: string): Promise<string>;
  // 以下三个只接受 resolveExisting 返回的规范路径
  isFile(resolvedPath: string): Promise<boolean>;
  readText(resolvedPath: string): Promise<string>;
  writeText(resolvedPath: string, content: string): Promise<void>;
  // 同步读（含围栏）：回执落盘时实测目标现状哈希用，调用点是同步的
  readTextSync(inputPath: string): string;
  // 在工作区根执行；超时或中止后必须保证该命令起的进程不残留
  exec(plan: HostExecPlan, options: HostExecOptions): Promise<HostExecResult>;
  listFiles(limit: number): Promise<HostFileSnapshot>;
  // Windows 本地实现：程序解析到的 .cmd / .bat 路径；其余实现恒为 undefined
  findLauncherScript(program: string, env: NodeJS.ProcessEnv): string | undefined;
  // 占位（098：快照与分叉挂同一层）。现状：宿主侧的快照与分叉仍由 orchestration/checkpoint.ts 直接调宿主 git，
  // 尚未迁到本接口；容器实现未提供。迁移时两个实现各自落在这两个方法上，调用方不得判断工作区形状
  snapshot?(): Promise<WorkspaceSnapshotRef>;
  fork?(ref: WorkspaceSnapshotRef): Promise<WorkspaceHost>;
  // 记下这一步的起点（决策 154②）：开工时的提交与"开工时的树"。容器实现提供；宿主侧由 checkpoint.ts 的快照改前基线给出
  markStepStart?(): Promise<StepStartMark>;
  // 验证前还原受保护的文件：与开工时的树（mark.baseCommit）相比被改动或删除、且 isProtected 认定受保护的文件，
  // 恢复成开工时的版本（不进暂存区）；开工时不在的文件（agent 新建的）不动。返回还原了的路径。容器实现提供
  restoreProtectedFromStepStart?(
    mark: StepStartMark,
    isProtected: (path: string) => boolean
  ): Promise<string[]>;
  // 只读的 git 查询（结构化记忆核验用：读文件之外，列出受跟踪的文件、追踪一个文件跨改名的历史），
  // 路径一律相对工作区根、正斜杠。容器实现提供；本地工作区待结构化记忆接入时补
  listTracked?(): Promise<string[]>;
  // 该文件的提交历史（新在前，跨改名追踪），每项给出提交与该提交上的路径；limit 为最多几条；不受跟踪即空
  fileHistory?(path: string, limit?: number): Promise<FileHistoryEntry[]>;
  // 同步执行一条命令（在工作区根，不经 shell）：结构化记忆的探针与派生是同步的，经它在容器里查文件与跑 git。
  // 超时记 timedOut；执行端本身不可用时抛错
  runSync?(argv: readonly string[], timeoutMs: number): HostSyncResult;
}

export interface HostSyncResult {
  exitCode: number | null;
  stdout: Buffer;
  timedOut: boolean;
}

export interface FileHistoryEntry {
  commit: string;
  path: string;
}

// 写保护命中——域错误（模型可以换个文件改），带归类标记
export class WorkspaceReadonlyError extends Error {
  readonly pigeonToolErrorKind = "domain";
}

// 写保护包装：给定的工作区相对路径经本接口一律不可写。用于外部基准的测试文件——判分脚本会先复位这些文件
// 再打官方测试补丁，改动不作数，还可能让补丁打不上。经命令改动拦不住，由任务源在取 diff 时排除同一批路径兜底
export function withReadonlyPaths(
  host: WorkspaceHost,
  relativePaths: readonly string[],
  reason: string
): WorkspaceHost {
  if (relativePaths.length === 0) {
    return host;
  }
  // 受保护路径的规范形式：目标存在才解析得出；不存在的每次写入时重试（之后可能被命令创建）
  const resolved = new Map<string, string>();
  const protectedTargets = async (): Promise<Map<string, string>> => {
    for (const relative of relativePaths) {
      if (resolved.has(relative)) {
        continue;
      }
      try {
        resolved.set(relative, await host.resolveExisting(relative));
      } catch (error) {
        // 目标不存在：无从写入，放行别的写入。其余失败（执行端不可用、越界、不可读）说明判不了这次写的是不是
        // 受保护文件——拒绝写入，而不是当作不受保护放行
        if (!(error instanceof WorkspacePathNotFoundError)) {
          throw new Error(
            `无法确认受保护路径 ${relative} 的位置（${error instanceof Error ? error.message : String(error)}），为免改到它，拒绝这次写入`
          );
        }
      }
    }
    return resolved;
  };
  return {
    platform: host.platform,
    root: host.root,
    resolveExisting: (inputPath) => host.resolveExisting(inputPath),
    isFile: (resolvedPath) => host.isFile(resolvedPath),
    readText: (resolvedPath) => host.readText(resolvedPath),
    readTextSync: (inputPath) => host.readTextSync(inputPath),
    exec: (plan, options) => host.exec(plan, options),
    listFiles: (limit) => host.listFiles(limit),
    findLauncherScript: (program, env) => host.findLauncherScript(program, env),
    async writeText(resolvedPath, content) {
      for (const [relative, target] of await protectedTargets()) {
        if (target === resolvedPath) {
          throw new WorkspaceReadonlyError(`${relative} 不可修改：${reason}`);
        }
      }
      await host.writeText(resolvedPath, content);
    },
  };
}
