// 注意：typescript 固定在 6.x —— dependency-cruiser 18.x 尚未支持 TS7 API，
// TS7 下会静默巡航 0 个模块导致 deps 假绿。dependency-cruiser 支持 TS7 后可升回。
/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "禁止循环依赖：模块依赖必须构成有向无环图。",
      from: {},
      to: { circular: true },
    },
    {
      name: "pi-agent-only-via-pi-runtime",
      severity: "error",
      comment:
        "架构约束（路线图 §3.6/约束 6）：业务代码不得直接 import @earendil-works/*；" +
        "src/tools 的豁免已收口为单一桥接文件 src/tools/wrap.ts（纯类型别名），" +
        "其余 tools 文件一律经 wrap.ts 取上游类型；所有运行交互统一经 src/pi-runtime 的 PiRuntimeAdapter。" +
        "src/tui 另有 tui-pi-tui-only 规则：仅允许直连 pi-tui（纯 UI 库，见该规则注释）。",
      from: { path: "^src", pathNot: "^src/(pi-runtime/|tools/wrap\\.ts$|tui/)" },
      to: { path: "node_modules/@earendil-works" },
    },
    {
      name: "tui-pi-tui-only",
      severity: "error",
      comment:
        "src/tui 只允许直连 @earendil-works/pi-tui（M2 S1）：pi-tui 是纯终端 UI 库" +
        "（S0 spike 实证依赖仅 get-east-asian-width + marked，docs/notes/spike-pi-tui.zh-CN.md），" +
        "与 agent 运行交互无关，故豁免精确到这一个包、只限 src/tui/；pi-agent-core / pi-ai" +
        "等上游 agent 包仍一律经 pi-runtime Adapter，tui 也不例外。",
      from: { path: "^src/tui/", pathNot: "\\.test\\.ts$" },
      to: {
        path: "node_modules/@earendil-works",
        pathNot: "node_modules/@earendil-works/pi-tui",
      },
    },
    // ---- 目录分层（M4 收口重整，ROADMAP §4）：只约束生产代码，测试文件可跨层搭夹具 ----
    {
      name: "state-is-leaf",
      severity: "error",
      comment: "state 是权威状态 schema、纯判据与投影，不依赖任何其他 src 目录（无 IO、无上游）。",
      from: { path: "^src/state/", pathNot: "\\.test\\.ts$" },
      to: { path: "^src/", pathNot: "^src/state/" },
    },
    {
      name: "persistence-only-state",
      severity: "error",
      comment: "persistence 是 state 的存储实现：只依赖 state，不依赖 tools / pi-runtime / 上层。",
      from: { path: "^src/persistence/", pathNot: "\\.test\\.ts$" },
      to: { path: "^src/", pathNot: "^src/(persistence|state)/" },
    },
    {
      name: "tools-only-state",
      severity: "error",
      comment: "tools（Registry / Policy / 匹配 / Coding 工具）只依赖 state。",
      from: { path: "^src/tools/", pathNot: "\\.test\\.ts$" },
      to: { path: "^src/", pathNot: "^src/(tools|state)/" },
    },
    {
      name: "approvals-only-state-tools",
      severity: "error",
      comment: "approvals（审批接口、会话 grant 运行态）只依赖 state 与 tools 的匹配语义。",
      from: { path: "^src/approvals/", pathNot: "\\.test\\.ts$" },
      to: { path: "^src/", pathNot: "^src/(approvals|state|tools)/" },
    },
    {
      name: "pi-runtime-only-state-tools",
      severity: "error",
      comment:
        "pi-runtime（Adapter 与 ToolGovernance 接口）只依赖 state 与 tools（022 修订：改允许清单）：" +
        "经结构类型接收落盘口（EventLogSink），不触达 persistence / execution，也不触达 Actor 层与其他上层目录。",
      from: { path: "^src/pi-runtime/", pathNot: "\\.test\\.ts$" },
      to: { path: "^src/", pathNot: "^src/(pi-runtime|state|tools)/" },
    },
    {
      name: "execution-only-state-persistence-tools",
      severity: "error",
      comment:
        "execution（冷恢复、未来的 Durable Executor）只依赖 state、persistence 与 tools" +
        "（022 修订：改允许清单）：不触达 pi-runtime、Actor 层与其他上层目录。",
      from: { path: "^src/execution/", pathNot: "\\.test\\.ts$" },
      to: { path: "^src/", pathNot: "^src/(execution|state|persistence|tools)/" },
    },
    {
      name: "application-is-controller",
      severity: "error",
      comment:
        "application 是 Controller 层（M2 S1，决策 025）：装配根、resume 流程与 Actor 共用措辞；" +
        "可依赖 state / persistence / tools / approvals / pi-runtime / execution 与各下层能力目录" +
        "（memory / skills / orchestration / mcp），不触达 Actor 层（cli/tui）。",
      from: { path: "^src/application/", pathNot: "\\.test\\.ts$" },
      to: {
        path: "^src/",
        pathNot:
          "^src/(application|state|persistence|tools|approvals|pi-runtime|execution|memory|skills|orchestration|mcp|web)/",
      },
    },
    {
      name: "orchestration-below-controller",
      severity: "error",
      comment:
        "orchestration（M5.5：工作树管理与 worker 生命周期，决策 040）对外只暴露 spawn / cancel / status / " +
        "awaitResult 四动作加审批回调；只依赖 state、tools、approvals、memory、mcp（022 修订：改允许清单），" +
        "worker 运行面由装配根以工厂注入，自身不触达 application 与 Actor 层（cli/tui）。",
      from: { path: "^src/orchestration/", pathNot: "\\.test\\.ts$" },
      to: {
        path: "^src/",
        pathNot: "^src/(orchestration|state|tools|approvals|memory|mcp)/",
      },
    },
    {
      name: "placeholders-only-state-tools",
      severity: "error",
      comment: "占位目录（context）暂按最小允许清单约束：只依赖 state 与 tools（022 修订）。",
      from: {
        path: "^src/context/",
        pathNot: "\\.test\\.ts$",
      },
      to: {
        path: "^src/",
        pathNot: "^src/(context|state|tools)/",
      },
    },
    {
      name: "memory-below-controller",
      severity: "error",
      comment:
        "memory（M5：Session Search 扫描器与两个 read 档工具、常驻 Memory，决策 038 / 042）" +
        "可依赖 state / persistence / tools；不触达 pi-runtime / application / execution / Actor 层" +
        "（022 修订）。检索目录与工作区根由装配根注入，memory 自身不做装配。",
      from: { path: "^src/memory/", pathNot: "\\.test\\.ts$" },
      to: { path: "^src/", pathNot: "^src/(memory|state|persistence|tools)/" },
    },
    {
      name: "skills-only-state-tools",
      severity: "error",
      comment:
        "skills（M5 S4：Skill Catalog 扫描与 load_skill 工具，决策 043）只依赖 state 与 tools；" +
        "读取留痕经装配根注入的回调写出，skills 自身不触达 persistence / pi-runtime / application / Actor 层。",
      from: { path: "^src/skills/", pathNot: "\\.test\\.ts$" },
      to: { path: "^src/", pathNot: "^src/(skills|state|tools)/" },
    },
    {
      name: "mcp-only-state-tools",
      severity: "error",
      comment:
        "mcp（M5.7：MCP 客户端、传输与注册表映射，决策 041 / 051）只依赖 state 与 tools；" +
        "不触达 persistence / pi-runtime / application / Actor 层，由 application 装配（022 修订）。",
      from: { path: "^src/mcp/", pathNot: "\\.test\\.ts$" },
      to: { path: "^src/", pathNot: "^src/(mcp|state|tools)/" },
    },
    {
      name: "web-only-state-tools",
      severity: "error",
      comment:
        "web（决策 287–291：联网搜索与抓取、内网防护、搜索后端适配、两件工具）只依赖 state 与 tools；" +
        "提炼的模型接入由 application 经回调注入，web 自身不触达 pi-runtime / persistence / application / Actor 层。",
      from: { path: "^src/web/", pathNot: "\\.test\\.ts$" },
      to: { path: "^src/", pathNot: "^src/(web|state|tools)/" },
    },
    {
      name: "eval-below-actors",
      severity: "error",
      comment:
        "eval（延续式跑批：出题、人的基准、跑批器、模型网关与报告）可依赖 state / persistence / " +
        "tools / orchestration / application 及以下；不触达 Actor 层（cli/tui），由 cli 调用（022 修订）。",
      from: { path: "^src/eval/", pathNot: "\\.test\\.ts$" },
      to: {
        path: "^src/",
        pathNot:
          "^src/(eval|application|orchestration|pi-runtime|approvals|execution|memory|skills|mcp|persistence|tools|state)/",
      },
    },
    {
      name: "actors-no-execution",
      severity: "error",
      comment:
        "Actor（cli / tui）只提交意图、渲染投影，不能触碰执行器（ROADMAP §2/§3.6 Actor 边界）；" +
        "冷恢复等 execution 用法一律经 application Controller（M2 S1，决策 025——" +
        "M4 记账的 cli 直连 execution 过渡豁免已随装配根抽取消除）。",
      from: { path: "^src/(cli|tui)", pathNot: "\\.test\\.ts$" },
      to: { path: "^src/execution" },
    },
    {
      name: "actors-no-persistence-writes",
      severity: "error",
      comment:
        "Actor（cli / tui）对 persistence 只许只读：会话文件经只读读取器与会话目录读（session-reader / session-catalog，决策 181）；" +
        "会改文件的入口（grants.json 读写、会话文件锁）一律经 application（M2 审计 note-1，决策 034）。",
      from: { path: "^src/(cli|tui)", pathNot: "\\.test\\.ts$" },
      to: { path: "^src/persistence/(grants-config|session-lock)\\.ts$" },
    },
    {
      name: "actors-not-each-other",
      severity: "error",
      comment:
        "两个 Actor（cli / tui）互不引用（022 修订）：共用逻辑一律下沉到 application 命令层，" +
        "否则一个 Actor 的渲染细节会经另一个 Actor 反向扩散。",
      from: { path: "^src/(cli|tui)/", pathNot: "\\.test\\.ts$" },
      to: { path: "^src/(cli|tui)/", pathNot: "^src/$1/" },
    },
    {
      name: "actors-no-session-writer-direct",
      severity: "error",
      comment:
        "Actor（cli / tui）不直连会话存储写者 pi-runtime/session-store.ts（022 修订，决策 181）：" +
        "读会话一律经 persistence 的只读读取器，写会话只由 application 装配的运行面持有，避免 Actor 侧建出会加锁、开追加句柄的写者。",
      from: { path: "^src/(cli|tui)/", pathNot: "\\.test\\.ts$" },
      to: { path: "^src/pi-runtime/session-store\\.ts$" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
  },
};
