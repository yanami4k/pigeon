// 审批排队（M5.5 S3，决策 040）：并发请求一次一个、先到先问；前一个抛错不堵后面。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApprovalDecision, ApprovalRequest } from "./handler.ts";
import { createApprovalQueue } from "./queue.ts";

function request(toolCallId: string): ApprovalRequest {
  return { toolName: "edit_file", toolCallId, args: { path: `${toolCallId}.ts` } };
}

test("审批排队：并发请求同一时刻只问一个，按到达顺序问", async () => {
  const queue = createApprovalQueue();
  const asked: string[] = [];
  const answers = new Map<string, ReturnType<typeof Promise.withResolvers<ApprovalDecision>>>();
  let inFlight = 0;
  let maxInFlight = 0;
  const handler = queue.wrap(async (incoming) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    asked.push(incoming.toolCallId);
    const answer = Promise.withResolvers<ApprovalDecision>();
    answers.set(incoming.toolCallId, answer);
    try {
      return await answer.promise;
    } finally {
      inFlight -= 1;
    }
  });

  const first = handler(request("a"));
  const second = handler(request("b"));
  const third = handler(request("c"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(asked, ["a"]);
  assert.equal(queue.pending(), 3);

  answers.get("a")?.resolve({ approved: true });
  assert.deepEqual(await first, { approved: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(asked, ["a", "b"]);

  answers.get("b")?.resolve({ approved: false, reason: "不准" });
  assert.deepEqual(await second, { approved: false, reason: "不准" });
  await new Promise((resolve) => setImmediate(resolve));
  answers.get("c")?.resolve({ approved: true });
  await third;
  assert.deepEqual(asked, ["a", "b", "c"]);
  assert.equal(maxInFlight, 1);
  assert.equal(queue.pending(), 0);
});

test("审批排队：前一个 handler 抛错原样上抛，后面的请求照常被问", async () => {
  const queue = createApprovalQueue();
  const handler = queue.wrap(async (incoming) => {
    if (incoming.toolCallId === "boom") {
      throw new Error("面板炸了");
    }
    return { approved: true };
  });
  const failing = handler(request("boom"));
  const next = handler(request("ok"));
  await assert.rejects(failing, /面板炸了/);
  assert.deepEqual(await next, { approved: true });
});

test("决策 303：排队期间被撤回的请求不再交给 handler（不上面板），按拒绝回话，后面的照常", async () => {
  const queue = createApprovalQueue();
  const seen: string[] = [];
  const first = Promise.withResolvers<{ approved: boolean }>();
  const handler = queue.wrap(async (request) => {
    seen.push(request.toolCallId);
    return request.toolCallId === "a" ? first.promise : { approved: true };
  });
  const controller = new AbortController();
  const a = handler({ toolName: "run_command", toolCallId: "a", args: {} });
  const b = handler({
    toolName: "run_command",
    toolCallId: "b",
    args: {},
    signal: controller.signal,
  });
  const c = handler({ toolName: "run_command", toolCallId: "c", args: {} });
  controller.abort();
  first.resolve({ approved: true });
  assert.deepEqual(await a, { approved: true });
  assert.equal((await b).approved, false);
  assert.deepEqual(await c, { approved: true });
  assert.deepEqual(seen, ["a", "c"]);
});
