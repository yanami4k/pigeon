# 本轮施工的最终验收（交付分支 claude/build-2-hooks，基线 ecb1a66）

范围：claude/build-2-hooks（ecb1a66，已含三层设置与安全底座、钩子、记忆、会话检索、沙箱与工程设施五段）在验证服务器上的全量 verify 与手动冒烟，验收中的小修，以及与决策分支 claude/dazzling-mccarthy-p9xgdf（a592637，决策 322–342 与会话权威链审计）一并合入 main。本文只写事实。

## 一、验证服务器上的 verify（ecb1a66）

- 环境：8 vCPU、31 GB 内存，Node 24.12.0，npm 11.6.2，Docker 29.8.1；`npm ci` 按锁定文件安装；以普通用户运行；`PIGEON_TEST_CONTAINER_IMAGE=pigeon-host-test:root`；测试步为 `npm run verify` 原样（node --test 缺省并发）。
- lint：`biome check .` 通过，536 个文件。check：`tsc -p tsconfig.json --noEmit` 通过。deps：564 个模块、4,070 条依赖、无违规。
- test：1,586 条，1,584 通过、0 失败、0 取消、2 跳过，用时 67 秒。跳过的 2 条为仅 Windows 的 .cmd 启动器用例。
- 真容器用例这次实际执行（均通过）：容器执行端（真容器）一组 8 条，含"辅助命令超时（决策 335）：卡住的辅助命令在容器内被终止，容器不重启，agent 在后台起的进程仍在"；"真容器：钩子在容器内执行"与"真容器：钩子超时被容器内 timeout 终止"；沙箱的真容器用例（断网参数、非 root 运行、改动交回、busybox 无 git 报错）；脚本编排容器（不挂目录、断网、限资源、只读根）；作业容器的判题前清理。
- 沙箱启动参数带 `--memory`、`--memory-swap`、`--pids-limit` 的几条用例用的是本机执行的假 docker；真容器上的资源上限在第二节冒烟七核对。
- 真容器执行端测试镜像的做法：`pigeon-host-test:root` 为通用沙箱镜像 `pigeon-sandbox:<标签>`（docker/sandbox/Dockerfile 所建，带 GNU coreutils 与 git）之上再加一层 `USER root`，即 Dockerfile 两行 `FROM pigeon-sandbox:<标签>` 与 `USER root`；CI 上没有这个镜像，相应真容器用例在 CI 上按现有逻辑跳过。
- 本轮没有改动任何 Dockerfile；`src/execution/sandbox-image.ts` 只把沙箱配置的读取挪到设置模块，镜像标签算法未变，验证服务器上已有的实验镜像与沙箱镜像直接沿用。

## 二、手动冒烟

做法：每项一个临时 git 仓库，用户级目录（HOME）指到临时目录，不读写真实用户目录；模型用 `--stream-fn` 加载的脚本模型（`src/pi-runtime/fixtures.ts` 的 `createFakeStreamFn`，按剧本回复与调用工具），不调真模型；终端界面在 tmux 里驱动、取屏核对。

1. 旧布局与迁移：旧布局项目（grants、commands、带 key 的 web、verify、loop-guard、.pigeon/learned、.pigeon/memory、用户级 preferences.md）下，`pigeon --line` 与 `pigeon run` 启动即报错，逐项列出旧配置与遗留，提示运行 `pigeon migrate-config`，退出码 1。迁移后 `.pigeon` 下只有 `settings.json`、`settings.local.json`（permissions 一节）与 `.gitignore`（`state/`、`settings.local.json` 两行）；旧文件原文在 `~/.pigeon/state/migration-backup/<项目目录名>-<哈希>/`；仓库内搜不到 key，也没有备份文件；key 未写入设置并提示改设 `ZAI_API_KEY`；`~/.pigeon/preferences.md` 改名为 `~/.pigeon/AGENTS.md`；verify.json 挪走并打印改写为 Stop 钩子的示例。迁移后再启动即列出新出现的命令短名要求确认；再次迁移报"没有要迁移的内容"。
2. 启动确认：项目共享层给出命令短名、sandbox 一节、MCP 服务（真实的 server-filesystem）、Stop 钩子与一条放行规则，另有被 git 跟踪的 `settings.local.json` 里的一条放行规则。终端界面启动时逐条列出（注明来自哪一层、类型、标识与完整内容），选"全部确认"后确认记录写入用户级 `config-trust.json`、会话正常启动；`/hooks` 列出生效的钩子及其来自哪一层。改动钩子后 `pigeon run` 报错退出（退出码 1）并列出未确认条目；加 `--trust-config` 照常运行、钩子执行，且不记指纹（再跑仍报错）。
3. Stop 钩子：照使用说明示例配 `npm test 1>&2 || exit 2`、测试恒失败。`pigeon run`：收尾时执行、拦下后把测试输出交给模型接着干；钩子执行 9 次、模型请求 9 次，连续拦下 8 次后不再接着跑，终态 `stop-hook-limit`、退出码 10。终端界面同样拦 8 次后提示"已到上限"并回到空闲，没有死循环。PreToolUse 钩子返回 `{"continue": false, "stopReason": …}` 时整轮停下，终态 aborted，原因记"钩子要求停止：…"，同批两条命令都未执行，之后不再触发 Stop。
4. `/reload`：开局两个 MCP 服务 keep、change；第一轮 run_command 要人批（拒绝）。在项目个人层加一条该命令的放行规则、把 change 的启动定义改指另一目录后 `/reload`：只列出 change 一项要求确认（个人层放权不需确认）；`/reload confirm` 后提示"改了 mcp、permissions 节""重启 change"；进程核对 keep 进程号不变、change 旧进程停止新进程启动；第二轮同一命令不再弹审批直接执行；四次模型请求的工具清单里 update_memory 都在。
5. 记忆与 AGENTS.md：模型调用 update_memory 后消息区出现"[记忆] 已记下（项目级 P1）：…"；`/memory edit user` 调用编辑器后提示"已保存用户级记忆…下次会话生效"；`/memory` 列出两层的位置、条数、用量与条目（项目级条目带日期、来源与会话编号）。项目级与用户级 AGENTS.md 从第一次请求起就在系统提示里；两层记忆在本会话内冻结，下一个会话的系统提示里才出现。
6. worker 续接：终端界面派出 worker、它收尾后不取用，退出后 `pigeon --continue` 续接：`worker_status` 显示"完成，2 轮……（来自之前的运行）"；`take_worker` 经人批准后取用成功，主目录文件变为 worker 的改动。
7. 沙箱会话（`--sandbox --sandbox-approval prompt`，镜像 pigeon-sandbox:30145c7527e6）：容器 Memory = MemorySwap = 16,477,323,264（`docker info` MemTotal 32,955,826,176 的一半），PidsLimit 4096，不设 CPU 上限，以 pigeon 用户运行；就绪提示写明两项上限。PreToolUse 钩子在容器里执行（`pwd=/workspace`、`/.dockerenv` 存在）并从标准输入读到完整事件 JSON。对 a.txt 按 [a] 本会话允许 edit_file 之后，写 `/workspace/.pigeon/settings.json` 仍弹审批，面板只有批准一次、拒绝、拒绝并说明，没有放权键。退出后改动交回为分支，容器已删除。

## 三、验收中的修改

| 提交 | 内容 |
|---|---|
| f952e31 | `.mcp.json` 校验报错的出错位置：原取 `failure.path`（typebox 1.x 的字段名是 `instancePath`），位置恒为"/"；改为复用设置模块的 `schemaProblems`，与设置文件的校验报错同一写法；新增 1 条用例 |
| dafb443 | `src/application/headless-core.ts` 文件头注释仍写 pigeon run 带 update_memory、做压缩前与收尾复盘，改为与决策 331 一致；`docs/configuration.md` 三处：写满被拒一句分别写明新增与替换两种拒绝给出的内容，克隆仓库自带放行规则的例子改为文字描述（原示例缺 `promotedFrom`，照抄即被设置校验拒绝），补回"会话检索"标题前的空行 |

- 新增用例：`src/persistence/mcp-config.test.ts`"MCP 配置：.mcp.json 校验失败时报错指出出错的位置（instancePath），不是一律写成 /"。修改前运行精确变红（报错为"/：must have required properties command；/：…"），修改后 7 条全过；报错变为"/mcpServers/a：must have required properties command；…"。
- 变异：把修复后的出错位置一律改写回"/"→ 上述新用例精确变红（该文件 6 过 1 败）；还原后文件 sha256 与修改后一致，7 条全过。
- 修改后 biome、tsc、dependency-cruiser 均通过（564 个模块、4,071 条依赖、无违规）。
- 修改后在 dafb443 上重跑 `npm run verify`（环境同第一节）：lint 536 个文件通过，check 通过，test 1,587 条、1,585 通过、0 失败、2 跳过（同为仅 Windows 的 .cmd 用例），用时 67 秒；deps 564 个模块、4,071 条依赖、无违规。

## 四、顺带发现（范围外，未修）

1. `/reload` 后沿用原连接、没有重启的 MCP 服务，其注解与配置冲突的提示也重新打印一遍。
2. 派 worker 时，Pigeon 自己写下且尚未提交的 `.pigeon/.gitignore` 计为"派出时 1 个未提交的文件"带进 worker 的起点快照；文件确属项目内容，只是提示容易让人以为工作目录里有别的未提交改动。
3. 沙箱会话的审批档缺省为 yolo；此档下 agent 用文件工具写 `/workspace/.pigeon/...` 放行，与决策 326"--yolo 下放行"一致；要人批须 `--sandbox-approval prompt`。
4. update_memory 在格式损坏时让模型"请告知用户用 /memory edit 修复"，而 `pigeon --line` 与 `pigeon resume` 的命令行对话注册了 update_memory 却没有 `/memory` 命令。属待项目负责人过目的文字，本次未改。

## 五、合入 main

- 次序：以 main（101bbc7）为基，先 `git merge --no-ff` 决策分支 claude/dazzling-mccarthy-p9xgdf（a592637），再 `git merge --no-ff` 本分支。两次都无文本冲突；第二次 docs/roadmap/decisions.md 自动合并，合并后索引 342 行、编号 001–342 连续无重复、详情段 342 个、无冲突标记。
- 合并后的树在验证服务器上重跑 `npm ci` 与 `npm run verify`（环境同第一节）：lint 536 个文件通过，check 通过，test 1,587 条、1,585 通过、0 失败、2 跳过（仅 Windows 的 .cmd 用例），用时 67 秒；deps 564 个模块、4,071 条依赖、无违规。本节写入后只多了这份审计的文字，代码与测试不变。
