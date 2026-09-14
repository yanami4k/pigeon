# M5.7 开工裁决（2026-09-14 起）

- 定位：M5.7 外部工具链接入（MCP 客户端，041）开工前五件小口径：1 配置文件与风险档覆盖、2 注解与配置冲突的留痕、3 Receipt 泛化与 exec 证据合成通用形状、4 隔离单位接口、5 验收用参考 server。逐件盘、逐件裁决
- 裁决：项目负责人；基线 d99d693（M5.5 收口）

## 第 1 件：配置文件与风险档覆盖 = B 旁置 .pigeon/mcp.json（索引 051）

### 事实

- `.mcp.json` 形状：mcpServers 下按名字列 server，command / args / env 或 type http 加 url；Claude Code 对未知字段的容忍无承诺
- Pigeon 现有项目级配置都在 .pigeon/ 下，grants.json 是版本化 schema 先例
- 术语澄清：工具风险档 tier（read / write / exec，工具属性，决定证据形态与能否自动放行）与放权六档排律（§3.9，每次调用的放行判定顺序）是两套东西，只在"read 档自动放行"一处相交

### 选项

- A 塞进 .mcp.json：依赖对方忽略未知字段，不可控
- B 旁置 .pigeon/mcp.json：server 定义仍读 .mcp.json，风险档覆盖按 server 名与工具名对上；无 .mcp.json 时可在此直接定义 server
- C 写进 grants.json：概念错位

### 裁决

- B。schema 带 version；servers 按名，defaultTier 缺省 write，tools 按名给 tier，read 工具可带 pathConfinement；未列出按 defaultTier；两份合并冲突以 .pigeon/mcp.json 为准。复杂度约 120 行加 80 行测试

## 第 2 件：注解与配置冲突的留痕 = B 记进 run.started（索引 052）

- 事实：注解在拉工具清单时即得，与具体调用无关；run.started（044）记本次 Run 实际暴露的工具集与策略摘要
- 选项：A 只进程内警告（冷侧不可见）；B run.started 工具集摘要加 declaredHint / effectiveTier / conflict 字段；C 每次 tool.proposed 记（冗余）；D 新族 mcp.catalog（与 B 重叠）
- 裁决：B。更严规则：声明只读配置 write/exec 按配置；声明 destructive 配置 read 按 write 并标 conflict。约 60 行加测试

## 第 3 件：Receipt 泛化 = 第三个证据块 mcp（索引 053）

- 事实：Receipt v4 = 公共字段加可选块 contentAfterHash（write）与 exec（exec，M5.5 加）；MCP 返回是内容块数组，新版协议有 structuredContent
- 选项：A 加第三个可选块；B 塞进 exec 块（字段对不上）；C 三块合成通用联合（重构已落地形状）。取 A
- 字段来源：与既有回执回答同样四个问题（参数是否审批时那份 / 实际发生了什么 / 证据完整吗 / 崩后怎么对账），无新治理语义；刻意不加审批步骤、不加记录族、不自动确证、不解析返回语义
- serverEvidence 约定：structuredContent 的 `evidence` 键原样收入，16 KiB 上限，哈希；工具链无需实现 Pigeon 接口
- 命名：call 语义不清，候选 mcp / external / exchange，取 mcp
- 复杂度：v4 到 v5 恒等迁移约 40 行、适配器落块约 60 行、测试约 80 行

## 第 4 件：隔离单位接口 = A 已满足，不动（索引 054）

- 事实：M5.5 已有 WorkspaceProvider（plan / create / changedFiles），git 工作树实现，测试注入内存实现；WorkerWorkspaceSchema.kind 为字面量 git-worktree；无 release 动作
- 选项：A 不动；B 预留联合类型与 release；C 做第二实现。取 A
- 澄清：隔离工作区（文件放哪）与沙箱（进程能干什么）是两个轴；容器是唯一同时落两层的实现。形状封顶三种（git 工作树 / 普通目录 / 容器），领域隔离归工具链，Pigeon 经 MCP roots 告知目录路径

## 第 5 件：验收参考 server = C 两个都用（索引 055）

- 事实：官方参考 server 在 npm，filesystem / everything / memory 均 2026.8.31，JS，npx 启动；本地 @modelcontextprotocol/sdk 1.30.0 作类型依赖，客户端用它；Windows 上 npx 是 .cmd，复用 048 启动器
- 三个 server 能力：filesystem 在允许目录内读写文件（真副作用）；everything 演示工具带注解、prompts、resources、长任务、故障（无副作用）；memory 知识图谱（不用）
- 一次调用的链路：启动时读两份配置拉起 server 映射进注册表并记冲突 → beforeToolCall 转 governance 六档排律 → 审批 → intent → MCP 客户端转发 → server 执行 → mcp 回执与 tool.settled → changedFiles → trace / search / 学习。模型与治理不区分外部与自有工具，区别只在证据格子
- 选项：A 只 filesystem（缺协议面）；B 只 everything（无真副作用）；C 两个都用。取 C
