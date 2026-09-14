# M0 Day 3 — pi-agent-core harness 层复用/自建审计表

> 对象：`@earendil-works/pi-agent-core@0.84.4`（package.json 精确锁定）的 `dist/harness/` 全模块。
> 依据：`docs/notes/harness/` 行为笔记（以 `.js` 实现为准）+ `docs/source-annotations/harness/` 注释版；上游声明文件仅作核对。
> 决策取值：`import`（直接依赖调用）/ `包装`（import 后前后挂治理逻辑）/ `自建`（自己写）/ `参考实现`（抄设计、自己写）/ `延后决策` / `不接入`。
> 叙事角色取值：`差异化证据` / `基础设施复用` / `仅设计参考` / `延后决策`。

| 模块 | 决策 | 一句话理由 | 叙事角色 |
|---|---|---|---|
| harness/agent-harness | 不接入 | 0.84.4 整体是蓝图桩：除配置 getter/setter 与 close 外全部方法 reject `HarnessNotImplemented`，连 hook 注册表都是假的，但其 11 个 hook 名、RunOutcome 四态、步进执行器词汇值得对齐（见 docs/notes/harness/agent-harness.d.ts+agent-harness.js.zh-CN.md） | 仅设计参考 |
| harness/session/jsonl（storage/codec/repo/errors/types） | 参考实现 | 要兼容上游 v4 JSONL 格式（header/mutation schema 的类型载体在 types、JsonlDecodeError 的 syntax/schema 二分在 errors、原子 rename 发布、cwd 分桶目录），但存储引擎按 Pigeon 治理需求自建（见 docs/notes/harness/session/jsonl/storage.d.ts+storage.js.zh-CN.md、codec.d.ts+codec.js.zh-CN.md、repo.d.ts+repo.js.zh-CN.md） | 基础设施复用 |
| harness/tools/bash | 包装 | bash.js 自身零直接副作用、副作用全部收敛在 `env` 层的 `executeShellWithCapture`，逻辑成熟，前后挂 `beforeToolCall` 审批与 Receipt 即可（见 docs/notes/harness/tools/bash.d.ts+bash.js.zh-CN.md） | 基础设施复用 |
| harness/tools/read | 包装 | 读取/截断/图片分流逻辑成熟，包装后 Receipt 记录解析路径、字节数、MIME、offset/limit 与 truncation（见 docs/notes/harness/tools/read.d.ts+read.js.zh-CN.md） | 基础设施复用 |
| harness/tools/write | 包装 | 覆盖写本身不做 diff/备份/hash 校验，审批必须在 `beforeToolCall`、最终防线包 `env.writeFile`，Receipt 记预写 hash 与真实字节数（见 docs/notes/harness/tools/write.d.ts+write.js.zh-CN.md） | 基础设施复用 |
| harness/tools/edit | 参考实现 | oldText 精确替换对模型摩擦高，参考 oh-my-pi hashline 降摩擦方案自建，但保留"校验全部通过才整文件覆写、队列临界区内落盘"的副作用形状（见 docs/notes/harness/tools/edit.d.ts+edit.js.zh-CN.md） | 差异化证据 |
| harness/reducer | 参考实现 | "validate→reduce 两段式、12 种机器可读 corruption 枚举、ProvisionedEntry 一票一账"的崩溃恢复协议形状直接抄入 M4 治理状态机（见 docs/notes/harness/reducer.d.ts+reducer.js.zh-CN.md） | 仅设计参考 |
| harness/session/testing（conformance/types） | import | 现成的 SessionBackend 契约测试套件（types 是其 fixture/case 类型契约），直接当自建持久化后端的验收标准（见 docs/source-annotations/harness/session/testing/conformance.d.ts.zh-CN.md） | 基础设施复用 |
| harness/telemetry | 自建 | 它的 telemetry 是 pi-telemetry 后端的观测词汇表，Pigeon 的 Trace 是治理证据，语义不同，仅借鉴"稳定错误码 + 低基数错误类别"双字段设计（见 docs/notes/harness/telemetry.d.ts+telemetry.js.zh-CN.md） | 差异化证据 |
| harness/compaction | 延后决策 | M5 才需要上下文压缩，届时按"摘要不是事实证据"的治理要求重估（见 docs/notes/harness/compaction/compaction.d.ts+compaction.js.zh-CN.md） | 延后决策 |
| harness/skills | 延后决策 | M5 才需要技能体系，届时按"名称→SKILL.md→references"渐进加载三层设计重估（见 docs/notes/harness/skills.d.ts+skills.js.zh-CN.md） | 延后决策 |
| harness/events | 参考实现 | 0.84.4 里是零实例化点的协议件，`watch` 的"先注册缓冲、再拍快照、start 顺序冲刷"防快照-订阅竞争设计抄进 Pigeon 治理事件总线，并补上游没有的 listener 异常隔离（见 docs/notes/harness/events.d.ts+events.js.zh-CN.md） | 仅设计参考 |
| harness/messages | 包装 | `convertToLlm` 的 role 适配逻辑成熟且与要兼容的 entry 类型对齐，外层补"未知 role 被静默丢弃"的显式治理记录（见 docs/notes/harness/messages.d.ts+messages.js+result.d.ts+result.js.zh-CN.md） | 基础设施复用 |
| harness/result | import | 极薄 Result + `TaggedError` 工厂直接作治理 API 边界的稳定错误码基础，持久化后按 `_tag` 显式重建实例（见 docs/notes/harness/messages.d.ts+messages.js+result.d.ts+result.js.zh-CN.md） | 基础设施复用 |
| harness/prompt-templates | 包装 | 容错加载器全走 ExecutionEnv 抽象，外层挂 source provenance 与调用前参数审计；其参数替换是刻意简化的 shell 语义，治理侧需自行约束参数边界（见 docs/notes/harness/prompt-templates.d.ts+prompt-templates.js.zh-CN.md） | 基础设施复用 |
| harness/system-prompt | 延后决策 | 仅 `formatSkillsForSystemPrompt` 一个函数且服务于 skills 体系，M5 与 skills 一并重估（见 docs/notes/harness/skills.d.ts+skills.js.zh-CN.md §7） | 延后决策 |
| harness/types | import | 纯类型加 `ok/err/getOrThrow/getOrUndefined/toError` 极薄 helper，import 保持与上游 vocabulary 对齐（见 docs/notes/harness/messages.d.ts+messages.js+result.d.ts+result.js.zh-CN.md） | 基础设施复用 |
| harness/session/session | 参考实现 | 提交前 `assertJsonSerializable` 断言、lane 闭包视图、query 入口校验等门面语义抄入自建 Session，实现随自建存储重写（见 docs/notes/harness/session/session.d.ts+session.js.zh-CN.md） | 仅设计参考 |
| harness/session/state | 参考实现 | seq 恰好连续、parent 必须链到 lane 叶、usedIds 全局去重等 mutation 不变量是自建崩溃恢复重放校验的蓝本（见 docs/notes/harness/session/state.d.ts+state.js.zh-CN.md） | 仅设计参考 |
| harness/session/context | 参考实现 | "末次 compaction 截断、deferred assistant 丢弃、transform/projector 挂接"的投影规则抄入自建上下文投影，治理摘要经 entryTransforms 注入（见 docs/notes/harness/session/context.d.ts+context.js.zh-CN.md） | 仅设计参考 |
| harness/session/memory | import | 现成的确定性内存后端直接作治理流程单元/冒烟测试 storage，注意其 fork 不复制 record、不能当生产持久化语义（见 docs/notes/harness/session/memory.d.ts+memory.js.zh-CN.md） | 基础设施复用 |
| harness/session/types | 参考实现 | entry/record 类型契约是 JSONL 格式与恢复协议的载体，自建持久化须按它对齐才能做到格式兼容（见 docs/notes/harness/reducer.d.ts+reducer.js.zh-CN.md §0、docs/notes/harness/session/jsonl/codec.d.ts+codec.js.zh-CN.md） | 基础设施复用 |
| harness/tools/edit-diff | import | 零副作用纯算法层，`generateUnifiedPatch` 的输出直接作 Receipt 的 patch 凭证无需重算（见 docs/notes/harness/tools/edit-diff.d.ts+edit-diff.js.zh-CN.md） | 基础设施复用 |
| harness/tools/file-mutation-queue | 包装 | 按 env + canonical path 串行的队列逻辑成熟，包装 `env.canonicalPath` 与 `fn` 以记录 canonical 路径、等待时长与变更前后快照（见 docs/notes/harness/tools/file-mutation-queue.d.ts+file-mutation-queue.js.zh-CN.md） | 基础设施复用 |
| harness/tools/image | import | 纯 magic-bytes 检测与手写 Base64 无状态无副作用，直接复用并在 Receipt 记录检测出的 MIME 与原始字节数（见 docs/notes/harness/tools/image.d.ts+image.js.zh-CN.md） | 基础设施复用 |
| harness/tools/path-utils | 包装 | resolver 不做沙箱判断且读取会猜 5 种文件名变体，包装以记录 raw/resolved/selected variant 并接 env 作最终防线（见 docs/notes/harness/tools/path-utils.d.ts+path-utils.js.zh-CN.md） | 基础设施复用 |
| harness/tools/tool-context | 参考实现 | 运行时为空、只有 `ExecutionToolContext` 类型，DI 边界形状照抄，沙箱/审批/计量集中在 Pigeon 自有 ExecutionEnv 实现里（见 docs/notes/harness/tools/tool-context.d.ts+tool-context.js.zh-CN.md） | 仅设计参考 |
| harness/tools/index | 不接入 | 纯 barrel 只转出四个工具工厂、不注册不审批不包装，Pigeon 在自建注册点装配工具并统一挂 toolCallId 审批与 Receipt（见 docs/notes/harness/tools/index.d.ts+index.js+tool-context.d.ts+tool-context.js+path-utils.d.ts+path-utils.js.zh-CN.md） | 仅设计参考 |
| harness/compaction/branch-summarization | 延后决策 | 与 compaction 共用摘要管线、同样 M5 才需要，届时随压缩体系一并重估（见 docs/notes/harness/compaction/branch-summarization.d.ts+branch-summarization.js.zh-CN.md） | 延后决策 |
| harness/compaction/utils | 延后决策 | 摘要管线共用的文件操作工具函数，M5 随 compaction 一并重估（见 docs/notes/harness/compaction/branch-summarization.d.ts+branch-summarization.js.zh-CN.md §0） | 延后决策 |
| harness/env/nodejs | 延后决策 | 尚无行为笔记，上游具体 env 实现与 Pigeon 自带沙箱/审计的 ExecutionEnv 关系未定（触发条件见文末登记） | 延后决策 |
| harness/utils/shell-output | 包装 | bash 的起子进程与截断后完整输出写临时文件都在这层，随 bash 包装一并接入并以 env 层兜底（见 docs/notes/harness/tools/bash.d.ts+bash.js.zh-CN.md §2） | 基础设施复用 |
| harness/utils/truncate | 包装 | read 的默认行数/字节截断由 `truncateHead` 承担，随 read 包装复用（见 docs/notes/harness/tools/read.d.ts+read.js.zh-CN.md） | 基础设施复用 |

备注：`harness/session/index`、`harness/session/jsonl`、`harness/session/testing/index` 三个 barrel 文件仅做转出、无独立逻辑，不单列。

## 延后决策登记

| 事项 | 触发条件 |
|---|---|
| TypeScript 7 升级 | dependency-cruiser 发布支持 TS7 API 的版本（背景：M0 Day 1 typescript 从 7.0.2 降到 6.0.3，因 dependency-cruiser 18.x 在 TS7 下静默巡航 0 模块导致 verify 假绿） |
| harness/compaction | M5 上下文压缩立项时重估 |
| harness/skills | M5 技能体系立项时重估 |
| harness/system-prompt | 随 harness/skills，M5 一并重估 |
| harness/compaction/branch-summarization | 随 harness/compaction，M5 一并重估 |
| harness/compaction/utils | 随 harness/compaction，M5 一并重估 |
| harness/env/nodejs | M1 实现 Pigeon ExecutionEnv 之前补读该模块源码并立决策 |
| @anthropic-ai/sdk override 的运行期兼容验证 | 首次接入 Anthropic provider 之前。背景：M1 提交 476d226 用 overrides 把锁树里的 @anthropic-ai/sdk 从 0.91.1 强升到 0.124.0（0.91.1 的类型在 skipLibCheck:false 下炸 TS2307）；pi-ai 0.84.4 走 Anthropic provider 时运行期实际使用 0.124.0，届时需验证兼容性。当前不用 Anthropic，无实际影响 |
