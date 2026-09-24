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
  // 以 root 执行（写 agent 不可写的位置，例如人的 pytest 配置）；本机测试实现照常以当前用户执行
  asRoot?: boolean;
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
        ...(options.asRoot === true ? { user: "0" } : {}),
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

// 跑批器自己的 git 操作不受 agent 能改的 git 设置左右：不执行 .git/hooks 里的钩子、不跑 fsmonitor 程序（环境变量里的
// 设置优先于仓库的 .git/config）。只加在工作区内部操作上，agent 与判题的命令照旧
const SAFE_GIT_ENV =
  "export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null GIT_CONFIG_KEY_1=core.fsmonitor GIT_CONFIG_VALUE_1=false";
// 把 agent 留下的未解决冲突（merge、cherry-pick、revert、stash pop）收成干净的索引：去掉进行中的合并状态，冲突路径按
// 工作区里的样子暂存。之后去标记、reset 都不会因为冲突条目报错（Unable to mark file、合并中不能 soft reset）
const SETTLE_INDEX = [
  'g="$(git rev-parse --git-dir)"',
  'rm -f -- "$g/MERGE_HEAD" "$g/MERGE_MSG" "$g/MERGE_MODE" "$g/AUTO_MERGE" "$g/CHERRY_PICK_HEAD" "$g/REVERT_HEAD"',
  "git diff -z --name-only --diff-filter=U | xargs -0 -r git add -A --",
].join(" && ");
const UNMARK_INDEX = `${SETTLE_INDEX} && git ls-files -z | xargs -0 -r git update-index --no-skip-worktree -- && git ls-files -z | xargs -0 -r git update-index --no-assume-unchanged --`;

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

// 维护步验证门写在容器里的报告（strands 的验证门步写到这里）
export const GATE_REPORT = "/tmp/pigeon-gate-junit.xml";

export class StreamWorkspace {
  private readonly shell: StreamShell;
  private readonly gateReport: string;

  // gateReport 只供本机测试改到各自的临时路径（本机 /tmp 为各用例共用）
  constructor(shell: StreamShell, options: { gateReport?: string } = {}) {
    this.shell = shell;
    this.gateReport = options.gateReport ?? GATE_REPORT;
  }

  get root(): string {
    return this.shell.root;
  }

  private async must(
    script: string,
    what: string,
    options: ShellOptions = {}
  ): Promise<ShellResult> {
    const result = await this.shell.sh(`${SAFE_GIT_ENV}\n${script}`, options);
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

  // 回到本步起点（缺省为 HEAD）：复原被跟踪文件，删掉未忽略的未跟踪文件；被忽略的文件（依赖目录）不动
  async rollback(to = "HEAD"): Promise<void> {
    await this.must(
      `${UNMARK_INDEX} && git reset -q --hard "$1" && git clean -fdq`,
      "回到本步起点",
      {
        args: [to],
        timeoutMs: 300_000,
      }
    );
  }

  // agent 在容器里也可能自己提交：把 HEAD 挪回本步起点、改动留在工作区，此后的恢复、判定与落地都相对起点
  async normalizeTo(base: string): Promise<void> {
    await this.must(`${SETTLE_INDEX} && git reset -q --soft "$1"`, "把 HEAD 挪回本步起点", {
      args: [base],
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

  // 建测量副本：从 HEAD 克隆到 measureRoot，依赖目录以链接接上；返回副本路径。只清空副本目录里的内容、不删目录本身：
  // 容器里以非 root 用户执行，镜像预建好归它所有的副本目录，它未必能写上级目录
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
        'mkdir -p -- "$1"',
        'find "$1" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +',
        `git -c core.autocrlf=false clone -q --no-hardlinks ${shellQuote(this.root)} "$1"`,
        links,
      ].join("\n"),
      "建立测量副本",
      { args: [measureRoot], timeoutMs: 600_000 }
    );
    return measureRoot;
  }

  // 测量与判题的产物用完即清，不留给下一步的 agent：清空测量副本目录的内容（人写测试的副本与其中的报告），
  // 删掉工作区里判题的报告与维护步验证门的报告
  async clearArtifacts(measureRoot: string): Promise<void> {
    await this.must(
      [
        'if [ -d "$1" ]; then find "$1" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; fi',
        `rm -f ${shellQuote(`${this.root}/.git/pigeon-cases-junit.xml`)} ${shellQuote(this.gateReport)}`,
      ].join("\n"),
      "清理测量与判题的产物",
      { args: [measureRoot], timeoutMs: 120_000 }
    );
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

  // 相对 HEAD 有改动的路径（含删除与未忽略的未跟踪文件）；untracked 表示 HEAD 里没有它
  // 相对本步起点的改动。暂存了的改名（R）与复制（C）：新路径记为新建（HEAD 里没有），并带上原路径 renamedFrom；
  // 改名的原路径另记一项（它在工作区里已不在，从 HEAD 恢复即可），复制的原路径没动、不记
  async changedPaths(): Promise<{ path: string; untracked: boolean; renamedFrom?: string }[]> {
    const r = await this.must("git status --porcelain=v1 -z --untracked-files=all", "读取改动");
    const parts = r.stdout.split("\x00");
    const out: { path: string; untracked: boolean; renamedFrom?: string }[] = [];
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i] ?? "";
      if (entry.length < 4) continue;
      const code = entry.slice(0, 2);
      const path = entry.slice(3);
      if (code.startsWith("R") || code.startsWith("C")) {
        // 改名与复制项后面跟着原路径
        const from = parts[i + 1] ?? "";
        i++;
        if (code.startsWith("R")) {
          out.push({ path, untracked: true, renamedFrom: from });
          out.push({ path: from, untracked: false });
        } else {
          out.push({ path, untracked: true });
        }
        continue;
      }
      out.push({ path, untracked: code === "??" || code.includes("A") });
    }
    return out;
  }

  // 工作区里叫这个名字的全部文件：被跟踪的、未跟踪的与被忽略的，逐个文件列出（被忽略的目录也往下展开，不折叠成目录）
  async filesNamed(name: string): Promise<string[]> {
    const spec = `:(glob)**/${name}`;
    const r = await this.must(
      [
        'git ls-files -z -- "$1"',
        'git ls-files -z --others --exclude-standard -- "$1"',
        'git ls-files -z --others --ignored --exclude-standard -- "$1"',
      ].join(" && "),
      `列出 ${name}`,
      { args: [spec] }
    );
    return [...new Set(r.stdout.split("\x00").filter((p) => p !== ""))];
  }

  // 去掉索引里全部条目的 skip-worktree 与 assume-unchanged 标记：agent 设了这些标记的文件，git status 看不到它的改动、
  // 检出与 reset --hard 也会跳过它。标记要以参数给路径、两种标记分两次去（一次只认最后一个）
  async unmarkIndex(): Promise<void> {
    await this.must(UNMARK_INDEX, "去掉索引标记");
  }

  // 删掉给定路径（连同暂存区里的记录）；不在的忽略
  async removePaths(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.must(
      'git rm -q -f --cached --ignore-unmatch -- "$@" >/dev/null && rm -f -- "$@"',
      "删除文件",
      { args: paths }
    );
  }

  // 把给定路径恢复成 HEAD 里的版本
  async restoreFromHead(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.must('git checkout -q HEAD -- "$@"', "从本步起点恢复文件", { args: paths });
  }

  // 目录里（缺省为工作区根）被跟踪文件的 blob 哈希
  async trackedBlobs(dir?: string): Promise<Map<string, string>> {
    const r = await this.must("git ls-files -s -z", "读取被跟踪文件", {
      ...(dir !== undefined ? { cwd: dir } : {}),
    });
    const out = new Map<string, string>();
    for (const entry of r.stdout.split("\x00")) {
      const tab = entry.indexOf("\t");
      if (tab < 0) continue;
      const [, blob = ""] = entry.slice(0, tab).split(" ");
      out.set(entry.slice(tab + 1), blob);
    }
    return out;
  }

  // 把人的文件同步进目录：只写 blob 与目录里被跟踪版本不同（或缺失）的文件；返回写入的路径。
  // 给了 exclusive 时，目录里被它认定为同一类（测试、测试辅助）却不在人的这批文件里的，先删掉（例如 agent 新建的
  // conftest.py 与测试文件），使目录里这一类文件与人的完全一致
  async syncHumanFilesAt(
    dir: string,
    entries: readonly { path: string; blob: string; kind: HumanFileOp["kind"] }[],
    read: (path: string) => Buffer,
    exclusive?: (path: string) => HumanFileOp["kind"] | null
  ): Promise<string[]> {
    const tracked = await this.trackedBlobs(dir);
    if (exclusive !== undefined) {
      const human = new Set(entries.map((e) => e.path));
      const extra: HumanFileOp[] = [];
      for (const p of tracked.keys()) {
        const kind = exclusive(p);
        if (kind !== null && !human.has(p)) extra.push({ path: p, op: "delete", kind });
      }
      await this.applyHumanFilesAt(dir, extra, read);
    }
    const stale = entries.filter((e) => tracked.get(e.path) !== e.blob);
    await this.applyHumanFilesAt(
      dir,
      stale.map((e) => ({ path: e.path, op: "write", kind: e.kind })),
      read
    );
    return stale.map((e) => e.path);
  }

  // 以 root 执行一段脚本（跑批器写 agent 不可写的位置）；失败即抛错
  async asRoot(
    script: string,
    what: string,
    options: Omit<ShellOptions, "asRoot"> = {}
  ): Promise<void> {
    await this.must(script, what, { ...options, asRoot: true });
  }

  // 写一个文件（绝对路径，例如工作区 .git 下的临时文件；不经 git）
  async writeFile(path: string, content: Buffer): Promise<void> {
    await this.must('cat > "$1"', `写入 ${path}`, { args: [path], stdin: content });
  }

  // 读取工作区里的一个文件（测量报告等）
  async readFile(path: string): Promise<Buffer> {
    return (await this.must('cat -- "$1"', `读取 ${path}`, { args: [path] })).stdoutBytes;
  }
}
