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
        "（memory / skills / orchestration / mcp / review / distillation / replay / activation），" +
        "不触达 Actor 层（cli/tui）。",
      from: { path: "^src/application/", pathNot: "\\.test\\.ts$" },
      to: {
        path: "^src/",
        pathNot:
          "^src/(application|state|persistence|tools|approvals|pi-runtime|execution|memory|skills|orchestration|mcp|review|distillation|replay|activation)/",
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
      comment:
        "占位目录（context）暂按最小允许清单约束：只依赖 state 与 tools（022 修订）。" +
        "review/、distillation/ 与 replay/ 已放行到各自的清单，见 review-below-controller、" +
        "distillation-below-controller 与 replay-below-controller。",
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
      name: "replay-below-controller",
      severity: "error",
      comment:
        "replay（M8：回放判定与统计、验证环境摘要与失效判据、回放材料的临时治理根，决策 084 / 085 / 091）" +
        "只依赖 state、tools、persistence 的只读物化与 activation 的落点与写入口径：" +
        "回放的经验装载必须与真激活走同一条路径，故复用 activation，不自己另写一份落点。" +
        "不触达 pi-runtime、orchestration、application 与 Actor 层——派发、调度与装配由 application 注入。" +
        "命名守决策 014：本目录的重执行不复用 replay 一词（类型与命令一律叫 rerun / verify），" +
        "M4 的 pigeon replay 与 state/replay.ts 仍是只读重建。",
      from: { path: "^src/replay/", pathNot: "\\.test\\.ts$" },
      to: { path: "^src/", pathNot: "^src/(replay|state|tools|persistence|activation)/" },
    },
    {
      name: "activation-only-state",
      severity: "error",
      comment:
        "activation（M8 S7：候选激活的落点、写入、漂移与撤销，决策 090 / 093）只依赖 state 与 " +
        "persistence 的整文件原子替换。这条同时是决策 090 的机检：放权写入模块" +
        "（persistence/grants-config.ts、application/grants.ts）与审批层不在允许清单里，" +
        "激活器在代码层面够不着它们。决策 094 删掉 Policy 形态后，这条是 §M8 完成证据里留下的那条不变式。",
      from: { path: "^src/activation/", pathNot: "\\.test\\.ts$" },
      to: {
        path: "^src/",
        pathNot: "^src/(activation|state)/|^src/persistence/atomic-write\\.ts$",
      },
    },
    {
      name: "review-below-controller",
      severity: "error",
      comment:
        "review（M6：Run 冻结快照、只读审阅工具、调度器、候选落盘与扫描，决策 064 / 065）" +
        "只依赖 state、tools 与 persistence 的只读物化：它读账本、产候选文件，不触达 pi-runtime、" +
        "application 与 Actor 层——调度与装配由 application 注入。",
      from: { path: "^src/review/", pathNot: "\\.test\\.ts$" },
      to: { path: "^src/", pathNot: "^src/(review|state|tools|persistence)/" },
    },
    {
      name: "distillation-below-controller",
      severity: "error",
      comment:
        "distillation（M7：提炼器的对比快照、只读工具、任务说明与候选落盘，决策 074 / 076）" +
        "只依赖 state、tools、persistence 的只读物化与 review 的截断和暂存口径；不触达 pi-runtime、" +
        "orchestration、application 与 Actor 层——派发、调度与装配由 application 注入。",
      from: { path: "^src/distillation/", pathNot: "\\.test\\.ts$" },
      to: { path: "^src/", pathNot: "^src/(distillation|review|state|tools|persistence)/" },
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
      name: "eval-below-actors",
      severity: "error",
      comment:
        "eval（M6.5：任务目录、快照准备、验证器、runner 与报告，决策 046 / 057；M9：任务源上的回放验证）可依赖 state / persistence / replay / " +
        "tools / orchestration / application 及以下；不触达 Actor 层（cli/tui），由 cli 调用（022 修订）。",
      from: { path: "^src/eval/", pathNot: "\\.test\\.ts$" },
      to: {
        path: "^src/",
        pathNot:
          "^src/(eval|application|replay|orchestration|pi-runtime|approvals|execution|memory|skills|mcp|persistence|tools|state)/",
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
        "Actor（cli / tui）对 persistence 只许只读物化（materializeSession / listSessionIds / filePathFor）；" +
        "会改文件的入口（grants.json 读写）一律经 application（M2 审计 note-1，决策 034）。",
      from: { path: "^src/(cli|tui)", pathNot: "\\.test\\.ts$" },
      to: { path: "^src/persistence/grants-config\\.ts$" },
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
      name: "actors-no-event-log-direct",
      severity: "error",
      comment:
        "Actor（cli / tui）不直连事件日志读写器 persistence/event-log.ts（022 修订）：" +
        "只读物化一律经 persistence/session-read.ts 的只读面，避免 Actor 侧构造出会建目录、开追加句柄的写入实例。",
      from: { path: "^src/(cli|tui)/", pathNot: "\\.test\\.ts$" },
      to: { path: "^src/persistence/event-log\\.ts$" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
  },
};
