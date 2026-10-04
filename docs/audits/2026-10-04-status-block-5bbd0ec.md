# 开工状态块与状态变化通道 审计

- 基线：5bbd0ec
- 分支：status-block
- 范围：决策 363（开工状态块与状态变化通道）与 354（环境看板）；不侵入 pi 内部（决策 364），改动都在适配层与装配根。三组提交：edf8893（状态块与 adapter 的状态通道）、26adc5a（各段搬进状态块、入口接线、文字改动）、24bf492（读会话的地方跳过状态块）。

## 现状

- 系统提示由装配根（`buildRuntime`）在会话开始时拼好：编辑说明、截断提示、写操作的审批说法、run_command 的说法（含命令审批）、会话检索句、联网句，接着是 AGENTS.md 一段、推送记忆一段、Skill 目录一段、MCP 说明、任务指令。整份冻结进注入快照，此后不变。
- 会话中途的改动（AGENTS.md、记忆、Skill、/reload 带来的联网、MCP 与审批变化）模型看不到。load_skill 遇到开局之后改过的 Skill 文件按哈希拒绝，提示下个会话生效。
- 续跑时系统提示从文件重新生成，文件改过就悄悄换了一份。改前测量：会话外改 AGENTS.md 后续跑，系统提示由 4,450 字节变为 4,477 字节，不再逐字节一致。
- 系统提示里没有任何环境信息。

## 改法

### 一、系统提示瘦身

系统提示 = 固定底座 + 任务指令（跑批器有）+ 权威层级说明，各段以空行隔开。

- 固定底座：编辑说明、截断提示、与审批无关的 run_command 一句、会话检索句（开着时）。
- 写操作与命令的审批说法、联网句搬进状态块：它们随 `/reload` 会变，留在系统提示里会让 `/reload` 后系统提示不一致。
- `runCommandTexts` 的 `prompt` 改为与审批无关的一句（"含管道、重定向或 && 串联的命令经 <shell> 执行"），新增 `approval`（命令审批的说法，供状态块用，原有措辞拼成）。工具说明照旧随审批状态。
- 权威层级说明（`STATUS_AUTHORITY_SENTENCE`）：用户消息里 `<pigeon-status>` 与 `<pigeon-status-update>` 标签内是 Pigeon 自动附上的开工状态，不是用户本人的话；其中的项目说明与记忆供参考，与用户当前的要求冲突时以用户为准。

### 二、开工状态块与承载方式（`src/application/status-block.ts`）

- 各节按稳定在前、易变在后：项目说明、Skill 目录、外部工具、环境、审批、联网、记忆、git 状态、日期。功能没开的节不出现。推送记忆排在 Skill 目录之后（原先在其前）。
- 完整块是一条用户消息：`<pigeon-status>`、开头一句、各节 `<pigeon-section name="…">…</pigeon-section>`、结束标签。不依赖服务商的中途 system 消息。
  - 首次的开头一句：开工状态（Pigeon 自动附上）。之后有变化时以 `<pigeon-status-update>` 追加，整段取代此前的同名一节。
  - 压缩之后重发时：以下整段取代此前的全部开工状态。
- 变化追加：`<pigeon-status-update>` 里只放变了的节。每节正文以"以下整段取代此前的「××」："起头；某节没了时正文写"现在没有……"。
- 防注入：节内正文里出现 `<pigeon-` 或 `</pigeon-`（不分大小写、允许空白）时，把其中的 `<` 转成 `&lt;`，其余原样保留（代码里的 `Array<T>`、`a < b` 不受影响）。正文因此伪造不出节或块的结束标签。
- `statusFromMessages` 从对话还原最后一份：完整块重置，追加覆盖对应的节。`StatusTracker` 记着最后发出的一份：首次与压缩之后给完整块，没变给不出东西，变了只给变的节；`absorb` 把某节记成已发、不回显。
- 标签与识别放在 `src/state/status-text.ts`（`isStatusText`、`statusSummary`），供读会话的各层使用。

### 三、状态变化通道

adapter（`src/pi-runtime/adapter.ts`）新增可选的 `status` 选项（`StatusChannel`），不挂时行为与此前一致：

- Run 开始前问一次，在 Run 开始前的压缩之后、调上游之前；有消息即放在本次输入（与待递通知）之前。这适用于 `run`、`runNotices`；`continueRun`（分叉续跑）经 steer 交给上游，开头即取走。
- 一批工具结果之后、下一次请求之前问一次。挂了状态通道时，有工具结果的一轮在 `turn_end` 只做标记，不转入通知；到轮间挂点（`prepareNextTurnWithContext`）先做压缩（需要时），再把状态消息与待递通知一起 steer 给上游。上游在这之后取走，发下一次请求之前送达，排在该批工具结果之后。没有工具结果的一轮照旧在 `turn_end` 转入通知，"没有工具调用时同样接着跑一轮"不变。中断或钩子要求停止时都不交，留待下一次运行。
- 任何一次压缩成功（Run 开始前、轮间、手动）之后，下一次给完整块。通道出错只进内部错误清单，这一次不带消息，压缩标记留着。
- 状态消息都经上游的 message_end 写进会话记录，占条目号，续跑时原样读出。

装配根（`src/application/runtime.ts`）里的通道：

- 文件类各节（项目说明、Skill 目录、记忆）、环境与 git 状态在 Run 开始时重取，在一批工具里有写档或命令档工具时重取；外部工具、审批、联网在本运行面内不变；日期每次都看。
- 项目说明照旧经 `loadAgentsInstructions` 读取，文字不变，只是不再进系统提示。注入快照里 AGENTS.md 的清单仍是开局读到的身份。
- Skill 增删改时重新扫描登记；开局注册了 load_skill 时，它随即按新目录与新的哈希读取，解除改动前的哈希拒绝。开局没有 Skill 的会话不注册 load_skill（工具清单开局即定），中途出现 Skill 时，目录一节末尾注明"本会话开始时没有 Skill，没有 load_skill 工具：新增的 Skill 下个会话才能用 load_skill 读取"。
- 模型自己用 update_memory 写成记忆后，下一次比对把记忆一节记成已发，不回显；别处改动的记忆照常追加。
- 具体改了哪些文件不进看板：git 状态一节只写分支、当前提交与有无未提交改动。

### 四、环境看板与取工作区 git 状态的接口（`src/application/status-sources.ts`）

- 环境一节：工作目录、操作系统与执行需要 shell 的命令用的 shell、沙箱档位、检测到的语言环境与依赖目录、网络（确知时才写）。
  - 语言环境按工作区根下的项目文件认：package.json、pyproject.toml / requirements.txt / setup.py / Pipfile、Cargo.toml、go.mod、pom.xml / build.gradle、Gemfile、composer.json。依赖目录写在场的 node_modules、.venv、venv、target、vendor。
- 沙箱档位与网络由入口给出（`StatusFacts`），各入口给法：
  - 日常沙箱联网档：写"容器沙箱（联网档）"，网络不写（联网档不算确知能用）。
  - 日常沙箱断网档：再写"网络：不可用（沙箱断网）"。
  - 跑批器 Pigeon 条件：作业容器恒为 `--network none`，写"跑批作业容器"与"网络：不可用（作业容器断网）"。
  - 本机会话：写"不在沙箱里"。
- git 状态一节：分支（或分离 HEAD）、当前提交前 12 位（或还没有提交）、工作区有没有未提交的改动，不是 git 仓库时写"不是 git 仓库"。日期一节：本地日期。
- 取工作区 git 状态的接口 `WorkspaceStatusProbe`：`gitState()` 与 `rootEntries()`。
  - 本段的简单实现：一次 `git status --porcelain=v2 --branch --untracked-files=normal -- . :(exclude).pigeon/state :(exclude).pigeon/settings.local.json`，不看被忽略的文件与 Pigeon 自己的程序状态。
  - 本机工作区直接在宿主上执行；执行端另一侧的工作区（容器）经执行端在工作区根执行，每次重取多一次进容器。
- **合并时要换的点**：run_command 的文件变化报告改由 git 找候选（决策 348）合并后，`gitState()` 换成复用该报告已取的 git 状态，容器上的这次额外进容器随之合并（决策 349），接口不变。

### 五、续跑、/reload、分叉、worker、各入口

- 续跑（`openSessionRuntime` 的 resume）：不重新生成系统提示，取会话记录里最后一个 Run 开始条目记下的系统提示全文。还原对话后，状态通道以对话里最后一份完整状态（含其后的追加）为起点；续跑后第一次只追加变了的节，完全没变就不追加。
  - 旧会话（系统提示里带人写的说明等）续跑时照样沿用其记录里的系统提示。对话里没有状态块，第一次照新规则追加完整一份，其中会与系统提示里的旧内容重复。
- 354 与 363 的出入：354 原话是续跑时追加一份新的完整快照，363 写的是与会话记录里最后一份比对。以 363 为准，只追加变了的节，也更省 token。压缩之后照旧重发完整块（压缩抹掉了原来那份）。
- `/reload`：新运行面沿用旧运行面的系统提示（经 `frozenPrompt.systemPrompt`），状态通道接着旧运行面最后发出的那份比对，下一次请求只追加变了的节（联网、MCP、审批，以及期间改过的文件类各节）。
- 分叉续跑：分支运行面以复制过来的历史里最后一份状态为起点，分支工作树的工作目录与 git 状态作为变化追加。
- worker 与 `pigeon run`、终端界面、命令行对话、续跑、跑批器 Pigeon 条件都经同一个装配根，走同一套。worker 的状态块只含它装配到的功能对应的节：记忆只在继承了推送时出现，外部工具只在有 MCP 工具时出现，联网只在带联网工具时出现。

### 六、读会话的地方跳过状态块（24bf492）

状态块以用户消息存下，但不是人输入的话。以下读者原先把它当成人输入，一并改正：

- 缺省分叉点（`resolveForkPoint`）：原为最近一次 Run 的第 1 条，现为该 Run 第一条不是状态块的用户消息（任务消息）。不改的话会落在状态块上，分支丢掉任务。
- 续跑与 `--continue` 的会话列表、list_sessions 里的"第一句"（`firstInputOf`、`extractSessionSearch` 的 `firstUserText`）：取第一条人输入的消息。
- 会话检索：状态块与状态追加不进检索。
- 回看（终端界面续跑时的历史、trace 与 replay 的正文）：状态消息显示为一行"[开工状态] 节名、…"或"[开工状态更新] 节名"。

### 七、模型可见文字的改动（「原」→「新」）

- AGENTS.md 一段：「以下内容在会话开始时读取并冻结；会话中修改这些文件要到下个会话才生效。」→「以下内容在会话开始时读取；会话中这些文件被改动时，改后的内容会整段追加。」
- 推送记忆开头（可写入的入口）：「……项目信息，在会话开始时读取并冻结；每条末尾……」→「……项目信息，在会话开始时读取，会话中被改动时整段追加（你用 update_memory 记下的不再回显）；每条末尾……」。只推送的入口（没有 update_memory）用同一句去掉括号里那半句。
- 推送记忆的写入说明末句：「本会话中记下的内容下次会话才会出现在这里。」→「你在本会话中记下的内容不会回显到这里，下次会话开始时会出现。」
- update_memory 工具说明：「只写不读：两层记忆已在会话开始时放进系统提示。」→「只写不读：两层记忆已在开工状态里。」
- Skill 目录一段：
  - 「以下 Skill 在会话开始时登记并冻结。」→「以下 Skill 在会话开始时登记，会话中增删改时整段追加。」
  - 删去「；会话中修改 Skill 文件要到下个会话才生效」，句号收在「不改变任何工具权限。」
  - 开局没有 Skill 而中途出现时，段末另加上文那一句。
- load_skill：
  - 两处工具说明「按名读取会话开始时登记的 Skill」→「按名读取 Skill 目录里登记的 Skill」。
  - 报错「（只认会话开始时登记的 Skill；…）」→「（只认 Skill 目录里登记的 Skill；…）」。
  - 报错「（下个会话重新登记）」→「（目录更新后会如实登记）」。
  - 报错「是会话开始后新增的文件 / 与会话开始时的哈希清单不符，下个会话生效」→「是登记之后新增的文件 / 与登记时的哈希清单不符，下一次请求之前会重新登记，届时再读」。
  - MCP prompt 那条不改（MCP prompt 不在请求之间重新登记）。
- 记忆文字版本 `MEMORY_TEXT_VERSION` 由 v2 升为 v3。跑批身份头里的记忆文字版本随之变为 v3，新旧跑批应判为不同条件。

## 已知边界

- 开局没有 Skill 的会话中途出现 Skill 时，读不到（见上文）。
- 轮间交付时上游的 steer 队列里若已有别的消息（例如使用者在运行中排队的输入），状态消息与通知顺延到下一轮。
- 注入快照与 Run 开始条目里的 AGENTS.md、Skill 清单仍是开局的身份，会话中途的改动只体现在状态块里。
- 容器工作区的 git 状态与工作区根条目经执行端各取一次（Run 开始时与写档、命令档工具之后），待决策 348/349 合并后收拢。

## 测试

### 现有测试的改动（逐个）

查系统提示内容的断言，仍要验证的行为改查新位置（第一次请求的状态块、之后的状态追加），用不上的删除，没有留恒真的断言：

- `src/application/runtime-memory.test.ts`（3 项）：
  - 人写的说明改查状态块，系统提示里没有它。
  - "中途改文件不影响当前 prompt"改为"中途改文件以状态追加整段取代、系统提示与清单不变"。
  - 沙箱读治理根的说明、关掉 agentsMd 时没有项目说明一节，都改查状态块。
- `src/application/runtime-pushed-memory.test.ts`：
  - 推送段的位置改为在状态块里、排在人写的说明与 Skill 目录之后。
  - 写入说明、两层上限、各入口、worker 只推送、第二会话带上一会话记下的纠正，都改查状态块；worker 一项改查 worker 自己的第一次请求。
  - "带写入配置"一项加了自写记忆不回显的断言。
  - 文字版本改为 v3。
- `src/application/runtime-tool-text.test.ts`：系统提示里查与审批无关的一句，审批的说法（写操作与命令）改查状态块的审批一节。
- `src/application/runtime-edit-mode.test.ts`：hashline 的系统提示逐字基准去掉审批句，末尾加权威层级说明。
- `src/application/runtime-skills.test.ts`、`runtime-web-tools.test.ts`、`launch-flags-web.test.ts`、`runtime-roots.test.ts`：Skill 目录行、联网句、工作区根的说明改查状态块，并断言它们不在系统提示里。
- `src/application/settings-reload.test.ts`：原"开局冻结的部分不随 /reload 变"改为：
  - `/reload` 后系统提示逐字节不变；
  - 中途改的 AGENTS.md、两层记忆、Skill 与 /reload 带来的外部工具，下一次请求以追加整段取代；
  - 不重发完整块。
- `src/application/fork.test.ts`：
  - 分叉点改为任务消息的条目号（排在它前面的是状态块）。
  - 比对角色与初始消息时去掉状态消息。
  - 分支文件开头的比对改为复制段整段一致。
  - 系统提示"以任务指令结尾"改为"含任务指令"（末尾是权威层级说明）。
- `src/application/resume.test.ts`、`session-store.test.ts`：比对角色序列的辅助函数去掉状态消息。
- 按"第一条用户消息"分派剧本的假模型改为取第一条人输入的消息：`spawn-worker-headless.test.ts`、`previous-workers.test.ts`、`src/cli/trace-workers.test.ts`、`src/cli/spawn-worker-cli.test.ts`、`script-wiring.test.ts`。
  - `spawn-worker-headless.test.ts` 读会话里用户消息的辅助函数也去掉状态消息。
- `src/application/headless-hooks.test.ts`：取输入的辅助函数去掉状态消息（SessionStart 的上下文仍进第一条人输入）。
- `src/cli/run-cli.test.ts`：数用户消息时去掉状态消息。
- `src/application/thinking-omission.test.ts`：回看行里去掉状态块的那一行，按角色找助手消息。
- 文字改动对应的逐字断言：`src/tools/run-command-text.test.ts`（`prompt` 与新的 `approval`）、`src/memory/agents-md.test.ts`、`src/memory/pushed.test.ts`（含 v3）、`src/memory/update-memory-tool.test.ts`、`src/skills/load-skill-tool.test.ts`（报错改为提示重新登记后再读）、`src/eval/stream-experiment.test.ts`（身份头 v3）、`src/eval/stream-agents.test.ts`（推送的记忆改查状态块）。

### 新增测试

- `src/application/status-block.test.ts`（3 项，纯函数）：
  - 伪造的结束标签与节标签逃不出所在的一节，还原出的状态与原文一致；非 pigeon 前缀的尖括号原样保留。
  - 首次完整块、没变不追加、变了只追加那几节、某节没了说现在没有、压缩之后重发完整块并注明取代全部。
  - 续跑以对话里最后一份为起点只追加变的节；对话里没有状态块时给完整块。
- `src/application/status-channel.test.ts`（6 项，真实运行面与假模型）：
  - 状态块随第一条输入单独发出。改文件后，第二次请求以第一次的消息为前缀（一字不改），其后依次是助手消息、工具结果与 git 状态的追加，追加里不出现文件名。
  - 续跑：系统提示与对话前缀逐字节一致，只追加"项目说明"一节；再续跑什么都没变时不追加。
  - 轮间压缩之后的请求带"以下整段取代此前的全部开工状态"的完整块。
  - Skill 文件改动后 load_skill 读到新内容，不报已变更。
  - 缺省分叉点落在任务消息上；回看把状态块显示为一行。
  - 旧会话续跑沿用记录里的系统提示，照新规则追加完整状态块。
- `src/application/status-fixtures.ts`：测试设施（取一次调用里的状态消息与人输入）。
- 测试量：新增测试文件共 420 行；产品代码新增 806 行（含注释）、删除 66 行。

## 变异

在服务器上逐个改回旧行为或去掉判定，跑相关测试文件；每个变异做完都还原，还原后工作区干净。

| 变异 | 变红的测试文件 |
|---|---|
| 不做防注入转义 | status-block |
| 每次都给完整块，不比对（只追加变了的节） | status-block、status-channel、settings-reload、runtime-memory |
| 续跑重新生成系统提示（续跑前缀逐字节一致） | status-channel |
| 压缩之后不重发完整块 | status-channel |
| 模型自己写的记忆也回显 | runtime-pushed-memory |
| 写档、命令档工具之后不重取 | status-channel |
| 有工具结果的一轮不在轮间交状态 | status-channel |
| 缺省分叉点不跳过状态块 | status-channel |

"续跑重新生成系统提示"在新会话上测不出：新会话现拼的系统提示与记录里的逐字相同。因此补了旧会话续跑一项，该变异由此变红。

## 前后对比

同一假模型脚本、同一份工作区（带 30 行的 AGENTS.md、一个 Skill、一条项目记忆，推送记忆开着），先跑一次改文件的任务，退出后在会话之外改 AGENTS.md 再续跑：

| 指标 | 基线 5bbd0ec | 本分支 |
|---|---|---|
| 第一次请求的系统提示 | 4,450 字节 | 1,078 字节 |
| 第一次请求的消息 | 1 条，75 字节 | 2 条（状态块、输入），4,853 字节 |
| 第一次请求合计（系统提示加消息） | 4,525 字节 | 5,931 字节 |
| 续跑后系统提示与退出前一致 | 否（4,450 → 4,477 字节） | 是（1,078 字节） |
| 续跑后对话前缀与退出前的对话一致 | 是（4 条） | 是（6 条，含状态块与改文件后的 git 状态追加） |
| 续跑后追加 | 1 条（输入） | 2 条（"项目说明"一节的追加与输入），共 2,752 字节 |

第一次请求合计变大，是因为新增了环境、审批与 git、日期各节；人写的说明、Skill 目录与记忆只是从系统提示搬进状态块。

## verify 的实际运行情况

- 机器：服务器 pigeon-verify，8 vCPU、31 GB 内存，Node v24.12.0；按服务器负载取测试并发。
- 树与 24bf492 相同的提交上：`npm run lint`（549 个文件，无问题）、`npm run check`、`npm run deps`（578 个模块，无违规）通过。测试分两批前台运行（并发 3）：application、tui、cli 580 项全过；其余目录 1,056 项，通过 1,054，跳过 2。合计 1,636 项，通过 1,634，失败 0，跳过 2。
- 含本审计的提交上另跑一次 verify，结果追加在下一节。
