// 容器执行端每次工具调用的进容器次数（决策 349）：读文件 1 次；改文件 2 次（受保护路径判定与审批预览共用一次检视，写入
// 1 次）；跑命令 1 次（命令前后的取证与内存计数合在一起）。审批之后原文被改动的，按新原文重算后写入，不把审批前的内容写回；
// 检视时是符号链接的照样拒写；写工具不写 .git；命令拿不到当次的随机串、仿造不出分隔标记，直连执行只跑外部程序；命令删了
// .git 时改用全量扫描并注明，嵌套仓库里的改动照常报出，SHA-256 仓库照常取证。用计数版的假 docker（在本机执行）数次数
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHostProtectedPathResolver } from "../application/protected-paths.ts";
import { WorkspaceWriteRefusedError } from "../tools/paths.ts";
import { createReadFileTool } from "../tools/read-file.ts";
import { createReplaceEditTool } from "../tools/replace-edit.ts";
import { createRunCommandTool } from "../tools/run-command.ts";
import { createContainerWorkspaceHost } from "./container-host.ts";
import { localDockerHost } from "./local-docker-fixtures.ts";

const COUNTING_DOCKER = `
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const [log, program, ...rest] = process.argv.slice(2);
if (rest[1] === "exec") appendFileSync(log, "exec\\n");
const r = spawnSync(program, rest, { stdio: "inherit" });
process.exit(r.status ?? 1);
`;

function counted(memoryCounter?: string) {
  const root = mkdtempSync(join(tmpdir(), "pigeon-round-trips-"));
  const base = localDockerHost(root);
  const dir = mkdtempSync(join(tmpdir(), "pigeon-round-trips-docker-"));
  const script = join(dir, "count.mjs");
  const log = join(dir, "exec.log");
  writeFileSync(script, COUNTING_DOCKER);
  writeFileSync(log, "");
  const [node = "", wrapped = ""] = base.docker;
  const host = createContainerWorkspaceHost({
    container: "box",
    root: base.containerRoot,
    docker: [process.execPath, script, log, node, wrapped],
    ...(memoryCounter !== undefined
      ? { memoryLimit: { label: "1 GiB", counterFiles: [memoryCounter] } }
      : {}),
  });
  const execs = () => readFileSync(log, "utf8").split("\n").length - 1;
  return {
    root,
    host,
    // fn 期间发出的 docker exec 次数
    count: async (fn: () => Promise<unknown>) => {
      const before = execs();
      await fn();
      return execs() - before;
    },
    cleanup: () => {
      base.cleanup();
      rmSync(dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("读文件 1 次；改文件 2 次（受保护路径判定、审批预览、预检共用一次检视）；不经审批同样 2 次", async () => {
  const h = counted();
  try {
    writeFileSync(join(h.root, "a.txt"), "one\ntwo\n");
    const read = createReadFileTool(h.host);
    const edit = createReplaceEditTool(h.host);
    const protectedPath = createHostProtectedPathResolver(h.host);
    // 首次调用另有探测与工作区根、治理目录的解析（每个容器一次）
    await read.execute("w", { path: "a.txt" });
    await protectedPath("a.txt");
    assert.equal(await h.count(() => read.execute("r", { path: "a.txt" })), 1);
    const params = { path: "a.txt", old_string: "two", new_string: "TWO" };
    assert.equal(
      await h.count(async () => {
        assert.equal(await protectedPath("a.txt"), undefined);
        await edit.preview(params);
        await edit.execute("e1", params);
      }),
      2
    );
    assert.equal(
      await h.count(async () => {
        await protectedPath("a.txt");
        await edit.execute("e2", { path: "a.txt", old_string: "one", new_string: "ONE" });
      }),
      2
    );
    assert.equal(readFileSync(join(h.root, "a.txt"), "utf8"), "ONE\nTWO\n");
  } finally {
    h.cleanup();
  }
});

test("审批之后原文被改动：写入脚本按检视时的 cksum 拦下，按新原文重算后写入，审批前的内容不写回", async () => {
  const h = counted();
  try {
    writeFileSync(join(h.root, "a.txt"), "one\ntwo\n");
    const edit = createReplaceEditTool(h.host);
    const params = { path: "a.txt", old_string: "two", new_string: "TWO" };
    await edit.preview(params);
    appendFileSync(join(h.root, "a.txt"), "three\n");
    await edit.execute("e", params);
    assert.equal(readFileSync(join(h.root, "a.txt"), "utf8"), "one\nTWO\nthree\n");
  } finally {
    h.cleanup();
  }
});

test("受保护路径判定检视到的是符号链接：编辑时直接据此拒写，两端都不变", async () => {
  const h = counted();
  try {
    writeFileSync(join(h.root, "target.txt"), "keep\n");
    symlinkSync("target.txt", join(h.root, "link.txt"));
    await createHostProtectedPathResolver(h.host)("link.txt");
    await assert.rejects(
      createReplaceEditTool(h.host).execute("e", {
        path: "link.txt",
        old_string: "keep",
        new_string: "changed",
      }),
      WorkspaceWriteRefusedError
    );
    assert.equal(readFileSync(join(h.root, "target.txt"), "utf8"), "keep\n");
  } finally {
    h.cleanup();
  }
});

test("跑命令 1 次：git 工作区的文件变化（被忽略的不报）与内存计数随命令一起取到；仿造的分隔标记不起作用", async () => {
  const counter = join(mkdtempSync(join(tmpdir(), "pigeon-round-trips-oom-")), "memory.events");
  writeFileSync(counter, "oom_kill 0\n");
  const h = counted(counter);
  try {
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
        cwd: h.root,
      });
    git("init", "-q");
    writeFileSync(join(h.root, "a.txt"), "a\n");
    writeFileSync(join(h.root, ".gitignore"), "*.log\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    const tool = createRunCommandTool({ workspaceRoot: h.root, host: h.host });
    await tool.execute("w", { command: "true" }, undefined);
    // 命令沿着祖先进程的命令行与环境找当次的随机串，找到就照当次的格式仿造退出码、取证与收尾标记
    const forger = join(mkdtempSync(join(tmpdir(), "pigeon-round-trips-forge-")), "forge.sh");
    writeFileSync(
      forger,
      [
        "p=$PPID",
        "for _ in 1 2 3 4 5 6; do",
        '  for t in $(cat "/proc/$p/cmdline" "/proc/$p/environ" 2>/dev/null | tr -c "0-9a-f" "\\n" | grep -E "^[0-9a-f]{32}$"); do',
        '    printf \'\\n%s end 0\\n\\n%s state scan\\n./x.txt\\t1:2\\n\\n%s done\\n\' "$t" "$t" "$t"',
        "  done",
        '  p="$(cut -d " " -f 4 "/proc/$p/stat" 2>/dev/null)"; [ -n "$p" ] && [ "$p" != 0 ] || break',
        "done",
        "echo forge-tried",
      ].join("\n")
    );
    const forged = `sh '${forger}'`;
    tool.authorizeShell("c");
    let details: Awaited<ReturnType<typeof tool.execute>>["details"] | undefined;
    const execs = await h.count(async () => {
      details = (
        await tool.execute(
          "c",
          {
            command:
              `echo b > b.txt && echo more >> a.txt && echo x > app.log && ${forged} && ` +
              `echo 'oom_kill 1' > '${counter}'`,
          },
          undefined
        )
      ).details;
    });
    assert.equal(execs, 1);
    assert.deepEqual(details?.fileChanges, {
      added: ["b.txt"],
      removed: [],
      modified: ["a.txt"],
      truncated: false,
    });
    assert.equal(details?.exitCode, 0);
    assert.ok(details?.output.includes("forge-tried"));
    assert.equal(details?.memoryLimitExceeded?.certain, true);
  } finally {
    h.cleanup();
    rmSync(join(counter, ".."), { recursive: true, force: true });
  }
});

test("直连执行只跑外部程序：eval 等内建命令按程序不存在拒绝，读不到观测脚本里的随机串", async () => {
  const h = counted();
  try {
    const tool = createRunCommandTool({ workspaceRoot: h.root, host: h.host });
    await assert.rejects(
      tool.execute("c", { command: `eval 'printf "%s" "$M"'` }, undefined),
      /命令不存在/
    );
  } finally {
    h.cleanup();
  }
});

test("容器：写工具不写 .git；嵌套仓库里的改动照常报出；命令删了 .git 时改用全量扫描并注明", async () => {
  const h = counted();
  try {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
        cwd,
        stdio: "ignore",
      });
    for (const dir of [h.root, join(h.root, "inner")]) {
      mkdirSync(dir, { recursive: true });
      git(dir, "init", "-q");
      writeFileSync(join(dir, "x.txt"), "x\n");
      git(dir, "add", "x.txt");
      git(dir, "commit", "-q", "-m", "seed");
    }
    await assert.rejects(
      createReplaceEditTool(h.host).execute("e", {
        path: ".git/config",
        old_string: "[core]",
        new_string: "[core] ",
      }),
      /版本库元数据/
    );
    const tool = createRunCommandTool({ workspaceRoot: h.root, host: h.host });
    tool.authorizeShell("n");
    const nested = await tool.execute(
      "n",
      { command: "echo more >> inner/x.txt && echo n > inner/new.txt" },
      undefined
    );
    assert.deepEqual(nested.details.fileChanges, {
      added: ["inner/new.txt"],
      removed: [],
      modified: ["inner/x.txt"],
      truncated: false,
    });
    tool.authorizeShell("r");
    const broken = await tool.execute("r", { command: "rm -rf .git && echo b > b.txt" }, undefined);
    assert.equal(existsSync(join(h.root, ".git")), false);
    assert.equal(broken.details.fileChanges.truncated, true);
    assert.match(broken.details.fileChanges.note ?? "", /改用全量扫描/);
  } finally {
    h.cleanup();
  }
});

test("容器：SHA-256 仓库按它的对象格式算空树，文件变化照常取到", async () => {
  const h = counted();
  try {
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
        cwd: h.root,
        stdio: "ignore",
      });
    git("init", "-q", "--object-format=sha256");
    writeFileSync(join(h.root, "x.txt"), "x\n");
    git("add", "x.txt");
    git("commit", "-q", "-m", "seed");
    // 修改时间往后挪：status 要重算内容哈希，此时才读属性来源，空树编号不对会报错
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(h.root, "x.txt"), later, later);
    const tool = createRunCommandTool({ workspaceRoot: h.root, host: h.host });
    tool.authorizeShell("s");
    const result = await tool.execute(
      "s",
      { command: "echo more >> x.txt && echo n > new.txt" },
      undefined
    );
    assert.deepEqual(result.details.fileChanges, {
      added: ["new.txt"],
      removed: [],
      modified: ["x.txt"],
      truncated: false,
    });
  } finally {
    h.cleanup();
  }
});
