// 提交流实验的工作区（决策 148、104、109、154、193、212）：每一步一个新开的断网容器，agent 在其中从人在该步之前的代码开工。
// 工作区的一切动作都是在工作区根执行的一段 sh 脚本，经 StreamShell 下发：生产实现走 docker exec，
// 测试用本机 sh 在临时目录里真跑同一批脚本。
//   起点：人在该步之前那次提交的代码，经 git bundle 送入（bundle 只含起点可达的历史，天然看不到未来），
//         再用与外部基准同一份清理脚本清到只剩当前并自验（109）；
//   开工：程序把该步人写的环境文件写进去（内容由宿主从人的提交里取、经标准输入送入，容器里没有未来对象）；
//         人在该步的测试与测试辅助文件判题时才写入（198）；
//   收工：记下 agent 相对开工时的改动（diff），判题与全量测量就地进行，之后整个容器丢弃，下一步另开。
import { containerExec, trustedShell } from "../execution/container-host.ts";
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
  // 用镜像自己的 PATH（所选依赖环境在前）：只给判题、测量、验证门这类要用所选环境的测试命令；其余一律以固定 PATH 执行
  imagePath?: boolean;
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
        command:
          options.imagePath === true
            ? ["/bin/sh", "-c", script, "sh", ...(options.args ?? [])]
            : trustedShell(script, ...(options.args ?? [])),
        workdir: options.cwd ?? input.root,
        ...(input.docker !== undefined ? { docker: input.docker } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
        ...(options.asRoot === true ? { user: "0" } : {}),
      });
    },
  };
}

// 程序落地提交用的身份；agent 从 git log 能看出哪些提交是程序落的
export const STREAM_COMMITTER = { name: "pigeon-stream", email: "stream@pigeon.invalid" };

export class StreamWorkspaceError extends Error {
  override name = "StreamWorkspaceError";
}

const BUNDLE_PATH = ".git/pigeon-start.bundle";

// 跑批器自己的 git 操作不受 agent 能改的 git 设置左右：不读全局与系统配置（agent 能写 ~/.gitconfig），不执行 .git/hooks
// 里的钩子、不跑 fsmonitor 程序、提交不签名（不调 gpg.program），提交身份固定（环境变量里的设置优先于仓库的
// .git/config）。仓库 .git/config 里的 filter 驱动等由 SANITIZE_GIT_CONFIG 在跑批器的 git 操作之前清掉。只加在工作区
// 内部操作上，agent 与判题的命令照旧
const SAFE_GIT_ENV = [
  "export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_COUNT=5",
  "GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null",
  "GIT_CONFIG_KEY_1=core.fsmonitor GIT_CONFIG_VALUE_1=false",
  "GIT_CONFIG_KEY_2=commit.gpgsign GIT_CONFIG_VALUE_2=false",
  `GIT_CONFIG_KEY_3=user.name GIT_CONFIG_VALUE_3=${STREAM_COMMITTER.name}`,
  `GIT_CONFIG_KEY_4=user.email GIT_CONFIG_VALUE_4=${STREAM_COMMITTER.email}`,
].join(" ");
// 把 .git/config 重写成只含无害项的一份，并删掉 .git/info/attributes：agent 能在其中配 filter 驱动（配合 .gitattributes，
// 跑批器的 git add、status、checkout 会执行它）、include 其他文件、改 core.worktree 等。只保留仓库格式与几项文件系统
// 属性（取值须为 true 或 false），其余一律丢掉；读取用 --file，不跟随 include
const SANITIZE_GIT_CONFIG = [
  // 不调 git：.git/config 被写坏时 git 自己先失败，回退随之报错
  'gd=.git && cfg="$gd/config" &&',
  "{ printf '[core]\\n\\trepositoryformatversion = 0\\n\\tbare = false\\n\\tlogallrefupdates = true\\n\\tautocrlf = false\\n';",
  "for k in filemode symlinks ignorecase; do",
  '  v="$(git config --file "$cfg" --get "core.$k" 2>/dev/null)";',
  '  case "$v" in true | false) printf \'\\t%s = %s\\n\' "$k" "$v" ;; esac;',
  "done;",
  `printf '[user]\\n\\tname = %s\\n\\temail = %s\\n[commit]\\n\\tgpgsign = false\\n' '${STREAM_COMMITTER.name}' '${STREAM_COMMITTER.email}'; } > "$cfg.pigeon" &&`,
  'mv -f -- "$cfg.pigeon" "$cfg" && rm -f -- "$gd/info/attributes"',
].join(" ");
// 把 agent 留下的未解决冲突（merge、cherry-pick、revert、stash pop）收成干净的索引：去掉进行中的合并状态，冲突路径按
// 工作区里的样子暂存。之后去标记、reset 都不会因为冲突条目报错（Unable to mark file、合并中不能 soft reset）
const SETTLE_INDEX = [
  'g="$(git rev-parse --git-dir)"',
  'rm -f -- "$g/MERGE_HEAD" "$g/MERGE_MSG" "$g/MERGE_MODE" "$g/AUTO_MERGE" "$g/CHERRY_PICK_HEAD" "$g/REVERT_HEAD"',
  "git diff -z --name-only --diff-filter=U | xargs -0 -r git add -A --",
].join(" && ");
const UNMARK_INDEX = `${SETTLE_INDEX} && git ls-files -z | xargs -0 -r git update-index --no-skip-worktree -- && git ls-files -z | xargs -0 -r git update-index --no-assume-unchanged --`;
// 让 HEAD 指回 main、main 指向给定提交（$1），不经过任何符号引用：agent 可以把 HEAD 或某条引用设成符号引用（例如
// HEAD 指向一条开工树引用、refs/heads/x 指向 main），跑批器沿着它们改写就会改掉保留的引用或删掉 main。只动引用，不动
// 暂存区与工作区
const HEAD_ONTO_MAIN =
  'git update-ref --no-deref refs/heads/main "$1" && git symbolic-ref HEAD refs/heads/main';

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

// 写入或删除人的文件之前：路径上凡是符号链接的一级（各级目录与文件本身）只删链接本身、不跟随，再由 mkdir -p 建真目录；
// 中间某一级是普通文件（人的树规定那里是目录）同样删掉。否则 agent 把人写测试的目录换成指向别处的链接后，写入会顺着链接
// 写到工作区之外，pytest 按链接路径加载那边的 conftest，链接还会随落地提交。删不掉即以退出码 UNLINK_FAILED 失败，
// 不顺着写出去（调用方把这一步作废）
const UNLINK_FAILED = 97;
const UNLINK_ON_PATH = [
  'unlink_on_path() { up_rest="$1"; up_p="";',
  'while [ -n "$up_rest" ]; do',
  `case "$up_rest" in */*) up_c="\${up_rest%%/*}"; up_rest="\${up_rest#*/}";; *) up_c="$up_rest"; up_rest="";; esac;`,
  `up_p="\${up_p:+$up_p/}$up_c";`,
  `if [ -L "$up_p" ]; then rm -f -- "$up_p" || return ${UNLINK_FAILED};`,
  `elif [ -n "$up_rest" ] && [ -e "$up_p" ] && [ ! -d "$up_p" ]; then rm -f -- "$up_p" || return ${UNLINK_FAILED}; fi;`,
  "done; };",
].join(" ");

// 残留的 git 锁文件（index.lock、HEAD.lock、packed-refs.lock、refs 下的 *.lock）：清进程恰好杀掉 agent 在途的 git
// 命令、或容器重启时留下，否则跑批器下一次 git 操作失败、作业停下。只在没有工作目录位于工作区（$1）下的 git 进程时删——
// 只看工作区下的，容器或宿主上别处的 git 进程不相干
export const STALE_GIT_LOCKS = [
  'r="$1"',
  "for p in /proc/[0-9]*; do",
  '  [ "$(cat "$p/comm" 2>/dev/null)" = git ] || continue',
  '  c="$(readlink "$p/cwd" 2>/dev/null)" || continue',
  '  case "$c" in "$r" | "$r"/*) exit 0 ;; esac',
  "done",
  'rm -f -- "$r/.git/index.lock" "$r/.git/HEAD.lock" "$r/.git/packed-refs.lock"',
  'if [ -d "$r/.git/refs" ]; then find "$r/.git/refs" -type f -name "*.lock" -exec rm -f -- {} + 2>/dev/null; fi',
  "true",
].join("\n");

// timeout 命令被 KILL 信号杀掉时的退出码
const TIMEOUT_KILLED = 137;

// run 把整条命令拼成一段 sh 脚本、作为一个参数下发；Linux 限制单个参数不超过 128 KiB（MAX_ARG_STRLEN），超了宿主启动
// docker 即报 spawn E2BIG（续跑时带上千条 --deselect 的用例外壳就会超）。脚本超过这个长度（留出余量）即改经标准输入
// 送入、在容器里 eval 同一段文本：命令的每个词原样到达，各自成为独立的参数，只受整条命令行的总上限约束
const INLINE_SCRIPT_LIMIT = 64 * 1024;
// 从标准输入读出整段脚本再执行（cat 取系统目录下的绝对路径，不按镜像的 PATH 解析）
const SCRIPT_FROM_STDIN = 'eval "$(/bin/cat)"';

// 脚本确实在跑批器起的 docker 作业容器里执行：容器带 PIGEON_STREAM_CONTAINER=1（docker run -e，exec 出来的进程都继承，
// agent 改不了容器配置），且有 docker 建的 /.dockerenv。本机测试的假 docker 在本机执行脚本，两者都不满足——清临时目录、
// 清进程这类只对作业容器安全的操作以它为前提
export const IN_STREAM_CONTAINER = `{ [ "\${PIGEON_STREAM_CONTAINER:-}" = 1 ] && [ -f /.dockerenv ]; }`;

// 工作区里有 agent 设下、跑批器处理不了的访问障碍（列不出的目录、删不掉的链接）：调用方把这一步作废重做，不停作业
export class StreamWorkspaceAccessError extends Error {
  override name = "StreamWorkspaceAccessError";
}

// 维护步验证门写在容器里的报告（strands 的验证门步写到这里）
export const GATE_REPORT = "/tmp/pigeon-gate-junit.xml";

export class StreamWorkspace {
  private readonly shell: StreamShell;
  private readonly homeDir: string | undefined;

  // homeDir 只供本机测试：判题前清家目录下的用户级文件时改到用例自建的目录。缺省清容器里执行用户的 $HOME，且只在
  // 跑批器起的作业容器里清（本机测试的"容器"就是本机，绝不能清本机的家目录）
  constructor(shell: StreamShell, options: { homeDir?: string } = {}) {
    this.shell = shell;
    this.homeDir = options.homeDir;
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

  // 从 bundle 恢复出完整历史并检出 head（参考工作区装人的完整历史用）
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
      "从 bundle 恢复",
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
        await this.humanWrite(
          `${UNLINK_ON_PATH} unlink_on_path "$1" || exit $?; rm -f -- "$1"`,
          `删除人的文件 ${op.path}`,
          {
            args: [op.path],
          }
        );
        continue;
      }
      await this.humanWrite(
        `${UNLINK_ON_PATH} unlink_on_path "$1" || exit $?; mkdir -p -- "$(dirname -- "$1")" && cat > "$1"`,
        `写入人的文件 ${op.path}`,
        { args: [op.path], stdin: read(op.path) }
      );
    }
  }

  // 在工作区根跑一条命令（验证门等），带墙钟上限
  // systemPath：以固定 PATH 执行（切依赖环境这类跑批器自己的命令）；缺省用镜像的 PATH（判题、测量、验证门）
  async run(
    command: readonly string[],
    timeoutMs: number,
    cwd?: string,
    options: { systemPath?: boolean } = {}
  ): Promise<CommandOutcome> {
    const started = Date.now();
    const script = timeoutWrapped(command, timeoutMs);
    const viaStdin = Buffer.byteLength(script) > INLINE_SCRIPT_LIMIT;
    const result = await this.shell.sh(viaStdin ? SCRIPT_FROM_STDIN : script, {
      ...(viaStdin ? { stdin: script } : {}),
      timeoutMs: timeoutMs + 60_000,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(options.systemPath === true ? {} : { imagePath: true }),
    });
    // 137 也可能是内存超限被杀：只有同时用满了墙钟才算超时
    const timedOut = result.exitCode === TIMEOUT_KILLED && Date.now() - started >= timeoutMs;
    return { exitCode: result.exitCode, timedOut, output: result.stdout + result.stderr };
  }

  // agent 在容器里也可能自己提交、切到别的分支或让 HEAD 游离：把 HEAD 放回指向本步起点的 main、改动留在暂存区与
  // 工作区（等同 soft reset，但不经过 agent 设下的符号引用），此后记改动、恢复人写测试与判题都相对起点
  async normalizeTo(base: string): Promise<void> {
    await this.must(
      `${SANITIZE_GIT_CONFIG} && ${SETTLE_INDEX} && ${HEAD_ONTO_MAIN}`,
      "把 HEAD 挪回本步起点",
      {
        args: [base],
      }
    );
  }

  // 工作区此刻的树（被跟踪文件与未忽略的未跟踪文件）：用临时索引从 HEAD 起暂存全部、写出树对象，返回树的哈希；
  // 不动真的暂存区。开工时与收工时各取一次，两者之差即 agent 在这一步的改动
  async worktreeTree(): Promise<string> {
    const r = await this.must(
      [
        SANITIZE_GIT_CONFIG,
        'gd="$(git rev-parse --git-dir)" && t="$gd/pigeon-tree-index" && rm -f -- "$t"',
        'GIT_INDEX_FILE="$t" git read-tree HEAD',
        'GIT_INDEX_FILE="$t" git add -A',
        'tree="$(GIT_INDEX_FILE="$t" git write-tree)"',
        'rm -f -- "$t"',
        'echo "$tree"',
      ].join(" && "),
      "读取工作区的树",
      { timeoutMs: 300_000 }
    );
    return r.stdout.trim();
  }

  // 两棵树之差（含二进制内容）：存下 agent 在这一步的改动，替代延续式的流历史
  async diffTrees(from: string, to: string): Promise<Buffer> {
    const r = await this.must(
      'git diff --binary --no-color --no-ext-diff --no-textconv "$1" "$2"',
      "取出改动",
      { args: [from, to], timeoutMs: 300_000 }
    );
    return r.stdoutBytes;
  }

  // 把工作区的全部改动暂存（含未忽略的未跟踪文件）：就地全量测量之前，让 agent 新建的测试文件也在被跟踪之列，
  // 同步人写测试时才能按类删掉它们
  async stageAll(): Promise<void> {
    await this.must(`${SANITIZE_GIT_CONFIG} && git add -A`, "暂存工作区的改动", {
      timeoutMs: 300_000,
    });
  }

  // 删掉家目录下给定的相对路径（用户级 site-packages、ruff 与 mypy 的用户级配置等，决策 195 的补口）：删不掉即抛访问
  // 错误（调用方把这一步作废）。缺省为容器里执行用户的 $HOME，且只在跑批器起的作业容器里删（IN_STREAM_CONTAINER）；
  // 构造时给了 homeDir（本机测试）则删它下面的
  async clearHomePaths(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    for (const p of paths) {
      if (p.startsWith("/") || p.split("/").includes("..") || p === "" || p === ".") {
        throw new StreamWorkspaceError(`家目录下的路径须为相对路径、不含 ..：${p}`);
      }
    }
    const enter =
      this.homeDir !== undefined
        ? 'h="$1"'
        : `${IN_STREAM_CONTAINER} || exit 0; h="\${HOME:-}"; [ -n "$h" ] && [ "$h" != / ] || exit 0`;
    const r = await this.shell.sh(
      [
        `${enter}; shift; cd -- "$h" || exit 0`,
        'chmod -R u+rwX -- "$@" 2>/dev/null; rm -rf -- "$@" 2>/dev/null',
        `for p; do if [ -e "$p" ] || [ -L "$p" ]; then exit ${UNLINK_FAILED}; fi; done; true`,
      ].join("\n"),
      { args: [this.homeDir ?? "", ...paths] }
    );
    if (r.exitCode === UNLINK_FAILED) {
      throw new StreamWorkspaceAccessError(
        `家目录下的用户级文件删不掉（${paths.join("、")}）：判题前不能保证它们不起作用`
      );
    }
    if (r.exitCode !== 0) {
      throw new StreamWorkspaceError(
        `清家目录下的用户级文件失败（退出码 ${r.exitCode}）：${r.stderr.trim()}`
      );
    }
  }

  // 把工作区里 agent 收走的属主权限放回来（chmod -R u+rwX；跑批器与 agent 同一用户，做得到）：agent 把目录设成
  // 不可读或不可写（例如 0311 能进不能列）后，列候选、回滚、还原与写人的文件都会漏看或失败。尽力而为，放不回来的由
  // 之后的操作报错
  async grantOwnerAccess(): Promise<void> {
    await this.must("chmod -R u+rwX -- . 2>/dev/null; true", "放回工作区的属主权限", {
      timeoutMs: 300_000,
    });
  }

  // 依赖环境的链接是否完好：每条都是链接、解析到给定的 root 所有目录之下（links 的 under 以 / 结尾）
  async envLinksIntact(links: readonly { link: string; under: string }[]): Promise<boolean> {
    const r = await this.shell.sh(
      [
        'while [ "$#" -gt 0 ]; do l="$1"; u="$2"; shift 2',
        '  [ -L "$l" ] || exit 1',
        '  t="$(readlink -f -- "$l")" || exit 1',
        '  case "$t/" in "$u"*) ;; *) exit 1 ;; esac',
        '  [ "$(stat -c %u -- "$t")" = 0 ] || exit 1',
        "done",
      ].join("\n"),
      { args: links.flatMap((l) => [l.link, l.under]) }
    );
    return r.exitCode === 0;
  }

  // 闸门（IN_STREAM_CONTAINER）在这个容器里是否成立
  async inStreamContainer(): Promise<boolean> {
    return (await this.shell.sh(IN_STREAM_CONTAINER)).exitCode === 0;
  }

  // 清掉 agent 在 .git/config 与 .git/info/attributes 里设下的东西（见 SANITIZE_GIT_CONFIG）
  async sanitizeGitConfig(): Promise<void> {
    await this.must(SANITIZE_GIT_CONFIG, "清理 git 配置");
  }

  // 工作区是否与 HEAD 逐字一致（被跟踪文件与未忽略的未跟踪文件）
  async isClean(): Promise<boolean> {
    const status = await this.must(
      "git status --porcelain --untracked-files=all",
      "读取工作区状态"
    );
    return status.stdout.trim() === "";
  }

  // 在给定目录（缺省工作区根）里写入人的文件
  async applyHumanFilesAt(
    dir: string,
    ops: readonly HumanFileOp[],
    read: (path: string) => Buffer
  ): Promise<void> {
    for (const op of ops) {
      const script = `${UNLINK_ON_PATH} unlink_on_path "$1" || exit $?; ${
        op.op === "delete" ? 'rm -f -- "$1"' : 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"'
      }`;
      await this.humanWrite(script, `写入人的文件 ${op.path}`, {
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

  // 工作区里叫这个名字的全部路径（文件、目录、符号链接本身），按文件系统逐个列出：不看 git（被忽略的、嵌套的 git 仓库里的
  // 都列到），不跟随符号链接，跳过工作区根的 .git。返回相对工作区根的路径
  async pathsNamed(name: string): Promise<string[]> {
    // 调用方先放回属主权限（grantOwnerAccess）；仍列不全（find 报错）即抛访问错误，不当作"没有"——pytest 可以按路径直接
    // 加载列不出的目录里的 conftest
    const r = await this.listing(
      'find . -path ./.git -prune -o -name "$1" -print0',
      `列出 ${name}`,
      [name]
    );
    return r.stdout
      .split("\x00")
      .filter((p) => p !== "")
      .map((p) => p.replace(/^\.\//, ""));
  }

  // 工作区里的全部符号链接（不跟随，跳过工作区根的 .git）。返回相对工作区根的路径
  async symlinks(): Promise<string[]> {
    const r = await this.listing(
      "find . -path ./.git -prune -o -type l -print0",
      "列出符号链接",
      []
    );
    return r.stdout
      .split("\x00")
      .filter((p) => p !== "")
      .map((p) => p.replace(/^\.\//, ""));
  }

  // 写或删人的文件：路径上的链接删不掉（UNLINK_FAILED）即抛访问错误，其余失败照常报错
  private async humanWrite(script: string, what: string, options: ShellOptions): Promise<void> {
    const r = await this.shell.sh(`${SAFE_GIT_ENV}\n${script}`, options);
    if (r.exitCode === UNLINK_FAILED) {
      throw new StreamWorkspaceAccessError(`${what}：路径上的链接或文件删不掉，不顺着写出去`);
    }
    if (r.exitCode !== 0) {
      throw new StreamWorkspaceError(
        `${what}失败（退出码 ${r.exitCode}）：${r.stderr.trim() || r.stdout.trim()}`
      );
    }
  }

  // 列文件的 find：报错即抛访问错误
  private async listing(script: string, what: string, args: string[]): Promise<ShellResult> {
    const r = await this.shell.sh(`${SAFE_GIT_ENV}\n${script}`, { args });
    if (r.exitCode !== 0) {
      throw new StreamWorkspaceAccessError(
        `${what}不全（退出码 ${r.exitCode}）：${r.stderr.trim().slice(-500)}`
      );
    }
    return r;
  }

  // 删掉给定路径：文件、整个目录，或符号链接本身（不跟随）；不在的忽略
  async removeTrees(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.must('rm -rf -- "$@"', "删除文件", { args: paths });
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

// 会被测试框架自动加载、改变人写测试收集与执行的辅助文件（strands 的 conftest.py）：不在人在该步树里、且所在目录的
// 子树里有人在该步测试文件的，删掉；只作用于 agent 自己测试目录的保留。判题之前（跑批器）与每次回炉验证之前（Pigeon）
// 同一规则。候选按文件系统列出且不进入符号链接目录，所以路径上是人写测试的上级目录、本身却是符号链接的，链接一并删掉
// （只删链接本身）：pytest 会按链接路径加载链接那边的 conftest。返回删掉的路径
export async function removeCoveringHelpers(
  ws: StreamWorkspace,
  name: string,
  inHumanTree: (path: string) => boolean,
  humanTests: readonly string[]
): Promise<string[]> {
  const covers = (dir: string) =>
    dir === "" || dir === "." || humanTests.some((t) => t.startsWith(`${dir}/`));
  await ws.grantOwnerAccess();
  const stray = (await ws.pathsNamed(name)).filter(
    (p) => !inHumanTree(p) && covers(posixDirname(p))
  );
  const linkedDirs = (await ws.symlinks()).filter(
    (p) => !inHumanTree(p) && !stray.includes(p) && humanTests.some((t) => t.startsWith(`${p}/`))
  );
  const removed = [...stray, ...linkedDirs];
  await ws.removeTrees(removed);
  return removed;
}

function posixDirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "." : p.slice(0, i);
}
