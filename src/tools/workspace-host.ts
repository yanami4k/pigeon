// 执行端接口（决策 098）：把"在工作区内读写文件、执行命令"抽成一层，本地进程与容器各一份实现，由工作区形状决定
// 注入哪一份；工具只调本接口，不判断自己运行在何处。路径围栏、进程终止、退出码、输出截断都是实现的职责——
// 跨边界的失败模式（超时后的孤儿进程、退出码保真、输出截断、路径映射）各由实现自己保证并各有测试。
// 快照与分叉与读写、执行同属"在该工作区上做事"，挂在同一层（096 ①）：本轮只留占位，见 snapshot / fork 的说明。
// 本文件只放接口与不依赖实现的包装；本地实现在 local-host.ts，容器实现在 execution/container-host.ts。
import { PIGEON_DIR } from "../state/paths.ts";

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
  // 交给命令的标准输入（钩子协议把事件 JSON 经标准输入交给命令）
  stdin?: string;
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
  // 分开的两路输出开头（各自截到实现上限：本机与容器都是 64 KiB）；需要区分 stdout 与 stderr 的调用方用（钩子协议），
  // 其余调用方照旧读 output
  stdout: string;
  stderr: string;
  // 决策 333：命令因超出沙箱内存上限被杀（容器实现在设了内存上限时判定）
  memoryLimitExceeded?: MemoryLimitExceeded;
}

// 超出内存上限：certain 为容器内存事件的 oom_kill 计数在命令前后增加；读不到计数、命令以 137 结束时为 false（可能）
export interface MemoryLimitExceeded {
  // 上限的可读写法（如 8 GiB）
  limit: string;
  certain: boolean;
}

// 给 agent 与人的同一句：明确报出超出沙箱内存上限及其数值，免得当作普通报错反复重试
export function memoryLimitText(exceeded: MemoryLimitExceeded): string {
  return exceeded.certain
    ? `超出沙箱内存上限 ${exceeded.limit}：命令或它起的进程被内核终止（OOM）。原样重试多半还会被杀，先减少并行度或内存占用`
    : `可能超出沙箱内存上限 ${exceeded.limit}：命令以退出码 137 结束（被 SIGKILL 终止），读不到容器的内存事件计数，无法确认`;
}

// 文件清单不跟进的目录，本地与容器实现共用这一份口径。
// 任意层级：版本库元数据与依赖目录（工作树里的 node_modules 可能是指向主仓库的目录联接）
export const LISTING_SKIPPED_DIRS: readonly string[] = [".git", "node_modules"];
// 只在工作区根：Pigeon 自己的治理目录（会话记录、记忆、放权与各项配置在运行中持续写入，与 agent 所做无关）；
// 子目录里同名的普通文件夹照常列出
export const LISTING_SKIPPED_ROOT_DIRS: readonly string[] = [PIGEON_DIR];

// 工作区文件清单：相对路径（正斜杠）→ 大小与修改时间签名；不含上面两份名单里的目录
export interface HostFileSnapshot {
  files: Map<string, string>;
  // 清单超过上限，不完整
  truncated: boolean;
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
  // 写工具用的解析（决策 334）：同 resolveExisting，另在模型给的路径本身是符号链接时拒写（WorkspaceWriteRefusedError），
  // 报出其指向
  resolveForWrite(inputPath: string): Promise<string>;
  // 以下三个只接受 resolveExisting / resolveForWrite 返回的规范路径
  isFile(resolvedPath: string): Promise<boolean>;
  readText(resolvedPath: string): Promise<string>;
  // 写入前复核（决策 334）：重新解析须仍得到 resolvedPath 本身，路径变了或目标成了符号链接即拒写（WorkspaceWriteRefusedError）
  writeText(resolvedPath: string, content: string): Promise<void>;
  // 在工作区根执行；超时或中止后必须保证该命令起的进程不残留
  exec(plan: HostExecPlan, options: HostExecOptions): Promise<HostExecResult>;
  listFiles(limit: number): Promise<HostFileSnapshot>;
  // Windows 本地实现：程序解析到的 .cmd / .bat 路径；其余实现恒为 undefined
  findLauncherScript(program: string, env: NodeJS.ProcessEnv): string | undefined;
  // 占位（098：快照与分叉挂同一层）。现状：宿主侧的快照与分叉仍由 orchestration/checkpoint.ts 直接调宿主 git，
  // 尚未迁到本接口；容器实现未提供。迁移时两个实现各自落在这两个方法上，调用方不得判断工作区形状
  snapshot?(): Promise<WorkspaceSnapshotRef>;
  fork?(ref: WorkspaceSnapshotRef): Promise<WorkspaceHost>;
}
