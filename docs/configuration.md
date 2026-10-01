# 配置与状态目录

本页说明 Pigeon 的设置文件、程序状态目录、迁移命令与配置相关的安全防线（决策 325、326、340、341）。

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

各节字段与原文件相同，去掉了各文件自己的 `version`。项目根的 `.mcp.json` 留在原处，格式不变。`.pigeon/verify.json` 与 `.pigeon/memory-review.json` 暂不并入，照旧读取。

另有只能写在用户级的 `trustedDirectories`（路径数组，只接受绝对路径或 `~` 开头），见下文第三道防线。

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

程序写的东西都在 `.pigeon/state/` 下：会话（`sessions/`）、学到的记忆（`learned/` 与 `learned.lock`）、worker 工作树（`worktrees/`）、补做复盘记录（`review-backfill/`）、终端界面的输入历史（`tui-history.json`）与日志（`logs/`）。用户级的程序状态（配置确认记录 `config-trust.json`、迁移备份 `migration-backup/`）在 `~/.pigeon/state/`。

人写的内容留在原处：`.pigeon/skills`、`~/.pigeon/skills`、`.pigeon/memory`、`~/.pigeon/preferences.md`。

Pigeon 第一次在项目里建 `.pigeon/state/` 或 `settings.local.json` 时，若 `.pigeon/.gitignore` 不存在，写入一份，内容为 `state/` 与 `settings.local.json` 两行；已存在则不改，缺这两行时在终端提示一行。

快照、checkpoint 与 worker 改动叠加只排除 `.pigeon/state` 与 `.pigeon/settings.local.json`；仓库已跟踪的 `.pigeon/settings.json` 与 `.pigeon/skills` 是项目内容，照常进快照与叠加。列目录与命令的文件变化报告仍不列整个 `.pigeon`。

## 迁移命令

```
pigeon migrate-config [--root <项目根>]
```

- 7 个旧配置文件各成一节写入设置：`permissions` 写项目个人 `.pigeon/settings.local.json`，其余写项目共享 `.pigeon/settings.json`；处理过的旧文件一律挪出仓库，原名原文放进用户级 `~/.pigeon/state/migration-backup/<项目目录名>-<哈希>/`（按项目的规范化路径分目录），迁移结束打印这个位置；仓库里不留备份（旧 `web.json` 里可能有 key，留在仓库里会进快照、沙箱容器与 worker 工作树，也可能被提交）。要取回 key 时从备份里找，改设为环境变量。
- 每次迁移都确保 `.pigeon/.gitignore`。
- `web.json` 里的 key 不写入，打印应设的环境变量名。
- 旧位置的程序状态移入 `.pigeon/state/`；worker 工作树用 `git worktree move` 移动。
- 目标设置文件已存在时合并进去；同一节两边都有且内容不同则报错停下，不覆盖。
- 有 Pigeon 会话或 worker 正在运行（锁被占用）、或工作树被锁定时拒绝并说明。
- 可重复执行；没有要迁移的内容时如实说明。

启动时（终端界面、`pigeon --line`、`pigeon resume`、`pigeon run`）发现任一旧配置文件或旧位置的状态即报错，提示运行 `pigeon migrate-config`，不自动迁移。

## 会话中途重读设置：`/reload`

终端界面里输入 `/reload` 重读三层设置，形成新快照：

- 执行命令类配置（命令短名、沙箱配置连同 Dockerfile、MCP 启动定义）与项目共享层的放行规则有变化（含首次出现）且未经确认的条目，照启动时的确认流程列出；`/reload confirm` 全部确认（记下指纹）并生效，`/reload skip` 不确认，这些条目沿用原内容，原来没有的不启用。
- 新快照自下一轮起生效：放权、命令短名、编排设定等此后即按新快照；此后派出的 worker、新开的脚本编排用新快照；运行面按新快照重建，结果行列出改了哪些节与重启、停止、启动的服务。
- MCP 服务只动有变化的：启动定义改了的重启，删掉的停止，新加的启动；启动定义未变的沿用原连接、不重启（只改风险档也不重启），服务自己的状态（例如浏览器类服务的登录与页面）得以保留。
- 系统提示里会话开始时读取并冻结的部分不随 `/reload` 变：常驻 Memory（`.pigeon/memory` 与 `~/.pigeon/preferences.md`）、推送的记忆、Skill 目录沿用开局读到的内容，中途改这些文件要到下个会话才生效；由设置决定的部分（工具清单与工具说明、MCP 一段等）按新快照变。
- 正在跑的沙箱容器不重建：在沙箱会话里 `/reload` 且 `sandbox` 一节有变化时，提示退出后用 `pigeon resume <会话号> --sandbox` 续跑才对本会话的容器生效。
- 有 worker 在跑或主 agent 正在运行时不重读。
- `pigeon run` 与 `pigeon --line` 不设重载。

## 三道防线

缺省全开，不设开关。

1. **`.pigeon` 是受保护路径。** agent 用文件工具写 `.pigeon` 下任何路径都须人逐次批准：会话放权与配置放权都不能放行，worker 在自己工作树里写也一样；`--yolo` 下放行，拒绝名单照常优先。判定按规范化后的真实路径（含符号链接解析）做，大小写不敏感的文件系统上按不敏感比较；沙箱会话在容器里判定：路径按容器的工作区根规范化（写成容器内绝对路径的也算），容器里的符号链接经容器解析。批准提示写明这是受保护路径，只能批准这一次或拒绝，不提供放权键，脚本编排里也不算"同类都允许"。`take_worker` 与脚本整批收回要叠回的改动含 `.pigeon` 下的文件时同样按受保护路径请示，请示里列出这些文件。命令（`run_command`）写入不在此列，由第三道防线兜底。
2. **设置在会话开始时冻结。** 会话中途改设置文件只在下次启动或 `/reload` 之后生效，执行命令类的变化与项目共享层的放行规则照样经人确认。
3. **会执行命令或放权的配置按内容确认。** 范围：`commands` 一节的每个短名、`sandbox` 一节（连同它指向的项目 Dockerfile 的内容）、MCP 服务的每个启动定义（项目根 `.mcp.json` 与设置 `mcp` 一节里给了 `launch` 的），以及项目共享层 `.pigeon/settings.json` 里 `permissions` 一节的每条放行规则。内容与上次确认不同（含首次出现）时：
   - 终端界面与 `pigeon --line` 启动时逐条列出（来自哪一层、类型、标识、完整命令或内容摘要），可选全部确认（记下内容指纹）、本次不用这些条目、或退出。选本次不用时，本会话不启动那些 MCP 服务、不展开那些短名、沙箱不用该配置、那些放行规则不生效（相应的操作照常请示）。
   - 放行规则逐条确认：每条规则按整条内容（规范化 JSON 的 sha256）记指纹，列出时标识为指纹前 12 位、内容为整条规则；规则内容一变即是新的一条，须重新确认；同样内容的多条只确认一次。克隆来的仓库可能自带放行规则，例如 `{"tool":"run_command","shell":true}`（不写具体命令）即放行全部命令，确认前它不生效。用户级与项目个人层 `settings.local.json` 的放权由使用者自己写入，直接生效、不需确认。
   - `pigeon run` 开跑前报错退出并逐条列出；加 `--trust-config` 只对本次运行放行，不记指纹。
   - 项目位于用户级设置 `trustedDirectories` 中任一目录之下时免于本道确认；项目级设置写这个键即报错（项目不能为自己免检），相对路径也报错。

钩子执行的项目代码（脚本、测试）agent 可以改；需要隔离时用沙箱会话（`--sandbox`）。
