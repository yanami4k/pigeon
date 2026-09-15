# 主干缺陷修复审计与验证证据（基线 eef6609）

- 日期：2026-09-15
- 施工位置：隔离 git 工作树（分支 worktree-fix-eval-found-defects），自 dev = main = origin 的 eef6609 开出
- 来源：Eval 任务集编写时在 8e76567 上发现的 4 个真实缺陷（任务 path-dotdot-name、tool-error-codes、args-summary-surrogate、insert-after-diff），外加同类的 Skill 资源围栏缺陷；缺陷口径以各任务的 task.md 为准
- 按 decisions.md 047 入库，只追加不覆盖

## 方法

- 测试先行：每个 Eval 任务的隐藏测试资产原样拷进 `src/` 对应位置、文件名去掉 `.eval`，作为常规测试；拷入后先跑一次确认为红再改代码。Skill 资源围栏没有现成的题，新增测试同样先红后改。
- 变异反向验证沿用 M6.5 审计的执行器：本地临时脚本（不入库）把工作树的 src 与配置文件复制到一次性目录，目录联接挂 node_modules，施加单点变异（补丁原文必须恰好命中一次）后跑 `node --test --test-timeout=120000 "src/**/*.test.ts"`，解析变红用例。"精确变红"指变红集合里每一条都能由该变异直接解释，且不含无关用例。

## 首次红运行

| 范围 | 输出（本地 tmp/，不入库） | 结果 |
|---|---|---|
| 拷入的 4 份测试（20 条） | tmp/dfx-red.txt | 10 红：参数摘要 2、错误分类 2、insertAfter 4、路径围栏 2；其余 10 条守"原有行为不变"，首次即绿 |
| Skill 资源围栏新增用例 | tmp/dfx-skill-red.txt | 1 红：`..notes.md` 报"路径越出 Skill 目录" |

## 缺陷与修复

### 1. 路径围栏误拒以 `..` 开头的名字（任务 path-dotdot-name）

- 现象：`resolveWorkspacePath` 与 `isPathInsideDir` 以 `path.relative` 结果"以 `..` 开头"判越界，把 `..notes.txt`、`src/..cache/x.txt` 这类合法名字判成越界：前者抛错，后者返回 false。
- 修复：`src/tools/paths.ts` 抽出并导出 `isOutsideRelative(rel)`，条件为 `rel === ".."`、以 `..` 加 `path.sep` 开头、或 `path.isAbsolute(rel)`；两个函数都改用它。真正的逃逸（`../x`、根外绝对路径、经符号链接或目录联接解析后越界）照旧拒绝，目标不存在时行为不变。
- 测试：`src/tools/paths-dotdot.test.ts`（拷自任务资产，4 条）。

### 2. Skill 资源围栏的同类缺陷

- 现象：`load_skill` 的资源路径围栏用同一"以 `..` 开头"判据，Skill 目录下名为 `..notes.md` 的资源被拒绝。
- 修复：`src/skills/load-skill-tool.ts` 改用 `tools/paths.ts` 导出的 `isOutsideRelative`；分层规则 skills-only-state-tools 允许 skills 依赖 tools。
- 测试：`src/skills/load-skill-tool.test.ts` 新增 1 条——`..notes.md` 正常读取并留 skill.loaded，`../` 与目录联接逃逸仍拒绝。编写中发现新用例的 `../` 逃逸路径少一层上跳、实际落到工作区内不存在的文件（报"资源不存在"而非"越出"），按既有用例改为四层上跳；首次红运行的红点在 `..notes.md` 那条断言，不受影响。

### 3. 工具错误的"环境异常"判据过宽（任务 tool-error-codes）

- 现象：`classifyToolError` 只要是 `Error` 且带字符串 `code` 就判 `environment`，把 Node 中止错误（`AbortError` / `ABORT_ERR`）与 `ERR_` 开头的编程错误码贴成环境异常。
- 修复：`src/tools/error-kind.ts` 按任务说明的顺序判定——归类标记优先、已知域错误类归 `domain`、中止错误（`name === "AbortError"` 或 `code === "ABORT_ERR"`，即使同时带 errno 风格 code）返回 `undefined`、只有完整匹配 `/^E[A-Z0-9]+$/` 的 code 归 `environment`、其余返回 `undefined`；模块注释同步更新。
- 既有测试与调用方核对：没有依赖"非 errno 的 code 也判为环境异常"的断言或调用方。MCP 不可用错误以归类标记声明 `environment`（不依赖 code）；`error-kind-marker.test.ts` 里"非法标记但带 code"的用例用的是 `ENOENT`，仍归 `environment`；`run_command` 的进程启动错误中 `ENOENT` 在工具内部转成域错误，其余启动错误原样上抛、携带 errno 风格 code，新旧口径下都归 `environment`，被中止时抛出的是不带 code 的普通错误，新旧口径下都不贴标签；`adapter-persistence.test.ts` 的环境异常用例抛的是 `EROFS`。无需改既有断言。
- 测试：`src/tools/error-kind-codes.test.ts`（拷自任务资产，4 条）。

### 4. 参数摘要截断劈开代理对（任务 args-summary-surrogate）

- 现象：`summarizeArgs` 超过 160 个码元时直接 `slice(0, 160)`，切点落在代理对中间时摘要末尾留下孤立高位代理。
- 修复：`src/application/format.ts` 在切点前一个码元位于 0xD800–0xDBFF 时切点减一；后缀字符数口径、原样返回与不可序列化行为不变。
- 测试：`src/application/summarize-args.test.ts`（拷自任务资产，6 条）。

### 5. insertAfter 的删除记账与 diff（任务 insert-after-diff）

- 现象：`insertAfter` 的 `AppliedEdit.removed` 记成锚点行，diff 里锚点行显示为删行，`edit_file` 回执报"删了 1 行"。
- 修复：`src/tools/hashline.ts` 的 `resolveEdit` 对 `insertAfter` 记 `removed = []`（范围仍占锚点行，重叠检测不变）；`buildEditDiff` 对 `insertAfter` 的上文取锚点行及其前 1 行（`oldLines.slice(max(0, startLine - 2), startLine)`），下文不变。
- 核对：重叠检测、"无实际变化"拒绝、replace 与 delete 的记账和 diff 均由拷入测试与既有 `hashline.test.ts` 覆盖且全绿；`edit_file` 回执的 "+a −b" 按 `removed.length` 计算、审批预览 diff 由 `buildEditDiff` 生成，随之正确；replace 编辑模式（`tools/replace-edit.ts`）自行计算改动行，不经 `resolveEdit`，不受影响。
- 测试：`src/tools/hashline-insert-diff.test.ts`（拷自任务资产，6 条）。

## 行为变化说明

- 错误分类：中止错误与 `ERR_` 开头等非 errno code 的工具错误，原来 `errorKind` 为 environment、失败四分类归"基础设施错误"；现在不贴标签，归"未知"。errno 风格 code（ENOENT、EACCES 等）与归类标记的判定不变。
- hashline 编辑：`insertAfter` 的回执与审批 diff 不再把锚点行算作删除——回执从"+n −1 行"变为"+n −0 行"，diff 中锚点行作为上下文行出现。
- 路径围栏与 Skill 资源围栏：名字以两个点开头的合法文件或目录不再被拒绝。
- 参数摘要：截断处不再出现孤立高位代理。

## Eval 任务锁定说明

Eval 任务 2（args-summary-surrogate）、4（path-dotdot-name）、5（tool-error-codes）、8（insert-after-diff）锁定在 8e76567，快照从该提交开出，主干修复不影响这些任务的题面与验证；`eval/` 下的任务与 Skill 本轮未改。

## 变异反向验证（精确变红）

全部修复落地后逐处恢复旧的缺陷写法，每处跑全量 568 条测试：

| 编号 | 变异 | 结果 |
|---|---|---|
| 1 | `tools/paths.ts` 的 `isOutsideRelative` 恢复为"以 `..` 开头或绝对路径" | 精确 3 红：「resolveWorkspacePath 接受以 .. 开头的合法文件名与目录名」、「isPathInsideDir 对以 .. 开头的名字判定正确」、「路径约束：名字以 .. 开头的合法资源（..notes.md）照常读取……」（Skill 资源围栏复用同一助手，一并变红） |
| 2 | `skills/load-skill-tool.ts` 的资源围栏恢复为"以 `..` 开头或绝对路径" | 精确 1 红：「路径约束：名字以 .. 开头的合法资源（..notes.md）照常读取……」 |
| 3 | `tools/error-kind.ts` 恢复"带字符串 code 就判为 environment"（去掉中止错误分支与 errno 形态校验） | 精确 2 红：「Node 中止错误不贴标签」、「ERR_ 编程错误码与其他非 errno code 不贴标签」 |
| 4 | `application/format.ts` 恢复直接 `slice(0, 160)` | 精确 2 红：「切点落在代理对中间：少取一个码元，结果是合法 UTF-16」、「连续 emoji：前缀停在最后一个完整字符」 |
| 5 | `tools/hashline.ts` 的 insertAfter `removed` 恢复为锚点行 | 精确 4 红：「insertAfter 的记账：不删除任何行」、「insertAfter 的 diff：锚点行作上下文」、「insertAfter 在首行与末行」、「混合编辑：各 hunk 按位置升序，insertAfter 不记删除」 |

变异执行过程中曾中途停止一次（发现 Skill 新用例的逃逸路径写错，修正后重跑），停止时遗留的一次性目录先拆联接再删除；上表为修正后的完整重跑结果。

## 门禁

`npm run verify`：biome 仅一条改动前已有的 noUnusedImports 警告（tui/main.ts）；tsc 零错；node --test 568/568；dependency-cruiser 271 模块 1849 依赖零违规。
