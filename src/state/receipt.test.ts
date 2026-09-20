// 回执组装的直测（随该段判据下沉到 state 补齐）：此前 executed 判据只被端到端用例间接覆盖，
// "出错但进程已经启动过"与"出错但 server 已给出返回"这两个例外分支没有任何断言——
// 它们正是"副作用可能已经发生"的那两种情形，判错会让审计把发生过的副作用记成没发生。
import assert from "node:assert/strict";
import { test } from "node:test";
import { newExecutionId } from "./ids.ts";
import { buildReceipt, type ReceiptMcp, type StagedExecEvidence } from "./receipt.ts";
import type { ToolExecution } from "./tool-execution.ts";

const DECISION = { outcome: "approved", approvedBy: "human", decidedAt: 150 } as const;
const REJECTED = { outcome: "rejected", approvedBy: "policy:deny", decidedAt: 150 } as const;

// 用可选字段显式带 undefined 的写法构造"没进入执行阶段"等形态（exactOptionalPropertyTypes 下要显式放开）
type RecordOverrides = { [K in keyof ToolExecution]?: ToolExecution[K] | undefined };

function record(overrides: RecordOverrides = {}): ToolExecution {
  return {
    version: 1,
    executionId: newExecutionId(),
    toolCallId: "toolu_1",
    toolName: "run_command",
    rawArgs: { command: "npm test" },
    state: "settled",
    proposedAt: 100,
    executionStartedAt: 200,
    settledAt: 300,
    ...overrides,
  } as ToolExecution;
}

const EXEC: StagedExecEvidence = {
  command: "npm test",
  argv: ["npm", "test"],
  launcher: false,
  shell: false,
  exitCode: 1,
  timedOut: false,
  outputBytes: 2,
  outputHash: "0".repeat(64),
  output: "ko",
  truncated: false,
  fileChanges: { added: [], removed: [], modified: [], truncated: false },
};

const MCP: ReceiptMcp = {
  server: "s",
  tool: "t",
  argsHash: "1".repeat(64),
  isError: true,
  resultSummary: "坏了",
  resultHash: "2".repeat(64),
  resultBytes: 3,
  truncated: false,
};

test("executed：执行过且无错即算副作用发生", () => {
  assert.equal(
    buildReceipt({ record: record(), decision: DECISION, isError: false }).executed,
    true
  );
});

test("executed：从未进入执行阶段的一律记没发生", () => {
  const receipt = buildReceipt({
    record: record({ executionStartedAt: undefined }),
    decision: REJECTED,
    isError: false,
  });
  assert.equal(receipt.executed, false);
  assert.match(receipt.summary, /未产生副作用（已拒绝）/);
});

test("executed：出错时默认记没发生，摘要说明是执行出错", () => {
  const receipt = buildReceipt({ record: record(), decision: DECISION, isError: true });
  assert.equal(receipt.executed, false);
  assert.match(receipt.summary, /未产生副作用（执行出错）/);
});

test("executed：出错但进程已经启动过（超时终止、被中止）按可能发生记", () => {
  const receipt = buildReceipt({
    record: record(),
    decision: DECISION,
    isError: true,
    exec: { ...EXEC, spawned: true, timedOut: true },
  });
  assert.equal(receipt.executed, true, "进程跑过就可能已经产生副作用");
  assert.match(receipt.summary, /退出码 1，超时终止/);
});

test("executed：出错但 server 已给出返回，同样按可能发生记", () => {
  const receipt = buildReceipt({ record: record(), decision: DECISION, isError: true, mcp: MCP });
  assert.equal(receipt.executed, true);
  assert.match(receipt.summary, /MCP s\/t，server 报错/);
});

test("exec 证据：进程启动标记只服务判定，不进回执", () => {
  const receipt = buildReceipt({
    record: record(),
    decision: DECISION,
    isError: false,
    exec: { ...EXEC, spawned: true },
  });
  assert.ok(receipt.exec !== undefined);
  assert.equal("spawned" in receipt.exec, false);
});

test("现状哈希：只在副作用可能发生时才去测，测不得则缺省", () => {
  let calls = 0;
  const hashAfter = () => {
    calls += 1;
    return "a".repeat(16);
  };
  const done = buildReceipt({ record: record(), decision: DECISION, isError: false, hashAfter });
  assert.equal(done.contentAfterHash, "a".repeat(16));
  assert.equal(calls, 1);

  const never = buildReceipt({
    record: record({ executionStartedAt: undefined }),
    decision: REJECTED,
    isError: false,
    hashAfter,
  });
  assert.equal(never.contentAfterHash, undefined, "没发生的副作用不去测");
  assert.equal(calls, 1, "也不该调用测量函数");

  const unmeasurable = buildReceipt({
    record: record(),
    decision: DECISION,
    isError: false,
    hashAfter: () => null,
  });
  assert.equal(unmeasurable.contentAfterHash, undefined, "测不得就缺省，不写 null 进回执");
});

test("时间：起点回退到提出时刻，收尾缺省用当下", () => {
  const receipt = buildReceipt({
    record: record({ executionStartedAt: undefined, settledAt: undefined }),
    decision: REJECTED,
    isError: false,
    now: () => 999,
  });
  assert.equal(receipt.startedAt, 100);
  assert.equal(receipt.finishedAt, 999);
});
