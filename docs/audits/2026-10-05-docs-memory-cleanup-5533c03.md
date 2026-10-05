# 文档与记忆收尾审计

- 基线：5533c03（main）
- 分支：docs-memory-cleanup
- 范围：决策 376 的续跑提示补一句；记忆、AGENTS.md、Skill、MCP、审批"会话开始时冻结、中途改了下个会话才生效"一类说法的普查与修正（决策 329–332、363）；
  版本号与过时注释；记忆写入等锁超时的固定回话；两个进程并发写记忆的测试；迁移备份去掉 key。测试照 docs/testing.md（决策 370）。
  改动都在 Pigeon 自己的代码里，不动 pi 的包（决策 364）。

## 一、续跑提示补一句（决策 376）

### 现状

- `src/state/runaway-config.ts` 的 `TRUNCATION_RESUME_PROMPT` 为"上条回复因长度上限被截断；从断处接着写，不要重复已写的内容"，
  `TRUNCATION_CONTINUATION_VERSION` 为 "v2"。
- `src/application/history.ts` 回看历史时按两句提示的原文逐字比对，认出续跑提示、显示成程序提示行。

### 改法

- `TRUNCATION_RESUME_PROMPT` 改为"上条回复因长度上限被截断，最后一行可能没写完；先补完它，再从断处接着写，不要重复已写的内容"。
  重复检测掐断时的 `TRUNCATION_CONTINUE_PROMPT` 不变。
- `TRUNCATION_CONTINUATION_VERSION` 升为 "v3"（注释写明 v3 为撞上限的提示加上先补完最后一行）。跑批身份头的 `continuationVersion`
  随之为 v3，此前写下 v2 的身份头续跑即判为不同。
- 新增 `PREVIOUS_TRUNCATION_RESUME_PROMPTS`（此前各版发出过的撞上限提示，现为 v2 的原文），只供回看历史时认出旧会话记录里的提示，不再发出。
  `history.ts` 改为按现行两句加此前各版组成的集合比对。

## 二、过时说法普查与修正

### 普查范围与方法

- docs/ 下除 decisions.md、ROADMAP.md 与审计以外的文档（实际只有 configuration.md 涉及），以及 src/ 下的使用者文字（终端界面与命令行的提示、
  命令回话）、模型文字（工具说明、系统提示、开工状态块各节）与注释（含测试文件的注释与测试名）。
- 关键词：冻结、开局、会话开始时、下个会话、下次会话、新会话、系统提示、推入、生效、沿用、重读、中途、不随、重启后。只与 git 快照、
  冻结标签、沙箱镜像相关的命中不计。

### 现行代码的事实（判断依据）

- 开工状态块（`src/application/status-block.ts`）各节依次为项目说明、Skill 目录、外部工具、环境、审批、联网、记忆、git 状态、日期。
  `src/application/runtime.ts` 的 `readSlowSections` 在每个 Run 开始，以及写档、命令档工具之后与 Skill 根的指纹变化时，重读 AGENTS.md、
  Skill 目录与两层记忆；与上一份比对，变了的节以 `<pigeon-status-update>` 整节追加。模型自己用 update_memory 写的记成已发、不回显。
- 系统提示只有基础段（工具的介绍）、任务指令与权威层级说明；续跑沿用会话记录里的那份，/reload 后逐字节不变（`FrozenSessionPrompt.systemPrompt`）。
- 按环境注册工具的检查结果（含有无 load_skill）开局定下，/reload 沿用（`toolEnvironmentProbe` 的 `frozen`）。开局没有 Skill 时没有 load_skill，
  会话中新增的 Skill 只出现在目录里，要到下个会话才能读（`NO_LOAD_SKILL_SENTENCE`）。开局有 Skill 时，本地 Skill 增删改后下一次请求之前重新登记，
  load_skill 随即按新目录读取。
- MCP 服务发来的 tools/list_changed、prompts/list_changed 只记录，本会话已暴露的工具集与开局取到的 prompt 正文不变（`src/mcp/client.ts`）。
  /reload 时启动定义改了的服务重启、新加的启动，工具清单与外部工具一节按新快照装配。
- /reload 按新设置快照重建运行面，固化放权规则随之重新装载（`settings-reload.test.ts` 的"改放权后 /reload：下一轮即生效"）。
- 设置快照本身会话开始时读一次，中途改设置文件只在下次启动或 /reload 之后生效（`src/persistence/settings.ts`）。

### 普查表

行号为基线 5533c03 的行号。

| 位置 | 原说法 | 判断 | 依据 |
|---|---|---|---|
| docs/configuration.md:328 | 学到的记忆"整份在会话开始时推入系统提示并冻结（会话中途改文件下个会话才生效）" | 改 | 记忆在开工状态块，每个 Run 开始与写档、命令档工具之后重读，变了整节追加 |
| docs/configuration.md:336 | AGENTS.md"会话开始时读取并冻结" | 改 | 同上，项目说明一节 |
| docs/configuration.md:334 后 | 没有 `--no-pushed-memory` | 补 | `src/application/launch-flags.ts`：终端界面、--line、resume、pigeon run 接受，关掉即不推送、不注册 update_memory |
| docs/configuration.md:334 | /memory edit 未说何时生效 | 补"改动从下一条消息起生效" | 同第一行 |
| docs/configuration.md:378 | /reload 一节"系统提示里会话开始时读取并冻结的部分……中途改这些文件要到下个会话才生效" | 改 | 系统提示 /reload 后不变；说明、记忆、Skill 目录不靠 /reload，照常每个 Run 重读；联网与 MCP 工具、审批等节按新快照变 |
| docs/configuration.md:15、416 | 设置在会话开始时读一次，中途改文件下次启动或 /reload 之后生效 | 留 | 设置快照 |
| docs/configuration.md:68 | 工具清单在一次会话内固定，/reload 不改变按环境判断的结果 | 留 | `toolEnvironmentProbe` 的 `frozen` |
| docs/configuration.md:458 | 钩子随设置快照冻结 | 留 | 设置快照；/reload 后按新快照 |
| docs/configuration.md:466 | SessionStart"不改开局冻结的系统提示" | 留 | 系统提示开局定下、续跑与 /reload 不变 |
| src/application/memory-command.ts:65、123、156（使用者） | /memory 查看标题与编辑回话"下次会话生效" | 改为"从下一条消息起生效" | 每个 Run 开始重读记忆 |
| src/application/memory-command.ts:5（注释） | "改动下次会话生效（本会话开局已冻结）" | 改 | 同上 |
| src/application/grants.ts:182、200（使用者） | /grants save、/revoke config#N"下次会话启动时生效；本会话求值冻结" | 改为"下次会话启动或终端界面 /reload 之后生效，在此之前本会话按原规则求值" | /reload 重建运行面时重新装载固化规则 |
| src/application/grants.ts:34、150、187，governance.ts:60，persistence/grants-config.ts:135（注释） | 固化规则"会话启动时装载、会话内冻结" | 改 | 同上 |
| src/cli/trace.ts:210（使用者） | MCP 清单变更通知"本会话不变，下个会话生效" | 留 | `src/mcp/client.ts` 只记录 |
| src/memory/pushed.ts `PUSHED_MEMORY_INTRO`（模型） | "在会话开始时读取，会话中被改动时整段追加（你用 update_memory 记下的不再回显）" | 留 | 与现行一致 |
| src/memory/pushed.ts `MEMORY_WRITE_GUIDANCE`（模型） | "你在本会话中记下的内容不会回显到这里，下次会话开始时会出现" | 留 | 自己写的记成已发不回显；下个会话开工状态块带上 |
| src/memory/agents-md.ts:146（模型） | "以下内容在会话开始时读取；会话中这些文件被改动时，改后的内容会整段追加" | 留 | 与现行一致 |
| src/skills/catalog.ts:308（模型） | "以下 Skill 在会话开始时登记，会话中增删改时整段追加" | 留 | 与现行一致 |
| src/skills/catalog.ts `NO_LOAD_SKILL_SENTENCE`（模型） | "本会话开始时没有 Skill，没有 load_skill 工具：新增的 Skill 下个会话才能用 load_skill 读取" | 留 | 工具清单开局定下，/reload 沿用 |
| src/skills/load-skill-tool.ts:148（模型） | MCP prompt 正文与开局哈希不符"下个会话生效" | 留 | MCP prompt 正文只在会话开始时取 |
| src/application/status-block.ts `LEGACY_PROMPT_NOTE`（模型） | 旧会话续跑时声明"会话开始时读取并冻结""下个会话才生效"一类说法已不适用 | 留 | 针对旧会话系统提示里的旧说法 |
| src/skills/load-skill-tool.ts:6（注释） | 文件被改或会话中新增的"拒绝并提示下个会话生效" | 改 | 本地 Skill 下一次请求之前重新登记；只有 MCP prompt 下个会话生效 |
| src/skills/catalog.ts:4–6、84（注释） | 目录段"追加进 system prompt，与 AGENTS.md 同样在会话开始时冻结" | 改 | 目录段是开工状态块的一节 |
| src/pi-runtime/snapshot.ts:76、81（注释） | 快照里的 systemPrompt 含说明段、记忆段、Skill 目录段；说明"注入走 system prompt 追加段" | 改 | 363 起只含基础段、任务指令与权威层级说明，更早的会话才拼着这几段 |
| src/application/runtime.ts:438–439（注释） | `FrozenSessionPrompt`"系统提示里会话开始时读取并冻结的部分" | 改 | 冻结的是系统提示与开局清单，状态块各节照常重读 |
| src/application/session-runtime.ts:89–91、settings-reload.ts:4–6（注释） | /reload 时"系统提示里开局冻结的部分（常驻 Memory、推送的记忆、本地 Skill 目录）沿用开局读到的内容" | 改 | 同上 |
| src/application/settings-reload.test.ts:3、skills/catalog.test.ts:2、grants-settings.test.ts:1–2（测试注释） | 同类旧说法 | 改 | 同上 |
| src/eval/stream-agents.test.ts:602（测试名） | "系统提示带作业目录里的项目级记忆"，用例实际断言不在系统提示里 | 改为"开工状态块带……" | 用例正文 |
| src/mcp/client.ts:2–3、165，state/mcp-toolset.ts:45（注释） | MCP 清单开局冻结，list_changed 只记录 | 留 | 与现行一致 |
| src/application/tool-environment.ts:2–3、runtime.ts:446、862（注释） | 一次会话内工具清单固定，搜索后端改了重启后生效 | 留 | 与现行一致 |
| src/persistence/settings.ts:1–2、state/settings.ts、hooks 相关注释 | 设置与钩子随会话快照冻结 | 留 | 设置快照；/reload 另行重读 |
| src/memory/pushed.ts:63、75、87，state/injection-manifest.ts，state/learned-memory.ts（注释） | "冻结身份""开局冻结的两层记忆的身份" | 留 | 指开局记进 Run 开始条目与注入快照的身份记录 |
| src/pi-runtime/snapshot.ts:16、29–31（注释） | 快照各版本的变更记录 | 留 | 历史版本说明 |

给模型看的文字普查下来都按现行代码成立，未改。

## 三、版本号与注释

- `src/memory/update-memory-tool.ts`、`src/memory/pushed.ts` 注释里的"记忆文字 v2"改为 v3（`MEMORY_TEXT_VERSION` 为 "v3"）。
  `pushed.test.ts`、`update-memory-tool.test.ts` 名为 v2 而断言现行文字的两个测试与文件头注释、用例内注释一并改为 v3。
- `src/eval/stream-runner.ts`：
  - `pushedMemory` 字段注释原为"推送记忆另行施工，打开时 headless 暂时报错"；`stream-agents.ts` 打开时给 headless 传 `pushedMemory`、
    只推项目级、不注册 update_memory。改为照此说明（决策 331）。
  - 结果行 `review` 的注释原为"推送格在 agent 部分里填"；复盘已随决策 331 删除，两处都恒为 null。改为照此说明；
    `memoryAtEnd` 的注释去掉"与收尾复盘"。
- `src/application/runtime-pushed-memory.test.ts` 开头原说推送段"放在人写的说明之后、Skill 目录之前"；开工状态块里记忆一节排在项目说明、
  Skill 目录、外部工具、环境、审批、联网之后，用例本身也按此断言。改为"排在人写的说明与 Skill 目录之后"。
- `src/persistence/exclusive-lock.ts` 开头的使用方清单原只列放权配置与跑批输出目录。现行取锁的还有配置确认记录（`config-trust-store.ts`）与
  学到的记忆（`learned-store.ts`，取不到时轮询等待）；迁移命令只借 `lockHeldByLiveProcess` 判断持有进程是否仍在。按此补全。

## 四、记忆写入等锁超时

### 现状

- `src/memory/learned-store.ts` 的 `withMemoryLock` 每 20 ms 试一次取锁，最多等 10 秒，等满仍取不到即把 `ExclusiveLockError` 抛出。
  `update_memory`（`applyMemoryUpdate`）没有接住，工具结果是一条报错，没有固定回话。

### 改法

- `UPDATE_MEMORY_TEXTS` 新增 `busy`："<层>记忆文件正被别的会话写入，这次没有写成；可稍后重试。"（层取"项目级"或"用户级"）。
  这是记忆文字 v3 下新增的一种拒绝情形，`MEMORY_TEXT_VERSION` 不升：跑批不注册 update_memory，不影响实验条件（注释里写明）。
- `applyMemoryUpdate` 只接住 `ExclusiveLockError`，按 `busy` 回话，`details` 为 `written: false`、`rejected: "busy"`，不写文件、不交出写入提示；
  其余错误照常抛出。`UpdateMemoryOptions` 加可选的 `lockWaitMs`（等锁上限，测试注入；缺省仍为 10 秒）。
- /memory edit 同用这把锁，等锁超时仍按原样报错，不在本次范围。

## 五、两个进程同时写记忆

- 新增用例：起两个 Node 子进程（`--input-type=module -e`，直接导入 `update-memory-tool.ts`），等同一个开跑文件出现后，各向同一项目级记忆
  连续新增 20 条。两者退出码为 0；之后解析记忆文件：格式合格，40 条内容与两边写入的逐一相同（不丢、不重复），编号各不相同。

## 六、迁移备份去掉 key

### 现状

- `pigeon migrate-config` 把旧 `.pigeon/web.json` 换算进设置时去掉 `search.zai.apiKey`、`search.tavily.apiKey`，打印应设的环境变量名；
  原文件整份挪进用户级本项目的迁移备份目录（`src/state/paths.ts` 的 `migrationBackupDirOf`），备份里仍有 key 的原文。
- `web.json` 不是合法 JSON 时，报错里带 `JSON.parse` 的消息；Node 的这类消息会摘录出错处附近的原文，key 未加引号等情形下会摘录出 key。

### 改法

- `src/persistence/migration-backup.ts` 新增 `writeRedactedMigrationBackup`：备份位置已存在即拒绝，按调用方给的内容新建备份文件（独占新建，权限 0600），
  再删掉原文件。
- `src/application/migrate-config.ts`：`web.json` 里有上述 apiKey 时，换算时另生成备份稿——原文各字段照留，每个 apiKey 的值换成
  "已移除，请改设环境变量 ZAI_API_KEY"（或 TAVILY_API_KEY）；执行时经 `writeRedactedMigrationBackup` 写入，迁移输出的该行注明备份里 key 的值已去掉。
  没有 key 的 `web.json` 与其余旧文件照旧原文挪动。
- `web.json` 解析失败时报错只说不是合法 JSON，不带解析细节。
- 迁移结束一行由"迁移挪走的旧文件原文备份在 …"改为"迁移挪走的旧文件备份在 …"。
- 更早的迁移留下的备份不改动。迁移检查阶段遇到备份位置已有文件照旧拦住、不覆盖。
- docs/configuration.md 迁移一节同步：去掉"要取回 key 时从备份里找"，写明备份里 key 的值被替换、迁移前须先设好环境变量、更早的备份不改动。

## 七、测试与变异

所有用例用合成数据，不发真实请求。本机只跑改动涉及的单个文件，Vitest 限两个 worker。

### 新增与改动的用例

- `src/application/runaway-rounds.test.ts`：回看历史的用例改为对现行两句加 `PREVIOUS_TRUNCATION_RESUME_PROMPTS` 逐一检查都显示成程序提示行。
- `src/eval/stream-experiment.test.ts`：身份头的 `continuationVersion` 期望值改为 v3，测试名同步。
- `src/memory/update-memory-tool.test.ts`：新增等锁超时与两进程并发写两条。
- `src/application/migrate-config.test.ts`：两条既有用例对 `web.json` 备份的期望由"原文"改为"字段照留、key 的值换成说明、备份目录里没有 key"；
  新增"备份位置已有旧备份：拦住、旧备份与仓库里的 web.json 一字不动、报错不带 key"与"web.json 不是合法 JSON：报错不带 key"两条。
- `src/application/memory-command.test.ts`：只改测试名。

### 变异验证（关键判定）

每项先改产品代码，确认相应用例精确变红，再从备份还原并核对文件逐字一致。

| 判定 | 变异 | 变红的用例 |
|---|---|---|
| 续跑提示随原因分开 | `adapter.ts` 里两种原因的提示对调 | adapter-continuation.test.ts 的两条按原因分开用例与轮间压缩后的接续提示用例（3 条） |
| 续跑版本为 v3 | `TRUNCATION_CONTINUATION_VERSION` 改回 "v2" | stream-experiment.test.ts 身份头记实际生效参数一条 |
| 等锁超时给固定回话 | `applyMemoryUpdate` 不接住 `ExclusiveLockError` | update-memory-tool.test.ts 等锁超时一条 |
| 两进程并发写不丢条目 | `withMemoryLock` 不取锁直接执行（连跑三次） | 每次都是依赖锁的三条：等锁期间写满、等锁超时、两进程并发写。本机为 Windows，两个子进程同时改名撞上 EPERM、以非零退出码变红 |
| 迁移备份里没有 key 的值 | 执行阶段不走去 key 的备份、照旧原文挪动 | migrate-config.test.ts 有 key 的两条 |
| 报错不摘录 key | `web.json` 解析失败时照旧带解析细节 | migrate-config.test.ts 不合法 JSON 一条 |

### 测试量

- 相对基线，src 下产品代码 +227/−135 行（多数为注释与文字的改写），测试 +173/−51 行。新增的行为代码约 90 行（续跑提示与历史识别、
  等锁超时回话、去 key 的备份），新增测试约 110 行（等锁超时、两进程并发、迁移去 key 两条），超出产品代码约两成：两进程并发用例
  须内嵌子进程脚本，迁移用例须建 git 仓库夹具，都没有更下层可放。

## 八、提交

- be53638 撞上限续跑提示补先补完最后一行，续跑版本 v3
- 46e646d 记忆文字版本号与过时注释
- f6004fd 普查修正：说明、记忆、Skill 目录与放权的中途生效说法，补 --no-pushed-memory
- 5280468 迁移备份去掉 key 的值
- 919a13e update_memory 等锁超时的固定回话
- 6aad108 两个进程同时写同一层记忆的测试

## 九、verify

- 本机（Windows）：只跑改动涉及的单个测试文件（Vitest，两个 worker），以及 `npm run check`、`npm run deps`、改动文件的 biome 检查，全部通过。
- 验证服务器（8 vCPU、31 GB 内存，Linux，Node 24.12.0，有 Docker 与实验镜像）第一轮：提交 5280468（第一、二、三、六节的改动），
  `TEST_CONCURRENCY=6 npm run verify:full`：lint、check 通过；测试 325 个文件全部通过，1837 项通过、7 项跳过，用时 212.6 秒；deps 无违例；退出码 0。
- 验证服务器第二轮：提交 c76f2e5（含全部代码改动与本审计），`TEST_CONCURRENCY=6 npm run verify:full`：lint、check 通过；测试 325 个文件全部通过，
  1839 项通过、7 项跳过，用时 93.8 秒；deps 无违例；退出码 0。
- 验证服务器上单独计时（`node scripts/test-timing.mjs --concurrency 1`）：`src/application/migrate-config.test.ts` 0.6 秒，
  `src/memory/update-memory-tool.test.ts` 0.4 秒，都不进慢档。
- 验证服务器上补做"两进程并发写不丢条目"的变异：`withMemoryLock` 不取锁直接执行，连跑三次，每次都是依赖锁的三条变红，
  两进程并发用例败在条目内容的比对上（Linux 上表现为丢条目）；用 git 还原后工作区无改动。

## 十、补充：/memory edit 排队保存与迁移说明

### /memory edit 保存时排队（528ff18）

- 现状：第四节所述，/memory edit 保存时与 update_memory 同用 `withMemoryLock`，等 10 秒仍拿不到锁即报错，界面显示"命令失败"。
- 改法：
  - `withMemoryLock` 加第四个参数：取消信号与"第一次没拿到锁"的回调；`waitMs` 可为 Infinity（不设上限）；等待途中被取消抛
    `MemoryLockAbortedError`，work 不执行。update_memory 的 10 秒上限与回话不变。
  - `editMemoryLayer` 保存时以不设上限的方式等锁；第一次没拿到锁起计时，满 1 秒仍在等才回调 `onWaiting`（一闪而过的不回调），
    轮到或取消即撤掉计时。取消时返回"没有保存，你改的内容留在 <编辑稿路径>。"，原文件不动、编辑稿保留。轮到后照原流程保存
    （含编辑期间原文件被改即不覆盖的检查）；出错时编辑稿保留。
  - 终端界面：`onWaiting` 时显示"正在保存记忆…（Esc 取消）"，并经壳新增的 `captureEscape` 接管 Esc（排在其余按键处理之前，
    审批挂起时不接管），按下即取消；保存结束交还 Esc。给使用者的文字不提锁。
  - docs/configuration.md 的 /memory 一条补上排队、提示与取消的说明。
- 测试：`src/application/memory-command.test.ts` 新增"排队等到后保存成功、提示只出现一次、编辑稿删掉"与"取消时原文件不变、编辑稿保留改过的内容、
  回话指出编辑稿位置"两条；`src/tui/memory-command.test.ts` 新增一条界面冒烟：提示出现后按 Esc，取消信号触发、结果落消息区。
- 变异：取消时删掉编辑稿 → 只有取消那一条变红；还原后文件逐字一致。
- 测试量：产品代码 +121/−24 行，测试 +94/−2 行。

### 迁移说明（4f40073）

- docs/configuration.md 迁移一节写明：迁移会去掉旧 `web.json` 里 key 的原文、不保留任何副本，也不因环境变量没设而拦住；迁移前先把 key
  设进对应的环境变量或另行保存。迁移的行为不变。

### verify

- 验证服务器第三轮：提交 4f40073，`TEST_CONCURRENCY=6 npm run verify:full`：lint、check 通过；测试 325 个文件全部通过，1842 项通过、7 项跳过，
  用时 140.6 秒；deps 无违例；退出码 0。
