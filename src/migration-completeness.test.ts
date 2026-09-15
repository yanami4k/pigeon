// 迁移完整性机检（架构审计建议第 2 条，M6.5 S0）：枚举全部版本化 schema，对每一个从 v1 构造最小文档，
// 经各自的迁移链逐级升到当前版本并通过当前 schema 校验。三处迁移注册表（Event Log、Receipt、旧账本）
// 与快照迁移函数保持分散，机检集中在本文件。另扫描 src 生产代码里的 `*_VERSION = N` 常量，
// 任何新增的版本化 schema 未在下表登记即变红——"每个版本化 schema 都有 v1 到当前的完整迁移链"由此成立。
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { EVAL_TASK_VERSION, EvalTaskSchema } from "./eval/task.ts";
import {
  LEDGER_DECISION_VERSION,
  LEDGER_INTENT_VERSION,
  LedgerDecisionSchema,
  LedgerIntentSchema,
} from "./persistence/ledger.ts";
import {
  INJECTION_SNAPSHOT_VERSION,
  InjectionSnapshotSchema,
  migrateInjectionSnapshotV1toV2,
  migrateInjectionSnapshotV2toV3,
  migrateInjectionSnapshotV3toV4,
  migrateInjectionSnapshotV4toV5,
} from "./pi-runtime/snapshot.ts";
import { CANDIDATE_VERSION, CandidateSchema } from "./state/candidate.ts";
import { COMMANDS_CONFIG_VERSION, CommandsConfigFileSchema } from "./state/commands.ts";
import { EVENT_LOG_VERSION, parseEventRecord } from "./state/event-log.ts";
import { EVENT_ENVELOPE_VERSION, EventEnvelopeSchema } from "./state/events.ts";
import { GRANTS_CONFIG_VERSION, GrantsConfigFileSchema } from "./state/grants.ts";
import {
  newEntryId,
  newExecutionId,
  newGrantId,
  newReceiptId,
  newRunId,
  newSessionId,
} from "./state/ids.ts";
import { MCP_CONFIG_VERSION, McpConfigFileSchema } from "./state/mcp-config.ts";
import { MESSAGE_CONTENT_VERSION, MessageContentRecordSchema } from "./state/message-content.ts";
import { MigrationRegistry } from "./state/migration.ts";
import { migrateReceiptToCurrent, RECEIPT_VERSION } from "./state/receipt.ts";
import { TOOL_EXECUTION_VERSION, ToolExecutionSchema } from "./state/tool-execution.ts";

interface VersionedSchemaCase {
  // 源码里的版本常量名（与扫描结果对账）
  constant: string;
  current: number;
  // v1 最小文档（每次调用新造，避免迁移函数改动共享对象）
  v1: () => Record<string, unknown>;
  // 逐级迁移到当前版本并按当前 schema 校验；迁移链缺一级即抛
  migrate: (doc: Record<string, unknown>) => unknown;
}

// 当前版本即 v1 的 schema：迁移链为空，校验即完整性
function validateOnly(schema: TSchema): (doc: Record<string, unknown>) => unknown {
  return (doc) => Value.Parse(schema, doc);
}

// 快照迁移函数只导出不注册（由冷加载方按名注册）：机检按同一约定组装
const snapshotMigrations = new MigrationRegistry();
snapshotMigrations.register("injection-snapshot", 1, migrateInjectionSnapshotV1toV2);
snapshotMigrations.register("injection-snapshot", 2, migrateInjectionSnapshotV2toV3);
snapshotMigrations.register("injection-snapshot", 3, migrateInjectionSnapshotV3toV4);
snapshotMigrations.register("injection-snapshot", 4, migrateInjectionSnapshotV4toV5);

const receiptV1 = () => ({
  version: 1,
  id: newReceiptId(),
  executionId: newExecutionId(),
  executed: true,
  isError: false,
  startedAt: 0,
  finishedAt: 1,
  summary: "v1",
});

const eventEnvelopeV1 = () => ({
  version: 1,
  id: newEntryId(),
  sessionId: newSessionId(),
  runId: newRunId(),
  timestamp: 0,
});

const decisionV1 = { outcome: "approved", approvedBy: "human", decidedAt: 0 };

const CASES: VersionedSchemaCase[] = [
  {
    constant: "EVENT_LOG_VERSION",
    current: EVENT_LOG_VERSION,
    v1: () => ({ ...eventEnvelopeV1(), kind: "turn.started", payload: {} }),
    migrate: parseEventRecord,
  },
  {
    constant: "RECEIPT_VERSION",
    current: RECEIPT_VERSION,
    v1: receiptV1,
    migrate: migrateReceiptToCurrent,
  },
  {
    constant: "INJECTION_SNAPSHOT_VERSION",
    current: INJECTION_SNAPSHOT_VERSION,
    v1: () => ({
      version: 1,
      model: { provider: "p", id: "m" },
      tools: { policy: { allow: [], deny: [] }, advertised: [] },
      context: { systemPrompt: "" },
      memory: [],
      skills: [],
      createdAt: 0,
    }),
    migrate: (doc) =>
      snapshotMigrations.migrate(
        "injection-snapshot",
        doc,
        INJECTION_SNAPSHOT_VERSION,
        InjectionSnapshotSchema
      ),
  },
  {
    constant: "MESSAGE_CONTENT_VERSION",
    current: MESSAGE_CONTENT_VERSION,
    v1: () => ({
      version: 1,
      sessionId: newSessionId(),
      runId: newRunId(),
      runSeq: 1,
      entryId: newEntryId(),
      role: "user",
      timestamp: 0,
      blocks: [{ type: "text", text: "hi", truncated: false }],
      contentHash: "0".repeat(64),
    }),
    migrate: validateOnly(MessageContentRecordSchema),
  },
  {
    constant: "GRANTS_CONFIG_VERSION",
    current: GRANTS_CONFIG_VERSION,
    v1: () => ({
      version: 1,
      grants: [
        {
          tool: "edit_file",
          promotedFrom: {
            grantId: newGrantId(),
            sessionId: newSessionId(),
            firstCall: { toolCallId: "tc-1", args: {} },
            promotedAt: 0,
          },
        },
      ],
    }),
    migrate: validateOnly(GrantsConfigFileSchema),
  },
  {
    constant: "COMMANDS_CONFIG_VERSION",
    current: COMMANDS_CONFIG_VERSION,
    v1: () => ({ version: 1, commands: { test: "node --test" } }),
    migrate: validateOnly(CommandsConfigFileSchema),
  },
  {
    constant: "MCP_CONFIG_VERSION",
    current: MCP_CONFIG_VERSION,
    v1: () => ({ version: 1, servers: {} }),
    migrate: validateOnly(McpConfigFileSchema),
  },
  {
    constant: "CANDIDATE_VERSION",
    current: CANDIDATE_VERSION,
    v1: () => ({
      version: 1,
      id: "cand-1",
      status: "Proposed",
      sourceRef: "sess",
      summary: "",
      createdAt: 0,
      updatedAt: 0,
    }),
    migrate: validateOnly(CandidateSchema),
  },
  {
    constant: "TOOL_EXECUTION_VERSION",
    current: TOOL_EXECUTION_VERSION,
    v1: () => ({
      version: 1,
      executionId: newExecutionId(),
      toolCallId: "tc-1",
      toolName: "read_file",
      rawArgs: {},
      state: "proposal",
      proposedAt: 0,
    }),
    migrate: validateOnly(ToolExecutionSchema),
  },
  {
    constant: "EVENT_ENVELOPE_VERSION",
    current: EVENT_ENVELOPE_VERSION,
    v1: () => ({ ...eventEnvelopeV1(), kind: "run.created", payload: null }),
    migrate: validateOnly(EventEnvelopeSchema),
  },
  {
    constant: "EVAL_TASK_VERSION",
    current: EVAL_TASK_VERSION,
    v1: () => ({
      version: 1,
      id: "fix-a",
      instructions: "task.md",
      repo: { path: ".", ref: "HEAD" },
      budget: { maxTurns: 1, wallClockMs: 1 },
      verifier: { command: ["node", "verify.mjs"], timeoutMs: 1 },
      assets: [],
      tags: [],
      holdout: false,
    }),
    migrate: validateOnly(EvalTaskSchema),
  },
  {
    constant: "LEDGER_INTENT_VERSION",
    current: LEDGER_INTENT_VERSION,
    v1: () => ({
      kind: "intent",
      version: 1,
      executionId: newExecutionId(),
      toolCallId: "tc-1",
      toolName: "edit_file",
      rawArgs: {},
      decision: decisionV1,
      at: 0,
    }),
    migrate: validateOnly(LedgerIntentSchema),
  },
  {
    constant: "LEDGER_DECISION_VERSION",
    current: LEDGER_DECISION_VERSION,
    v1: () => ({
      kind: "decision",
      version: 1,
      executionId: newExecutionId(),
      toolCallId: "tc-1",
      toolName: "edit_file",
      rawArgs: {},
      decision: { ...decisionV1, outcome: "rejected", reason: "不改" },
      at: 0,
    }),
    migrate: validateOnly(LedgerDecisionSchema),
  },
];

// 生产代码里的版本常量：`export const XXX_VERSION = N;`
function scanVersionConstants(dir: string): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        const text = readFileSync(path, "utf8");
        for (const match of text.matchAll(/^export const ([A-Z][A-Z0-9_]*_VERSION) = \d+;/gm)) {
          found.set(match[1] ?? "", relative(dir, path).split("\\").join("/"));
        }
      }
    }
  };
  walk(dir);
  return found;
}

test("迁移完整性：源码里每个版本常量都在机检表登记，表里没有多余项", () => {
  const scanned = scanVersionConstants(fileURLToPath(new URL(".", import.meta.url)));
  const registered = new Set(CASES.map((entry) => entry.constant));
  const missing = [...scanned.keys()].filter((name) => !registered.has(name));
  const stale = [...registered].filter((name) => !scanned.has(name));
  assert.deepEqual(
    missing.map((name) => `${name}（${scanned.get(name)}）`),
    [],
    "新增的版本化 schema 须在本表登记 v1 最小文档与迁移链"
  );
  assert.deepEqual(stale, [], "表里登记的常量在源码中已不存在");
});

for (const entry of CASES) {
  test(`迁移完整性：${entry.constant} 从 v1 逐级迁移到 v${entry.current} 并通过当前 schema 校验`, () => {
    const migrated = entry.migrate(entry.v1()) as { version?: unknown };
    assert.equal(migrated.version, entry.current);
  });
}

test("迁移完整性：Event Log v1 的 intent 与内嵌 v1 receipt 记录升到当前版本（内嵌 receipt 同步升级）", () => {
  const intent = parseEventRecord({
    ...eventEnvelopeV1(),
    kind: "intent",
    executionId: newExecutionId(),
    toolCallId: "tc-1",
    toolName: "edit_file",
    rawArgs: {},
    decision: decisionV1,
    at: 0,
  });
  assert.equal(intent.version, EVENT_LOG_VERSION);
  const receipt = parseEventRecord({ ...eventEnvelopeV1(), kind: "receipt", receipt: receiptV1() });
  assert.equal(receipt.kind, "receipt");
  assert.equal(receipt.kind === "receipt" ? receipt.receipt.version : undefined, RECEIPT_VERSION);
});
