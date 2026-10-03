// 联网工具的审批（决策 290）——真实 pi-agent-core Agent + 审批闸 + 命令行审批交互：
//   - web_search 免审批（read 档自动放行，审批通道不被调用）；
//   - web_fetch 第一次访问某网站问人，[a]“以后都允许”即建按网站的放权，此后同一网站不再问；换网站仍问；
//   - 撤销后再问；固化规则带 host 命中记 policy:config；yolo 全放行不问。
// 网页抓取走注入的传输层与解析（不连外网），提炼走假提炼器。
import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import { createCliApprovalHandler } from "../cli/approval-ui.ts";
import { PiRuntimeAdapter } from "../pi-runtime/adapter.ts";
import { createFakeStreamFn, type FakeReply } from "../pi-runtime/fixtures.ts";
import { INJECTION_SNAPSHOT_VERSION, type InjectionSnapshot } from "../pi-runtime/snapshot.ts";
import { asGrantId, newGrantId, newSessionId } from "../state/ids.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { Transport } from "../web/network.ts";
import {
  createWebFetchTool,
  createWebSearchTool,
  webFetchRegistration,
  webSearchRegistration,
} from "../web/tools.ts";
import { createToolGovernance } from "./governance.ts";

const lookup = async () => [{ address: "93.184.216.34", family: 4 as const }];
const transport: Transport = async () =>
  new Response("<html><head><title>页</title></head><body><p>正文</p></body></html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });

function makeTools() {
  return [
    createWebSearchTool({
      backend: {
        id: "fake",
        search: async (params) => ({
          backend: "fake",
          query: params.query,
          results: [{ title: "t", url: "https://r.example/1", snippet: "s" }],
        }),
      },
      defaultMaxResults: 5,
    }),
    createWebFetchTool({
      limits: { timeoutMs: 5_000, maxBytes: 100_000, maxChars: 100_000 },
      lookup,
      transport,
      distill: async () => ({ text: "提炼" }),
    }),
  ];
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(webSearchRegistration());
  registry.register(webFetchRegistration());
  return registry;
}

function makeSnapshot(approvalMode: "prompt" | "yolo"): InjectionSnapshot {
  return {
    version: INJECTION_SNAPSHOT_VERSION,
    model: { provider: "fake-provider", id: "fake-model-1" },
    tools: {
      policy: { allow: ["web_search", "web_fetch"], deny: [], approvalMode },
      advertised: ["web_search", "web_fetch"],
    },
    context: { systemPrompt: "你是 Pigeon 测试助手。" },
    memory: [],
    skills: [],
    createdAt: 1700000000000,
  };
}

const fetchCall = (url: string): FakeReply => ({
  text: "抓",
  toolCalls: [{ name: "web_fetch", args: { url, prompt: "找什么" } }],
});

test("web_search 免审批；web_fetch 第一次访问某网站问人，[a] 以后都允许即放行该网站，换网站仍问；撤销后再问", async () => {
  const store = new SessionGrantStore({ workspaceRoot: "/nonexistent" });
  const prompts: string[] = [];
  const outputs: string[] = [];
  const approvalHandler = createCliApprovalHandler(
    async (prompt) => {
      prompts.push(prompt);
      return "a";
    },
    (text) => outputs.push(text),
    { grants: store }
  );
  const adapter = new PiRuntimeAdapter({
    snapshot: makeSnapshot("prompt"),
    streamFn: createFakeStreamFn({
      replies: [
        { text: "搜", toolCalls: [{ name: "web_search", args: { query: "q" } }] },
        fetchCall("https://docs.example/a"),
        fetchCall("https://docs.example/b"),
        fetchCall("https://other.example/c"),
        { text: "完" },
      ],
    }),
    governance: createToolGovernance({
      registry: makeRegistry(),
      approvalHandler,
      sessionGrants: store,
    }),
    tools: makeTools(),
    sessionId: newSessionId(),
  });
  const result = await adapter.run("查资料");
  assert.equal(result.status, "completed");
  const decisions = result.toolExecutions.map((record) => [
    record.toolName,
    record.decision?.outcome,
    record.decision?.approvedBy,
  ]);
  assert.deepEqual(decisions, [
    ["web_search", "approved", "policy:auto"],
    ["web_fetch", "approved", "human"],
    ["web_fetch", "approved", "human:grant"],
    ["web_fetch", "approved", "human"],
  ]);
  // 只问了两次：docs.example 一次、other.example 一次；提示点名网站，不提供 [d]
  assert.equal(prompts.length, 2);
  assert.match(prompts[0] ?? "", /\[a\] 以后都允许访问 docs\.example/);
  assert.doesNotMatch(prompts[0] ?? "", /\[d\]/);
  assert.match(prompts[1] ?? "", /\[a\] 以后都允许访问 other\.example/);
  assert.match(outputs.join(""), /网站：docs\.example/);
  // 提示里工具、网站、参数三行相连
  assert.match(outputs.join(""), /工具：web_fetch\n网站：docs\.example\n参数：/);
  assert.match(
    outputs.join(""),
    /已创建会话放权 grant_[0-9A-Z]+（web_fetch，仅限网站 docs\.example）/
  );
  const grants = store.list();
  assert.deepEqual(
    grants.map((grant) => [grant.tool, grant.host, grant.hitCount]),
    [
      ["web_fetch", "docs.example", 1],
      ["web_fetch", "other.example", 0],
    ]
  );
  // 按网站的放权不带目录限定
  assert.deepEqual(
    grants.map((grant) => grant.pathPrefix),
    [undefined, undefined]
  );
  // 第二次访问 docs.example 的放行回指第一条放权
  assert.deepEqual(result.toolExecutions[2]?.decision?.grantRef, {
    kind: "session-grant",
    id: grants[0]?.grantId,
  });
  await adapter.dispose();

  // 撤销 docs.example 的放权后再访问：重新问人
  store.revoke(asGrantId(grants[0]?.grantId ?? ""));
  const again = new PiRuntimeAdapter({
    snapshot: makeSnapshot("prompt"),
    streamFn: createFakeStreamFn({
      replies: [fetchCall("https://docs.example/z"), { text: "完" }],
    }),
    governance: createToolGovernance({
      registry: makeRegistry(),
      approvalHandler,
      sessionGrants: store,
    }),
    tools: makeTools(),
    sessionId: newSessionId(),
  });
  const before = prompts.length;
  await again.run("再查");
  assert.equal(prompts.length, before + 1);
  await again.dispose();
});

test("固化规则带网站：命中记 policy:config 并回指出处；不命中的网站仍问人", async () => {
  const prompts: string[] = [];
  const store = new SessionGrantStore({ workspaceRoot: "/nonexistent" });
  const grantId = newGrantId();
  const adapter = new PiRuntimeAdapter({
    snapshot: makeSnapshot("prompt"),
    streamFn: createFakeStreamFn({
      replies: [
        fetchCall("https://docs.example/a"),
        fetchCall("https://x.example/b"),
        { text: "完" },
      ],
    }),
    governance: createToolGovernance({
      registry: makeRegistry(),
      approvalHandler: async (request) => {
        prompts.push(request.host ?? "");
        return { approved: true };
      },
      sessionGrants: store,
      configGrants: [
        {
          tool: "web_fetch",
          host: "docs.example",
          promotedFrom: {
            grantId,
            sessionId: newSessionId(),
            firstCall: { toolCallId: "toolu_0", args: { url: "https://docs.example/" } },
            promotedAt: 1,
          },
        },
      ],
    }),
    tools: makeTools(),
    sessionId: newSessionId(),
  });
  const result = await adapter.run("查");
  assert.deepEqual(
    result.toolExecutions.map((record) => [record.decision?.approvedBy, record.decision?.grantRef]),
    [
      ["policy:config", { kind: "config-rule", id: grantId }],
      ["human", undefined],
    ]
  );
  assert.deepEqual(prompts, ["x.example"]);
  await adapter.dispose();
});

test("放手模式（yolo）：两件工具全部放行，不问人", async () => {
  let asked = 0;
  const adapter = new PiRuntimeAdapter({
    snapshot: makeSnapshot("yolo"),
    streamFn: createFakeStreamFn({
      replies: [
        { text: "搜", toolCalls: [{ name: "web_search", args: { query: "q" } }] },
        fetchCall("https://docs.example/a"),
        fetchCall("https://other.example/c"),
        { text: "完" },
      ],
    }),
    governance: createToolGovernance({
      registry: makeRegistry(),
      approvalHandler: async () => {
        asked += 1;
        return { approved: false };
      },
    }),
    tools: makeTools(),
    sessionId: newSessionId(),
  });
  const result = await adapter.run("查");
  assert.equal(asked, 0);
  assert.deepEqual(
    result.toolExecutions.map((record) => record.decision?.approvedBy),
    ["policy:yolo", "policy:yolo", "policy:yolo"]
  );
  await adapter.dispose();
});

test("没有审批通道（无人值守、非 yolo）：web_search 照常放行，web_fetch 按 fail-closed 拒绝", async () => {
  const adapter = new PiRuntimeAdapter({
    snapshot: makeSnapshot("prompt"),
    streamFn: createFakeStreamFn({
      replies: [
        { text: "搜", toolCalls: [{ name: "web_search", args: { query: "q" } }] },
        fetchCall("https://docs.example/a"),
        { text: "完" },
      ],
    }),
    governance: createToolGovernance({ registry: makeRegistry() }),
    tools: makeTools(),
    sessionId: newSessionId(),
  });
  const result = await adapter.run("查");
  assert.deepEqual(
    result.toolExecutions.map((record) => [record.decision?.outcome, record.decision?.approvedBy]),
    [
      ["approved", "policy:auto"],
      ["rejected", "policy:deny"],
    ]
  );
  await adapter.dispose();
});
