# 沙箱与编排便利性（决策 278、279、280）实现审计

- 基线：formal-v2 的 165432c
- 分支：p1a-snapshot-cache
- 代码提交：61553e6（工作目录快照与 worker 改动叠加）、862ca0b（worker 从快照开工、take_worker）、cdef03f（沙箱从快照开工、共用下载缓存）；本审计另起一个提交
- 范围：共用的工作目录快照；沙箱默认带入未提交的改动（278）；本机 worker 从快照开工、只收 worker 自己的改动（279）；沙箱共用下载缓存（280）。沙箱里不派 worker 的现状不变。

## 一、共用的工作目录快照（`src/execution/workdir-snapshot.ts`）

- `snapshotWorkdir({ repoRoot, ref })` 把工作目录写成一个以 HEAD 为父的提交：受跟踪文件的当前内容，加上未跟踪且未被 `.gitignore` 忽略的新文件；删除的受跟踪文件在快照里即为删除。
- 做法沿用 078 的临时索引：复制用户索引为临时 `GIT_INDEX_FILE`，并保留原索引文件的时间戳；然后 `add -A`，再把治理目录 `.pigeon` 在临时索引里还原成 HEAD 的样子（`reset -q -- .pigeon`），接着 `write-tree`、`commit-tree -p HEAD`（作者固定为 pigeon），最后 `update-ref` 挂到调用方给的引用上。引用必须在 `refs/pigeon/` 下，否则报错。
- 与 078 的差别有两处。其一，078 用 `rm --cached` 把 `.pigeon` 从临时索引摘掉，受跟踪的 `.pigeon` 文件会在快照里显得被删；本段改为还原到 HEAD 的样子。其二，保留原索引的时间戳：复制出的索引若带新时间戳，git 对"与索引写入同一刻改过的文件"的重读保护会失效，同一秒内改过且大小不变的文件会被当成没改而漏出快照。
- 工作目录的树与 HEAD 的树相同时，不建提交、不挂引用，起点即 HEAD；同名引用若是先前残留的，一并删除。
- 返回起点提交、HEAD、是否另建了快照，以及相对 HEAD 带入的文件清单（`diff-tree --no-renames`，含新建与删除的文件）。
- 用户的工作目录、暂存区、当前分支与 HEAD 一律不碰。git 经参数数组直接调用，不经 shell。
- 不是 git 工作区、仓库还没有提交、引用不在 `refs/pigeon/` 下，均明确报错。
- 引用：沙箱用 `refs/pigeon/sandbox-start/<sessionId>`，worker 用 `refs/pigeon/worker-start/<worker 名>`；清理时机见二、三两节。

## 二、沙箱默认带入未提交的改动（278，`src/execution/sandbox.ts`）

- 开工：镜像先就位（构建或拉取），然后拍快照，这样镜像失败时不会留下引用。有快照时，从快照引用打 git bundle 送进容器，容器起点为快照提交，并提示一行"已带入 N 个未提交的文件（含新建文件）"；没有未提交的改动时从 HEAD 开工，不提示。
- 就绪提示在带了快照时写明"从 <分支> 加未提交改动的快照 <提交号> 起步"，并写明挂了共用下载缓存卷。
- 启动参数 `--sandbox-from-head`：只从当前分支的最新提交开工。它是无取值开关，只配合 `--sandbox` 用，单给即报错；有未提交改动时提示一行"按参数不带进沙箱"。参数写进了 `pigeon run` 的用法行、终端界面的用法行，以及命令行对话与续跑的参数清单。
- 续跑：照旧从该沙箱交回过的分支开工，不受快照影响；开工时顺手删除残留的开工快照引用。
- 交回：分支为快照提交加 agent 的提交。交回的 bundle 以起点为界，而起点就是快照提交，宿主仓库本就有它。交回结果带 `snapshotCommit`，`pigeon run --json` 的 `sandbox` 字段随之带上。交回提示在带了快照时加一句："分支第一条提交（<提交号>）是开箱时的未提交改动；合并前先把本地这份未提交改动收起（stash 或丢弃）"。
- 引用清理：
  - 交回成功、删除容器时删除开工快照引用，此时快照提交已由交回的分支引用。
  - 开工中途失败（打包失败、同名容器已存在、容器起不来、镜像缺 git、建仓库失败）与不交回直接丢弃容器时，一并删除引用。
  - 交回失败时，容器与引用都保留。
  - `pigeon sandbox clean` 删除残留容器时，按容器标签里记下的宿主仓库路径，连同该沙箱的开工快照引用一并删除。

## 三、本机 worker 从快照开工，只收 worker 自己的改动（279）

### 起点

- 编排层 `src/orchestration/workers.ts` 新增起点提供者 `startPoint`，由装配根注入，编排层不触达执行层。派出时先拍快照；拍不成即不派，没有派出记录，也不建工作区与运行面，错误写明原因。
- 工作区形状记下 `baseCommit`（起点提交），它写进派出记录，工作树以它为起点建出。状态与收尾结果带 `start`：起点提交、是否另拍了快照、带入的文件。
- 装配 `createSessionWorkers`（`src/application/workers.ts`）注入 `snapshotWorkdir`，终端界面的 `/spawn` 与 `spawn_worker`、`pigeon run` 的 `spawn_worker` 共用。引用为 `refs/pigeon/worker-start/<worker 名>`。
- `deleteBranch`（`src/orchestration/worktree.ts`）删除 worker 分支时一并删除同名的起点引用；引用不存在也不报错。

### 返回文字

- `spawn_worker`（按 271 的修订）：原定稿文字不变，另起一行写起点与取用方式，额度用完的文字不加这一行。
  - 带快照：`起点：快照 <12 位提交号>（含派出时 N 个未提交的文件）；要把它的改动叠进你的工作目录，调用 take_worker（worker=<名>）。`
  - 没有未提交文件：`起点：提交 <12 位提交号>（派出时没有未提交的文件）；要把它的改动叠进你的工作目录，调用 take_worker（worker=<名>）。`
- `/spawn` 的收尾摘要加同一行，取用方式写作"用 /take <名>"。
- `spawn_worker` 工具说明第二段的定稿原文（"worker 从当前提交开工……看不到你还没提交的改动……要它接着你的改动干，先提交。"）本段未改，与现在的起点行为不一致。

### 取用入口：take_worker 工具与 /take 命令（`src/application/take-worker-tool.ts`）

- 入口经裁决定为 agent 用的 `take_worker` 工具，加上终端界面的 `/take <worker 名>`，两者返回同一套文字。
- 工具说明（定稿原文）：
  - 把一个已收尾的 worker 自己的改动叠进你的工作目录。worker 从派出时拍的快照开工；本工具只取快照之后它改过的文件，以快照里的版本为共同祖先逐文件三方合并，写进你的工作目录。
  - 只写入 worker 改过的文件，它没碰的文件一律不动；不删除、不回退你工作目录里的任何文件。worker 删除的文件不自动删，只在结果里列出，由你决定删不删。
  - 叠不上的文件（你在同一处也改了）不写入，列在冲突清单里；worker 的分支与工作树原样保留，查看它在这些文件上的改动：git -C <工作树路径> diff <快照号> -- <文件>。叠加没有撤销：叠之前先看清交回的摘要与改动文件。
  - 多个 worker 的改动按需要逐个取，前一个取完再取下一个；后取的若和先取的改了同一处，会列为冲突。
  - 返回三份清单：已叠入的文件、有冲突未写入的文件、worker 删除的文件。
- 参数 `worker` 的说明：worker 的名字，即 spawn_worker 交回结果里的名字（分支 pigeon/<名>）。
- 返回文字（定稿原文）：
  - 叠入：`已把 worker X 的改动叠进工作目录。叠入的文件（N）：…。冲突未写入的文件（M）：…`；有冲突时接着写 `；查看 worker 在这些文件上的改动：git -C <工作树路径> diff <快照号> -- <文件>`；最后是 `。worker 删除的文件（K，未删）：…。`
  - 没改动：`worker X 相对起点快照没有改动，工作目录未变。`
  - 没收尾（在跑或排队）：`worker X 还没收尾，等它交回后再取。`
  - 不存在：`没有名为 X 的 worker；用 spawn_worker 交回结果里的名字。`
  - 工作树已清理：`worker X 的工作树已清理，改动无法取用。`
  - 派出记录里没有起点：`worker X 没有记录起点快照，改动无法取用。`
  - 失败：`取用 worker X 的改动失败：原因。已叠入的文件（N）：…。`
  - 没有装配编排器：按失败的文字回话，原因写明没有装配编排器。
- 注册：写档（写主工作目录，按写操作审批），路径限定在工作区，串行执行。它与 `spawn_worker` 共用同一个工具槽与注册范围：只给终端界面与 `pigeon run` 的主 agent；命令行对话、worker 自己、沙箱与跑批器各条件都不注册。跑批器各条件照 265 不注册；身份头 `agents.pigeon` 新增 `takeWorker`，记实际生效值 false，与 `spawnWorkers` 同一个值。
- 终端界面：`/take` 在沙箱里给出不支持的原因（与 `/spawn` 同一句，句中列出 `/take`）；未知命令提示里列出 `/take <worker>`；没给名字时提示用法。
- 工作树何时被清理：生产代码里没有调用 `removeWorktree` 或 `deleteBranch` 的地方，Pigeon 不自动清理 worker 的工作树与分支。工作树一直在，直到人手动 `git worktree remove`（或删掉 `.pigeon/worktrees` 下的目录后执行 `git worktree prune`）；取用依赖它还在，已清理即返回上面那一句。同理，`refs/pigeon/worker-start/<名>` 只在经 `deleteBranch` 删除分支时删除，日常使用里会一直留着；同名 worker 再次派出时覆盖它。

### 叠加与硬性规则（`src/execution/worker-overlay.ts`）

worker 的改动取它工作树的当前内容（可能未提交）：用与快照同一种临时索引写成树，再以 `diff-tree --no-renames` 与起点快照比对，`.pigeon` 下的路径跳过。三方的内容都取 git 里经清理过滤后的样子，写回时经 `cat-file --filters` 还原成工作树形式。

| 硬性规则 | 实现 | 专门用例 |
|---|---|---|
| 只写入 worker 改过的文件，没碰的文件一律不动 | 只遍历"起点快照 → worker 树"的改动集合，别的路径不读不写 | worker-overlay.test.ts「硬性规则：只写入 worker 改过的文件，worker 没碰的文件一律不动（worker 工作树里被忽略的文件也不带）」 |
| 主工作目录有未提交改动时仍能叠 | 不读写主仓库的暂存区，逐文件处理：主与 worker 一致即不写；主的版本等于共同祖先即直接取 worker 的版本；否则用 `git merge-file -p` 三方合并。不用会因主工作目录不干净而整体失败的合并命令 | 「硬性规则：主工作目录有未提交改动（含已暂存的）时仍能叠——同一文件不同处的改动三方合并」（核对暂存区原样） |
| 叠不上即列出冲突，不写入冲突部分，保留 worker 分支 | `merge-file` 的退出码为冲突数（1 到 127）即列为冲突、不写；双方各自新建了内容不同的同名文件、二进制文件双方都改、路径在主工作目录里是目录或符号链接、符号链接或子模块条目，均列为冲突；worker 工作树与分支不动 | 「硬性规则：叠不上时列出冲突文件、不写入冲突的那部分；其余文件照叠；worker 分支与工作树原样保留」；take-worker-tool.test.ts 的冲突用例 |
| worker 删除的文件不自动删 | 删除条目只进 `deletedByWorker` 清单，不动主工作目录与暂存区 | 「硬性规则：worker 删除的文件不自动删，只在结果里列出——主工作目录里没动过的与快照后又改过的都原样保留」 |
| 不回退主工作目录的任何文件 | 主工作目录已删掉、worker 改了的文件不写回，列为冲突 | 「硬性规则：不回退主工作目录——主已删掉的文件 worker 改了不写回（列为冲突）；主没改的文件直接取 worker 版本（含二进制）」 |
| `.gitignore` 内的文件不带进快照 | 快照的 `add -A` 排除被忽略的文件；worker 工作树里被忽略的文件同样不在 worker 的树里 | workdir-snapshot.test.ts「硬性规则：.gitignore 里的文件不带进快照」；沙箱用例核对被忽略的文件不进容器 |
| 不设撤销 | 没有撤销入口；中途出错时抛出带已写入部分的错误，失败文字列出已叠入的文件 | — |

## 四、沙箱共用下载缓存（280）

- Docker 卷 `pigeon-sandbox-cache`，挂到容器的 `/pigeon-cache`，所有项目与沙箱共用。`docker run -v` 在卷不存在时自动建立。断网档照样挂，缓存里有的包能装。
- 各包管理器的缓存经 `docker run -e` 指到卷里各自的子目录，之后每次在容器里执行都带着：

| 包管理器 | 环境变量 | 取值 |
|---|---|---|
| npm | `npm_config_cache` | `/pigeon-cache/npm` |
| pnpm | `npm_config_store_dir` | `/pigeon-cache/pnpm/store` |
| yarn | `YARN_CACHE_FOLDER`、`YARN_GLOBAL_FOLDER` | `/pigeon-cache/yarn/cache`、`/pigeon-cache/yarn/berry` |
| pip | `PIP_CACHE_DIR` | `/pigeon-cache/pip` |
| uv | `UV_CACHE_DIR` | `/pigeon-cache/uv` |
| cargo（registry 与 git 缓存） | `CARGO_HOME` | `/pigeon-cache/cargo` |
| go（模块与构建缓存） | `GOMODCACHE`、`GOCACHE` | `/pigeon-cache/go/mod`、`/pigeon-cache/go/build` |

- 目录权限：容器起来后，以 root 在同一步里建工作区目录与卷下各子目录；卷根的属主不是运行用户时，整卷交给运行用户。新建的卷由 root 所有，以别的 uid 运行过的卷也会改过来。
- `pigeon sandbox cache` 从 `docker system df -v` 的卷清单里取出该卷的占用与正在使用它的容器数；卷不存在时说明尚未建立。
- `pigeon sandbox clear-cache` 删除整个卷，下次开沙箱自动重建；卷不存在时说明本就是空的；有容器在用时报错说明，不强删。
- 两条命令与 `list`、`clean` 并列，已写进顶层帮助与用法行。
- 不缓存装好的依赖目录，不做按项目的环境快照。
- 测试用的假 docker 夹具（`sandbox-docker-fixtures.ts`）加上了卷：`run -v` 建卷，`volume rm` 在有容器挂着时报 in use，`system df` 按真 docker 的字段名输出。

## 五、测试

新增测试文件与用例数：

| 文件 | 用例数 |
|---|---|
| `src/execution/workdir-snapshot.test.ts` | 8 |
| `src/execution/worker-overlay.test.ts` | 7 |
| `src/application/take-worker-tool.test.ts` | 4 |
| `src/application/workers-start.test.ts` | 3 |

在既有文件里新增的用例：

| 文件 | 新增用例 | 内容 |
|---|---|---|
| `src/execution/sandbox.test.ts` | 4 | 带入快照与交回分支结构、fromHead、没有未提交改动、挂缓存卷，并改写首个用例 |
| `src/application/sandbox-session.test.ts` | 1 | cache 与 clear-cache 命令 |
| `src/application/launch-flags-sandbox.test.ts` | 1 | `--sandbox-from-head` |
| `src/orchestration/workers.test.ts` | 3 | 起点提供者在场、拍不成不派、没有提供者 |
| `src/orchestration/worktree.test.ts` | 1 | 起点引用随分支删除 |

- 真容器用例 `sandbox-docker.test.ts` 加上了核对：未提交改动与新建文件进了容器、缓存卷已挂且子目录可写、交回分支为"agent 提交 → 快照 → HEAD"、宿主的未提交改动原样。缓存卷用测试专用的名字，用完删除。
- 既有测试的调整：
  - `spawn_worker` 定稿文字的比对（spawn-worker-headless、spawn-worker-cli）去掉末尾的起点行，起点行的格式另在 workers-start.test.ts 专门核对。
  - 用假 docker 的沙箱测试给出缓存挂载点。
  - 终端界面的 worker 与沙箱命令测试加上 `/take`。
  - 实验身份头测试加上 `takeWorker`。
  - 派 worker 注册测试的替身编排器加上 `status`。

## 六、变异反向验证

每次只植入一处，跑相关的测试文件，记下变红的用例；还原后对该文件执行 `git diff --quiet`，核对逐字一致。以下在 cdef03f 上运行，基线全过。7 次变异均变红，7 次还原均逐字一致。

| 编号 | 植入处 | 变红的用例 |
|---|---|---|
| M0 | 快照复制索引后不再保留原索引的时间戳 | 同一秒内改过且大小不变的文件也带进快照（1 条） |
| M1 | 快照漏带新建文件：临时索引上 `add -A` 改为 `add -u` | 快照含改动与新建文件；.gitignore 不带；沙箱带入未提交改动；叠加只写 worker 改过的文件；叠加冲突；目录或符号链接冲突（6 条） |
| M2 | 叠加误改 worker 没碰的文件：比对的共同祖先由起点快照换成主仓库 HEAD | 叠加的 5 条硬性规则用例、worker 没改动、take_worker 叠入与各情形（8 条） |
| M3 | 冲突时仍写入：双方各自新建的内容不同的同名文件写入 worker 版本 | 叠不上时列出冲突（1 条） |
| M3b | 冲突时仍写入：三方合并有冲突时写入 worker 版本 | 叠不上时列出冲突；take_worker 冲突用例（2 条） |
| M5 | worker 删除的文件被自动删 | worker 删除的文件不自动删；只写 worker 改过的文件；take_worker 叠入（3 条） |
| M4 | 沙箱不挂缓存卷：`docker run` 去掉卷与环境变量 | 挂共用下载缓存卷（假 docker）；真容器用例（2 条） |

## 七、verify 的实际运行情况

- 全在服务器上运行：8 vCPU、30 GiB 内存、Node 24.12.0、Docker 29.8.1。
- 提交 cdef03f，`npm run verify` 的四步用一条前台 ssh 命令同步跑完。当时服务器上没有别的测试在跑，并发取 6。
- 结果：
  - lint：退出码 0，没有提示。
  - check：退出码 0。
  - test：1208 条，1206 过、0 失败、2 跳过，跳过的是两条只在 Windows 上运行的 `.cmd` 用例。真容器用例实际运行，用的是服务器上已有的通用镜像 `pigeon-sandbox:30145c7527e6`（只读使用）。
  - deps：没有违规。
- 跑完后没有残留的沙箱容器，也没有残留的 pigeon 卷。
- 本审计提交只增加这一个 Markdown 文件。

## 八、真容器冒烟

在服务器上用假模型运行，不调用真实模型接口，镜像为 `pigeon-sandbox:30145c7527e6`，提交 cdef03f。

1. 小仓库带未提交的改动：`a.txt` 改过、新建 `new.txt`、被忽略的 `debug.log`。执行 `pigeon run --sandbox`：
   - 提示"已带入 2 个未提交的文件（含新建文件）"。
   - 容器里看到的 `a.txt` 为改后内容，`new.txt` 在，`debug.log` 不在；`npm_config_cache` 指向 `/pigeon-cache/npm`；`npm install left-pad@1.3.0` 成功，缓存目录有了内容。
   - 交回分支的历史为"agent 的提交 → 快照提交 → 原 HEAD"，快照提交里 `a.txt` 为改后内容、含 `new.txt`、不含 `debug.log`。
   - 交回提示带那句合并前先收起本地未提交改动的话。
   - 宿主当前分支、`a.txt` 与 `new.txt` 原样，开工快照引用已删。
2. 第二次在同一仓库执行 `pigeon run --sandbox --sandbox-network off`，在断网的容器里执行 `npm install --offline left-pad@1.3.0`，退出码 0，外网请求失败，说明包是从共用缓存卷装的。
3. `pigeon sandbox cache` 显示卷的占用。收尾没有残留的沙箱容器，`pigeon sandbox clear-cache` 删除了本次测试建立的卷，之后没有 pigeon 卷。
4. 在中间提交上的第一次冒烟里，与提交在同一秒内改过、大小不变的 `a.txt` 没有进入快照（容器里是改前内容）。据此改为保留原索引的时间戳，并加了用例与变异 M0。上面是 cdef03f 上的结果。
