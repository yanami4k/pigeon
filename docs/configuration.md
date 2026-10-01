# 配置与状态目录

本页说明 Pigeon 的设置文件、程序状态目录、迁移命令与配置相关的安全防线（决策 325、326）。

## 三层设置

| 层 | 位置 | 是否提交 |
| --- | --- | --- |
| 用户级 | `~/.pigeon/settings.json` | 不在项目里 |
| 项目共享 | `.pigeon/settings.json` | 可提交 |
| 项目个人 | `.pigeon/settings.local.json` | 不提交 |

优先级：项目个人 > 项目共享 > 用户级。合并规则：对象按键逐层合并，标量与数组由高优先层整体替换；唯一例外是 `permissions` 的放权规则，三层并集生效。

设置在会话开始时读一次，形成本会话的设置快照；会话中途改文件不生效，下次启动才生效。worker 与沙箱会话沿用派出它的会话的快照。

文件不是合法 JSON、出现未知键（顶层或节内）、写了 key、项目级写了 `trustedDirectories`，或合并后不成立（例如角色清单引用了各层都没有的命令短名），启动时报错并指出文件、键与所在层。整个文件可以有一个 `$schema` 键。

## 各节

| 节 | 内容 | 原文件 |
| --- | --- | --- |
| `mcp` | MCP 服务的风险档覆盖（`servers.<名>.defaultTier`、`tools`），也可用 `launch` 直接定义服务 | `.pigeon/mcp.json` |
| `permissions` | 固化的放权规则 `grants`；`/grants save` 写入项目个人一层，`/revoke config#N` 从中删除 | `.pigeon/grants.json` |
| `commands` | 命令短名 `commands` 与角色允许清单 `roles` | `.pigeon/commands.json` |
| `orchestration` | worker 并发、层数、上限、卡住判定、任务清单、脚本编排 | `.pigeon/orchestration.json` |
| `web` | 搜索后端与地址、抓取上限 | `.pigeon/web.json` |
| `sandbox` | 沙箱镜像（`image` 或项目自己的 `dockerfile`、`context`）与通用镜像的构建参数 `build` | `.pigeon/sandbox.json` |
| `loopGuard` | 打转检测的开关、轮数与豁免工具 | `.pigeon/loop-guard.json` |

各节字段与原文件相同，去掉了各文件自己的 `version`。项目根的 `.mcp.json` 留在原处，格式不变。`.pigeon/verify.json` 与 `.pigeon/memory-review.json` 暂不并入，照旧读取。

另有只能写在用户级的 `trustedDirectories`（路径数组），见下文第三道防线。

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

程序写的东西都在 `.pigeon/state/` 下：会话（`sessions/`）、学到的记忆（`learned/` 与 `learned.lock`）、worker 工作树（`worktrees/`）、补做复盘记录（`review-backfill/`）、终端界面的输入历史（`tui-history.json`）与日志（`logs/`）。用户级的程序状态（配置确认记录 `config-trust.json`）在 `~/.pigeon/state/`。

人写的内容留在原处：`.pigeon/skills`、`~/.pigeon/skills`、`.pigeon/memory`、`~/.pigeon/preferences.md`。

Pigeon 第一次在项目里建 `.pigeon/state/` 或 `settings.local.json` 时，若 `.pigeon/.gitignore` 不存在，写入一份，内容为 `state/` 与 `settings.local.json` 两行；已存在则不改，缺这两行时在终端提示一行。

快照、checkpoint 与 worker 改动叠加只排除 `.pigeon/state` 与 `.pigeon/settings.local.json`；仓库已跟踪的 `.pigeon/settings.json` 与 `.pigeon/skills` 是项目内容，照常进快照与叠加。列目录与命令的文件变化报告仍不列整个 `.pigeon`。

## 会话检索

agent 可以查本项目以前的会话，共三件工具，都是只读、免审批：

- `search_sessions`：按关键词检索以前会话里的对话。关键词大小写不敏感、按字面匹配，最多 8 个，任一命中即列出，按命中的关键词数从多到少、同数从新到旧排序，每条标出命中了哪些关键词，最多 20 条。
- `read_session_entry`：按条目号读一条消息的完整原文（含思考内容与工具输出）。
- `list_sessions`：列出以前的会话，每个给出会话编号、开始时间、第一句使用者的话与改动过的文件（`edit_file` 的写入与 `run_command` 报告的文件变化），可按开始时间与文件路径筛选，最多 20 个。

缺省范围：检索与会话目录都不含当前会话所在的这一组会话，即当前会话本身（续接的会话也算）、派出它的会话、它派出的 worker 与分叉；检索只搜对话正文，即使用者的话与模型回复的文字，不含思考内容与工具调用；以前的工具输出（命令输出、读过的文件内容）要在调用时给 `includeToolOutput: true` 才一起搜。这三件工具自身的输出任何时候都不进检索。

缓存：每个会话文件抽出的可搜文本与目录信息缓存在 `.pigeon/state/search-cache/`，每个会话两份（`<会话号>.json` 存目录信息与对话正文，`<会话号>.tools.json` 存工具输出），按会话文件的大小与修改时间判断是否过期，过期或损坏即重建；会话文件已不在的缓存与崩溃留下的临时文件在检索时顺手清理。可随时删除整个目录，下次检索时重建。

三件工具同进同出：终端界面、`--line` 命令行对话与 `pigeon run` 的主会话缺省都带，worker 只有 explorer 角色带。使用者在终端界面与 `--line` 对话里用 `/search` 命令检索，走同一套检索与缓存，加 `--tool-output` 连同工具输出一起搜；人用的 `/search` 不排除当前会话。

## 迁移命令

```
pigeon migrate-config [--root <项目根>]
```

- 7 个旧配置文件各成一节写入设置：`permissions` 写项目个人 `.pigeon/settings.local.json`，其余写项目共享 `.pigeon/settings.json`；旧文件改名为 `<原名>.bak`。
- `web.json` 里的 key 不写入，打印应设的环境变量名。
- 旧位置的程序状态移入 `.pigeon/state/`；worker 工作树用 `git worktree move` 移动。
- 目标设置文件已存在时合并进去；同一节两边都有且内容不同则报错停下，不覆盖。
- 有 Pigeon 会话或 worker 正在运行（锁被占用）、或工作树被锁定时拒绝并说明。
- 可重复执行；没有要迁移的内容时如实说明。

启动时（终端界面、`pigeon --line`、`pigeon resume`、`pigeon run`）发现任一旧配置文件或旧位置的状态即报错，提示运行 `pigeon migrate-config`，不自动迁移。

## 三道防线

缺省全开，不设开关。

1. **`.pigeon` 是受保护路径。** agent 用文件工具写 `.pigeon` 下任何路径都须人逐次批准：会话放权与配置放权都不能放行，worker 在自己工作树里写也一样；`--yolo` 下放行，拒绝名单照常优先。判定按规范化后的真实路径（含符号链接解析）做，大小写不敏感的文件系统上按不敏感比较。批准提示写明这是受保护路径。命令（`run_command`）写入不在此列，由第三道防线兜底。
2. **设置在会话开始时冻结。** 会话中途改设置文件只在下次启动生效。
3. **会执行命令的配置按内容确认。** 范围：`commands` 一节的每个短名、`sandbox` 一节（连同它指向的项目 Dockerfile 的内容）、MCP 服务的每个启动定义（项目根 `.mcp.json` 与设置 `mcp` 一节里给了 `launch` 的）。内容与上次确认不同（含首次出现）时：
   - 终端界面与 `pigeon --line` 启动时逐条列出（来自哪一层、类型、标识、完整命令或内容摘要），可选全部确认（记下内容指纹）、本次不用这些条目、或退出。选本次不用时，本会话不启动那些 MCP 服务、不展开那些短名、沙箱不用该配置。
   - `pigeon run` 开跑前报错退出并逐条列出；加 `--trust-config` 只对本次运行放行，不记指纹。
   - 项目位于用户级设置 `trustedDirectories` 中任一目录之下时免于本道确认；项目级设置写这个键即报错（项目不能为自己免检）。

钩子执行的项目代码（脚本、测试）agent 可以改；需要隔离时用沙箱会话（`--sandbox`）。
