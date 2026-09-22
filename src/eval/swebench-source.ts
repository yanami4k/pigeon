// 任务源的外部基准实现（决策 097 / 102）：SWE-bench Verified。四样东西——
//   实例清单：数据集 JSONL（每行一个实例：instance_id、problem_statement、test_patch、difficulty 等），可按 id 取子集；
//   环境准备：起该实例的官方评测镜像当工作区（容器内 /testbed 已处在基准提交、依赖已装好），交回容器执行端；
//   判据命令：判分脚本（eval/swebench/judge.py）——它调官方判分器对取出的补丁判分，0 已解决、1 未解决、2 判分设施出错；
//   元数据：数据集自带的难度标记；不设 holdout。
// 取 diff 的口径：相对仓库根、相对基准提交上的镜像初始状态。镜像在基准提交之上可能带有环境准备留下的未提交改动
// （如固定依赖版本而改过的 setup.py），评测容器里同样有这些改动——若直接对基准提交取 diff，这些改动会混进补丁并在
// 判分时打不上。做法是准备环境时用独立索引文件把初始工作区写成一棵树，收工后同法再写一棵，取两棵树之差；
// 不动 HEAD、不动仓库自己的索引，agent 看不到痕迹。
// agent 的工作区容器无网络（docker 的 none 网络，只留本机回环）：防的是模型在运行期联网下载或外传内容——
// 曾有运行用软件包下载命令取回被修仓库的后续发布版本来对照。隔离靠机制，不靠任务说明里的一句话。
// 判分阶段的评测容器是另一条路（judgeProxy）：那里跑的是官方测试脚本、没有模型参与，两侧的网络配置不得互相复用。
// 仓库历史：官方镜像是整仓克隆再检出基准提交，/testbed/.git 里带着基准提交之后多年的全部历史——修复提交本身就在
// 容器里，翻一下提交记录就是答案，断网挡不住。环境准备时把它清掉：删全部标签与 HEAD 所在分支之外的一切引用、
// 删远端、过期 reflog、清不可达对象，只留 HEAD 可达的历史；清完自验（无标签、全部可达提交数等于 HEAD 可达数、
// 清理前取的一个后续提交对象已不存在），不过即准备失败。先清理、再建初始树。只动工作区容器：判分在由同一镜像
// 另起的干净容器里做，那边需要完整镜像，不受影响。
// 测试文件（官方测试补丁涉及的路径）判分时会先被复位再打官方补丁：经编辑工具的写入在执行端上直接拒绝，
// 经命令造成的改动在取 diff 时排除。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  containerExec,
  createContainerWorkspaceHost,
  listContainersByLabel,
  removeWorkspaceContainer,
  startWorkspaceContainer,
} from "../execution/container-host.ts";
import { withReadonlyPaths } from "../tools/workspace-host.ts";
import type { EvalInstance, EvalInstanceBudget, TaskSource } from "./task-source.ts";

// 容器内的工作区根与测试环境（官方镜像的约定）
const TESTBED_ROOT = "/testbed";
const TESTBED_PATH =
  "/opt/miniconda3/envs/testbed/bin:/opt/miniconda3/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
// 独立索引文件放在工作区之外
const SCRATCH_INDEX = "/tmp/pigeon-eval-index";
// 判分脚本约定：判分设施自身出错的退出码
const JUDGE_INFRA_EXIT_CODE = 2;
const MODEL_NAME = "pigeon";
// 外部基准的采样温度（110）：缺省固定为 0；要改必须由调用方显式给出
export const SWEBENCH_DEFAULT_TEMPERATURE = 0;

export function swebenchTemperature(requested: number | undefined): number {
  return requested ?? SWEBENCH_DEFAULT_TEMPERATURE;
}

// 工作方式指令：追加进 system prompt 的一句话，告诉模型它的工作是改仓库代码来解决用户消息里描述的问题。
// 没有它，模型会把 issue 原文当成提问来回答、不动手（实测纯 issue 原文下 12 题里 4 题 1 轮收工）。
// 措辞与公开的最简实现对齐（其 SWE-bench 配置里的同一句），只把两处指代换成本 harness 的说法：
// "the current directory" → "the repository at /testbed"，"the PR description" → "the user message"。
// 只说工作方式，不对 issue 内容做任何归纳或翻译。这句话属于被测条件——换一句分数就可能变，改它等于换条件
export const SWEBENCH_WORK_DIRECTIVE =
  "Your task is to make changes to non-test files in the repository at /testbed in order to fix the issue described in the user message, in a way that is general and consistent with the codebase.";
// 工作区容器的网络：恒为无网络，不提供开关
const WORKSPACE_NETWORK_ARGS = ["--network", "none"] as const;
// 调用方的附加参数里不得出现会打开网络或带入代理的选项。短选项 -p / -P 可与取值粘连（-p8080:80）；
// 环境变量文件的内容无从检查（可能带代理），一律不收
const NETWORK_OPENING_ARG =
  /^(--net(work)?|--add-host|--dns[a-z-]*|--publish(-all)?|--link|--expose|--env-file)(=|$)|^-[pP]/;
const PROXY_ENV_ARG = /^[a-z_]*proxy=/i;

function assertKeepsWorkspaceOffline(runArgs: readonly string[]): void {
  runArgs.forEach((arg, index) => {
    const envValue =
      arg === "-e" || arg === "--env" ? runArgs[index + 1] : arg.replace(/^(--env=|-e=?)/, "");
    const setsProxy =
      (arg === "-e" || arg === "--env" || /^(--env=|-e)/.test(arg)) &&
      PROXY_ENV_ARG.test(envValue ?? "");
    if (NETWORK_OPENING_ARG.test(arg) || setsProxy) {
      throw new Error(
        `工作区容器必须保持无网络：附加参数里不得出现 ${arg}（判分阶段的代理请用 judgeProxy，它只作用于评测容器）`
      );
    }
  });
}

export interface SwebenchSourceOptions {
  // 数据集 JSONL 文件
  datasetFile: string;
  // 只取这些实例（按给定顺序）；缺省取全部
  instanceIds?: readonly string[];
  // 判分工作目录（补丁文件、官方判分器的日志与报告落在这里）
  workDir: string;
  // 装有官方判分器的 Python 解释器
  python: string;
  // 判分脚本路径
  judgeScript: string;
  budget: EvalInstanceBudget;
  // 评测镜像的命名空间（缺省 swebench）
  namespace?: string;
  docker?: readonly string[];
  // docker run 的附加参数（内存上限等）；不得含任何会打开网络或带入代理的选项——工作区容器恒为无网络
  containerRunArgs?: readonly string[];
  // 判分超时（毫秒），缺省 40 分钟；官方判分器内部的单实例测试超时取其 3/4
  judgeTimeoutMs?: number;
  // 只给判分阶段的评测容器配的代理：http(s)://主机:端口，或 gateway:端口（判分时现取默认路由的网关，不写死）。
  // 判分跑的是官方测试脚本、没有模型参与；部分实例的官方测试要访问外网。本选项只进判据命令——
  // agent 干活的工作区容器（startWorkspaceContainer 与容器执行端）不读它，也不得复用它
  judgeProxy?: string;
}

interface SwebenchRow {
  instance_id: string;
  problem_statement: string;
  test_patch: string;
  difficulty?: string;
  repo?: string;
}

// 官方评测镜像名：<namespace>/sweb.eval.x86_64.<instance_id 小写、双下划线换成 _1776_>:latest
export function swebenchImageName(instanceId: string, namespace = "swebench"): string {
  return `${namespace}/sweb.eval.x86_64.${instanceId.toLowerCase().replace("__", "_1776_")}:latest`;
}

// 测试补丁涉及的路径（判分时会被复位）
export function testPatchPaths(testPatch: string): string[] {
  const paths = new Set<string>();
  for (const match of testPatch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    for (const file of [match[1], match[2]]) {
      if (file !== undefined && file !== "/dev/null") {
        paths.add(file);
      }
    }
  }
  return [...paths];
}

function loadRows(datasetFile: string): SwebenchRow[] {
  return readFileSync(datasetFile, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      const row = JSON.parse(line) as Partial<SwebenchRow>;
      if (
        typeof row.instance_id !== "string" ||
        typeof row.problem_statement !== "string" ||
        typeof row.test_patch !== "string"
      ) {
        throw new Error(`数据集第 ${index + 1} 行缺 instance_id / problem_statement / test_patch`);
      }
      return row as SwebenchRow;
    });
}

// 清掉基准提交之后的仓库历史并自验；末行固定形如 PRUNED tags=0 all=N head=N future=gone|none|present
const PRUNE_HISTORY_SCRIPT = [
  "# pigeon-prune-history",
  "set -e",
  // 清理前记下一个不可从 HEAD 到达的提交，清理后用它验证对象确实没了
  "future=$(git rev-list --all --not HEAD -n 1 || true)",
  "current=$(git symbolic-ref -q HEAD || true)",
  'git for-each-ref --format="%(refname)" | while read -r ref; do [ "$ref" = "$current" ] || git update-ref -d "$ref"; done',
  'git remote | while read -r remote; do git remote remove "$remote"; done',
  "rm -f .git/FETCH_HEAD .git/ORIG_HEAD",
  "git reflog expire --expire=now --expire-unreachable=now --all",
  "git -c gc.auto=0 -c pack.threads=2 -c pack.windowMemory=256m gc --prune=now --quiet",
  'state=none; if [ -n "$future" ]; then if git cat-file -e "$future" 2>/dev/null; then state=present; else state=gone; fi; fi',
  'echo "PRUNED tags=$(git tag | wc -l) all=$(git rev-list --all --count) head=$(git rev-list HEAD --count) future=$state"',
].join("\n");

// 自验：无标签、--all 可达的提交数等于 HEAD 可达数、清理前取的后续提交对象已不存在
export function historyPruneVerified(output: string): boolean {
  const match = /^PRUNED tags=(\d+) all=(\d+) head=(\d+) future=(gone|none|present)\s*$/m.exec(
    output
  );
  return (
    match !== null &&
    match[1] === "0" &&
    match[2] === match[3] &&
    Number(match[3]) > 0 &&
    match[4] !== "present"
  );
}

// 把当前工作区写成一棵树（独立索引，不动 HEAD 与仓库索引）；.gitignore 照常生效
const WRITE_TREE_SCRIPT = `set -e; export GIT_INDEX_FILE=${SCRATCH_INDEX}; rm -f "$GIT_INDEX_FILE"; git read-tree HEAD; git add -A; git write-tree`;

export function swebenchTaskSource(options: SwebenchSourceOptions): TaskSource {
  const docker = options.docker ?? ["docker"];
  const datasetFile = path.resolve(options.datasetFile);
  const workDir = path.resolve(options.workDir);
  const all = loadRows(datasetFile);
  const byId = new Map(all.map((row) => [row.instance_id, row]));
  const rows =
    options.instanceIds === undefined
      ? all
      : options.instanceIds.map((id) => {
          const row = byId.get(id);
          if (row === undefined) {
            throw new Error(`数据集里没有这个实例：${id}`);
          }
          return row;
        });
  const judgeTimeoutMs = options.judgeTimeoutMs ?? 40 * 60_000;
  assertKeepsWorkspaceOffline(options.containerRunArgs ?? []);

  const inContainer = async (
    container: string,
    script: string,
    what: string,
    timeoutMs = 300_000
  ): Promise<string> => {
    const result = await containerExec({
      container,
      docker,
      workdir: TESTBED_ROOT,
      command: ["sh", "-c", script],
      timeoutMs,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `${what}失败（退出码 ${result.exitCode}）：${result.stderr.trim().slice(-500)}`
      );
    }
    return result.stdout;
  };

  return {
    name: "swebench-verified",
    instances: (): EvalInstance[] =>
      rows.map((row) => ({
        id: row.instance_id,
        // 任务说明冻结为数据集的 issue 原文，逐字、不加任何包装：措辞是被测条件的一部分。
        // system prompt 与工具说明仍是中文，模型处在"中文指令加英文任务"的混合语境——这是本 harness 的真实特性，
        // 不用包装掩盖。"不要改测试文件"不再写进说明，由执行端的写保护与取 diff 时的排除兜住
        instructions: row.problem_statement,
        systemDirective: SWEBENCH_WORK_DIRECTIVE,
        budget: { ...options.budget },
        holdout: false,
        tags: row.repo !== undefined ? [row.repo] : [],
        ...(row.difficulty !== undefined ? { difficulty: row.difficulty } : {}),
      })),
    async prepare(instance, context) {
      const row = byId.get(instance.id);
      if (row === undefined) {
        throw new Error(`任务源里没有这个实例：${instance.id}`);
      }
      const protectedPaths = testPatchPaths(row.test_patch);
      const container = `pigeon-eval-${context.sessionId.toLowerCase()}`;
      // 宿主侧占位目录：账本与治理按它登记，工具经容器执行端读写，不经它
      const workspaceRoot = path.join(
        context.governanceRoot,
        ".pigeon",
        "container-workspaces",
        context.sessionId
      );
      mkdirSync(workspaceRoot, { recursive: true });
      await startWorkspaceContainer({
        image: swebenchImageName(instance.id, options.namespace),
        name: container,
        docker,
        runArgs: [
          ...WORKSPACE_NETWORK_ARGS,
          "--label",
          `pigeon.eval-root=${context.governanceRoot}`,
          ...(options.containerRunArgs ?? []),
        ],
      });
      let released = false;
      const release = async (): Promise<void> => {
        if (!released) {
          released = true;
          await removeWorkspaceContainer(container, docker);
        }
      };
      let baselineTree: string;
      try {
        // 先清历史、再建初始树
        const pruned = await inContainer(container, PRUNE_HISTORY_SCRIPT, "清理仓库历史", 900_000);
        if (!historyPruneVerified(pruned)) {
          throw new Error(
            `历史清理自验未通过：${pruned.trim().split("\n").at(-1) ?? "（无输出）"}`
          );
        }
        baselineTree = (await inContainer(container, WRITE_TREE_SCRIPT, "建立初始树")).trim();
      } catch (error) {
        await release();
        throw error;
      }
      const predictionsFile = path.join(workDir, "predictions", `${context.sessionId}.json`);
      const judgeCommand = [
        options.python,
        path.resolve(options.judgeScript),
        "--dataset",
        datasetFile,
        "--instance",
        instance.id,
        "--predictions",
        predictionsFile,
        "--run-id",
        context.sessionId,
        "--work-dir",
        workDir,
        "--namespace",
        options.namespace ?? "swebench",
        "--model-name",
        MODEL_NAME,
        "--test-timeout",
        String(Math.floor((judgeTimeoutMs * 3) / 4 / 1000)),
        ...(options.judgeProxy !== undefined ? ["--proxy", options.judgeProxy] : []),
      ];
      return {
        workspaceRoot,
        host: withReadonlyPaths(
          createContainerWorkspaceHost({
            container,
            root: TESTBED_ROOT,
            docker,
            env: { PATH: TESTBED_PATH },
          }),
          protectedPaths,
          "这是判分用的测试文件，判分时会被复位成官方版本，改了不作数；请只改源码"
        ),
        judgeCommandHint: judgeCommand,
        async judge() {
          const finalTree = (await inContainer(container, WRITE_TREE_SCRIPT, "取收工树")).trim();
          const excludes = protectedPaths
            .map((file) => `':(exclude,literal)${file.replaceAll("'", "'\\''")}'`)
            .join(" ");
          // 相对仓库根、相对初始树；排除测试文件（经命令造成的改动也进不了补丁）
          const patch = await inContainer(
            container,
            `git diff --no-color --binary ${baselineTree} ${finalTree} -- . ${excludes}`,
            "取 diff "
          );
          mkdirSync(path.dirname(predictionsFile), { recursive: true });
          writeFileSync(
            predictionsFile,
            JSON.stringify([
              { instance_id: instance.id, model_name_or_path: MODEL_NAME, model_patch: patch },
            ])
          );
          // 判分另起评测容器：先放掉工作区容器腾出内存
          await release();
          return {
            command: judgeCommand,
            cwd: workDir,
            timeoutMs: judgeTimeoutMs,
            assets: [predictionsFile],
            undeterminedExitCodes: [JUDGE_INFRA_EXIT_CODE],
          };
        },
        release,
      };
    },
    // 续跑前清理上次进程死于中途留下的工作区容器（按输出目录标签认领，不碰别的容器）
    async cleanupStale(governanceRoot) {
      for (const name of await listContainersByLabel(
        `pigeon.eval-root=${governanceRoot}`,
        docker
      )) {
        await removeWorkspaceContainer(name, docker);
      }
    },
  };
}
