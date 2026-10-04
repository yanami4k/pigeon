// 基准：容器执行端每种工具一次调用的耗时（决策 349，提交 42a33fb4：每次工具调用尽量一次进容器——读文件 1 次、改文件 2 次、
// 跑命令 1 次；grep、glob 见决策 368）。不依赖真 Docker：假 docker 用 local-docker-fixtures.ts 的本机替身，外面再包一层计数
// 与固定延迟——每次 docker exec 先记一笔、再等 EXEC_DELAY_MS 毫秒，模拟真 docker exec 的往返开销。每次 exec 本身还要起两个
// node 进程（计数层与替身），所以每多一次 exec，单次调用的耗时就上一个台阶；exec 次数退回变多时这里随之变慢。
// afterAll 打出各工具平均每次调用的 exec 次数（含预热），便于对照台阶。
// 精确断言 exec 次数的测试在 src/execution/container-round-trips.test.ts：
//   「读文件 1 次；改文件 2 次（受保护路径判定、审批预览、预检共用一次检视）；不经审批同样 2 次」——read_file 1 次、edit_file 2 次；
//   「跑命令 1 次：git 工作区的文件变化（被忽略的不报）与内存计数随命令一起取到；仿造的分隔标记不起作用」——run_command 1 次。
// write_file、grep、glob 没有测试精确断言次数，这里只量耗时、打出次数。
// 受保护路径判定（application/protected-paths.ts 的 createHostProtectedPathResolver）按分层规则不能从 execution 引用，
// 这里按它对已存在文件的做法直接调执行端的 resolveExisting（它在判定里也只经这一处进容器）。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import { createGlobTool } from "../tools/glob.ts";
import { createGrepTool } from "../tools/grep.ts";
import { createReadFileTool } from "../tools/read-file.ts";
import { FileReadTracker } from "../tools/read-tracker.ts";
import { createReplaceEditTool } from "../tools/replace-edit.ts";
import { createRunCommandTool } from "../tools/run-command.ts";
import type { WorkspaceHost } from "../tools/workspace-host.ts";
import { createWriteFileTool } from "../tools/write-file.ts";
import { createContainerWorkspaceHost } from "./container-host.ts";
import { localDockerHost } from "./local-docker-fixtures.ts";

// 每次 docker exec 的固定延迟（毫秒）
const EXEC_DELAY_MS = 20;
const OPTIONS = { time: 2_000, warmupIterations: 1 };

// 计数与延迟层：argv 为 <延迟毫秒> <计数文件> <替身的 node> <替身脚本> <docker 子命令…>；exec 时往计数文件追加一个字节再同步等待
const DELAYED_DOCKER = `
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const [delay, log, program, ...rest] = process.argv.slice(2);
if (rest[1] === "exec") {
  appendFileSync(log, "x");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(delay));
}
const r = spawnSync(program, rest, { stdio: "inherit" });
process.exit(r.status ?? 1);
`;

interface Fixture {
  root: string;
  host: WorkspaceHost;
  // 计数文件的字节数即累计 exec 次数
  execs: () => number;
  cleanup: () => void;
}

function delayedDocker(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pigeon-bench-round-trips-"));
  const base = localDockerHost(root);
  const dir = mkdtempSync(join(tmpdir(), "pigeon-bench-round-trips-docker-"));
  const script = join(dir, "delayed.mjs");
  const log = join(dir, "exec.log");
  writeFileSync(script, DELAYED_DOCKER);
  writeFileSync(log, "");
  const [node = "", wrapped = ""] = base.docker;
  const host = createContainerWorkspaceHost({
    container: "box",
    root: base.containerRoot,
    docker: [process.execPath, script, String(EXEC_DELAY_MS), log, node, wrapped],
  });
  return {
    root,
    host,
    execs: () => statSync(log).size,
    cleanup: () => {
      base.cleanup();
      rmSync(dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function makeTools(host: WorkspaceHost, root: string, reads: FileReadTracker) {
  return {
    read: createReadFileTool(host),
    edit: createReplaceEditTool(host),
    write: createWriteFileTool(host, reads),
    run: createRunCommandTool({ workspaceRoot: root, host }),
    grep: createGrepTool(host, { maxResults: 50 }),
    glob: createGlobTool(host, { maxResults: 50 }),
  };
}

type Tools = ReturnType<typeof makeTools>;

describe("容器执行端：每种工具一次调用（假 docker，每次 exec 固定延迟）", () => {
  let fixture: Fixture | undefined;
  let tools: Tools | undefined;
  const tally = new Map<string, { calls: number; execs: number }>();
  // edit_file 与 write_file 每次改成新的值，保证每次调用都真的写入
  let editValue = 0;
  let writeValue = 0;

  const use = (): { current: Fixture; tools: Tools } => {
    if (fixture === undefined || tools === undefined) throw new Error("夹具没有建好");
    return { current: fixture, tools };
  };
  // 量一次调用并记下这次调用发出的 exec 次数
  const counted = async (name: string, call: () => Promise<unknown>): Promise<void> => {
    const { current } = use();
    const before = current.execs();
    await call();
    const entry = tally.get(name) ?? { calls: 0, execs: 0 };
    entry.calls += 1;
    entry.execs += current.execs() - before;
    tally.set(name, entry);
  };
  // 受保护路径判定对已存在文件的那一次检视（见文件头）
  const protectedPathCheck = (file: string) => {
    const { host } = use().current;
    return host.resolveExisting(posix.join(host.root, file));
  };

  beforeAll(async () => {
    fixture = delayedDocker();
    const { root, host } = fixture;
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
        cwd: root,
        stdio: "ignore",
      });
    git("init", "-q");
    writeFileSync(join(root, ".gitignore"), "*.log\n");
    writeFileSync(join(root, "r.txt"), "line one\nline two\nline three\n");
    writeFileSync(join(root, "a.txt"), `value: ${editValue}\n`);
    writeFileSync(join(root, "w.txt"), `value: ${writeValue}\n`);
    // grep 与 glob 的搜索对象：几个目录里各有一些源码文件
    for (let d = 0; d < 5; d++) {
      mkdirSync(join(root, "src", `m${d}`), { recursive: true });
      for (let f = 0; f < 20; f++) {
        writeFileSync(
          join(root, "src", `m${d}`, `f${f}.ts`),
          `export const name${f} = "m${d}";\n// needle ${d}-${f}\n`
        );
      }
    }
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    const reads = new FileReadTracker();
    tools = makeTools(host, root, reads);
    // 预热：首次调用另有探测、工作区根与治理目录的解析、搜索后端的探测（每个容器一次），不算进基准
    await tools.read.execute("warm", { path: "r.txt" });
    await protectedPathCheck("r.txt");
    await tools.grep.execute("warm", { pattern: "needle" });
    await tools.glob.execute("warm", { pattern: "**/*.ts" });
    await tools.run.execute("warm", { command: "true" }, undefined);
    // write_file 覆盖已存在的文件前须在本会话读过
    await createReadFileTool(host, { editMode: "replace", reads }).execute("warm", {
      path: "w.txt",
    });
  });

  afterAll(() => {
    const lines = [...tally].map(
      ([name, { calls, execs }]) =>
        `  ${name}：${calls} 次调用，平均每次 ${(execs / Math.max(1, calls)).toFixed(2)} 次 exec`
    );
    console.log(`容器执行端每次调用的 docker exec 次数（含预热）：\n${lines.join("\n")}`);
    fixture?.cleanup();
  });

  test("read_file 一次（应为 1 次 exec）", async ({ bench }) => {
    await bench("read_file 一次（应为 1 次 exec）", async () =>
      counted("read_file", () => use().tools.read.execute("r", { path: "r.txt" }))
    ).run(OPTIONS);
  });

  test("edit_file 一次：受保护路径判定 + 审批预览 + 执行（应为 2 次 exec）", async ({ bench }) => {
    await bench("edit_file 一次：受保护路径判定 + 审批预览 + 执行（应为 2 次 exec）", async () =>
      counted("edit_file", async () => {
        const { edit } = use().tools;
        const params = {
          path: "a.txt",
          old_string: `value: ${editValue}`,
          new_string: `value: ${editValue + 1}`,
        };
        await protectedPathCheck("a.txt");
        await edit.preview(params);
        await edit.execute("e", params);
        editValue += 1;
      })
    ).run(OPTIONS);
  });

  test("write_file 覆盖一次：受保护路径判定 + 审批预览 + 执行", async ({ bench }) => {
    await bench("write_file 覆盖一次：受保护路径判定 + 审批预览 + 执行", async () =>
      counted("write_file", async () => {
        const { write } = use().tools;
        const params = { path: "w.txt", content: `value: ${writeValue + 1}\n` };
        await protectedPathCheck("w.txt");
        await write.preview(params);
        await write.execute("w", params);
        writeValue += 1;
      })
    ).run(OPTIONS);
  });

  test("run_command 一次：git 工作区，命令前后取证合在一起（应为 1 次 exec）", async ({
    bench,
  }) => {
    await bench("run_command 一次：git 工作区，命令前后取证合在一起（应为 1 次 exec）", async () =>
      counted("run_command", () => use().tools.run.execute("c", { command: "true" }, undefined))
    ).run(OPTIONS);
  });

  test("grep 一次", async ({ bench }) => {
    await bench("grep 一次", async () =>
      counted("grep", () => use().tools.grep.execute("g", { pattern: "needle" }))
    ).run(OPTIONS);
  });

  test("glob 一次", async ({ bench }) => {
    await bench("glob 一次", async () =>
      counted("glob", () => use().tools.glob.execute("l", { pattern: "**/*.ts" }))
    ).run(OPTIONS);
  });
});
