// 工作区容器的共用约束：外部基准（swebench-source.ts）与延续式跑批（stream-workspace.ts）走同一套（决策 096），
// 断网（104）与清未来历史（109）只此一份实现。

// 工作区容器的网络：恒为无网络，不提供开关
export const WORKSPACE_NETWORK_ARGS = ["--network", "none"] as const;
// 调用方的附加参数里不得出现会打开网络或带入代理的选项。短选项 -p / -P 可与取值粘连（-p8080:80）；
// 环境变量文件的内容无从检查（可能带代理），一律不收
const NETWORK_OPENING_ARG =
  /^(--net(work)?|--add-host|--dns[a-z-]*|--publish(-all)?|--link|--expose|--env-file)(=|$)|^-[pP]/;
const PROXY_ENV_ARG = /^[a-z_]*proxy=/i;

export function assertKeepsWorkspaceOffline(runArgs: readonly string[]): void {
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

// 清掉基准提交之后的仓库历史并自验；末行固定形如 PRUNED tags=0 all=N head=N future=gone|none|present
export const PRUNE_HISTORY_SCRIPT = [
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
