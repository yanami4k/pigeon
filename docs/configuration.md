# 配置与状态目录

本页说明 Pigeon 的设置文件、程序状态目录、记忆与人写的说明、迁移命令与配置相关的安全防线（决策 325、326、328–332、340、341）。

## 三层设置

| 层 | 位置 | 是否提交 |
| --- | --- | --- |
| 用户级 | `~/.pigeon/settings.json` | 不在项目里 |
| 项目共享 | `.pigeon/settings.json` | 可提交 |
| 项目个人 | `.pigeon/settings.local.json` | 不提交 |

优先级：项目个人 > 项目共享 > 用户级。合并规则：对象按键逐层合并，标量与数组由高优先层整体替换；唯一例外是 `permissions` 的放权规则，三层并集生效（项目共享层的规则须先经确认，见下文第三道防线）。

设置在会话开始时读一次，形成本会话的设置快照；会话中途改文件不生效，下次启动或在终端界面里 `/reload` 之后才生效（见下文）。worker、沙箱会话与脚本编排沿用派出它的会话的快照。

文件不是合法 JSON、出现未知键（顶层或节内）、写了 key、项目级写了 `trustedDirectories`，或合并后不成立（例如角色清单引用了各层都没有的命令短名），启动时报错并指出文件、键与所在层。整个文件可以有一个 `$schema` 键。

## 各节

| 节 | 内容 | 原文件 |
| --- | --- | --- |
| `mcp` | MCP 服务的风险档覆盖（`servers.<名>.defaultTier`、`tools`），也可用 `launch` 直接定义服务 | `.pigeon/mcp.json` |
| `permissions` | 固化的放权规则 `grants`；`/grants save` 写入项目个人一层，`/revoke config#N` 从中删除；写在项目共享层的规则须经确认才生效 | `.pigeon/grants.json` |
| `commands` | 命令短名 `commands` 与角色允许清单 `roles` | `.pigeon/commands.json` |
| `orchestration` | worker 并发、层数、上限、卡住判定、任务清单、脚本编排 | `.pigeon/orchestration.json` |
| `web` | 搜索后端与地址、抓取上限 | `.pigeon/web.json` |
| `sandbox` | 沙箱镜像（`image` 或项目自己的 `dockerfile`、`context`）与通用镜像的构建参数 `build` | `.pigeon/sandbox.json` |
| `loopGuard` | 打转检测的开关、轮数与豁免工具 | `.pigeon/loop-guard.json` |
| `hooks` | 钩子：事件 → matcher 组 → 命令（决策 323 / 324，见下文"钩子"一节） | 新节 |
| `memory` | 学到的记忆的两层上限：`projectLimitChars`、`userLimitChars`，缺省各 4,000 字符 | — |

各节字段与原文件相同，去掉了各文件自己的 `version`。项目根的 `.mcp.json` 留在原处，格式不变。`.pigeon/verify.json` 已随验证门退役（决策 322），`.pigeon/memory-review.json` 属已删除功能的遗留（决策 331）：启动时按旧配置报错，迁移命令把它们挪进备份目录（verify.json 另打印改写为收尾钩子的示例）。

另有顶层键 `disableAllHooks`（停用全部钩子）与 `stopHookBlockCap`（收尾钩子连续拦截上限，缺省 8），以及只能写在用户级的 `trustedDirectories`（路径数组，只接受绝对路径或 `~` 开头），见下文第三道防线。

示例（`.pigeon/settings.json`）：

```json
{
  "commands": {
    "commands": { "test": "npm test" },
    "roles": { "tester": ["test"] }
  },
  "orchestration": { "maxConcurrent": 4 },
  "loopGuard": { "stopAt": 30 }
}
```

## key 走环境变量

设置文件里没有任何 key 字段。智谱搜索的 key 从环境变量 `ZAI_API_KEY` 读，Tavily 的从 `TAVILY_API_KEY` 读，DeepSeek 用模型接入同一个环境变量。在 `web` 一节里写了 `apiKey` 即报错，并给出应设的环境变量名。

## 程序状态目录 `.pigeon/state/`

程序写的东西都在 `.pigeon/state/` 下：会话（`sessions/`）、项目级学到的记忆（`memory.md` 与 `memory.lock`）、worker 工作树（`worktrees/`）、终端界面的输入历史（`tui-history.json`）与日志（`logs/`）。用户级的程序状态（用户级学到的记忆 `memory.md`、配置确认记录 `config-trust.json`、迁移备份 `migration-backup/`）在 `~/.pigeon/state/`。

人写的内容：`.pigeon/skills`、`~/.pigeon/skills` 留在原处；人写的说明改读 AGENTS.md（见下文"记忆与人写的说明"），旧的 `.pigeon/memory/` 与 `~/.pigeon/preferences.md` 不再读取，由迁移命令处理。

Pigeon 第一次在项目里建 `.pigeon/state/` 或 `settings.local.json` 时，若 `.pigeon/.gitignore` 不存在，写入一份，内容为 `state/` 与 `settings.local.json` 两行；已存在则不改，缺这两行时在终端提示一行。

快照、checkpoint 与 worker 改动叠加只排除 `.pigeon/state` 与 `.pigeon/settings.local.json`；仓库已跟踪的 `.pigeon/settings.json` 与 `.pigeon/skills` 是项目内容，照常进快照与叠加。列目录与命令的文件变化报告仍不列整个 `.pigeon`。

## 记忆与人写的说明

学到的记忆分两层，一行一条，整份在会话开始时推入系统提示并冻结（会话中途改文件下个会话才生效）：

- 项目级 `.pigeon/state/memory.md`、用户级 `~/.pigeon/state/memory.md`；行形如 `- [P3] 内容 〔2026-10-01 · 终端界面 · 会话 sess_…〕`（编号项目级 P 开头、用户级 U 开头；〔〕一段由工具补上日期、来源与会话编号，人手加的条目可缺）。
- 记使用者的偏好、纠正与代码之外的项目信息（外部资料的位置、约定、背景）；能从代码与 git 历史看出的内容不记。
- 两层各限 4,000 字符（设置的 `memory` 一节可改）。写满时新增或改长都会被拒绝，拒绝文字给出当前用量与还差多少；改短或等长一律放行。
- 写入用 `update_memory` 工具（带 `layer` 参数，新增、按编号替换、按编号删除），写入不审批，写入后消息区提示一行。只有有人对话的入口（终端界面主会话含沙箱会话、`pigeon --line`）带这个工具；`pigeon run`、worker、跑批器只推送记忆。
- 终端界面里 `/memory` 查看两层的内容、位置与用量；`/memory edit project|user` 用 `$VISUAL`/`$EDITOR` 编辑（存盘后校验格式与上限，不合格保留原内容）。

人写的说明读 AGENTS.md：用户级 `~/.pigeon/AGENTS.md` 在前，项目级从仓库根到工作目录逐层拼接（某层没有 AGENTS.md 而有 CLAUDE.md 时读该层的 CLAUDE.md；不越过仓库根；不在 git 仓库里只读工作目录本身）。合计上限 32 KiB（按 UTF-8 字节），超出部分截断并在推送内容末尾与终端各提示一行。会话开始时读取并冻结。
## 会话检索

agent 可以查本项目以前的会话，共三件工具，都是只读、免审批：

- `search_sessions`：按关键词检索以前会话里的对话。关键词大小写不敏感、按字面匹配，最多 8 个，任一命中即列出，按命中的关键词数从多到少、同数从新到旧排序，每条标出命中了哪些关键词，最多 20 条。
- `read_session_entry`：按条目号读一条消息的完整原文（含思考内容与工具输出）。
- `list_sessions`：列出以前的会话，每个给出会话编号、开始时间、第一句使用者的话与改动过的文件（`edit_file` 的写入与 `run_command` 报告的文件变化），可按开始时间与文件路径筛选，最多 20 个。

缺省范围：检索与会话目录都不含当前会话所在的这一组会话，即沿派出与分叉关系上溯到最上层的会话，连同它派出的各级 worker 与分叉（当前会话本身、续接的会话、上级与兄弟会话都在其中）；检索只搜对话正文，即使用者的话与模型回复的文字，不含思考内容与工具调用；以前的工具输出（命令输出、读过的文件内容）要在调用时给 `includeToolOutput: true` 才一起搜。这三件工具自身的输出任何时候都不进检索。

缓存：每个会话文件抽出的可搜文本与目录信息缓存在 `.pigeon/state/search-cache/`，每个会话两份（`<会话号>.json` 存目录信息与对话正文，`<会话号>.tools.json` 存工具输出），按会话文件的大小与修改时间判断是否过期，过期或损坏即重建；会话文件已不在的缓存与崩溃留下的临时文件在检索时顺手清理。可随时删除整个目录，下次检索时重建。

三件工具同进同出：终端界面、`--line` 命令行对话与 `pigeon run` 的主会话缺省都带，worker 只有 explorer 角色带。使用者在终端界面与 `--line` 对话里用 `/search` 命令检索，走同一套检索与缓存，加 `--tool-output` 连同工具输出一起搜；人用的 `/search` 不排除当前会话。

## 迁移命令

```
pigeon migrate-config [--root <项目根>]
```

- 7 个旧配置文件各成一节写入设置：`permissions` 写项目个人 `.pigeon/settings.local.json`，其余写项目共享 `.pigeon/settings.json`；处理过的旧文件一律挪出仓库，原名原文放进用户级 `~/.pigeon/state/migration-backup/<项目目录名>-<哈希>/`（按项目的规范化路径分目录），迁移结束打印这个位置；仓库里不留备份（旧 `web.json` 里可能有 key，留在仓库里会进快照、沙箱容器与 worker 工作树，也可能被提交）。要取回 key 时从备份里找，改设为环境变量。
- 每次迁移都确保 `.pigeon/.gitignore`。
- `web.json` 里的 key 不写入，打印应设的环境变量名。
- `.pigeon/verify.json` 不并入设置：验证门已随决策 322 退役，迁移把它挪进备份目录，并打印把原验证命令改写为收尾（Stop）钩子的配置示例（分步配置按各步命令以 `&&` 连接）。
- 旧位置的程序状态移入 `.pigeon/state/`；worker 工作树用 `git worktree move` 移动。
- 已删除功能的遗留挪出仓库进用户级备份目录：旧学到的记忆（`.pigeon/learned/`、`.pigeon/state/learned/` 与它们的锁）、补做复盘记录（`.pigeon/review-backfill`、`.pigeon/state/review-backfill`）、复盘配置 `.pigeon/memory-review.json`、旧人写说明 `.pigeon/memory/`（另打印提示"把其中内容并入项目的 AGENTS.md"）。
- 用户级旧偏好 `~/.pigeon/preferences.md` 改名为 `~/.pigeon/AGENTS.md`；目标已存在即拦阻、不覆盖。
- 目标设置文件已存在时合并进去；同一节两边都有且内容不同则报错停下，不覆盖。
- 有 Pigeon 会话或 worker 正在运行（锁被占用）、或工作树被锁定时拒绝并说明。
- 可重复执行；没有要迁移的内容时如实说明。

启动时（终端界面、`pigeon --line`、`pigeon resume`、`pigeon run`）发现任一旧配置文件、旧位置的状态或已删除功能的遗留（复盘配置与补做记录、旧学到的记忆、`.pigeon/memory/`、`~/.pigeon/preferences.md`）即报错，提示运行 `pigeon migrate-config`，不自动迁移。

## 会话中途重读设置：`/reload`

终端界面里输入 `/reload` 重读三层设置，形成新快照：

- 执行命令类配置（命令短名、沙箱配置连同 Dockerfile、MCP 启动定义、钩子）与项目共享层的放行规则有变化（含首次出现）且未经确认的条目，照启动时的确认流程列出；`/reload confirm` 全部确认（记下指纹）并生效，`/reload skip` 不确认，这些条目沿用原内容，原来没有的不启用。新快照里的钩子自 `/reload` 起按新快照生效（终端界面在拦下或出错时的提示、`/hooks` 的清单随之更新）。
- 新快照自下一轮起生效：放权、命令短名、编排设定等此后即按新快照；此后派出的 worker、新开的脚本编排用新快照；运行面按新快照重建，结果行列出改了哪些节与重启、停止、启动的服务。
- MCP 服务只动有变化的：启动定义改了的重启，删掉的停止，新加的启动；启动定义未变的沿用原连接、不重启（只改风险档也不重启），服务自己的状态（例如浏览器类服务的登录与页面）得以保留。
- 系统提示里会话开始时读取并冻结的部分不随 `/reload` 变：人写的说明（AGENTS.md）、推送的两层记忆、Skill 目录沿用开局读到的内容，中途改这些文件要到下个会话才生效；由设置决定的部分（工具清单与工具说明、MCP 一段等）按新快照变。
- 正在跑的沙箱容器不重建：在沙箱会话里 `/reload` 且 `sandbox` 一节有变化时，提示退出后用 `pigeon resume <会话号> --sandbox` 续跑才对本会话的容器生效。
- 有 worker 在跑或主 agent 正在运行时不重读。
- `pigeon run` 与 `pigeon --line` 不设重载。

## 三道防线

缺省全开，不设开关。

1. **`.pigeon` 是受保护路径。** agent 用文件工具写 `.pigeon` 下任何路径都须人逐次批准：会话放权与配置放权都不能放行，worker 在自己工作树里写也一样；`--yolo` 下放行，拒绝名单照常优先。判定按规范化后的真实路径（含符号链接解析）做，大小写不敏感的文件系统上按不敏感比较；沙箱会话在容器里判定：路径按容器的工作区根规范化（写成容器内绝对路径的也算），容器里的符号链接经容器解析。批准提示写明这是受保护路径，只能批准这一次或拒绝，不提供放权键，脚本编排里也不算"同类都允许"。`take_worker` 与脚本整批收回要叠回的改动含 `.pigeon` 下的文件时同样按受保护路径请示，请示里列出这些文件。命令（`run_command`）写入不在此列，由第三道防线兜底。
2. **设置在会话开始时冻结。** 会话中途改设置文件只在下次启动或 `/reload` 之后生效，执行命令类的变化与项目共享层的放行规则照样经人确认。
3. **会执行命令或放权的配置按内容确认。** 范围：`commands` 一节的每个短名、`sandbox` 一节（连同它指向的项目 Dockerfile 的内容）、MCP 服务的每个启动定义（项目根 `.mcp.json` 与设置 `mcp` 一节里给了 `launch` 的）、`hooks` 一节的每个钩子（决策 324：逐条按事件、matcher、命令与执行位置记指纹），以及项目共享层 `.pigeon/settings.json` 里 `permissions` 一节的每条放行规则。内容与上次确认不同（含首次出现）时：
   - 终端界面与 `pigeon --line` 启动时逐条列出（来自哪一层、类型、标识、完整命令或内容摘要），可选全部确认（记下内容指纹）、本次不用这些条目、或退出。选本次不用时，本会话不启动那些 MCP 服务、不展开那些短名、沙箱不用该配置、那些放行规则不生效（相应的操作照常请示）。
   - 放行规则逐条确认：每条规则按整条内容（规范化 JSON 的 sha256）记指纹，列出时标识为指纹前 12 位、内容为整条规则；规则内容一变即是新的一条，须重新确认；同样内容的多条只确认一次。克隆来的仓库可能自带放行规则，例如 `{"tool":"run_command","shell":true}`（不写具体命令）即放行全部命令，确认前它不生效。用户级与项目个人层 `settings.local.json` 的放权由使用者自己写入，直接生效、不需确认。
   - 钩子逐条确认：每个钩子按事件、matcher、命令、超时与执行位置记指纹（决策 324）；内容一变即是新的一条，须重新确认；三层给出的钩子都算。
   - `pigeon run` 开跑前报错退出并逐条列出；加 `--trust-config` 只对本次运行放行，不记指纹。
   - 项目位于用户级设置 `trustedDirectories` 中任一目录之下时免于本道确认；项目级设置写这个键即报错（项目不能为自己免检），相对路径也报错。

## 钩子

钩子是在会话的各个时刻自动执行的命令（决策 323 / 324）。一切照 Claude Code 的协议做，工具名用 Pigeon 自己的。

### 配置结构

`hooks` 一节：事件名 → matcher 组数组；每组有一个可选 `matcher` 与一个 `hooks` 数组；每个钩子只支持 `type: "command"`（保留 `type` 字段以便以后扩展）：

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "npm test", "timeout": 600 }]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "run_command",
        "hooks": [{ "type": "command", "command": "node check-danger.mjs" }]
      }
    ]
  },
  "disableAllHooks": false,
  "stopHookBlockCap": 8
}
```

- `matcher`：工具类事件按正则匹配 Pigeon 的工具名（非锚定；`Edit` 也命中 `Edit|Write` 这类写法请写成 `^edit_file$` 这样的显式正则）；其余事件匹配各自的取值（`SessionStart` 的 `source`、`SessionEnd` 的 `reason`、`PreCompact`/`PostCompact` 的 `trigger`、`Notification` 的通知种类）。缺省、`*` 与空串匹配全部。非法正则在校验时报错。
- `timeout`：秒。缺省：`UserPromptSubmit` 30 秒、`SessionEnd` 1.5 秒（单个钩子可提高，最长 60 秒）、其余 600 秒。
- `host`：可选布尔；`true` 表示这个钩子在宿主执行（沙箱会话里其余钩子在容器里执行）。
- 三层合并：各层的条目并列生效（不去重事件或 matcher）；同一事件同一 `matcher` 下命令完全相同的只执行一次。
- `disableAllHooks`：顶层键，停用全部钩子（三层按标量覆盖，高优先层说了算）。启动参数 `--no-hooks` 只对本次运行停用全部钩子。
- `stopHookBlockCap`：收尾钩子连续拦截上限，缺省 8。
- 钩子在会话开始时随设置快照冻结；每个钩子逐条接入执行命令类配置的内容确认（第三道防线），内容一变须重新确认。

### 事件

首批 13 个（决策 323）：

| 事件 | 何时触发 | 能做什么 |
| --- | --- | --- |
| `SessionStart` | 会话开始或续跑时 | 补上下文（以一条上下文消息进入，不改开局冻结的系统提示） |
| `SessionEnd` | 会话结束（退出、换绑、`pigeon run` 结束） | 只作副作用 |
| `UserPromptSubmit` | 使用者的输入交给模型之前 | 拦下、补上下文；不能改写 |
| `PreToolUse` | 工具调用之前、审批之前 | 拒绝、要人确认、放行、改参数、补上下文 |
| `PostToolUse` | 工具调用成功之后 | 替换工具结果、把理由交给模型、补上下文 |
| `PostToolUseFailure` | 工具调用失败之后 | 把理由交给模型、补上下文 |
| `Stop` | 一轮回复收尾 | 拦住要求接着干、补上下文 |
| `StopFailure` | 一轮以出错结束 | 只作副作用 |
| `SubagentStart` | worker 派出（含续做）时 | 补上下文 |
| `SubagentStop` | worker 收尾 | 拦住要求接着干、补上下文 |
| `PreCompact` | 上下文压缩之前 | 只通知，不能拦（拦下压缩会让下一次请求超长出错） |
| `PostCompact` | 压缩完成之后 | 只作副作用 |
| `Notification` | 需要使用者注意时 | 只作副作用 |

`PreToolUse` 的结论合并：拒绝 > 要人确认 > 放行。**放行只免掉人工审批这一步**——拒绝名单、路径围栏与受保护路径照常生效；改过的参数重新经过全部检查。工具类事件在 worker 内同样触发；`Stop`/`SubagentStop` 连续拦截到上限（`stopHookBlockCap`）后不再理会、照常结束，结束原因记为"收尾钩子拦截到上限"（不贴失败标签）。

### 协议

事件信息以 JSON 经标准输入交给命令（公共字段：`session_id`、`cwd`、`hook_event_name`；各事件自己的字段如 `tool_name`/`tool_input`/`tool_use_id`、`prompt`、`source`、`trigger`、`stop_hook_active`、`last_assistant_message`、`error`、`message` 等照 Claude Code）。环境变量 `PIGEON_PROJECT_DIR` 指向项目根。

退出码：`0` 放行；`2` 拦下（标准错误为理由）；其他为钩子自身出错，不拦只提示。标准输出可以是一个 JSON 对象：

```json
{ "continue": false, "stopReason": "停下", "systemMessage": "注意",
  "decision": "block", "reason": "理由",
  "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny",
    "permissionDecisionReason": "理由", "updatedInput": { "…": "改后的参数" },
    "additionalContext": "补的上下文", "updatedToolOutput": "替换后的工具结果" } }
```

同一事件命中多个钩子时并行执行；每个钩子的运行写入会话记录（事件、命令、退出码、用时、结论、输出摘要），`pigeon trace` 与会话回放显示；终端界面在拦下或出错时显示一行提示，`/hooks` 列出生效的钩子及其来自哪一层。

### 执行位置

钩子在工作区所在处执行：本机会话在本机、沙箱会话在容器里（经执行端）；`host: true` 的单个钩子指定在宿主执行。超时或取消时杀掉整棵进程树（非 Windows 用独立进程组、Windows 用 `taskkill /T /F`）。`pigeon --line` 不接钩子；实验跑批器不读使用者的用户级与项目级钩子。

### 示例

收尾时跑测试（原验证门的替代）：

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "npm test" }] }
    ]
  }
}
```

拦危险命令：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "run_command",
        "hooks": [{ "type": "command", "command": "node .pigeon/hooks/deny-danger.mjs" }]
      }
    ]
  }
}
```

`deny-danger.mjs` 从标准输入读事件 JSON，命中危险命令时以退出码 2 结束并把理由写到标准错误：

```js
let data = "";
process.stdin.on("data", (chunk) => (data += chunk));
process.stdin.on("end", () => {
  const input = JSON.parse(data);
  const command = String(input.tool_input?.command ?? "");
  if (/\brm\s+-rf\b/.test(command)) {
    process.stderr.write("禁用 rm -rf：请改用可审计的删除方式");
    process.exit(2);
  }
  process.exit(0);
});
```

钩子执行项目代码（脚本、测试），这些代码 agent 可以改；需要隔离时用沙箱会话。
