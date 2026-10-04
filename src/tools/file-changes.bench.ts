// 基准：run_command 的文件变化报告（决策 348，提交 a015d72）。量一次命令执行连同命令前后两次取证、比出"改了哪些文件"的耗时。
// 改动前：不论是否 git 工作区，命令前后各同步遍历一次整棵工作树。改动后：git 工作区按命令前后两次 git status 找候选、
// 只对候选取签名；非 git 工作区异步全量扫描，并跳过常见的虚拟环境、构建产物与缓存目录（LISTING_SKIPPED_DIRS）。
// 夹具专门放了"git 不看、扫描却会走"的内容，退回时耗时明显上升：
//   - git 工作区：大量被 .gitignore 忽略、又不在跳过名单里的文件（tmp-cache/）——退回整树扫描即变慢；
//     同组另有一个参照基准，用去掉 fileState 的执行端走整树扫描（即改动前的取法），两者之比就是这项改动的收益；
//   - 非 git 工作区：大量 .venv/、dist/ 下的文件——跳过名单缩水或失效即变慢。
// 两个工作区的文件总数都压在 FILE_SNAPSHOT_LIMIT 以内（超出即截断，扫描会提前停下，量不出差别）。
// 命令是 git --version：起进程的开销固定，随实现变的只有取证。报告是否正确由 file-changes.test.ts 把关，这里只量耗时；
// 夹具在 beforeAll 里先跑一次，报告不为空或被截断即报错（说明夹具失效，量出的数不可信）。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import { createLocalWorkspaceHost } from "./local-host.ts";
import { createRunCommandTool, FILE_SNAPSHOT_LIMIT } from "./run-command.ts";
import type { WorkspaceHost } from "./workspace-host.ts";

// 工作区里"有意义"的源码文件数，与扫描会走、git 不看（或跳过名单该挡住）的文件数
const SOURCE_FILES = 2_000;
const NOISE_FILES = 15_000;
const FILES_PER_DIR = 200;
const COMMAND = "git --version";
const OPTIONS = { time: 3_000, warmupIterations: 2 };

type RunCommandTool = ReturnType<typeof createRunCommandTool>;

if (SOURCE_FILES + NOISE_FILES >= FILE_SNAPSHOT_LIMIT) {
  throw new Error("夹具文件数须小于 FILE_SNAPSHOT_LIMIT，否则扫描提前截断");
}

// 在 root/dir 下建 count 个小文件，每个子目录 FILES_PER_DIR 个
function seedTree(root: string, dir: string, count: number): void {
  for (let i = 0; i < count; i++) {
    const sub = join(root, dir, `d${Math.floor(i / FILES_PER_DIR)}`);
    if (i % FILES_PER_DIR === 0) {
      mkdirSync(sub, { recursive: true });
    }
    writeFileSync(join(sub, `f${i}.txt`), `${dir} ${i}\n`);
  }
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd: root,
    stdio: "ignore",
  });
}

// 跑一次命令，返回文件变化报告；退出码不为 0 即报错
async function runOnce(tool: RunCommandTool) {
  const result = await tool.execute("bench", { command: COMMAND }, undefined);
  if (result.details.exitCode !== 0) {
    throw new Error(`${COMMAND} 退出码 ${result.details.exitCode}：${result.details.output}`);
  }
  return result.details.fileChanges;
}

// 命令什么都没改：报告应为空且完整
async function assertQuiet(tool: RunCommandTool, label: string) {
  const changes = await runOnce(tool);
  const count = changes.added.length + changes.removed.length + changes.modified.length;
  if (count > 0 || changes.truncated) {
    throw new Error(`${label}：夹具失效，空命令报出了文件变化 ${JSON.stringify(changes)}`);
  }
}

describe("run_command 文件变化报告：git 工作区（决策 348）", () => {
  let root = "";
  let tool: RunCommandTool | undefined;
  let scanTool: RunCommandTool | undefined;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pigeon-bench-changes-git-"));
    git(root, "init", "-q");
    writeFileSync(join(root, ".gitignore"), "tmp-cache/\n");
    seedTree(root, "src", SOURCE_FILES);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    // 忽略目录不在 LISTING_SKIPPED_DIRS 里：git status 不进去，整树扫描会逐个取 stat
    seedTree(root, "tmp-cache", NOISE_FILES);
    const host = createLocalWorkspaceHost(root);
    tool = createRunCommandTool({ workspaceRoot: root, host });
    // 参照：去掉 fileState 的执行端，run_command 退回命令前后各列一次整树（改动前的取法）
    const { fileState: _fileState, ...scanOnly } = createLocalWorkspaceHost(root);
    const scanHost: WorkspaceHost = scanOnly;
    scanTool = createRunCommandTool({ workspaceRoot: root, host: scanHost });
    await assertQuiet(tool, "git 工作区");
    await assertQuiet(scanTool, "git 工作区（整树扫描参照）");
  });

  afterAll(() => {
    if (root !== "") rmSync(root, { recursive: true, force: true });
  });

  test("一次命令的文件变化报告（git status 取候选）", async ({ bench }) => {
    await bench("一次命令的文件变化报告（git status 取候选）", async () => {
      await runOnce(tool as RunCommandTool);
    }).run(OPTIONS);
  });

  test("参照：同一工作区退回整树扫描（决策 348 之前的取法）", async ({ bench }) => {
    await bench("参照：同一工作区退回整树扫描（决策 348 之前的取法）", async () => {
      await runOnce(scanTool as RunCommandTool);
    }).run(OPTIONS);
  });
});

describe("run_command 文件变化报告：非 git 工作区（决策 348）", () => {
  let root = "";
  let tool: RunCommandTool | undefined;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pigeon-bench-changes-scan-"));
    seedTree(root, "src", SOURCE_FILES);
    // 跳过名单里的目录：扫描应整个跳过
    seedTree(root, ".venv", NOISE_FILES - 3_000);
    seedTree(root, "dist", 3_000);
    tool = createRunCommandTool({ workspaceRoot: root, host: createLocalWorkspaceHost(root) });
    await assertQuiet(tool, "非 git 工作区");
  });

  afterAll(() => {
    if (root !== "") rmSync(root, { recursive: true, force: true });
  });

  test("一次命令的文件变化报告（异步全量扫描，跳过 .venv、dist 等）", async ({ bench }) => {
    await bench("一次命令的文件变化报告（异步全量扫描，跳过 .venv、dist 等）", async () => {
      await runOnce(tool as RunCommandTool);
    }).run(OPTIONS);
  });
});
