// M2 S3：TUI /grants 视图与斜杠命令离屏测试（与 shell.test.ts 同一 Mock Terminal 路径）。
// 断言面：
//   - /grants 渲染会话 grant + 固化规则（createdAt/命中次数/作用域/出处，口径同
//     application/grants.ts 的 listGrants），含空列表文案；
//   - /revoke <id> 后 store 状态（立即停免审）；/grants save <id> 写 .pigeon/grants.json；
//   - 未知命令与命令失败（语法/语义错误）如实呈现（同 REPL 口径）；
//   - busy 期间斜杠命令同样被拒绝（决策 027 语义不开旁路）；
//   - 命令层只有一份：TUI 只换 write 投影，治理语义零新增（决策 030）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import { loadGrantConfig } from "../persistence/grants-config.ts";
import type { RunResult, StreamTextDelta } from "../pi-runtime/adapter.ts";
import type { EventEnvelope } from "../state/events.ts";
import type { ConfigGrantRule } from "../state/grants.ts";
import { asGrantId, newRunId, newSessionId, type SessionId } from "../state/ids.ts";
import { PigeonTuiShell, type TuiRuntimeFace } from "./shell.ts";
import { MockTerminal, screenFlat, screenText, settle, squashSpaces } from "./testing.ts";

const SESSION_ID: SessionId = newSessionId();
const RUN_ID = newRunId();

// 最小 application 面：记录 run 提交；autoResolve=false 时挂起（busy 测试的闸门）
class StubRuntime implements TuiRuntimeFace {
  readonly runs: string[] = [];
  autoResolve = true;
  private readonly pendingResolvers: Array<() => void> = [];

  run(input: string): Promise<RunResult> {
    this.runs.push(input);
    const { promise, resolve } = Promise.withResolvers<RunResult>();
    const result: RunResult = {
      runId: RUN_ID,
      status: "completed",
      stopReason: "stop",
      syntheticFailure: false,
      failure: null,
      advertisedTools: [],
      toolExecutions: [],
    };
    if (this.autoResolve) {
      resolve(result);
    } else {
      this.pendingResolvers.push(() => resolve(result));
    }
    return promise;
  }

  finishAll(): void {
    for (const resolve of this.pendingResolvers.splice(0)) resolve();
  }

  interrupt(): Promise<void> {
    return Promise.resolve();
  }

  listenerErrors(): unknown[] {
    return [];
  }

  subscribe(_listener: (event: EventEnvelope) => void): () => void {
    return () => {};
  }

  subscribeStream(_listener: (delta: StreamTextDelta) => void): () => void {
    return () => {};
  }
}

// 固化规则夹具：工具级（不限目录），出处结构按 state/grants.ts 的 PromotedFrom 形状
const CONFIG_RULE: ConfigGrantRule = {
  tool: "read_file",
  promotedFrom: {
    grantId: asGrantId("grant_01J5Z7K8W9ABCDEFGHJKMNPR11"),
    sessionId: SESSION_ID,
    firstCall: { toolCallId: "tc-old", args: { path: "src/a.ts" } },
    promotedAt: 1700000000000,
  },
};

function makeView(configRules: readonly ConfigGrantRule[] = []): {
  shell: PigeonTuiShell;
  term: MockTerminal;
  runtime: StubRuntime;
  store: SessionGrantStore;
  root: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tui-grants-"));
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-log-"));
  const term = new MockTerminal(90, 30);
  const runtime = new StubRuntime();
  const store = new SessionGrantStore({ workspaceRoot: root });
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime,
    sessionId: SESSION_ID,
    logDir,
    grants: { root, store, configRules },
  });
  return {
    shell,
    term,
    runtime,
    store,
    root,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(logDir, { recursive: true, force: true });
    },
  };
}

test("/grants 空列表：如实说明无生效项（文案同 listGrants 口径）", async () => {
  const { shell, term, cleanup } = makeView();
  try {
    shell.start();
    await settle();
    term.input("/grants");
    term.input("\r");
    await settle();
    const flat = screenFlat(term);
    assert.ok(flat.includes("> /grants"), `命令回显\n${flat}`);
    assert.ok(flat.includes("会话放权（0）："), flat);
    assert.ok(flat.includes("固化规则（0，来自 .pigeon/grants.json）："), flat);
    assert.ok(
      flat.includes("（无——审批提示可用 [a]/[d] 创建会话放权，/grants save <id> 升格固化）"),
      `空列表文案\n${flat}`
    );
  } finally {
    shell.stop();
    cleanup();
  }
});

test("/grants 列出会话 grant（createdAt/命中/作用域/首调）与固化规则（升格时间/出处）", async () => {
  const { shell, term, store, cleanup } = makeView([CONFIG_RULE]);
  try {
    const grant = store.create({
      tool: "edit_file",
      pathPrefix: "src",
      firstCall: { toolCallId: "tc-1", args: { path: "src/a.ts" } },
    });
    shell.start();
    await settle();
    term.input("/grants");
    term.input("\r");
    await settle();
    const flat = screenFlat(term);
    assert.ok(flat.includes("会话放权（1）："), flat);
    assert.ok(flat.includes(grant.grantId), flat);
    assert.ok(flat.includes("仅限目录 src"), `作用域\n${flat}`);
    assert.ok(flat.includes("创建 20"), `createdAt 时间列\n${flat}`);
    assert.ok(flat.includes("命中 0 次"), `命中计数\n${flat}`);
    assert.ok(flat.includes("首调 tc-1"), `首调摘要\n${flat}`);
    assert.ok(flat.includes("固化规则（1，来自 .pigeon/grants.json）："), flat);
    assert.ok(flat.includes("config#0 ｜ read_file ｜ 工具级（不限目录）"), `固化规则行\n${flat}`);
    assert.ok(flat.includes("升格 2023-11-14 22:13"), `升格时间\n${flat}`);
    assert.ok(flat.includes("出处 会话"), `出处\n${flat}`);
  } finally {
    shell.stop();
    cleanup();
  }
});

test("/revoke <id>：store 立即移除（停免审），回显同 cli 措辞；/grants save 升格写配置", async () => {
  const { shell, term, store, root, cleanup } = makeView();
  try {
    const grant = store.create({
      tool: "edit_file",
      firstCall: { toolCallId: "tc-1", args: { path: "a.ts" } },
    });
    shell.start();
    await settle();

    // /grants save：升格固化（正规写入方是人的显式命令）
    term.input(`/grants save ${grant.grantId}`);
    term.input("\r");
    await settle();
    const rules = loadGrantConfig(root);
    assert.equal(rules.length, 1, "grants.json 应写入一条固化规则");
    assert.equal(rules[0]?.promotedFrom.grantId, grant.grantId);
    assert.equal(rules[0]?.promotedFrom.sessionId, SESSION_ID);
    assert.ok(screenFlat(term).includes(`已升格 ${grant.grantId} → .pigeon/grants.json`));

    // /revoke：会话 grant 立即停免审
    term.input(`/revoke ${grant.grantId}`);
    term.input("\r");
    await settle();
    assert.equal(store.list().length, 0, "revoke 后 store 应立即移除");
    const flat = screenFlat(term);
    assert.ok(flat.includes(`已撤销会话放权 ${grant.grantId}：立即生效`), flat);
  } finally {
    shell.stop();
    cleanup();
  }
});

test("未知命令与命令失败如实呈现（同 REPL 口径）", async () => {
  const { shell, term, cleanup } = makeView();
  try {
    shell.start();
    await settle();
    term.input("/blah");
    term.input("\r");
    await settle();
    // 折行点空格会被词界折行吃掉（testing.ts squashSpaces 注释），按去空格比对
    assert.ok(
      squashSpaces(screenFlat(term)).includes(
        squashSpaces(
          "未知命令：/blah（可用 /quit、/sessions、/resume <sessionId>、/search <关键词>、/grants、/revoke <id>、/grants save <id>）"
        )
      )
    );

    // 语义错误：格式合法但不存在的 grant id
    term.input("/revoke grant_01J5Z7K8W9ABCDEFGHJKMNPR99");
    term.input("\r");
    await settle();
    assert.ok(screenFlat(term).includes("命令失败：grant 不存在或已撤销"));
  } finally {
    shell.stop();
    cleanup();
  }
});

test("busy 期间斜杠命令同样被拒绝：不执行、留 [busy] 提示（决策 027 不开旁路）", async () => {
  const { shell, term, runtime, store, cleanup } = makeView();
  runtime.autoResolve = false;
  try {
    shell.start();
    await settle();
    term.input("任务一");
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, ["任务一"]);

    term.input("/grants");
    term.input("\r");
    await settle();
    assert.ok(screenText(term).includes("[busy]"), "busy 提示");
    assert.ok(!screenText(term).includes("会话放权（"), "busy 期间命令不得执行");
    assert.equal(store.list().length, 0);

    runtime.finishAll();
    await settle();
    term.input("\r"); // 缓冲保留的 /grants 重提
    await settle();
    assert.ok(screenFlat(term).includes("会话放权（0）："), "run 结束后缓冲的命令可重提");
  } finally {
    shell.stop();
    cleanup();
  }
});
