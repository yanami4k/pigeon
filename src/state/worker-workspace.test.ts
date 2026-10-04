// worker 工作区联合（M6 S0，决策 064）：加法式新增"无工作区"成员（054 的形状封顶口径不变）。
// git-worktree 成员逐字不动；收尾结果的分支与改动文件对无工作区的 worker 缺省。
// 只读、无工作区的 Reviewer 已退役（决策 137），"无工作区"成员保留在联合里使形状不变。
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { test } from "vitest";
import {
  ChildResultSchema,
  isGitWorktreeWorkspace,
  type WorkerWorkspace,
  WorkerWorkspaceSchema,
} from "./session-payloads.ts";

test("工作区联合：git-worktree 与 none 两种形状都通过；缺字段或未知成员被拒绝", () => {
  assert.ok(
    Value.Check(WorkerWorkspaceSchema, {
      kind: "git-worktree",
      path: "/repo/.pigeon/state/worktrees/w",
      branch: "pigeon/w",
    })
  );
  assert.ok(
    Value.Check(WorkerWorkspaceSchema, {
      kind: "git-worktree",
      baseCommit: "a".repeat(40),
      path: "/repo/.pigeon/state/worktrees/w",
      branch: "pigeon/w",
    }),
    "可选起点提交（决策 082）"
  );
  assert.ok(Value.Check(WorkerWorkspaceSchema, { kind: "none" }));
  assert.ok(!Value.Check(WorkerWorkspaceSchema, { kind: "git-worktree", path: "/repo" }));
  assert.ok(!Value.Check(WorkerWorkspaceSchema, { kind: "container", image: "node" }));
  assert.ok(
    !Value.Check(WorkerWorkspaceSchema, {
      kind: "git-worktree",
      baseCommit: "not-a-commit",
      path: "/repo/.pigeon/state/worktrees/w",
      branch: "pigeon/w",
    }),
    "起点提交必须是完整提交号"
  );
});

test("工作区类型谓词：只有 git 工作树形状判为真", () => {
  const worktree: WorkerWorkspace = {
    kind: "git-worktree",
    path: "/repo/.pigeon/state/worktrees/w",
    branch: "pigeon/w",
  };
  assert.equal(isGitWorktreeWorkspace(worktree), true);
  assert.equal(isGitWorktreeWorkspace({ kind: "none" }), false);
});

test("收尾结果：无工作区时分支与改动文件缺省，可携带结构化内容；缺摘要或截断标记被拒绝", () => {
  const worktreeResult = {
    branch: "pigeon/w",
    changedFiles: ["a.ts"],
    summary: "改完了",
    summaryTruncated: false,
  };
  assert.ok(Value.Check(ChildResultSchema, worktreeResult), "工作树 worker 的结果有效");

  const noWorkspaceResult = {
    summary: "提出 1 个候选",
    summaryTruncated: false,
    structured: { candidates: [{ kind: "skill", name: "anchors" }] },
  };
  assert.ok(Value.Check(ChildResultSchema, noWorkspaceResult), "无工作区的结果可缺分支与改动文件");

  assert.ok(!Value.Check(ChildResultSchema, { summaryTruncated: false }), "摘要必填");
  assert.ok(!Value.Check(ChildResultSchema, { summary: "x" }), "截断标记必填");
  assert.ok(
    !Value.Check(ChildResultSchema, { summary: "x", summaryTruncated: false, branch: "" }),
    "分支不得为空串"
  );
});
