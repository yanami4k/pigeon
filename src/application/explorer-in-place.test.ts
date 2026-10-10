// explorer 不建工作树（决策 377）端到端：真实 git 仓库 + 真实 worker 运行面 + 假模型。explorer 直接读派出方的工作区——
// 读到被忽略、因而任何快照都不会带上的文件即证明读的是工作区本身；不拍快照、不建工作树；作用范围与工作区外读取的审批
// 照样生效。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import { type WorkerApprovalRequest, WorkerOrchestrator } from "../orchestration/workers.ts";
import { createFakeStreamFn, type FakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { createWorkerRuntimeFactory } from "./workers.ts";

const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-explorer-")));
const home = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-explorer-home-")));
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "pigeon@example.invalid"]);
git(["config", "user.name", "pigeon-test"]);
writeFileSync(join(repo, "a.ts"), "tracked\n");
writeFileSync(join(repo, ".gitignore"), "docs/notes.txt\n");
git(["add", "."]);
git(["commit", "-q", "-m", "init"]);
mkdirSync(join(repo, "docs"));
writeFileSync(join(repo, "docs", "notes.txt"), "live notes\n");
writeFileSync(join(home, "outside.txt"), "outside\n");

// 工具结果按调用顺序：取最后一次请求里的全部工具结果文字与是否出错
function toolResults(fake: FakeStreamFn): Array<{ text: string; isError: boolean }> {
  const messages = fake.calls.at(-1)?.context.messages ?? [];
  return messages.flatMap((message) =>
    message.role === "toolResult"
      ? [
          {
            text: message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
            isError: message.isError,
          },
        ]
      : []
  );
}

test("explorer 不拍快照不建工作树、读到派出方工作区的当前内容；作用范围与工作区外读取的审批照样生效", async () => {
  const fakes = new Map<string, FakeStreamFn>();
  const reads: Record<string, string[]> = {
    look: ["docs/notes.txt", join(home, "outside.txt")],
    narrow: ["a.ts"],
  };
  const approvals: WorkerApprovalRequest[] = [];
  let snapshots = 0;
  const orchestrator = new WorkerOrchestrator({
    governanceRoot: repo,
    session: { sessionId: newSessionId() },
    parentPolicy: { allow: ["read_file"], deny: [], approvalMode: "prompt" },
    parentLog: { appendChildSpawned: () => {}, appendChildSettled: () => {} },
    startPoint: () => {
      snapshots += 1;
      throw new Error("explorer 不应拍快照");
    },
    createRuntime: createWorkerRuntimeFactory({
      provider: "fake-provider",
      modelId: "fake-model-1",
      homeDir: home,
      streamFnFor: (request) => {
        const fake = createFakeStreamFn({
          replies: [
            {
              text: "读",
              toolCalls: (reads[request.name] ?? []).map((path) => ({
                name: "read_file",
                args: { path },
              })),
            },
            { text: "查完" },
          ],
        });
        fakes.set(request.name, fake);
        return fake;
      },
    }),
    approvals: async (request) => {
      approvals.push(request);
      return { approved: true };
    },
  });
  const look = await orchestrator.awaitResult(
    orchestrator.spawn({ role: "explorer", task: "查", name: "look" })
  );
  const narrow = await orchestrator.awaitResult(
    orchestrator.spawn({
      role: "explorer",
      task: "只查 docs",
      name: "narrow",
      scopes: [{ tool: "read_file", paths: ["docs"] }],
    })
  );
  assert.equal(look.status, "completed", JSON.stringify(look));
  assert.equal(narrow.status, "completed", JSON.stringify(narrow));
  assert.equal(snapshots, 0);
  assert.equal(existsSync(join(repo, ".pigeon", "state", "worktrees")), false, "没建工作树");
  assert.equal(git(["for-each-ref", "refs/pigeon/"]).trim(), "", "没留快照引用");

  const [notes, outside] = toolResults(fakes.get("look") as FakeStreamFn);
  // 被忽略的文件不会进任何快照：读得到即读的是工作区本身
  assert.ok(notes?.text.includes("live notes") && !notes.isError, notes?.text);
  // 工作区外：经审批读到
  assert.ok(outside?.text.includes("outside") && !outside.isError, outside?.text);
  assert.deepEqual(
    approvals.map((request) => request.worker.name),
    ["look"]
  );
  // 作用范围：范围外拒读
  const [scoped] = toolResults(fakes.get("narrow") as FakeStreamFn);
  assert.equal(scoped?.isError, true);
  assert.ok(!scoped?.text.includes("tracked"), scoped?.text);
});
