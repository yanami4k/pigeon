// Receipt（ROADMAP §3.2 + §4 状态机）：一次副作用调用的持久化回执。
// 所有到达 dispatch 的调用都产生 Receipt；executed=false 表示 Rejected、参数非法或
// 执行前取消，即副作用从未发生。摘要仅供人读，治理结论必须回查原始记录（§3.3）。
// v2：补批准来源（决策 4，证据链）与 toolCallId（回联上游 transcript / ToolExecution 账本）。
// v3（M4 S2 哈希自动确证）：补 contentAfterHash——执行后实测的目标内容哈希
// （snapshotTag 格式，16 位十六进制），供冷恢复三方比对与撕裂写检测；只读工具无此字段。
// v4（M5.5 S5，决策 048）：补 exec——exec 工具的执行证据（命令、参数数组、退出码、输出哈希与截断输出、
// 执行前后工作树文件清单差异）；非 exec 工具无此字段。
// v5（M5.7 S3，决策 053）：补 mcp——MCP 工具的调用与返回证据（参数哈希、返回哈希与摘要、截断标记、结构化返回哈希、
// server 主动交的证据）；非 MCP 工具无此字段。
import { type Static, Type } from "typebox";
import { ExecutionIdSchema, ReceiptIdSchema } from "./ids.ts";
import { type Migration, MigrationRegistry } from "./migration.ts";

export const RECEIPT_VERSION = 5;

// 批准来源（与 ToolExecutionDecision.approvedBy 同枚举，决策 4 + M4 S6 决策 3 扩展）
export const ReceiptApprovedBySchema = Type.Union([
  Type.Literal("human"),
  Type.Literal("policy:yolo"),
  Type.Literal("policy:auto"),
  Type.Literal("policy:deny"),
  Type.Literal("human:grant"),
  Type.Literal("policy:config"),
]);

// exec 执行证据（决策 048）：输出全文不入账，只存哈希与截断文本
export const ReceiptExecSchema = Type.Object({
  command: Type.String({ minLength: 1 }),
  // 经 .pigeon/commands.json 短名展开时的短名
  alias: Type.Optional(Type.String({ minLength: 1 })),
  // 实际进程参数（经启动器或 shell 时是 cmd.exe / sh 的参数）
  argv: Type.Array(Type.String()),
  // 048 修订：是否经 cmd.exe 启动器运行 .cmd / .bat、是否以 shell 运行
  launcher: Type.Boolean(),
  shell: Type.Boolean(),
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  signal: Type.Optional(Type.String()),
  timedOut: Type.Boolean(),
  outputBytes: Type.Integer({ minimum: 0 }),
  outputHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  output: Type.String(),
  truncated: Type.Boolean(),
  fileChanges: Type.Object({
    added: Type.Array(Type.String()),
    removed: Type.Array(Type.String()),
    modified: Type.Array(Type.String()),
    truncated: Type.Boolean(),
  }),
});
export type ReceiptExec = Static<typeof ReceiptExecSchema>;

// MCP 调用证据（决策 053）：返回全文不入账，只存哈希、字节数与文本摘要；不解析返回语义
export const ReceiptMcpSchema = Type.Object({
  server: Type.String({ minLength: 1 }),
  tool: Type.String({ minLength: 1 }),
  // 发给 server 的参数按 037 规范序列化的哈希（与 intent 原始参数对得上）
  argsHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  // server 返回 isError
  isError: Type.Boolean(),
  resultSummary: Type.String(),
  resultHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  resultBytes: Type.Integer({ minimum: 0 }),
  // 文本摘要是否截断（截断不支撑确定性结论，§3.3）
  truncated: Type.Boolean(),
  structuredHash: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
  // server 在 structuredContent 的 evidence 键主动交的证据：未超上限原样收入 value，超上限只留 text 前缀
  serverEvidence: Type.Optional(
    Type.Object({
      value: Type.Optional(Type.Unknown()),
      text: Type.Optional(Type.String()),
      bytes: Type.Integer({ minimum: 0 }),
      hash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
      truncated: Type.Boolean(),
    })
  ),
});
export type ReceiptMcp = Static<typeof ReceiptMcpSchema>;

export const ReceiptSchema = Type.Object({
  version: Type.Literal(RECEIPT_VERSION),
  id: ReceiptIdSchema,
  executionId: ExecutionIdSchema,
  // 上游 toolCall id：回联 transcript 与 ToolExecution 账本
  toolCallId: Type.String({ minLength: 1 }),
  // 批准来源：人工 / yolo 批发授权 / 分层自动放行 / deny 清单拒绝
  approvedBy: ReceiptApprovedBySchema,
  // 副作用是否真实发生
  executed: Type.Boolean(),
  // 执行过程是否出错（仅 executed=true 时有意义）
  isError: Type.Boolean(),
  // 起止时间，Unix 毫秒
  startedAt: Type.Integer({ minimum: 0 }),
  finishedAt: Type.Integer({ minimum: 0 }),
  // 面向人的结果摘要，不是证据
  summary: Type.String(),
  // M4 S2：执行后实测的目标内容哈希（snapshotTag 格式）；executed=true 且工具具备
  // 内容证据能力时在场；只读工具 / 执行失败 / 哈希不可得时缺省（缺省 ≠ 篡改）
  contentAfterHash: Type.Optional(Type.String({ pattern: "^[0-9a-f]{16}$" })),
  // M5.5 S5：exec 工具的执行证据；进程启动过（含超时终止）即在场
  exec: Type.Optional(ReceiptExecSchema),
  // M5.7 S3：MCP 工具的调用与返回证据；server 给出返回（含 isError 结果）即在场
  mcp: Type.Optional(ReceiptMcpSchema),
});

export type Receipt = Static<typeof ReceiptSchema>;

// v1 → v2：补 approvedBy / toolCallId。注意：v1 Receipt 从未被任何代码路径持久化
// （M0 仅为 schema 占位，首个写入方是 M3 切片 5 的 JSONL 账本，直接写 v2），
// 迁移的字段默认值是占位语义，作用只是维系迁移管线连续性（同 snapshot v1→v2 先例）。
export const migrateReceiptV1toV2: Migration = (doc) => ({
  ...doc,
  version: 2,
  toolCallId: "legacy-v1",
  approvedBy: "policy:auto",
});

// v2 → v3：contentAfterHash 可缺省，纯版本推进
export const migrateReceiptV2toV3: Migration = (doc) => ({ ...doc, version: 3 });

// v3 → v4：exec 可缺省，纯版本推进
export const migrateReceiptV3toV4: Migration = (doc) => ({ ...doc, version: 4 });

// v4 → v5：mcp 可缺省，纯版本推进
export const migrateReceiptV4toV5: Migration = (doc) => ({ ...doc, version: 5 });

// receipt 迁移链的唯一装配点：M3 旧账本读取（ledger.ts）与 Event Log 读路径
// （event-log.ts 内嵌 receipt 载荷升级）共用同一条链，杜绝两套迁移表漂移
const receiptMigrations = new MigrationRegistry();
receiptMigrations.register("receipt", 1, migrateReceiptV1toV2);
receiptMigrations.register("receipt", 2, migrateReceiptV2toV3);
receiptMigrations.register("receipt", 3, migrateReceiptV3toV4);
receiptMigrations.register("receipt", 4, migrateReceiptV4toV5);

// 任意历史版本的 Receipt 文档 → 当前版本 + 校验
export function migrateReceiptToCurrent(doc: unknown): Receipt {
  return receiptMigrations.migrate("receipt", doc, RECEIPT_VERSION, ReceiptSchema);
}
