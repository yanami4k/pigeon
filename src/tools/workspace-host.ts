// 执行端接口（决策 098）：把"在工作区内读写文件、执行命令"抽成一层，本地进程与容器各一份实现，由工作区形状决定
// 注入哪一份；工具只调本接口，不判断自己运行在何处。路径围栏、进程终止、退出码、输出截断都是实现的职责——
// 跨边界的失败模式（超时后的孤儿进程、退出码保真、输出截断、路径映射）各由实现自己保证并各有测试。
// 快照与分叉与读写、执行同属"在该工作区上做事"，挂在同一层（096 ①）：本轮只留占位，见 snapshot / fork 的说明。
// 本文件只放接口与不依赖实现的包装；本地实现在 local-host.ts，容器实现在 execution/container-host.ts。
import { PIGEON_DIR } from "../state/paths.ts";
import { WorkspaceContentChangedError } from "./paths.ts";
import type { ReadPathClassification, ReadTarget } from "./read-deny.ts";

// 系统程序所在的目录（root 所有、agent 改不了）：Pigeon 自己执行的程序按它们优先解析
export const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

// Pigeon 自己执行的辅助程序的环境：系统目录放到 PATH 最前（Windows 照旧），屏蔽 git 的全局与系统配置
//（其中的 filter、fsmonitor 等会执行程序），不带 ripgrep 的配置文件
export function helperEnv(source: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && key.toUpperCase() !== "RIPGREP_CONFIG_PATH") env[key] = value;
  }
  if (platform !== "win32") env.PATH = `${SYSTEM_PATH}${env.PATH ? `:${env.PATH}` : ""}`;
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
}

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
  // 决策 356：另保留输出末尾的这么多字节（缺省不留）；给了即另计输出总行数
  tailBytes?: number;
  // 决策 356：输出超过开头加末尾两段时，把全量输出写进这个宿主文件（至多 maxBytes 字节）；没超过不建文件
  fullOutput?: { path: string; maxBytes: number };
  signal: AbortSignal | undefined;
  // 交给命令的标准输入（钩子协议把事件 JSON 经标准输入交给命令）
  stdin?: string;
}

export interface OutputFileIdentity {
  dev: string;
  ino: string;
  sha256: string;
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
  // 截断后的输出文本（开头部分）；给了 tailBytes 且没超过开头加末尾时为全量输出
  output: string;
  // 决策 356：输出末尾（给了 tailBytes 且输出超过开头加末尾两段时）
  tail?: string;
  // 决策 356：输出总行数（给了 tailBytes 时计）
  outputLines?: number;
  // 决策 356：全量输出已写进 fullOutput.path；partial 为超过写入上限，只写了前面部分
  fullOutputSaved?: { bytes: number; partial: boolean };
  // 写下的落盘文件的身份：打开后 fstat 得到的设备号与 inode（十进制字符串），与实际写入字节的 sha256；
  // 落盘存储据此只认 Pigeon 自己写下的内容
  fullOutputFile?: OutputFileIdentity;
  // 决策 356：给了 fullOutput 但未能保存（磁盘满、文件已在或被换成链接等）的原因；此时照常给出头尾
  fullOutputError?: string;
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
// 任意层级：版本库元数据、依赖目录（工作树里的 node_modules 可能是指向主仓库的目录联接），以及常见的虚拟环境、
// 构建产物与缓存目录（决策 348；git 工作区按 git status 找候选，不经这份名单）
export const LISTING_SKIPPED_DIRS: readonly string[] = [
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "dist",
  "build",
  "target",
  ".tox",
  ".nox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "__pycache__",
  ".gradle",
  ".next",
  ".nuxt",
  ".turbo",
  ".parcel-cache",
  "coverage",
];
// 只在工作区根：Pigeon 自己的治理目录（会话记录、记忆、放权与各项配置在运行中持续写入，与 agent 所做无关）；
// 子目录里同名的普通文件夹照常列出
export const LISTING_SKIPPED_ROOT_DIRS: readonly string[] = [PIGEON_DIR];

// 工作区文件清单：相对路径（正斜杠）→ 大小与修改时间签名；不含上面两份名单里的目录
export interface HostFileSnapshot {
  files: Map<string, string>;
  // 清单超过上限，不完整
  truncated: boolean;
}

// 文件变化的取证（决策 348）。git 工作区：git status 报出的路径（含未跟踪、不含被忽略；工作区根下的治理目录除外）及其
// 签名；命令后的那次另把命令前报出、命令后不再报出的路径补查签名，状态记 clean。非 git 工作区：全量清单
export type HostFileState =
  | { kind: "git"; entries: Map<string, GitFileEntry>; truncated: boolean }
  // fallback：git 工作区里 git status 失败（命令删了 .git、弄坏了索引等），改用全量扫描
  | ({ kind: "scan"; fallback?: true } & HostFileSnapshot);

export interface GitFileEntry {
  status: "tracked" | "untracked" | "clean";
  // 大小与修改时间（同 HostFileSnapshot 的口径）；文件不存在为 MISSING_SIGNATURE
  signature: string;
}

export const MISSING_SIGNATURE = "-";

// 一次命令（或一个后台作业期间）的文件变化报告
export interface FileChanges {
  added: string[];
  removed: string[];
  modified: string[];
  // 清单超过上限，差异不完整（这时只报命令前后都在、签名变了的文件）
  truncated: boolean;
  // 取证方式上的说明（git status 失败、改用全量扫描等）；没有为缺省
  note?: string;
}

// 决策 365：命令进程带的标记环境变量（值每次随机，子孙进程随之继承）；容器里的超时与中止、后台作业的停止与崩溃后的
// 清理按它认进程
export const RUN_MARKER_VAR = "PIGEON_RUN";

// 决策 365：后台作业的启动选项。输出两路按到达顺序交给 onOutput；标准输入为空
export interface HostJobOptions {
  // 已过白名单的环境变量（容器实现不采用）
  env: NodeJS.ProcessEnv;
  // 本作业的标记（RUN_MARKER_VAR 的值）
  marker: string;
  onOutput(chunk: Buffer): void;
  // 决策 409：会话结束后保留的作业——两路输出直接写进 outputFd（追加打开的输出文件，不经 Pigeon 的管道，Pigeon 退出后
  // 进程照样写得进去）；各平台都分离启动、不登记进程退出时的兜底终止，组长退出后不清扫组里的子孙（容器里同样不清扫）
  keep?: { outputFd: number };
}

export interface HostJobExit {
  exitCode: number | null;
  signal?: string;
  // 拉不起来：code 为 ENOENT 表示程序不存在
  spawnError?: NodeJS.ErrnoException;
}

// 崩溃后清理时认进程用的记录（决策 365）：本机为进程号与启动时间（Windows 另有命令行），容器为容器与标记
export type JobProcessRecord =
  | {
      kind: "local";
      platform: NodeJS.Platform;
      pid: number;
      // 进程的启动时间（Linux 为 /proc/<pid>/stat 的 starttime，macOS 为 ps 的 lstart，Windows 为 CreationDate）
      startTime: string;
      // Windows：进程的命令行（那里读不到别的进程的环境变量，以它代替标记）
      commandLine?: string;
      marker: string;
    }
  | { kind: "container"; container: string; marker: string };

// 一个在跑的后台作业：done 在进程结束（输出收完）时决议；kill 停掉整个进程组或进程树（容器里按组与标记），
// 返回时进程已结束或已尽力；record 为认进程的记录（取不到为 undefined）
export interface HostJob {
  done: Promise<HostJobExit>;
  kill(): Promise<void>;
  record(): Promise<JobProcessRecord | undefined>;
  // 决策 409：本机作业的进程号（容器里的作业没有）
  pid?: number;
  // 决策 409：会话结束时交出保留的作业——不再让它拖住 Pigeon 进程退出（进程照常跑）
  detach?(): void;
}

// 一次被观测的执行：命令的结果与命令前后的取证；超时、中止等拿不到命令后取证时 after 缺省（调用方另取）
export interface ObservedExec {
  result: HostExecResult;
  before: HostFileState;
  after?: HostFileState;
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
  // 决策 355：读档的解析——不限工作区：给出符号链接解析后的真实路径与它是否落在工作区根之外；落在禁读名单 deny
  //（~ 按本执行端的家目录展开）之内抛 ReadDeniedError，不存在抛 WorkspacePathNotFoundError。
  // 可选：没有实现的执行端读档只限工作区之内（照 resolveExisting）
  resolveForRead?(inputPath: string, deny: readonly string[]): Promise<ReadTarget>;
  // 决策 355 / 368：grep、glob 的结果（相对工作区根的路径）逐条按真实路径分类——可读、落在工作区外、禁读；
  // 取不到真实路径的不在结果里；检查超时或中止时标明不完整。可选：没有实现的执行端 grep、glob 不可用
  classifyReadPaths?(
    relPaths: readonly string[],
    deny: readonly string[],
    signal?: AbortSignal
  ): Promise<ReadPathClassification>;
  // 决策 368：Pigeon 自己的只读辅助程序（grep、glob 的搜索后端）的执行，不走 agent 的执行通道——程序解析成系统目录里的
  // 绝对路径（本机跳过当前目录、相对目录与工作区之内的目录；容器里照 trustedShell 的取法：系统目录在前），屏蔽 git 的系统与全局配置，不带 RIPGREP_CONFIG_PATH；
  // git 另加 git-hardening.ts 同一张表的加固参数（决策 348、352：关 fsmonitor 与钩子、以空树作属性来源）；
  // stdout 与 stderr 各自留到 maxOutputBytes。env 为调用方过了白名单的环境（容器实现不采用）。在工作区根执行。
  // 可选：没有实现的执行端 grep、glob 不可用
  execHelper?(
    program: string,
    args: readonly string[],
    options: HostExecOptions
  ): Promise<HostExecResult>;
  // 决策 368：工作区内文件（相对工作区根的路径）的修改时间（毫秒）；取不到的不在结果里。glob 据此排序。
  // 可选：没有实现的执行端 glob 按路径排序
  fileMtimes?(relPaths: readonly string[]): Promise<Map<string, number>>;
  // 决策 358（write_file）：目标已存在时同 resolveForWrite（exists 为真）；不存在时按路径上最深的已存在一层的真实路径拼上
  // 其余各段，须仍在工作区根内（exists 为假）。两个实现都有；可缺省只为测试里手拼的执行端
  resolveForCreate?(inputPath: string): Promise<{ path: string; exists: boolean }>;
  // 决策 358 照 334：新建 resolveForCreate 给出的不存在的路径——复核路径上最深的已存在一层未变，补建中间目录，目标已存在
  // 即拒写（不覆盖）
  createText?(resolvedPath: string, content: string): Promise<void>;
  // 以下三个只接受 resolveExisting / resolveForWrite / resolveForCreate / resolveForRead 返回的规范路径
  isFile(resolvedPath: string): Promise<boolean>;
  readText(resolvedPath: string): Promise<string>;
  // 决策 358：按字节读（读取记录按文件字节算哈希）；两个实现都有，缺省时调用方退回 readText
  readBytes?(resolvedPath: string): Promise<Buffer>;
  // 写入前复核（决策 334）：重新解析须仍得到 resolvedPath 本身，路径变了或目标成了符号链接即拒写（WorkspaceWriteRefusedError）
  writeText(resolvedPath: string, content: string): Promise<void>;
  // 在工作区根执行；超时或中止后必须保证该命令起的进程不残留
  exec(plan: HostExecPlan, options: HostExecOptions): Promise<HostExecResult>;
  listFiles(limit: number): Promise<HostFileSnapshot>;
  // 决策 348：文件变化的取证；命令后的那次传入命令前的结果（沿用同一种取法）。缺省时调用方按 listFiles 比对
  fileState?(limit: number, before?: HostFileState): Promise<HostFileState>;
  // 决策 349：命令与命令前后的取证合成一次执行（容器实现）；缺省时调用方分三步做
  execObserved?(plan: HostExecPlan, options: HostExecOptions, limit: number): Promise<ObservedExec>;
  // 决策 365：在工作区根启动一个后台作业（本机 Linux/macOS 以独立进程组、Windows 按进程树，容器里以 setsid 起组并带标记）。
  // 没有实现的执行端不能开后台作业
  startJob?(plan: HostExecPlan, options: HostJobOptions): HostJob;
  // 决策 365：容器实现的 docker 调用前缀（崩溃后按标记清理容器作业时照用）；本地实现没有
  readonly dockerPrefix?: readonly string[];
  // Windows 本地实现：程序解析到的 .cmd / .bat 路径；其余实现恒为 undefined
  findLauncherScript(program: string, env: NodeJS.ProcessEnv): string | undefined;
  // 决策 352：命令报"程序不存在"时作废该程序的查找缓存（会话中途装上的程序）；没有缓存的实现不提供
  forgetLauncherScript?(program: string): void;
  // 占位（098：快照与分叉挂同一层）。现状：宿主侧的快照与分叉仍由 orchestration/checkpoint.ts 直接调宿主 git，
  // 尚未迁到本接口；容器实现未提供。迁移时两个实现各自落在这两个方法上，调用方不得判断工作区形状
  snapshot?(): Promise<WorkspaceSnapshotRef>;
  fork?(ref: WorkspaceSnapshotRef): Promise<WorkspaceHost>;
}

// git status 取候选的参数（决策 348），接在 git-hardening.ts 的加固参数之后：不取可选的锁、不刷新使用者的索引（刷新要短暂
// 占住 index.lock，使用者同时在终端或编辑器里跑 git 时可能报锁已存在；代价是修改时间晚于索引的文件每次都要重算内容哈希）；
// 含未跟踪文件、逐个列出未跟踪目录里的文件、不含被忽略的、不合并改名；只看当前目录所在的子树
export const GIT_STATUS_ARGS: readonly string[] = [
  "--no-optional-locks",
  "status",
  "--porcelain=v1",
  "-z",
  "--untracked-files=all",
  "--no-renames",
  "--",
  ".",
];

// git status --porcelain=v1 -z 的输出 → 路径与状态。路径在输出里相对仓库根，去掉 prefix（工作区在仓库里的前缀；嵌套仓库
// 为空），不以它开头的不要；governance 为真时（工作区根所在的仓库）另去掉工作区根下的治理目录。未跟踪的嵌套仓库以带结尾
// 斜杠的目录出现，原样交回。同一路径既有跟踪状态又有未跟踪（git rm --cached）时记跟踪
export function parseGitStatus(
  output: string,
  prefix: string,
  governance = true
): Map<string, "tracked" | "untracked"> {
  const statuses = new Map<string, "tracked" | "untracked">();
  for (const record of output.split("\0")) {
    if (record.length < 4 || !record.slice(3).startsWith(prefix)) {
      continue;
    }
    const file = record.slice(3 + prefix.length);
    if (
      file === "" ||
      (governance &&
        LISTING_SKIPPED_ROOT_DIRS.some((dir) => file === dir || file.startsWith(`${dir}/`)))
    ) {
      continue;
    }
    const status = record.startsWith("??") ? "untracked" : "tracked";
    if (statuses.get(file) !== "tracked") {
      statuses.set(file, status);
    }
  }
  return statuses;
}

// 组装 git 取证：超过上限的只留前 limit 个并标不完整；命令后的那次（给了 before）把命令前报出、这次没报出的路径补上，记 clean
export function gitFileState(
  statuses: ReadonlyMap<string, "tracked" | "untracked">,
  signatureOf: (file: string) => string,
  limit: number,
  before?: HostFileState
): HostFileState {
  const entries = new Map<string, GitFileEntry>();
  let truncated = false;
  for (const [file, status] of statuses) {
    if (entries.size >= limit) {
      truncated = true;
      break;
    }
    entries.set(file, { status, signature: signatureOf(file) });
  }
  if (before?.kind === "git") {
    for (const file of before.entries.keys()) {
      if (!entries.has(file)) {
        entries.set(file, { status: "clean", signature: signatureOf(file) });
      }
    }
    truncated ||= before.truncated;
  }
  return { kind: "git", entries, truncated };
}

// 写工具的预检与落盘（决策 349）：执行端可能以检视时读出的原文（审批之前）供预检——预检失败时先刷新检视再预检一次；
// 写入时执行端复核原文未变，变了即刷新检视并抛 WorkspaceContentChangedError，这里用新原文重算一次再写（同"执行时重新预检"）。
// 本地执行端每次现读，两处重试的结果与原先相同
export async function planAndWrite<P extends { resolvedPath: string }>(input: {
  host: WorkspaceHost;
  inputPath: string;
  plan: () => Promise<P>;
  contentOf: (plan: P) => string;
  signal: AbortSignal | undefined;
}): Promise<P> {
  let planned: P;
  try {
    planned = await input.plan();
  } catch (error) {
    try {
      await input.host.resolveExisting(input.inputPath);
    } catch {
      throw error;
    }
    planned = await input.plan();
  }
  input.signal?.throwIfAborted();
  try {
    await input.host.writeText(planned.resolvedPath, input.contentOf(planned));
  } catch (error) {
    if (!(error instanceof WorkspaceContentChangedError)) {
      throw error;
    }
    planned = await input.plan();
    input.signal?.throwIfAborted();
    await input.host.writeText(planned.resolvedPath, input.contentOf(planned));
  }
  return planned;
}
