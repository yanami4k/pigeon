# 回炉接入容器施工记录（基线 d1e8f43）

分支 `stream-repair` 自 `stream-runner`（`d1e8f43`）拉出，合入 `repair-loop` 当时的头 `43deb0e`；回炉合并进 main 后整体变基到 main、线性化。本记录只写事实、选项、权衡与证据。

## 一、执行端的"回到这一步起点"（决策 154②）

`repair-loop` 的撤回（`orchestration/checkpoint.ts`）直接调宿主 git 与宿主文件系统，遇到容器执行端即拒绝开回炉。本块在执行端接口上加一对可选能力，由容器实现提供：

- `markStepStart()`：开工时记下当前提交，以及当时已被忽略的路径（`git ls-files -z --others --ignored --exclude-standard --directory`，整个被忽略的目录只占一项）。
- `restoreStepStart(mark)`：先确认起点提交仍在库里，不在即抛 `StepStartLostError`，不做部分恢复；再 `git reset --hard <起点>`（agent 自己的提交一并撤掉）并 `git clean -fd`（不带 `-x`）；最后列出现在被忽略的路径，删掉开工时清单里没有的——即 agent 新建的被忽略文件与目录。

取舍：只做 reset 加不带 `-x` 的 clean 更简单，但会留下 agent 新建的被忽略文件（构建产物、缓存目录等），不满足"agent 新建的一概清掉"；带 `-x` 又会删掉开工时已被忽略的依赖目录。故采用开工时记下的忽略清单。集合差在跑批进程里算，要删的路径作为参数交给 `rm -rf`：容器里的 sh 为 dash，逐项处理 NUL 分隔的路径不便，且避免路径被 shell 拆分。按 `--directory` 的粒度，开工时已被忽略的目录之下后来多出的文件同样不动。撤回在容器里以镜像缺省的非 root 用户执行，文件属主保持一致。

证据：

- 用例（假 docker CLI 在本机执行命令，对着真实 git 仓库）："回到这一步起点：回到起点提交（agent 自己的提交也撤掉），删掉 agent 新建的一切含被忽略的，开工时已被忽略的不动"；"回到这一步起点：起点提交已不在库里即报错，不做部分恢复"。
- 变异均变红：不删 agent 新建的被忽略路径；开工时已被忽略的也删；不回到起点提交（只复原文件）；起点丢失不单独报错。
- 在 `pigeon-stream-strands:v3` 容器里实测：以 uid 10001 执行；agent 提交一次并新建未跟踪文件、被忽略文件与目录后撤回，提交数回到 1、已跟踪文件复原、新建的全部删除、开工时已被忽略的 `build/` 与 `pre.log` 保留，撤回后各文件属主仍为该用户。

## 二、两条流的分步验证配置

分步验证的形状与 `.pigeon/verify.json` 的分步配置一致（`version: 1`、`steps: [{name, command, cwd?}]`、`timeoutMs`）。每条流的运行方式带上自己的分步，跑批器在每个作业开始时把它写进该作业治理根下的 `.pigeon/verify.json`。Pigeon 在宿主进程内运行，项目配置从治理根读取；strands 仓库也不忽略 `.pigeon/`，写进容器工作区会被当成 agent 的改动落地提交，故不写进容器工作区。

- 本仓库四步：格式（`npm run lint`）、类型（`npm run check`）、测试（`node --test --test-timeout=120000 "src/**/*.test.ts"`）、分层（`npm run deps`）。逐提交核对：清单范围内 93 个提交（起点加各步）的 `package.json` 里 lint、check、test、deps、verify 五个脚本逐字相同，没有缺失或不一致。
- strands 三步，都在 `strands-py` 下执行：ruff（`ruff format --check && ruff check`）、mypy、pytest（与原验证门的单测一步相同：带 `--continue-on-collection-errors`，报告写出后等 5 秒杀掉进程，看报告里有没有失败或出错的用例）。
- 验证门（维护步的判定）改由同一份分步派生：各步全跑、各带标题，任一步失败即不通过；失败之后的步照样执行，反馈里有每一步的结论。原先本仓库的验证门是 `npm run verify`，测试一步没有单用例超时；现在与分步一致。

mypy 的检查范围：在 v3 容器里对人的代码实跑派生的验证门，s1 起点 `003bd9f44` 上 ruff 通过、pytest 5289 条全过，但 mypy 报 "cannot read file 'tests_typing'"。该提交的 CI 只跑 `mypy ./src`，类型测试目录 `tests_typing` 由 `577a9d6a1`（2026-09-01）才加入。写死两个目录会让人的代码在窗口前段也过不了验证门，维护步随之判错，次要指标的类型错误数也取不到。改为 `mypy ./src $(test -d tests_typing && echo ./tests_typing)`，验证门与次要指标共用这一条。

用例："分步验证：本仓库四步……测试步带 120 秒单用例超时；strands 三步……都在 strands-py 下执行"（含 mypy 的写法与次要指标共用）；"验证门由分步派生：各步全跑、各自带标题，任一步失败即不通过（失败之后的步照样跑）"；跑批器用例增加断言：作业治理根下的 `.pigeon/verify.json` 与运行方式的分步一致。

变异均变红：测试步不带单用例超时；验证门遇到失败即停；pytest 步不在 strands-py 下（另使"strands 验证门……"变红）；验证门无视失败（同上）；验证配置不写进治理根。

对人的代码实跑派生的验证门（v3 镜像、2g 上限）的其余发现：

- strands 的 ruff 步：末端 `381ab48ab` 上 `ruff check` 通过，`ruff format --check` 报 8 个文件需要重新格式化（ruff 0.16.8，在其依赖声明的 0.13 至 0.17 范围内）。其 CI 的 lint 作业只跑 `hatch fmt --linter --check`（即 `ruff check` 与 mypy），不做格式检查。ruff 步改为只跑 `ruff check`；格式偏差仍计入次要指标。变异"ruff 步加上格式检查"变红分步验证的用例。
- strands 的 mypy 步（待定）：其 CI 的 lint 作业在 Python 3.10 上跑，pyproject 的 mypy 配置为 `python_version = "3.10"`。镜像的五套环境都是 Python 3.13，装进了只在 3.12 及以上才安装的包，以及按 3.13 解析的 numpy 2.5.3；这些包的源码或类型存根使用 3.12 的语法。于是人的代码上 mypy 也不通过：`003bd9f44` 报 `numpy/__init__.pyi` 的 type 语句，`381ab48ab` 报 `smithy_core/aio/eventstream.py` 的类型参数列表。改用 `--python-version 3.13` 同样不行：`003bd9f44` 上报 1 条 `Unused "type: ignore"`，`381ab48ab` 上报 3 条（含两条协变类型变量）。
- 本仓库的类型步（待定）：`ba94b539e` 上 2g 容器内 Node 按容器内存得出的堆上限为 1120 MiB，`npm run check`（tsc）堆内存耗尽退出（134）；设 `--max-old-space-size=1536` 后通过。同一限制也会让次要指标的类型错误数与 agent 自己在容器里跑的 tsc 失败。该提交上格式、测试（323 条全过）、分层三步通过。
- strands 的 pytest 步：`003bd9f44` 上 5289 条全过，`381ab48ab` 上 6643 条通过、31 条跳过。
