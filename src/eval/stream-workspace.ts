// 延续式实验的流工作区（决策 148、104、109、154）：每条流一个断网容器，agent 在其中一步接一步地改同一份代码。
// 工作区的一切动作都是在工作区根执行的一段 sh 脚本，经 StreamShell 下发：生产实现走 docker exec，
// 测试用本机 sh 在临时目录里真跑同一批脚本。
//   起点：人在该流起点那次提交的代码，经 git bundle 送入（bundle 只含起点可达的历史，天然看不到未来），
//         再用与外部基准同一份清理脚本清到只剩当前并自验（109）；
//   每步：程序把该步人写的测试、测试辅助与环境文件写进去（内容由宿主从人的提交里取、经标准输入送入，容器里没有未来对象）；
//   落地：以该步的提交信息提交一次（148），agent 可用 git log 读到；
//   回到本步起点：每步起点即 HEAD，复原被跟踪文件并删掉未忽略的未跟踪文件，被忽略的依赖目录不动（154）；
//   续跑：每步落地后把历史导出成 bundle 存到宿主，容器丢失时可由镜像加 bundle 重建；
//   测量副本：从 HEAD 克隆一份到另一目录，依赖目录以链接接上，在其中跑全量测试，结果不进 agent 的会话（145）。
import { containerExec } from "../execution/container-host.ts";
import { historyPruneVerified, PRUNE_HISTORY_SCRIPT } from "./container-workspace.ts";
import type { HumanFileOp } from "./stream-manifest.ts";

export interface ShellResult {
  exitCode: number | null;
  stdout: string;
  stdoutBytes: Buffer;
  stderr: string;
}

export interface ShellOptions {
  // 脚本的位置参数（$1 起）
  args?: readonly string[];
  stdin?: string | Buffer;
  timeoutMs?: number;
  // 在哪个目录执行；缺省为工作区根
  cwd?: string;
}

export interface StreamShell {
  // 工作区根（容器内路径）
  readonly root: string;
  sh(script: string, options?: ShellOptions): Promise<ShellResult>;
}

// 生产实现：在流容器里执行
export function dockerStreamShell(input: {
  container: string;
  root: string;
  docker?: readonly string[];
}): StreamShell {
  return {
    root: input.root,
    async sh(script, options = {}) {
      return containerExec({
        container: input.container,
        command: ["sh", "-c", script, "sh", ...(options.args ?? [])],
        workdir: options.cwd ?? input.root,
        ...(input.docker !== undefined ? { docker: input.docker } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      });
    },
  };
}

export class StreamWorkspaceError extends Error {
  override name = "StreamWorkspaceError";
}

// 程序落地提交用的身份；agent 从 git log 能看出哪些提交是程序落的
export const STREAM_COMMITTER = { name: "pigeon-stream", email: "stream@pigeon.invalid" };

const BUNDLE_PATH = ".git/pigeon-start.bundle";

export interface CommandOutcome {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

// 带墙钟上限跑一条命令：容器内以 timeout 杀掉整组进程，docker 客户端侧另留余量
export function timeoutWrapped(command: readonly string[], timeoutMs: number): string {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  return `timeout -s KILL ${seconds} ${command.map(shellQuote).join(" ")}`;
}

export function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

// timeout 命令被 KILL 信号杀掉时的退出码
const TIMEOUT_KILLED = 137;

export class StreamWorkspace {
  private readonly shell: StreamShell;

  constructor(shell: StreamShell) {
    this.shell = shell;
  }

  get root(): string {
    return this.shell.root;
  }

  private async must(
    script: string,
    what: string,
    options: ShellOptions = {}
  ): Promise<ShellResult> {
    const result = await this.shell.sh(script, options);
    if (result.exitCode !== 0) {
      throw new StreamWorkspaceError(
        `${what}失败（退出码 ${result.exitCode}）：${result.stderr.trim() || result.stdout.trim()}`
      );
    }
    return result;
  }

  // 从起点 bundle 建工作区：取出起点提交、检出、清理历史并自验。工作区根里预装的依赖目录（已被 .gitignore 忽略）保留
  async initFromBundle(bundle: Buffer, startCommit: string): Promise<void> {
    await this.must(
      [
        "set -e",
        "git init -q .",
        `git config user.name ${shellQuote(STREAM_COMMITTER.name)}`,
        `git config user.email ${shellQuote(STREAM_COMMITTER.email)}`,
        "git config commit.gpgsign false",
        "git config core.autocrlf false",
        `cat > ${BUNDLE_PATH}`,
        `git fetch -q ${BUNDLE_PATH} "$1"`,
        'git checkout -q -f -B main "$1"',
        `rm -f ${BUNDLE_PATH}`,
      ].join("\n"),
      "建立流起点",
      { args: [startCommit], stdin: bundle, timeoutMs: 900_000 }
    );
    const pruned = await this.must(PRUNE_HISTORY_SCRIPT, "清理起点历史", { timeoutMs: 900_000 });
    if (!historyPruneVerified(pruned.stdout)) {
      throw new StreamWorkspaceError(`起点历史清理自验不过：${pruned.stdout.trim()}`);
    }
    const head = await this.head();
    if (head !== startCommit)
      throw new StreamWorkspaceError(`起点检出不符：HEAD 为 ${head}，应为 ${startCommit}`);
  }

  // 从续跑 bundle 恢复（容器丢失后重建）：bundle 为此前导出的完整流历史，末端即断点
  async restoreFromBundle(bundle: Buffer, head: string): Promise<void> {
    await this.must(
      [
        "set -e",
        "git init -q .",
        `git config user.name ${shellQuote(STREAM_COMMITTER.name)}`,
        `git config user.email ${shellQuote(STREAM_COMMITTER.email)}`,
        "git config commit.gpgsign false",
        "git config core.autocrlf false",
        `cat > ${BUNDLE_PATH}`,
        `git fetch -q ${BUNDLE_PATH} "$1"`,
        'git checkout -q -f -B main "$1"',
        `rm -f ${BUNDLE_PATH}`,
        "rm -f .git/FETCH_HEAD",
      ].join("\n"),
      "从续跑点恢复",
      { args: [head], stdin: bundle, timeoutMs: 900_000 }
    );
  }

  async head(): Promise<string> {
    return (await this.must("git rev-parse HEAD", "读取 HEAD")).stdout.trim();
  }

  // 程序把人的文件写进工作区（测试、测试辅助、环境文件）；内容由调用方从人的提交里取
  async applyHumanFiles(
    ops: readonly HumanFileOp[],
    read: (path: string) => Buffer
  ): Promise<void> {
    for (const op of ops) {
      if (op.op === "delete") {
        await this.must('rm -f -- "$1"', `删除人的文件 ${op.path}`, { args: [op.path] });
        continue;
      }
      await this.must('mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', `写入人的文件 ${op.path}`, {
        args: [op.path],
        stdin: read(op.path),
      });
    }
  }

  // 在工作区根跑一条命令（验证门等），带墙钟上限
  async run(command: readonly string[], timeoutMs: number, cwd?: string): Promise<CommandOutcome> {
    const started = Date.now();
    const result = await this.shell.sh(timeoutWrapped(command, timeoutMs), {
      timeoutMs: timeoutMs + 60_000,
      ...(cwd !== undefined ? { cwd } : {}),
    });
    // 137 也可能是内存超限被杀：只有同时用满了墙钟才算超时
    const timedOut = result.exitCode === TIMEOUT_KILLED && Date.now() - started >= timeoutMs;
    return { exitCode: result.exitCode, timedOut, output: result.stdout + result.stderr };
  }

  // 落地：以提交信息提交当前工作区的全部改动（没有改动也提交一次，步与提交一一对应）
  async land(message: string): Promise<string> {
    await this.must("git add -A && git commit -q --allow-empty --no-verify -F -", "落地提交", {
      stdin: message,
      timeoutMs: 300_000,
    });
    return this.head();
  }

  // 回到本步起点（即 HEAD）：复原被跟踪文件，删掉未忽略的未跟踪文件；被忽略的文件（依赖目录）不动
  async rollback(): Promise<void> {
    await this.must("git reset -q --hard HEAD && git clean -fdq", "回到本步起点", {
      timeoutMs: 300_000,
    });
  }

  // 工作区是否与 HEAD 逐字一致（被跟踪文件与未忽略的未跟踪文件）
  async isClean(): Promise<boolean> {
    const status = await this.must(
      "git status --porcelain --untracked-files=all",
      "读取工作区状态"
    );
    return status.stdout.trim() === "";
  }

  // 导出整条流历史，供续跑时重建
  async exportBundle(): Promise<Buffer> {
    const result = await this.must("git bundle create - --all 2>/dev/null", "导出流历史", {
      timeoutMs: 600_000,
    });
    return result.stdoutBytes;
  }

  // 建测量副本：从 HEAD 克隆到 measureRoot，依赖目录以链接接上；返回副本路径
  async prepareMeasureCopy(measureRoot: string, depsLinks: readonly string[]): Promise<string> {
    const links = depsLinks
      .map(
        (d) =>
          `if [ -e ${shellQuote(`${this.root}/${d}`)} ]; then ln -s ${shellQuote(`${this.root}/${d}`)} "$1/${d}"; fi`
      )
      .join("\n");
    await this.must(
      [
        "set -e",
        'rm -rf -- "$1"',
        `git -c core.autocrlf=false clone -q --no-hardlinks ${shellQuote(this.root)} "$1"`,
        links,
      ].join("\n"),
      "建立测量副本",
      { args: [measureRoot], timeoutMs: 600_000 }
    );
    return measureRoot;
  }

  // 在测量副本里写入人的文件
  async applyHumanFilesAt(
    dir: string,
    ops: readonly HumanFileOp[],
    read: (path: string) => Buffer
  ): Promise<void> {
    for (const op of ops) {
      const script =
        op.op === "delete" ? 'rm -f -- "$1"' : 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"';
      await this.must(script, `测量副本写入 ${op.path}`, {
        args: [op.path],
        cwd: dir,
        ...(op.op === "write" ? { stdin: read(op.path) } : {}),
      });
    }
  }

  // 读取工作区里的一个文件（测量报告等）
  async readFile(path: string): Promise<Buffer> {
    return (await this.must('cat -- "$1"', `读取 ${path}`, { args: [path] })).stdoutBytes;
  }
}
