// Adapter 的通知队列（决策 297）：Run 进行中递来的通知在这一轮结束时进下一轮（同一个 Run 内，本轮没有工具调用时同样接着跑一轮）；
// 递出之前可撤回；空闲时 runNotices 只带通知开一个 Run；下一次 run 连同输入带上待递的通知（通知在前）。真实 pi-agent-core Agent、假模型。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createToolGovernance } from "../application/governance.ts";
import { PiRuntimeAdapter } from "./adapter.ts";
import { createFakeStreamFn } from "./fixtures.ts";
import type { StreamFn } from "./index.ts";
import { INJECTION_SNAPSHOT_VERSION, type InjectionSnapshot } from "./snapshot.ts";

function createSnapshot(): InjectionSnapshot {
  return {
    version: INJECTION_SNAPSHOT_VERSION,
    model: { provider: "fake-provider", id: "fake-model-1" },
    tools: { policy: { allow: [], deny: [], approvalMode: "prompt" }, advertised: [] },
    context: { systemPrompt: "你是 Pigeon 测试助手。" },
    memory: [],
    skills: [],
    createdAt: 1700000000000,
  };
}

// 每次请求时模型看到的用户消息（按顺序）
function recording(onCall?: (index: number) => void): { streamFn: StreamFn; calls: string[][] } {
  const fake = createFakeStreamFn({ replies: [{ text: "好" }] });
  const calls: string[][] = [];
  const streamFn = ((model, context, options) => {
    calls.push(
      context.messages
        .filter((message) => message.role === "user")
        .map((message) => {
          const content = (message as { content: unknown }).content;
          return typeof content === "string"
            ? content
            : (content as Array<{ type: string; text?: string }>)
                .map((block) => block.text ?? "")
                .join("");
        })
    );
    onCall?.(calls.length);
    return fake(model, context, options);
  }) as StreamFn;
  return { streamFn, calls };
}

function adapterWith(streamFn: StreamFn): PiRuntimeAdapter {
  return new PiRuntimeAdapter({
    snapshot: createSnapshot(),
    streamFn,
    governance: createToolGovernance(),
  });
}

test("Run 进行中递来的通知：这一轮结束时进下一轮，同一个 Run 内接着跑", async () => {
  let adapter: PiRuntimeAdapter | undefined;
  let key = "";
  const { streamFn, calls } = recording((index) => {
    if (index === 1) key = adapter?.notify("[worker 通知] w 已完成") ?? "";
  });
  adapter = adapterWith(streamFn);
  let runs = 0;
  adapter.subscribe((event) => {
    if (event.kind === "run.ended") runs += 1;
  });
  const result = await adapter.run("开始");
  assert.equal(result.status, "completed");
  assert.equal(runs, 1);
  assert.deepEqual(calls, [["开始"], ["开始", "[worker 通知] w 已完成"]]);
  assert.equal(adapter.noticeDelivered(key), true);
  assert.equal(adapter.withdrawNotice(key), false);
  assert.equal(adapter.pendingNotices(), 0);
});

test("递出之前撤回：通知不进对话，也不多跑一轮", async () => {
  let adapter: PiRuntimeAdapter | undefined;
  const { streamFn, calls } = recording((index) => {
    if (index === 1 && adapter !== undefined) {
      const key = adapter.notify("[worker 通知] 撤回的");
      assert.equal(adapter.withdrawNotice(key), true);
      assert.equal(adapter.noticeDelivered(key), false);
    }
  });
  adapter = adapterWith(streamFn);
  await adapter.run("开始");
  assert.deepEqual(calls, [["开始"]]);
});

test("空闲时：runNotices 只带通知开一个 Run；下一次 run 连同输入带上待递的通知（通知在前）", async () => {
  const { streamFn, calls } = recording();
  const adapter = adapterWith(streamFn);
  await assert.rejects(() => adapter.runNotices(), /没有待递的通知/);
  await adapter.run("第一句");
  const key = adapter.notify("[worker 通知] a 已完成");
  assert.equal(adapter.pendingNotices(), 1);
  const woke = await adapter.runNotices();
  assert.equal(woke.status, "completed");
  assert.equal(adapter.noticeDelivered(key), true);
  assert.deepEqual(calls.at(-1), ["第一句", "[worker 通知] a 已完成"]);
  adapter.notify("[worker 通知] b 已完成");
  await adapter.run("第二句");
  assert.deepEqual(calls.at(-1), [
    "第一句",
    "[worker 通知] a 已完成",
    "[worker 通知] b 已完成",
    "第二句",
  ]);
  assert.equal(adapter.pendingNotices(), 0);
});
