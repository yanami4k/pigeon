import assert from "node:assert/strict";
import { test } from "node:test";
import { runWorkQueue } from "./work-queue.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("工作队列：同时最多 N 路，按队列顺序取项，全部做完才返回", async () => {
  let active = 0;
  let peak = 0;
  const order: number[] = [];
  await runWorkQueue([1, 2, 3, 4, 5], 2, async (job) => {
    order.push(job);
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
  });
  assert.equal(peak, 2);
  assert.deepEqual(order, [1, 2, 3, 4, 5]);
});

test("工作队列：取项前等待进行中的暂停；停止后不再取新项", async () => {
  const gate = deferred();
  let pause: Promise<void> | undefined;
  let stop: string | undefined;
  const taken: number[] = [];
  const run = runWorkQueue(
    [1, 2, 3, 4],
    1,
    async (job) => {
      taken.push(job);
      if (job === 1)
        pause = gate.promise.then(() => {
          pause = undefined;
        });
      if (job === 2) stop = "停止";
    },
    { paused: () => pause, stopped: () => stop }
  );
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(taken, [1]);
  gate.resolve();
  await run;
  assert.deepEqual(taken, [1, 2]);
});

test("工作队列：没有项时不起任何一路", async () => {
  let calls = 0;
  await runWorkQueue([], 4, async () => {
    calls += 1;
  });
  assert.equal(calls, 0);
});
