# 日常沙箱（决策 237、245–248）实现审计

- 基线：formal-v2 的 dfb1804
- 分支：sandbox-daily
- 范围：日常入口（终端界面、命令行对话与续跑、`pigeon run`）可选在一次性 Docker 容器里工作；跑批器的容器逻辑不动。

## 一、容器生命周期（执行层 `src/execution/sandbox.ts`）

- **开工**：先确认 Docker 可用（`docker version` 取得到守护进程版本），再确认项目是至少有一个提交的 git 仓库；两者不满足即报错说明原因，不起容器。起点为当前分支的 HEAD：宿主上 `git bundle create <文件> HEAD`，经 `docker exec -i` 的标准输入送进容器，在容器工作区根（`/workspace`）里 `git init`、从 bundle 取出起点并检出到分支 `pigeon/sandbox-<会话号>`，核对容器里的 HEAD 等于起点提交。治理根位于仓库子目录时，容器里的工作区根对应到同一子目录。
- **未提交的改动**：宿主 `git status --porcelain` 非空时提示一行"这些改动不会带进沙箱"，并写明起点分支与提交。
- **非 root 运行**：镜像配置的用户为空或 root 时，`docker run` 加 `--user 1000:1000 -e HOME=/tmp`；工作区目录由 root（`docker exec -u 0`）建好并交给运行用户。通用镜像本身以用户 pigeon（uid 1000）运行，不另加参数。
- **标签**：容器名 `pigeon-sandbox-<会话号>`，标签 `pigeon.sandbox=<会话号>`，另记 `pigeon.sandbox.pid`（起它的进程号）、`pigeon.sandbox.host`（主机名）、`pigeon.sandbox.repo`（宿主仓库路径），用于识别残留。
- **镜像须有 git**：容器起来后先执行 `git --version`，失败即删除容器并报错，说明沙箱要用 git 建仓库与交回，建议换镜像或回到通用镜像。
- **中途失败**：起容器之后任一步失败（缺 git、建仓库失败），先删除容器再上抛。同名容器已存在（上次异常退出留下）时不删除，报错并给出自取与清理办法。
- **工具**：三个工作区工具经容器执行端（`container-host.ts`，未改动其行为）在容器里读写与执行。

## 二、交回（245）

- 容器里：`git add -A`，有暂存改动即提交（不执行仓库钩子、不签名，提交身份 `pigeon <pigeon@sandbox.invalid>`），`refs/heads/pigeon/sandbox-<会话号>` 指向 HEAD。
- 宿主已有该提交（没有新提交、或容器里退回到旧提交）时直接在宿主建分支；否则容器里 `git bundle create <文件> refs/heads/<分支> ^<起点>`，经标准输出取出，宿主 `git fetch -q <文件> +refs/heads/<分支>:refs/heads/<分支>`。
- 只更新沙箱分支这一条引用，不动当前分支、工作目录与未提交的改动；不经网络，不推送。宿主当前检出的恰是沙箱分支时拒绝交回，不改动它。
- 时机：会话结束时自动交回一次，交回后删除容器；会话中 `/export` 手动交回（命令行对话与终端界面），可多次，每次在上次之上前进；`pigeon run` 在返回前交回。交回失败时保留容器并说明改动还在里面。
- 交回后写明分支名与查看命令，如 `git diff main..pigeon/sandbox-<会话号>`；没有改动时写明分支指向起点。`pigeon run --json` 的结果行带 `sandbox` 字段（分支、提交、是否有改动、查看命令），提示行写标准错误。

## 三、联网（246）

- 启动参数 `--sandbox-network on|off`，缺省 `on`（`docker run` 不带网络参数）；`off` 带 `--network none`。
- 断网参数与跑批器工作区容器同一份：`NO_NETWORK_ARGS` 定义移到执行层 `container-host.ts`，`src/eval/container-workspace.ts` 的 `WORKSPACE_NETWORK_ARGS` 改为引用它（取值不变，跑批器照旧断网；执行层不得依赖 eval 层）。
- 取值是档位名，以后加"只放行包管理源"一档只需新增一个取值，用法不变。

## 四、镜像与构建参数（247，`src/execution/sandbox-image.ts`、`docker/sandbox/Dockerfile`）

- 通用镜像：`docker/sandbox/Dockerfile`，底镜像 `ubuntu:24.04`，装 git、ca-certificates、curl、wget、openssh-client、python3（含 pip、venv、python-is-python3）、nodejs、npm、ripgrep、fd-find、jq、tree、less、file、patch、procps、unzip、zip、xz-utils、build-essential；删除镜像自带的 ubuntu 用户，建 uid 1000 的 pigeon 用户，`USER pigeon`，`WORKDIR /workspace`；设 `PIP_BREAK_SYSTEM_PACKAGES=1`（容器一次性，允许 pip 直接装进系统环境）。
- 标签 `pigeon-sandbox:<哈希>`，哈希取 Dockerfile 内容与底镜像名（前 12 位）；本地已有同标签即直接用，没有才构建。软件源只影响下载来源，不进标签。
- 构建参数（环境变量，或 `.pigeon/sandbox.json` 的 `build` 段，后者优先）：`PIGEON_SANDBOX_BASE_IMAGE`/`baseImage` → `BASE_IMAGE`；`PIGEON_SANDBOX_APT_MIRROR`/`aptMirror` → `APT_MIRROR`（替换 ubuntu 官方源地址）；`PIGEON_SANDBOX_PIP_INDEX`/`pipIndex` → `PIP_INDEX_URL`（写进 `/etc/pip.conf`）；`PIGEON_SANDBOX_NPM_REGISTRY`/`npmRegistry` → `NPM_REGISTRY`（写进 npm 全局配置）。构建失败时报错带输出末尾 15 行，并列出以上全部参数。
- 项目配置 `.pigeon/sandbox.json`：`image`（任一镜像名，本地没有即先拉取）或 `dockerfile`（相对治理根，可配 `context`；标签 `pigeon-sandbox-project:<内容哈希>`）二选一；未知字段、类型不对、两者同给、`context` 单给一律报错。

## 五、审批（248）

- `--sandbox` 缺省把审批档设为全部放行（复用 yolo）；`--sandbox-approval prompt` 改回逐条询问，另给 `--yolo` 仍放行。解析在 `launch-flags.ts`，各入口共用。
- 逐条询问要在注入执行端时接交互审批。装配层原先因"按目录限定的放权以宿主路径判定、对容器工作区会静默失配"一律拒绝这一组合；现新增装配参数 `pathScopedGrants: false`：沙箱会话照常接交互审批，会话放权存储不建目录限定的放权（抛 `PathScopedGrantUnsupportedError`），命令行与终端界面的审批在 `[d]` 时说明原因并按批准一次处理，`[a]`（工具级、精确命令）照常。未新增审批机制；带 `pathPrefix` 的固化规则在容器工作区下照旧拒绝装配。

## 六、入口参数

- 终端界面、命令行对话、`pigeon resume`、`pigeon run` 都接受 `--sandbox`、`--sandbox-network on|off`、`--sandbox-approval yolo|prompt`；沙箱参数不配 `--sandbox` 即报错，不接受沙箱的入口把它们当未知参数。`--sandbox` 加入无取值开关名单（续跑与 `run` 的参数切分不吞下一个参数）。
- 新增 `pigeon sandbox list` 与 `pigeon sandbox clean`。
- 入口接线在 `src/application/sandbox-session.ts`（Actor 不直连执行层）。

## 七、护栏与续跑

- `headless-core.ts`：注入执行端时不再拒绝会话验证命令；收尾验证经执行端在容器里执行（与回炉的验证同一路径）。失败自动分叉重试与分支会话仍在装配前拒绝，报错写明原因（分叉要在宿主的 git 工作区上打快照、到独立工作树里续跑）。
- `session-runtime.ts`：注入执行端时不在宿主上打快照，验证命令经执行端执行，开失败自动分叉重试即报错。
- 入口层：`--sandbox` 与 `--retry-on-fail` 同给时在起容器之前报错；命令行对话里的 `/fork` 与终端界面的 `/fork`、`/spawn`、`/cancel`、`/workers`、`/resume` 在沙箱里给出不支持的原因（worker 在宿主的 git 工作树里干活，会越出沙箱；`/resume` 换绑要另开容器，改用 `pigeon resume <会话号> --sandbox`）。终端界面在沙箱里不挂 worker 编排器与换绑入口。
- 续跑：`pigeon resume <会话号> --sandbox` 从该会话交回的 `pigeon/sandbox-<会话号>` 新开容器，起点为该分支的最新提交；分支不存在即报错说明。续跑后的交回在同一分支上前进。

## 八、残留处理

- 残留判定：容器已停；或容器由本机起、起它的进程已不在（`process.kill(pid, 0)`）。别的主机起的容器无从判断，不算残留。
- 开沙箱时列出残留（容器名与会话号），提示里面没交回的改动可用 `docker exec` 自取，清理命令为 `pigeon sandbox clean`；不自动删除。
- `pigeon sandbox clean` 只删残留，在用的不动；`pigeon sandbox list` 只列出。

## 九、记忆与会话存储

会话文件（`.pigeon/sessions`）、`.pigeon/learned`、放权与验证配置都在宿主的治理根，不进容器；`read_file`、`edit_file`、`run_command` 经执行端读写容器里的工作区。MCP server 仍在宿主上按治理根启动，本段未改变其行为。

## 十、服务器上使用

仓库根新增 `README.md`，含"日常沙箱"与"在服务器上用 tmux 挂着"两节：`tmux new -s pigeon` 起会话、`Ctrl-b d` 脱离、`tmux attach -t pigeon` 接回；交回的分支经 SSH `git fetch` 或 bundle 拷回本机。

## 十一、测试与变异

新增测试文件：`src/execution/sandbox.test.ts`（9）、`src/execution/sandbox-image.test.ts`（4）、`src/execution/sandbox-docker.test.ts`（2，真 Docker，缺 Docker 或镜像时跳过）、`src/application/sandbox-session.test.ts`（3）、`src/application/launch-flags-sandbox.test.ts`（4）、`src/tui/sandbox-commands.test.ts`（2）；改写 `src/application/headless-container-guard.test.ts`（会话验证命令由"拒绝"改为"经执行端执行"，验证命令检查只在执行端一侧存在的文件）。假 docker 夹具 `src/execution/sandbox-docker-fixtures.ts` 记录 run 参数、标签与容器状态，exec 在本机目录里用真 git 执行。

真容器用例在服务器上运行：busybox（无 git）验证开工报错并删除容器；带 git 的镜像（服务器已载入的 `pigeon-stream-pigeon:v4`）验证 `--network none` 生效（`HostConfig.NetworkMode` 为 `none`）、缺省联网、容器内 `id -u` 非 0、改动交回成宿主分支、容器删除。

变异反向验证：每次只植入一处，跑上列 6 个沙箱相关测试文件（基线 21 个用例全过），记下变红的用例，还原后 `git diff --quiet` 核对逐字一致（12 次均一致）。

| 编号 | 植入处 | 变红的用例 |
|---|---|---|
| M1 | 交回的 fetch 改为更新宿主当前分支（`--update-head-ok`） | run 沙箱全流程；真容器交回；开沙箱与交回不动当前分支；多次交回；续跑（5 条） |
| M2 | 分支名去掉会话号 | run 沙箱全流程；开沙箱与交回；多次交回；续跑；宿主检出沙箱分支时拒绝交回（5 条） |
| M3 | 断网档不带 `--network none` | 真容器断网与联网；假 docker 联网档位（2 条） |
| M4 | `--sandbox` 缺省改为断网 | `--sandbox` 缺省联网、全部放行（1 条） |
| M5 | 去掉镜像缺 git 的检查 | 真容器 busybox 缺 git；假 docker 缺 git（2 条） |
| M6 | 沙箱缺省不放行 | `--sandbox` 缺省联网、全部放行（1 条） |
| M7 | 沙箱恒放行（参数改不回询问） | `--sandbox-approval prompt` 改回逐条询问（1 条） |
| M8 | 收尾验证不经执行端 | 执行端护栏与验证经执行端；run 沙箱全流程（2 条） |
| M9 | 入口不拒绝沙箱与分叉重试同开 | 沙箱里开失败自动分叉重试在起容器前报错（1 条） |
| M10 | 续跑从宿主当前 HEAD 起步 | 续跑从交回的分支起步（1 条） |
| M11 | 残留只认已停容器 | 残留容器被识别（1 条） |
| M12 | 终端界面沙箱里不拦 `/fork` | 沙箱会话的不支持命令说明（1 条） |

## 十二、服务器上的镜像构建与冒烟

- 机器：阿里云实例，8 vCPU、31 GB 内存，Docker 已装。
- 通用镜像经 `ensureSandboxImage`（缺省参数，未设软件源）构建成功：`pigeon-sandbox:f434f842d1cd`，用时 216 秒，镜像 1.03 GB。底镜像 `ubuntu:24.04` 与 apt 官方源在该实例上可直接拉取。镜像保留。
- 冒烟（假模型，不调用真实模型接口；小仓库、宿主有未提交改动）：
  - `pigeon run --sandbox --verify-command "test -f smoke.txt" --json`：未提交改动提示出现；容器内用户 `pigeon`，Python 3.12.3、Node v18.19.1、ripgrep 14.1.0、git 2.43.0；联网档访问镜像站得到 HTTP 301；验证在容器里判 pass；交回分支含 agent 写的文件；宿主工作区的未提交改动与当前分支不变，宿主无 agent 写的文件。
  - 命令行对话 `--sandbox --sandbox-network off`：断网档访问镜像站失败；`/export` 交回成分支；`/fork` 给出不支持的原因；退出时自动交回一次。
  - `pigeon resume <会话号> --sandbox`：从该会话交回的分支起步，退出时交回（无改动，分支指向起点）。
  - 结束后没有带沙箱标签的残留容器（`docker ps -a --filter label=pigeon.sandbox` 为空，`pigeon sandbox list` 报告无残留）。
- 首轮冒烟时联网档的 curl 未设超时，访问外网 pypi 卡满 `run_command` 的 120 秒上限，验证判 fail；改为带 10 秒超时访问镜像站后重跑，结果如上。同轮发现续跑时就绪提示把起点写成宿主当前分支，改为续跑时写沙箱分支（`Sandbox.startLabel`），续跑用例加了断言。

## 十三、verify 的实际运行情况

在服务器上（阿里云实例，8 vCPU、31 GB 内存，Node 24.12.0）对代码树与交付提交相同的临时提交运行 `npm run verify` 的四步，测试步为 `node --test --test-concurrency=6 "src/**/*.test.ts"`（运行前无其他测试进程）：

- lint：通过（biome 检查 384 个文件）
- check：通过（tsc 无报错）
- test：1076 个用例，通过 1074，失败 0，跳过 2（两个 Windows 专属的 `.cmd` 启动用例，平台不符跳过）；沙箱真容器用例两条均实际运行并通过
- deps：通过（400 个模块、2710 条依赖，无违规）
