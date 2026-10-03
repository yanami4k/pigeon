# 派 worker 时指定工具与作用范围 审计

- 基线：5bbd0ec
- 分支：worker-tools
- 范围：决策 360（性能调优第二波 2e）。spawn_worker 加可选的工具清单与各工具的作用范围；worker 只注册给了的工具、提示只介绍有的工具；worker 跑命令与主会话同一规则。

## 一、现状

- `spawn_worker` 的 `role` 只能取 explorer、implementer、tester（`application/spawn-worker-tool.ts`），各带写死的工具（`orchestration/roles.ts` 的 `ROLE_TOOLS`）；工具说明写死"三种角色另外都能用 web_search 与 web_fetch""检索历史会话"，不看主 agent 实际有没有这些工具。
- tester 的 `run_command` 只接受设置 `commands.roles` 为它登记的命令：`runtime.ts` 取 `commandsConfig.roles[role] ?? []`，没登记即空清单，一条命令都跑不了（放手模式下同样）。
- worker 的注册表登记全部内置工具，只靠适配器按委派策略的 `allow` 过滤广告；系统提示与主会话相同，介绍 edit_file、run_command、会话检索、联网、Skill 目录与外部工具段，不管 worker 有没有这些工具。
- 没有按路径或命令前缀限定 worker 工具的手段。

## 二、改法

范围的登记与判定（`tools/tool-scope.ts`，新增）：
- `SCOPABLE_TOOLS`：可附加作用范围的工具登记表（工具名 → 范围种类）：read_file、edit_file 为 `paths`，run_command 为 `commandPrefixes`。派出参数的校验、spawn_worker 的说明与参数说明、报错里"可以附加的"清单都从这张表取；write_file、grep、glob 合并后各加一行即可。
- `normalizeScopePath`：范围路径相对 worker 工作树的根，规整为正斜杠形式；空串、绝对路径、盘符开头与含 `..` 段的一律不收。
- `pathWithinScope`：调用的路径与范围路径都解析到真实路径（目标还不存在时解析最近一级已存在的上级再接上其余部分）后比较包含关系，符号链接指出范围即越界。
- `commandPrefixWords`：前缀按 `run_command` 的同一切分规则切成词；含换行、shell 语法、引号未闭合或为空的不收。
- `scopeViolation`：一次调用越界时给出拒绝理由。文件类看 `path` 参数（缺 `path` 即越界）；命令看治理层的只读检查结果——须为不经 shell 的单条命令（只读检查为直接执行或 cmd 启动器，命令串不含换行），且参数数组按词以某个前缀开头。管道、重定向、`;` `&&` `||` 串联、命令替换（`$(`、反引号）、换行，以及 Windows 下 `.cmd` 垫片带保守字符集外参数而退到经 shell 的情形，一律越界。
- `scopeWithin`：同一件工具两份范围的包含关系（嵌套派出用）。
- `scopePromptSentence`：worker 系统提示里交代作用范围的一句。

委派策略（`state/session-payloads.ts`、`orchestration/roles.ts`、`orchestration/workers.ts`）：
- `DelegatedPolicySchema` 加可选的 `scopes`（`ToolScopeSchema`：`tool`，`paths` 或 `commandPrefixes`）。范围随委派策略写进派出记录，补批续做与冷恢复取派出记录的策略，范围一并还原；之前的记录没有该字段，即不限。
- `deriveWorkerPolicy(parent, role, { orchestration, tools, scopes })`：给了 `tools` 即只用清单（去重，不套预设），逐件须在 `delegableTools(parent)` 之内——派出方 allow 里、不在 deny 里、不在 `MAIN_ONLY_TOOLS` 里（update_memory、take_worker、orchestrate、update_tasks、list_tasks，以及按层数自动给的派出与等待等编排工具）；有一件不合即整次拒绝（`WorkerPolicyError`，列出可选的工具）。不给即按角色预设（原逻辑：预设与派出方 allow 取交，implementer 另继承 MCP 工具）。编排工具仍按层数自动加。
- 作用范围：每件工具至多一份；须是 worker 有的工具；种类与登记表对得上；路径与前缀按上述规则规整与校验。派出方（嵌套派出时的上层 worker）限定过的工具：没另给即沿用派出方的范围，给了须不比它宽。
- `assertPolicySubset` 加一道：父策略限定了范围的工具，子策略须带不比它宽的范围。
- `ROLE_TOOLS` 的注释改为三份预设；explorer 预设处注明 grep、glob 合并后加入。
- `SpawnRequest` 加 `tools`、`scopes`；策略推导挪到取名与一切副作用之前，校验不过即不派（零记录、零工作区、不占自动编号）。

spawn_worker（`application/spawn-worker-tool.ts`、`attempt-group.ts`、`spawn-worker-host.ts`）：
- 参数加 `tools`（字符串数组，至少一项）与 `scopes`（每项 `tool` 加 `paths` 或 `commandPrefixes`）；多份尝试同样带上。
- 校验不过（`WorkerPolicyError`）：回话"没有派出：{理由}。"，`rejected` 为 `bad-tools`，退还已占的派出额度（`SpawnWorkerBudget.refund`）。
- 说明按派出方当前已注册的工具生成（`createSpawnWorkerTool(slot, available)`，装配根传入本运行面的 `policy.allow`）：各角色一句只写主 agent 有的能力（没有会话检索工具不写"检索历史会话"，联网工具只列有的，没有 edit_file、run_command 的不写对应角色），能收窄的工具取登记表与现有工具的交集，有 run_command 才写"worker 跑命令与你同一套审批规则"。工具齐全时的定稿原文：
  - 「不给 tools 时，角色决定 worker 能用的工具：explorer 只能读代码与检索历史会话，适合调查与定位；implementer 能读写文件、不能跑命令，适合按明确的方案改代码；tester 能读文件与跑命令、不能改文件，适合运行与诊断测试；三种角色另外都能用 web_search 与 web_fetch 查资料。」
  - 「要别的组合就给 tools：只能从你自己现在能用的工具里选（派 worker、写记忆、任务清单一类除外），没列的工具 worker 没有。还可以用 scopes 收窄某件工具：read_file、edit_file 限在给定的路径之内，run_command 只能运行以给定前缀开头、不经 shell 的单条命令；越出范围的调用会被拒绝。worker 跑命令与你同一套审批规则。」
- 参数说明：tools「worker 能用的工具名单，只能从你现在能用的工具里选；不给即按角色的预设」；scopes「可选，把某几件工具的作用范围收窄，每件一项」；tool「要收窄的工具，须是 worker 有的」；paths「read_file、edit_file 用：相对 worker 工作树根的路径，目录含其下全部；不能用 .. 或绝对路径」；commandPrefixes「run_command 用：允许的命令开头（按词比对），如 npm test」（工具名取自登记表）。

治理层（`application/governance.ts`）：
- 加 `scopes` 选项。逐调用判定在钩子拒绝之后、放权与审批模式求值之前：越界即以 `policy:deny` 拒绝，理由原样交给模型，熔断按参数指纹计。放权、yolo、钩子放行都不豁免。

装配根（`application/runtime.ts`）：
- 设置里为该角色登记了命令才套允许清单（登记为空清单即一条都不许），没登记的角色不套；worker 跑命令与主会话同一审批规则，放手模式下照样放行。设置的角色清单与命令前缀范围同时生效（取交集）。
- `toolPolicy` 的类型带上可选的 `scopes`，交给治理层。
- 委派策略在场时注册表只留策略里的工具（`registrySubset`）；治理层与 `toolTiers` 用这份注册表。
- 系统提示：开头一句只介绍有的文件工具（两件都在时与原句逐字相同）；没有 edit_file 的不带截断提示与写操作审批句；没有 run_command 的不带命令句；会话检索句、联网句要所提的工具都在才带；没有 load_skill 的不带 Skill 目录段；没有 MCP 工具的不带外部工具段；有范围时末尾加 `scopePromptSentence`。主会话的工具一律在场，提示不变。
- spawn_worker 的说明按本运行面的 `policy.allow` 生成。

文档：`docs/configuration.md` 的 commands 一行写明角色清单登记了才限；会话检索一节写明 worker 照预设或清单；"worker 与续接"一节开头加一段说明工具清单、作用范围、拒绝与注册。

## 三、改动过的现有测试

- `src/application/spawn-worker-tool.test.ts`：`FINAL_DESCRIPTION` 里角色那一句换成上面两句（工具说明改了，逐字比对的原文随之更新）。其余用例未动。

## 四、新增测试

- `src/tools/tool-scope.test.ts`（3 项）：路径范围内放行（含还不存在的文件）；范围外、`..` 绕出、同前缀的兄弟目录、符号链接指出范围都越界；缺 `path`、没有工作区根都越界。命令前缀 `npm test`、`git status`：带参数的放行；`npm testing`、`FOO=1 npm test`、`npm`、`git statusx`，以及接 `;`、`&&`、`||`、`|`、`>`、换行（LF 与 CRLF）、`$(`、反引号的都越界；`.cmd` 垫片退到经 shell 的情形越界；没有只读检查结果越界。
- `src/orchestration/roles-tools.test.ts`（3 项）：给了清单只用清单、去重、编排工具按层数照加；不给按角色预设；空清单、空名、deny 的、主会话专用的、编排工具、派出方没有的一律拒绝。范围规整写进策略；没给的工具、种类不对、不能附加的工具、重复、含 `..`、`..` 本身、绝对路径、盘符路径、带 `;` `&&` `|` 换行 `$(` 与引号未闭合的前缀一律拒绝。嵌套派出沿用、更窄放行、更宽拒绝（不同目录、整个工作树、短前缀、半个词）；第二道校验拒绝丢掉或放宽范围。
- `src/application/worker-tools-runtime.test.ts`（1 项）：经 `buildRuntime` 装一个委派策略为 read_file、run_command 且带范围的 tester（放手模式、设置里没登记命令）：注册表只有这两件；提示介绍这两件与范围、不提 edit_file、会话检索与联网工具；范围内的读与命令执行成功，范围外的读与带 `&&` 的命令被拒。
- `src/application/spawn-worker-scopes.test.ts`（2 项）：真编排器下工具清单与规整后的范围写进 worker 的委派策略；清单含主会话专用工具时不派出、退还额度，之后照常能派。说明按给定的工具名单生成：没有的联网、会话检索工具与 run_command 不提，能收窄的工具只列有的。

产品代码 +594 −52 行，测试 +406 −1 行。

## 五、变异

在关键判定上逐条改坏、跑对应测试、确认变红后还原：

| 变异 | 结果 |
| --- | --- |
| 清单不查是否可交出 | 变红 |
| 主会话专用工具可交出 | 变红 |
| 嵌套派出不查是否更窄 | 变红 |
| 第二道校验不查范围 | 变红 |
| 没给的工具也能带范围 | 变红 |
| 范围路径放行 `..` | 变红 |
| 命令不查换行 | 变红 |
| 命令不查是否经 shell | 变红 |
| 前缀按字符串而非按词比对 | 变红 |
| 路径按字面比对、不解析符号链接 | 变红 |
| 治理层不拦越界 | 变红 |
| 角色命令清单未登记即为空清单（改前行为） | 变红 |
| worker 注册全部工具 | 变红 |
| 校验不过不退额度 | 变红 |

## 六、未做与留待

- grep、glob、write_file 合并后：在 `SCOPABLE_TOOLS` 各加一行；grep、glob 加进 explorer 预设（`ROLE_TOOLS` 处已注明）。它们的路径参数若不叫 `path`，或缺省为工作区根，`scopeViolation` 取参数处需随之调整。
- 作用范围按宿主路径判定；worker 不在容器工作区里运行，沙箱会话不派 worker。
- 冷恢复 worker 会话（`sessionRuntimeScope`）原本不套角色命令清单，本段未改；范围随委派策略还原，照常生效。
