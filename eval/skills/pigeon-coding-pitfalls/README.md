# pigeon-coding-pitfalls

M6.5 Eval 冒烟对照用的手写 Skill（decisions.md 059 与其修订）。

- `candidate/`：候选版本，由人手写，不经自动管线。
- `approved/`：项目负责人核对候选后复制的同一份文件，作为"已批准"条件。两个目录内容一致时，候选对已批准这一组对照验证的是注入管线；无 Skill 对有 Skill 才验证经验本身的效果。
- runner 的三个条件分别以空、`candidate/`、`approved/` 作为 skillRoots；每次运行的 run.started 记下 Skill 文件的哈希清单，可与本目录文件对账。

## 内容来源

从既有审计里模型在真实 provider 链路上实际出现过的失误提炼，另补从工具约定推出的操作要点：

- edit_file 的 `lines` 带入分隔空格导致新行多出前导空格：docs/audits/2026-09-12-m4-real-provider-acceptance.md 观察 O-2；docs/audits/2026-09-13-m5-5-8ac7266.md S6 结果后的观察。
- 要求调用工具时未发起调用、直接写出结果：docs/audits/2026-09-13-m5-ba94b53.md 剧本 m5a 第 3 步。
- 其余条目（锚点与快照格式、op 种类、重叠编辑与行号漂移、run_command 不经 shell、Windows .cmd 参数字符集、输出截断与超时、熔断阈值）来自 src/tools 与 src/application/runtime.ts 对模型暴露的约定。

写作时未查看任务集，holdout 任务对 Skill 作者不可见。

## 适用范围与已知问题

- 本 Skill 写于 hashline 为缺省编辑模式时。第 1 节（read_file 的 `N#TAG` 锚点，edit_file 的 anchor、snapshot、lines 与 op）只适用于 `--edit-mode hashline`；decisions.md 062 起缺省编辑模式为 replace，第 1 节在缺省模式下不适用。
- 第 1 节"同一调用连续被拦 3 次会中止整个运行"与实现不符：编辑失败是工具执行报错，不计入熔断；熔断只针对治理阻断（同一 key 在一个 Run 内累计满 3 次）与上游拦截（工具不存在或参数不合 schema，同一工具连续 3 次）。
- `candidate/` 与 `approved/` 下的 SKILL.md 是 M6.5 冒烟实际注入的版本，哈希记录在该次运行的会话启动快照与 docs/audits/2026-09-14-m6-5-8e76567.md 中，保持原样不改。后续评测如需适配 replace 的版本，另建 Skill 目录并重新审阅。

## 许可

随本仓库。
