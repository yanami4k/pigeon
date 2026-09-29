# 编排三段：脚本编排（决策 309–314）实现审计

- 基线：formal-v2 的 1bd6a87（已含编排一段 5706114 与编排界面一段 1bd6a87 的合并）
- 分支：o3-script-orchestration
- 代码提交：9918676（受限执行器与隔离容器）、41809b7（编排器：指定起点、脚本调用标记、只看事件的观察口）、e0728cc（脚本运行器：接力、按指纹续跑、输出格式、花费上限、同类放行、整批收回）、6f1a501（接入终端界面、pigeon run 与编排配置，实验条件不注册）；本审计另起一个提交。
- 范围：决策 309–314 与 300、301、303 的脚本部分；决策 294 D。
- 不做：打转检测（脚本派出的 worker 是普通 worker，打转检测照常作用于它们，本段不另做）；逐行对话（--line）不注册脚本编排。
- 依据：决策 237、265、271、279、292、294、297–303、309–314。

## 一、谁来用（309）

- 工具名 `orchestrate`（`src/application/script-tool.ts`）。工具集随会话冻结（系统提示与工具定义冻结进注入快照），不能按每条输入增删工具，因此工具常注册、由程序在每次调用时按"本次人手输入是否点名"判定能否执行：没点名即拒绝并回定稿文字。
- 点名（`src/application/script-naming.ts` 的 `ScriptGate`）：
  - 关键词为"脚本编排"；斜杠命令 `/orchestrate <任务> [额度 …]` 以人的输入提交，交给模型的文字为"（人用 /orchestrate 点名用脚本编排做这件事）"加换行加任务，同样带关键词。
  - 判断只挂在一个入口：终端界面把人的一条输入交给运行面之前（壳的 `submitNow`，含空闲后发出的排队输入）调用 `humanInput(文字)`，带关键词即点名，不带即收回。模型读到的文件与网页内容（工具结果）、worker 完成通知与发给 worker 的消息都不经过这个入口；模型自己在调用参数里写上关键词也不算。
  - 点名管到下一条人手输入为止；其间完成通知叫醒的轮次沿用这条输入的点名状态。
  - pigeon run 的任务描述算作点名（`runTask`），整次运行（含回炉各轮）都算。
- 项目配置：放进 `.pigeon/orchestration.json`，新增可选的 `script` 段——`modelDecides`（缺省 false；打开后工具常驻、不看点名，工具说明第 2 句换成"由模型判断何时用"的一句）与 `budget`（单次脚本的缺省花费上限，写法同点名时的额度，如 `"¥20"`、`"$5"`、`"2m"`；写法不对即启动时响亮失败）。放进已有文件而不另立，理由：同属编排的项目配置、由同一个读取器校验，缺省取值不变。
- 注册范围：只给主会话——终端界面与 pigeon run，随派 worker 的开关（`--no-spawn-workers` 一并关掉）；worker 会话（带委派策略，嵌套缺省一层）、沙箱会话（执行端在场）与跑批器各条件都不注册，worker 因此不能提交脚本。

## 二、隔离的实现与验证（310）

- 容器（`src/execution/script-sandbox.ts`）：每次脚本执行起一个专用容器，`docker run -i --rm`，不挂任何目录，`--network none`，`--memory 256m --memory-swap 256m --pids-limit 64 --cpus 1`，`--read-only`，`--cap-drop ALL`，`--security-opt no-new-privileges`，带标签 `pigeon.script=1`；容器里以 `node --max-old-space-size=192 -e <执行器>` 运行执行器（`docker/script/executor.cjs`）。宿主与执行器之间只有标准输入输出一条通道，每行一个 JSON：宿主发 `start`（脚本正文与 args）与 `result`（某次 agent 调用的结果），执行器发 `call`、`phase`、`log`、`done`、`error`。脚本结束或被停即删掉容器；宿主断开时执行器随标准输入结束而退出。
- 镜像：用日常沙箱的通用镜像（`docker/sandbox/Dockerfile`，决策 247，内含 Node 24），标签按 Dockerfile 内容与底镜像名的哈希取，首次使用时经 `ensureSandboxImage` 找缓存、没有才构建；项目沙箱配置里改用的镜像不一定带 Node，这里只取它的构建参数。镜像与容器的数据照现有沙箱留在 Docker 自己的存储里，不另挂目录。Docker 不可用时工具回"Docker 不可用，脚本编排跑不了：<原因>。"。
- 受限执行环境（执行器内）：脚本在 `node:vm` 的独立上下文里跑，上下文对象为空、`codeGeneration: { strings: false, wasm: false }`；上下文里没有 require、import、process、console 与任何文件、网络接口（fetch 等不在上下文里）；静态 import 为语法错误，动态 import 因没有加载回调而报错。先在上下文里收掉读时间与取随机数：`Date.now`、`Date()`、无参的 `new Date()` 抛错（给了参数的 `new Date(x)` 照常可用），原构造器的 `now` 同样抛错，日期原型的 constructor 指向受限版；`Math.random` 抛错；删去 `Intl`（格式化当前时间也是读时间）；冻结 Math 与 Date。积木在上下文里定义，宿主只经一层闭包交给它们一个桥函数，桥只收发字符串、自身不抛错，宿主的对象不进上下文。开跑到第一个 await 之间的同步部分限时 10 秒。
- 验证：`src/execution/script-sandbox.test.ts`（本机进程版驱动同一个执行器）逐项断言读文件、跑命令、联网、process、动态 import、静态 import、Date.now、new Date()、Date()、Math.random、eval、借积木的构造器逃出、经日期原型拿回原构造器、格式化当前时间均报错，并钉住容器参数；真容器用例（第十五节）在脚本运行期间 `docker inspect` 核对无挂载、断网、限资源、只读根、去掉全部能力。

## 三、积木（310）

- `agent(任务, {label, phase, role, schema, relay})`：派一个 worker 并等它结束，返回 `{ok, status, ref, name, label, phase, branch, files, summary, output, error, errorKind, reused}`（`ref` 供接力用）。角色缺省 implementer；写错角色、任务为空、schema 不是对象时不派出，照常返回失败结果。
- `schema` 为一份 JSON Schema：任务后面附上格式要求（定稿文字），worker 最后一条回复里的 JSON 对象（沿用 `structuredResultOf` 的解析）按格式校验（`src/state/json-schema-check.ts`，支持 type、enum、const、properties、required、additionalProperties、items、minItems、maxItems、minLength、maxLength、minimum、maximum、anyOf）。
- `parallel(任务数组)`：全部结束才返回，结果按顺序；某项抛错即在该位置给失败结果，不中断其余。
- `pipeline(items, 步骤…)`：每项各自依次走完各步骤、不等其他项；步骤为 `(上一步结果, 项, 序号)`，第一步收到的上一步结果就是该项本身；某步结果 `ok` 为 false（或抛错）即跳过该项后面的步骤。
- `phase(名)`：之后的 agent 归入这个阶段（agent 选项里的 phase 优先）；`log(…)`：在人的消息区写一行 `[脚本 <名>] <文字>`；`args`：提交时给的参数。
- 脚本后台跑：提交即返回运行号；结束时一条汇总以 `[脚本通知] ` 开头进主 agent 的下一轮（与 worker 完成通知同一条队列，空闲时叫醒）。脚本派出的 worker 来源记为程序（不逐个发完成通知，结果交回脚本）。

## 四、接力与收回（311）

- 快照：脚本开跑时给主工作目录拍一张快照（做法同 279），挂在 `refs/pigeon/scripts/<运行号>`；工作目录没有未提交改动时起点即 HEAD，同样挂上引用（`src/execution/script-snapshot.ts`）。整次脚本（含各次续跑）共用这一张；引用保留到本次脚本收回完成或放弃（`/orchestrate drop <运行号>`）为止。
- 起点：编排器的派出新增 `start`——`{point}` 直接用脚本的快照（不另拍）；`{from}` 为接力的上游 worker 的工作树，照 279 拍它的快照开工。下游因此看得到上游的改动，而它的"自身改动"只算快照之后的。
- 收回流程（`ScriptRuns` 的收回，`src/application/script-runner.ts`）：只在脚本以"已完成"结束时做；清单为脚本返回值的 `collect` 数组（agent 的结果或 worker 名），只取成功的调用、去重；清单为空即"没有要收回的"。先整批请示一次：请求的工具名为 take_worker、参数为 worker 名单、写档，面板来源行写"来源：脚本 <名>（运行号 <号>）收回"；放手模式、会话放权或固化规则（与 take_worker 同一工具名）命中即直接做；pigeon run 没有审批通道，非放手模式又没有放权即不收回。批准后按清单先后逐个以三方叠加收回（`overlayWorkerChanges`，同 take_worker：只写 worker 改过的文件、不删除不回退、冲突不写入），汇总列出叠入、冲突与 worker 删除但未删的文件；收回之后删掉快照引用。脚本运行期间不写主工作目录。

## 五、指纹口径与续跑（312）

- 指纹（`src/orchestration/script-fingerprint.ts`）：内容键为 SHA-256（规范化 JSON：任务文字、角色、输出格式（键按字母序）、开工起点——"snapshot"或"relay:<上游调用的指纹>"）；同一次执行里同一内容键的第 n 次出现（从 0 起）再取 SHA-256，取前 32 位十六进制为指纹。与派出先后无关。
- 记录：现有的 worker 派出与收尾条目加可选字段 `script`（不新增记录种类）——派出为 `{runId, fingerprint, relayFrom?}`，收尾为 `{runId, fingerprint, structured?}`（交回的结构化数据，续跑复用时重新校验）。worker 名为 `<运行号>-<序号>`。
- 续跑：从头重执行脚本。复用的条件为同一指纹的记录已完成、工作树还在、给了格式时数据仍合格式，且接力的调用其上游是同一个 worker（`relayFrom` 与本次上游的会话号相同）——上游重做了，下游随之重做。其余（失败、被停、中断时在跑的、没有记录的）派新的 worker。续跑沿用该次开跑时的快照；续跑前按编排器的现状刷新记录（人进入 worker 会话补批续做完的，以最新的收尾为准）。
- 入口：工具参数 `resume_run`（可同时交改过的脚本）；终端界面 `/orchestrate resume <运行号> [额度 …]`（沿用该次的脚本）；给了新额度即换成它后续跑。仅限同一会话：同一进程里取内存中的运行；重启后从本会话文件找回——提交脚本的工具结果 details 里的脚本正文与额度、派出与收尾条目上的记录、各 worker 会话的花费，新派的 worker 名从已派出的最大序号之后排。pigeon run 在同一会话的回炉各轮里可用运行号续跑。

## 六、单个失败（313）

- agent 总是返回结果：成功的带摘要、分支、改动文件、结构化输出；失败的 `ok` 为 false，带状态、错误类型与原因（沿用 298 的取值，另有 bad-call、relay-unavailable、spawn-failed、output-invalid、budget-exhausted、stopped）。
- parallel、pipeline 不因单个失败中断；框架不自动重试。
- 结构化输出不合格式（或没有可解析的 JSON 对象）时，经编排器的续做（`resume`，同一会话号与工作树）把改正的话交给它，至多两次；仍不合即 `ok` 为 false、错误类型 output-invalid。
- 汇总：结束方式（已完成、额度用完、已停止、出错）、worker 数与成功失败数、复用数、花费、各失败的 worker 与原因；等审批超时（approval-timeout、approval-unattended）的单独一行，写明补批后用运行号续跑。

## 七、花费上限与计费（314）

- 写法：点名时"额度 ¥5"（人民币）、"额度 $2"（美元）、"额度 300k"（token；k 为千、m 为百万、万为一万）；项目配置可设缺省；都不设即不限。
- 计费：编排器新增只看运行事件的观察口（`observe(…, { eventsOnly: true })`，不因此订阅流式正文，pigeon run 的行为不变），运行器按轮取 `turn.completed` 的用量，用与状态栏同一个 `addUsage`（回复自带价格记美元；DeepSeek 自带价格为 0 时按官方人民币价目与该轮起止时刻计；其余价格为零的记无价格 token）。额度按同一单位比：人民币比人民币部分、美元比美元部分、token 比全部 token。续跑时累计此前各次的花费（重启后由各 worker 会话文件算）。
- 到上限即不再派新的 worker（之后的调用返回 budget-exhausted、不派出），在跑的做完；有调用因此没派出时脚本以"额度用完"结束，汇总写明没有派出的调用数与续跑方法；不收回。
- pigeon run 给了总额度（token）时，脚本派出的 worker 用的 token 经编排器照常计入；总额度用完即停掉在跑的 worker，脚本之后的调用不再派。

## 八、进度与界面（300、301）

- 开跑时消息区一行计划：`[脚本] <名>（运行号 <号>）开跑：阶段 A → B；已知 N 项；额度 ¥5。`（args 为数组时写项数；不设上限、不确认）；log 行进消息区；结束汇总与 worker 通知同样显示成系统行。
- 树形视图：壳的 `scripts` 取运行器的节点——脚本一层 `script <名> (<运行号>)  running|stopping|done|budget|stopped|error`，其下按阶段列出本次执行派出或复用的 worker，阶段一层写 running 或 done；面板照常列出各 worker。
- 停止整个脚本：树形视图里选中脚本下的 worker 按 `X`（不属于脚本的 worker 同 `x`），或 `/orchestrate stop [运行号]`（不给即停在跑的全部）。在跑的 worker 经编排器取消，其余调用不再派，结果照 313 交回；脚本 10 秒内没结束即删掉容器。树形视图表头加 `[X] stop script`。
- 命令表新增 `/orchestrate`，运行中可用（发起的那条输入照常排队）。

## 九、审批（302、303）

- 脚本派出的 worker 的请求带上运行号；装配方包在汇聚审批入口外面（`wrapScriptApprovals`）：同类已放行即直接批准；否则补上脚本名与同类交给人，面板多一个 `[s] 本次脚本内同类都允许`，选了即批准这一次并回显"已允许本次脚本内同类调用（<同类>），脚本结束即失效"。放行只在同一次脚本运行内生效，这次执行结束即清空。其余照 303（汇到主会话、写明 worker、超时或无人值守即可恢复交回、事后补批）。
- 同类口径（`src/application/script-approvals.ts`）：
  - 跑命令：程序名加第一个子命令词（第二个词为字母开头、只含字母数字与 `_ : -` 时，如 `npm test`、`git status`）；否则只取程序名（`pytest a.py` 取 pytest）。命令需经 shell，或含 `| & ; < > $ ( ) { }`、反引号、换行时不给同类。
  - 高危不给同类、照常逐次请示，面板不显示 `[s]`：命令里任一词的程序名（去掉路径与 `.` 之后的后缀，如 mkfs.ext4 取 mkfs）在单词名单里，或命令以两词名单开头。单词名单（常量 `SCRIPT_KIND_DENY_PROGRAMS`）：rm、sudo、su、chmod、chown、dd、mkfs、curl、wget、ssh、scp；两词名单（`SCRIPT_KIND_DENY_COMMANDS`）：git push、git reset、git clean。
  - 网络档：同一网站。其余工具：同一工具加同一目录（调用带 path 时），无路径即同一工具。
- 审批面板里 `s` 只在请求带同类时生效，其余情形按键吞掉。

## 十、记录与视图

- `child.spawned`、`child.settled` 新增可选 `script`（见第五节）；加这一项之前的记录照常读取。
- 审批请求新增可选 `script`（运行号、脚本名、同类描述），审批决定新增可选 `scope: "script-kind"`；都只在内存里。
- 回看历史（`src/application/history.ts`）：以 `[worker 通知] ` 或 `[脚本通知] ` 开头的用户消息显示成系统行（与实时一致），人输入的话照旧带 `> ` 前缀。

## 十一、实验（265）

- 跑批器各条件不注册 orchestrate：headless 的 `scriptOrchestration` 缺省关，跑批器以常量 `STREAM_SCRIPT_ORCHESTRATION = false` 明确关掉；身份头记 `scriptOrchestration: false`（加这一项之前写下的身份头没有它，续跑即判为不同，与 taskList 同一口径）。

## 十二、说明文字

- 文字按 271 定稿文字的风格写成并定稿（`src/application/script-texts.ts`）：工具说明八段（第 2 句随配置换）、参数说明、各返回文字（开跑、续跑、没点名、没有该运行号、还在跑、Docker 不可用）、worker 附言与改正、斜杠命令用法与交给模型的文字、开跑计划行、log 行、结束汇总、收回请示的来源行、审批新键与回显。其中：高危名单不提供整批放行；工具说明第 3 句写明 pipeline 第一步收到的上一步结果就是该项本身；`[脚本通知]` 照 worker 通知的样式显示成系统行（含回看历史）。
- 另有三句不在上述清单里的命令回显（`src/application/script-commands.ts`）：停止（"已停止脚本 <号>：在跑的 worker 停下，结果照常交回。"）、没有在跑的脚本、放弃（"已放弃脚本 <号>，删掉了它的快照引用；之后不能再续跑。"），以及装配失败的兜底句（不是 git 仓库、没有装配、没有开跑：<原因>）。

## 十三、测试

- 新增：
  - `src/execution/script-sandbox.test.ts`（16）：隔离的各项与容器参数（第二节）。
  - `src/application/script-runner.test.ts`（8）：agent 与结构化输出（合格、改正后合格、两次仍不合，改正在原会话里）；parallel 屏障；pipeline 各项不等齐；phase、log 与 args；计划行；树形视图节点；接力起点看得到上游改动、按清单三方叠加、整批请示一次、冲突列出、运行期间主目录不变、收回后删快照引用；人没批准不写、没给清单不请示；单个失败不中断、pipeline 跳过该项后续、汇总写明原因；等审批超时单独标出；到限停派、在跑做完、汇总写明、无价格按 token；脚本抛错与写错角色。
  - `src/application/script-resume.test.ts`（7）：机器重启式中断后只重派没做完的（新编排器、同一会话，记录冻结模拟进程死掉）；单个失败后只重派失败的；改脚本后只重派受影响的调用；流水线派出顺序变化不影响复用；沿用开跑快照（主目录之后改了并提交）；接力上游重做时下游随之重做；调高额度后续跑复用；等审批超时、补批做完后续跑即复用。
  - `src/application/script-approvals.test.ts`（4）：同类口径、高危名单常量与各高危写法、串联与 shell 不给同类、网络档与路径工具。
  - `src/application/script-wiring.test.ts`（7）：注册范围与 worker 不能提交；点名（人本次输入带关键词才可提交；文件内容、模型在调用参数里写上的关键词、worker 回报里的关键词不算；下一条没带即收回）；斜杠命令点名、额度写法、配置开关与说明第 2 句；pigeon run 任务描述算点名、汇总作为新的一轮处理完才结束；pigeon run 总额度计入脚本 worker 的 token、用完即停不再派；实验条件不注册、身份头记关；回看历史里两种通知显示成系统行。
  - `src/tui/script-ui.test.ts`（5）：计划行、log 与汇总进消息区，树形视图的脚本与阶段节点；树形视图 X 与 `/orchestrate stop` 停止整个脚本；`/orchestrate` 发起以人的输入提交、点名与额度生效；审批 `[s]` 只对本脚本内同类生效、rm 不出现 `[s]`、另一个脚本照常请示；收回请示的来源行。
  - `src/application/script-docker.test.ts`（1）：真容器（第十五节）。
- 改写（语义变更）：`src/application/orchestration-wiring.test.ts`（编排配置的生效值多 `scriptModelDecides`）；`src/tui/input-queue.test.ts`（运行中放行表加 orchestrate）；`src/eval/stream-experiment.test.ts`（身份头加 scriptOrchestration）。

## 十四、变异反向验证

- 服务器上跑；每项只改一处实现、只跑相关用例文件（单用例超时 20 秒、外包 150 秒）；每项还原后以 `git hash-object` 核对与提交逐字一致（六项均一致），全部还原后工作区干净，复跑五个相关用例文件 39 条全过。

| 变异 | 改动 | 变红的用例 |
|---|---|---|
| 点名判定接受了非人手输入 | 工具在模型调用参数含关键词时也放行 | 点名（1 条） |
| 脚本可读文件 | 执行器上下文里放进 require | 读文件、跑命令（2 条） |
| 接力不生效 | 接力的调用一律从脚本快照开工 | 接力与收回；真容器（2 条） |
| 续跑按顺序前缀而非指纹 | 第一个不能复用的调用之后全部重派 | 单个失败后只重派失败的、改脚本后只重派受影响的；接力上游重做时下游随之重做（2 条） |
| 单个失败中断整个脚本 | agent 失败即抛错 | agent 与结构化输出；单个失败不中断；花费上限；脚本出错与角色写错；续跑两条（6 条） |
| 上限不生效 | 超额判断恒为否 | 花费上限；调高额度后续跑（2 条） |

## 十五、真容器用例

- `src/application/script-docker.test.ts` 在服务器上以真 Docker 运行（未跳过）：走产品的容器路径（`dockerLauncherFor`，通用镜像 `pigeon-sandbox:30145c7527e6` 已在本地，标签与仓库 Dockerfile 算出的一致，没有构建），脚本为小流水线——派 3 个 worker（worker 为按任务驱动的替身，不调用模型接口），其中一个接力上一个，最后按清单收回三个。断言：汇总"已完成。worker 3 个：成功 3，失败 0"；接力的 worker 在工作树里看到上游写的文件；三个文件叠进主目录、无冲突；运行期间 `docker inspect` 得到挂载为空、网络 none、内存 268435456、进程数上限 64、只读根、去掉 ALL；结束后没有残留的脚本容器。约 0.6 秒。

## 十六、verify

- 服务器（8 vCPU、31 GB 内存、Node 24.12.0，专属目录），提交 6f1a501，工作区干净：`npm run lint`、`npm run check` 通过；测试步 `node --test --test-concurrency=6 "src/**/*.test.ts"`（当时服务器上没有别的测试在跑）：1429 条，通过 1427，跳过 2（既有），失败 0，约 110 秒；`npm run deps`：537 个模块、3785 条依赖，0 违规。四步合计约 127 秒。变异与真容器用例同在服务器上跑。

## 十七、已知限制

- 脚本在第一个 await 之后的死循环不受同步时限约束，只能从界面停止（停止 10 秒后删掉容器）；没有整次脚本的墙钟上限。
- 金额额度只比同一币种的部分：模型没有价格时（价格为零且不是 DeepSeek）它的 token 不计入金额额度，这种情况要写 token 额度才有约束。
- 结构化输出只认 JSON 对象（沿用 `structuredResultOf`，数组不算）。
- 重启后续跑要求提交脚本的那次工具结果仍在会话里（找回脚本正文）；worker 的工作树已清理的调用重派。
- 失败自动分叉重试另开会话，不能接上原会话的脚本运行（续跑仅限同一会话）。
