// pigeon verify 的参数解析（M8 收口补遗）：每组次数的下限在命令入口就判——
// 低于下限的次数不该先真跑四组共八次回放（几十分钟加模型花费）才在判定阶段报错，而且那时还不落回执。
import assert from "node:assert/strict";
import { test } from "node:test";
import { MIN_RERUN_N } from "../replay/verdict.ts";
import { parseVerifyArgs } from "./index.ts";

const usage = "用法：pigeon verify <选择器>";

test("--n：低于下限在入口就拒绝，报错里给出下限", () => {
  for (const value of ["2", "1", "0", "-1"]) {
    assert.throws(
      () => parseVerifyArgs(["abc123", "--n", value], usage),
      (error: unknown) =>
        new RegExp(`不小于 ${MIN_RERUN_N}`).test(String(error)) && /--n/.test(String(error)),
      `--n ${value} 应被入口拒绝`
    );
  }
  assert.throws(() => parseVerifyArgs(["abc123", "--n", "3.5"], usage), /整数/);
});

test("--n：达到下限及以上照常接受", () => {
  assert.equal(parseVerifyArgs(["abc123", "--n", String(MIN_RERUN_N)], usage).n, MIN_RERUN_N);
  assert.equal(parseVerifyArgs(["abc123", "--n", "5"], usage).n, 5);
  assert.equal(parseVerifyArgs(["abc123"], usage).n, undefined, "不给就用缺省");
});

test("其余参数：选择器必填，门槛在 (0,1]，模型接入参数原样转给通用解析", () => {
  assert.throws(() => parseVerifyArgs([], usage), /缺少候选选择器/);
  assert.throws(() => parseVerifyArgs(["abc123", "--effect", "0"], usage), /--effect/);
  assert.throws(() => parseVerifyArgs(["abc123", "--effect", "1.5"], usage), /--effect/);
  const parsed = parseVerifyArgs(
    ["abc123", "--effect", "0.4", "--keep-worktree", "--provider", "p", "--yolo"],
    usage
  );
  assert.equal(parsed.selector, "abc123");
  assert.equal(parsed.effectThreshold, 0.4);
  assert.equal(parsed.keepWorktree, true);
  assert.deepEqual(parsed.modelArgv, ["--provider", "p", "--yolo"]);
});
