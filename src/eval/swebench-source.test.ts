// 任务源的外部基准实现（决策 097 / 102）。两层：
//   ① 纯函数（任何机器都跑）：镜像命名、测试补丁路径、任务说明、按 id 取子集；
//   ② 真容器（本机有 docker 守护进程与该实例的评测镜像才跑，否则跳过并说明）：测试文件在工具边界上被挡、
//      取出的 diff 相对仓库根且不含镜像自带的未提交改动与测试文件、判分前放掉工作区容器、残留容器按标签清理。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { listContainersByLabel } from "../execution/container-host.ts";
import { newSessionId } from "../state/ids.ts";
import { createReplaceEditTool } from "../tools/replace-edit.ts";
import { WorkspaceReadonlyError } from "../tools/workspace-host.ts";
import {
  SWEBENCH_WORK_DIRECTIVE,
  swebenchImageName,
  swebenchTaskSource,
  testPatchPaths,
} from "./swebench-source.ts";

const TEST_PATCH = [
  "diff --git a/tests/test_pycode_ast.py b/tests/test_pycode_ast.py",
  "--- a/tests/test_pycode_ast.py",
  "+++ b/tests/test_pycode_ast.py",
  "@@ -1,1 +1,2 @@",
  "+# added by the official test patch",
  "diff --git a/tests/roots/new/conf.py b/tests/roots/new/conf.py",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/tests/roots/new/conf.py",
  "@@ -0,0 +1 @@",
  "+x = 1",
  "",
].join("\n");

function writeDataset(dir: string, ids: readonly string[]): string {
  const file = join(dir, "dataset.jsonl");
  writeFileSync(
    file,
    ids
      .map((id) =>
        JSON.stringify({
          instance_id: id,
          problem_statement: `issue of ${id}：1-element tuple rendered incorrectly`,
          test_patch: TEST_PATCH,
          difficulty: "<15 min fix",
          repo: "sphinx-doc/sphinx",
        })
      )
      .join("\n")
  );
  return file;
}

test("镜像命名与测试补丁路径", () => {
  assert.equal(
    swebenchImageName("sphinx-doc__sphinx-9367"),
    "swebench/sweb.eval.x86_64.sphinx-doc_1776_sphinx-9367:latest"
  );
  assert.equal(
    swebenchImageName("Django__Django-11880", "mirror"),
    "mirror/sweb.eval.x86_64.django_1776_django-11880:latest"
  );
  assert.deepEqual(testPatchPaths(TEST_PATCH), [
    "tests/test_pycode_ast.py",
    "tests/roots/new/conf.py",
  ]);
  assert.deepEqual(testPatchPaths(""), []);
});

test("工作方式指令：逐字冻结、每个实例相同、不含任何 issue 内容；任务说明仍是 issue 原文，两者不混", () => {
  // 这句话属于被测条件：换一句分数就可能变。改它等于换条件，须连同审计里的逐字记录一起改
  assert.equal(
    SWEBENCH_WORK_DIRECTIVE,
    "Your task is to make changes to non-test files in the repository at /testbed in order to fix the issue described in the user message, in a way that is general and consistent with the codebase."
  );
  const dir = mkdtempSync(join(tmpdir(), "pigeon-swe-directive-"));
  try {
    const instances = swebenchTaskSource({
      datasetFile: writeDataset(dir, ["a__a-1", "b__b-2"]),
      workDir: join(dir, "work"),
      python: "python3",
      judgeScript: join(dir, "judge.py"),
      budget: { maxTurns: 10, wallClockMs: 60_000 },
    }).instances();
    for (const instance of instances) {
      assert.equal(instance.systemDirective, SWEBENCH_WORK_DIRECTIVE);
      // 指令里没有这道题的任何内容；任务说明里也没有指令
      assert.equal(instance.systemDirective?.includes(instance.id), false);
      assert.equal(instance.systemDirective?.includes("tuple"), false);
      assert.equal(instance.instructions.includes(SWEBENCH_WORK_DIRECTIVE), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("任务说明冻结为 issue 原文：逐字等于数据集的 problem_statement，不加任何包装", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-swe-instr-"));
  try {
    const statement =
      "  1-element tuple rendered incorrectly\n\n**Describe the bug**\nThis is a followup to #7964.\r\n  `(1,)` is rendered as `(1)`.\n";
    const file = join(dir, "dataset.jsonl");
    writeFileSync(
      file,
      JSON.stringify({
        instance_id: "a__a-1",
        problem_statement: statement,
        test_patch: TEST_PATCH,
      })
    );
    const [instance] = swebenchTaskSource({
      datasetFile: file,
      workDir: join(dir, "work"),
      python: "python3",
      judgeScript: join(dir, "judge.py"),
      budget: { maxTurns: 10, wallClockMs: 60_000 },
    }).instances();
    // 逐字：首尾空白、换行风格都不动；没有包装文字、没有受保护文件清单、没有中文
    assert.equal(instance?.instructions, statement);
    assert.doesNotMatch(
      instance?.instructions ?? "",
      /[\u4e00-\u9fff]|<issue>|tests\/test_pycode_ast/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("实例清单：按给定 id 取子集并保持顺序，元数据来自数据集；不认识的 id 与缺字段的行响亮失败", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-swe-"));
  try {
    const datasetFile = writeDataset(dir, ["a__a-1", "b__b-2", "c__c-3"]);
    const base = {
      datasetFile,
      workDir: join(dir, "work"),
      python: "python3",
      judgeScript: join(dir, "judge.py"),
      budget: { maxTurns: 10, wallClockMs: 60_000 },
    };
    const picked = swebenchTaskSource({ ...base, instanceIds: ["c__c-3", "a__a-1"] }).instances();
    assert.deepEqual(
      picked.map((instance) => instance.id),
      ["c__c-3", "a__a-1"]
    );
    assert.equal(picked[0]?.difficulty, "<15 min fix");
    assert.deepEqual(picked[0]?.tags, ["sphinx-doc/sphinx"]);
    assert.equal(picked[0]?.holdout, false);
    assert.deepEqual(picked[0]?.budget, { maxTurns: 10, wallClockMs: 60_000 });
    assert.equal(swebenchTaskSource(base).instances().length, 3);
    assert.throws(
      () => swebenchTaskSource({ ...base, instanceIds: ["nope"] }),
      /数据集里没有这个实例：nope/
    );
    writeFileSync(datasetFile, JSON.stringify({ instance_id: "only-id" }));
    assert.throws(() => swebenchTaskSource(base), /数据集第 1 行缺/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 假 docker：记录每次调用的参数；run / exec / rm 一律成功，exec 吐一个树哈希
const FAKE_DOCKER = `
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({ args }) + "\\n");
if (args[0] === "exec") {
  if (args.join(" ").includes("pigeon-prune-history")) {
    const mode = process.env.FAKE_PRUNE ?? "clean";
    process.stdout.write(
      mode === "clean"
        ? "PRUNED tags=0 all=5 head=5 future=gone\\n"
        : mode === "tags"
          ? "PRUNED tags=3 all=5 head=5 future=gone\\n"
          : mode === "refs"
            ? "PRUNED tags=0 all=9 head=5 future=gone\\n"
            : "PRUNED tags=0 all=5 head=5 future=present\\n"
    );
  } else {
    process.stdout.write("0123456789abcdef0123456789abcdef01234567\\n");
  }
}
process.exit(0);
`;

test("判分代理只出现在判据命令里：配了判分代理，agent 工作区容器的创建参数与每一次进容器的调用里都不出现代理", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-swe-jp-"));
  const previous = process.env.FAKE_DOCKER_LOG;
  try {
    const script = join(dir, "docker.mjs");
    const log = join(dir, "calls.jsonl");
    writeFileSync(script, FAKE_DOCKER);
    writeFileSync(log, "");
    process.env.FAKE_DOCKER_LOG = log;
    const base = {
      datasetFile: writeDataset(dir, ["a__a-1"]),
      workDir: join(dir, "work"),
      python: "python3",
      judgeScript: join(dir, "judge.py"),
      budget: { maxTurns: 10, wallClockMs: 60_000 },
      docker: [process.execPath, script],
      containerRunArgs: ["--memory", "3g"],
    };
    const proxied = swebenchTaskSource({ ...base, judgeProxy: "gateway:7890" });
    const plain = swebenchTaskSource(base);
    const context = {
      governanceRoot: dir,
      condition: "none" as const,
      attempt: 1,
    };
    const [instance] = proxied.instances();
    assert.ok(instance !== undefined);
    const withProxy = await proxied.prepare(instance, { ...context, sessionId: newSessionId() });
    const withoutProxy = await plain.prepare(instance, { ...context, sessionId: newSessionId() });

    // 判分一侧：给了才带，不给一个字都不加
    const hint = [...withProxy.judgeCommandHint];
    assert.deepEqual(hint.slice(hint.indexOf("--proxy"), hint.indexOf("--proxy") + 2), [
      "--proxy",
      "gateway:7890",
    ]);
    assert.equal(withoutProxy.judgeCommandHint.includes("--proxy"), false);

    // agent 一侧：经执行端读一次文件、执行一条命令，再看全部 docker 调用
    const host = withProxy.host;
    assert.ok(host !== undefined);
    await host.exec(
      { program: "python", args: ["-V"], verbatim: false },
      {
        env: { https_proxy: "http://must-not-leak:1" },
        timeoutMs: 20_000,
        maxOutputBytes: 1024,
        signal: undefined,
      }
    );
    await withProxy.release();
    await withoutProxy.release();
    const calls = readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { args: string[] });
    const runs = calls.filter((call) => call.args[0] === "run");
    assert.equal(runs.length, 2);
    // 两个任务源（配了与没配判分代理）建出的工作区容器参数，除容器名外逐字相同
    const normalized = runs.map((call) =>
      call.args.map((arg) => arg.replace(/pigeon-eval-sess_[0-9a-z]+/, "pigeon-eval-<id>"))
    );
    assert.deepEqual(normalized[0], normalized[1]);
    assert.ok(calls.some((call) => call.args[0] === "exec"));
    for (const call of calls) {
      const text = call.args.join(" ");
      assert.doesNotMatch(
        text,
        /proxy|7890|gateway/i,
        `agent 侧的 docker 调用里出现了代理：${text}`
      );
      // 不得顺手把判分侧的容器配置复用过来；网络相关的参数只许出现"无网络"那一处（见下一条用例）
      assert.doesNotMatch(text, /--net=|--add-host|--dns/);
      assert.doesNotMatch(text.replace("--network none", ""), /--network/);
    }
  } finally {
    if (previous === undefined) {
      delete process.env.FAKE_DOCKER_LOG;
    } else {
      process.env.FAKE_DOCKER_LOG = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent 的工作区容器无网络：创建参数里网络恒为 none，调用方的附加参数不得改它", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-swe-offline-"));
  const previous = process.env.FAKE_DOCKER_LOG;
  try {
    const script = join(dir, "docker.mjs");
    const log = join(dir, "calls.jsonl");
    writeFileSync(script, FAKE_DOCKER);
    writeFileSync(log, "");
    process.env.FAKE_DOCKER_LOG = log;
    const base = {
      datasetFile: writeDataset(dir, ["a__a-1"]),
      workDir: join(dir, "work"),
      python: "python3",
      judgeScript: join(dir, "judge.py"),
      budget: { maxTurns: 10, wallClockMs: 60_000 },
      docker: [process.execPath, script],
    };
    const source = swebenchTaskSource({ ...base, containerRunArgs: ["--memory", "3g"] });
    const [instance] = source.instances();
    assert.ok(instance !== undefined);
    const prepared = await source.prepare(instance, {
      governanceRoot: dir,
      sessionId: newSessionId(),
      condition: "none",
      attempt: 1,
    });
    await prepared.release();
    const run = readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => (JSON.parse(line) as { args: string[] }).args)
      .find((args) => args[0] === "run");
    assert.ok(run !== undefined);
    // 网络关闭：恰好一处网络参数，取值 none，且排在镜像名之前（是 docker run 的选项而不是容器命令的参数）
    const networkFlags = run.filter((arg) => /^--net(work)?(=|$)/.test(arg));
    assert.deepEqual(networkFlags, ["--network"]);
    assert.equal(run[run.indexOf("--network") + 1], "none");
    assert.ok(run.indexOf("--network") < run.findIndex((arg) => arg.includes("sweb.eval.")));
    // 调用方的附加参数照常生效，但不得带任何会打开网络的参数
    assert.ok(run.includes("--memory"));
    for (const args of [
      ["--network", "host"],
      ["--network=bridge"],
      ["--net", "host"],
      ["--net=host"],
      ["--add-host", "pypi.org:1.2.3.4"],
      ["--dns", "8.8.8.8"],
      ["--publish", "80:80"],
      ["-p", "80:80"],
      // 短选项与取值粘连的写法
      ["-p8080:80"],
      ["-P"],
      ["-eHTTPS_PROXY=http://10.0.0.1:7890"],
      ["-e", "https_proxy=http://10.0.0.1:7890"],
      ["--env", "HTTP_PROXY=http://10.0.0.1:7890"],
      // 环境变量文件的内容无从检查（可能带代理），一律不收
      ["--env-file", "proxy.env"],
      ["--env-file=proxy.env"],
    ]) {
      assert.throws(
        () => swebenchTaskSource({ ...base, containerRunArgs: args }),
        /工作区容器必须保持无网络/,
        args.join(" ")
      );
    }
    // 不打开网络的参数不误拦
    for (const args of [
      ["--memory", "4g"],
      ["--pids-limit", "512"],
      ["-e", "LANG=C.UTF-8"],
      ["--env=PYTHONDONTWRITEBYTECODE=1"],
      ["--platform", "linux/amd64"],
    ]) {
      assert.doesNotThrow(
        () => swebenchTaskSource({ ...base, containerRunArgs: args }),
        args.join(" ")
      );
    }
  } finally {
    if (previous === undefined) {
      delete process.env.FAKE_DOCKER_LOG;
    } else {
      process.env.FAKE_DOCKER_LOG = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("环境准备先清掉基准提交之后的仓库历史再建初始树；自验不过即准备失败并放掉容器", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-swe-prune-"));
  const previous = { log: process.env.FAKE_DOCKER_LOG, prune: process.env.FAKE_PRUNE };
  try {
    const script = join(dir, "docker.mjs");
    const log = join(dir, "calls.jsonl");
    writeFileSync(script, FAKE_DOCKER);
    process.env.FAKE_DOCKER_LOG = log;
    const source = swebenchTaskSource({
      datasetFile: writeDataset(dir, ["a__a-1"]),
      workDir: join(dir, "work"),
      python: "python3",
      judgeScript: join(dir, "judge.py"),
      budget: { maxTurns: 10, wallClockMs: 60_000 },
      docker: [process.execPath, script],
    });
    const [instance] = source.instances();
    assert.ok(instance !== undefined);
    const context = { governanceRoot: dir, condition: "none" as const, attempt: 1 };
    const calls = (): string[][] =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => (JSON.parse(line) as { args: string[] }).args);

    writeFileSync(log, "");
    delete process.env.FAKE_PRUNE;
    const prepared = await source.prepare(instance, { ...context, sessionId: newSessionId() });
    const execs = calls()
      .filter((args) => args[0] === "exec")
      .map((args) => args.join(" "));
    const pruneAt = execs.findIndex((text) => text.includes("pigeon-prune-history"));
    const treeAt = execs.findIndex((text) => text.includes("git write-tree"));
    // 清理在前、建初始树在后：初始树建在清理过的仓库上，取 diff 不受影响
    assert.ok(pruneAt !== -1, "环境准备没有执行历史清理");
    assert.ok(treeAt > pruneAt, "初始树必须在历史清理之后建立");
    const pruneScript = execs[pruneAt] ?? "";
    // 清理的四件事都在脚本里：删标签与其余引用、过期 reflog、清不可达对象
    for (const step of [
      "update-ref -d",
      "reflog expire",
      "--expire-unreachable=now",
      "gc --prune=now",
    ]) {
      assert.ok(pruneScript.includes(step), `清理脚本缺 ${step}`);
    }
    await prepared.release();

    // 自验三种不过的情形：还有标签、还有 HEAD 之外的提交可达、后续提交对象还在
    for (const [mode, pattern] of [
      ["tags", /历史清理自验未通过.*tags=3/],
      ["refs", /历史清理自验未通过.*all=9 head=5/],
      ["future", /历史清理自验未通过.*future=present/],
    ] as const) {
      writeFileSync(log, "");
      process.env.FAKE_PRUNE = mode;
      await assert.rejects(
        source.prepare(instance, { ...context, sessionId: newSessionId() }),
        pattern,
        mode
      );
      // 准备失败不留容器
      assert.ok(
        calls().some((args) => args[0] === "rm"),
        `${mode}：准备失败后应移除容器`
      );
      assert.equal(
        calls().some((args) => args.join(" ").includes("git write-tree")),
        false,
        `${mode}：自验不过不应继续建初始树`
      );
    }
  } finally {
    for (const [key, value] of [
      ["FAKE_DOCKER_LOG", previous.log],
      ["FAKE_PRUNE", previous.prune],
    ] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

// 真容器层用的实例：镜像自带未提交改动（setup.py、tox.ini）的那一类，正好验证取 diff 的口径
const INSTANCE = process.env.PIGEON_TEST_SWEBENCH_INSTANCE ?? "sphinx-doc__sphinx-9367";

function skipReason(): string | undefined {
  const info = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    // 没有守护进程时 CLI 可能长时间挂着不返回：短超时即判不可用
    timeout: 6_000,
    windowsHide: true,
  });
  if (info.error !== undefined || info.status !== 0) {
    return "本机没有可用的 docker 守护进程";
  }
  const image = spawnSync("docker", ["image", "inspect", swebenchImageName(INSTANCE)], {
    timeout: 20_000,
    windowsHide: true,
  });
  return image.status === 0
    ? undefined
    : `本机没有评测镜像 ${swebenchImageName(INSTANCE)}（测试不主动拉取）`;
}

const skip = skipReason();

describe("SWE-bench 任务源（真容器）", { skip: skip ?? false }, () => {
  test("测试文件在工具边界被挡；diff 相对仓库根、不含镜像自带改动与测试文件；判分前放掉容器；残留容器按标签清理", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pigeon-swe-real-"));
    try {
      const source = swebenchTaskSource({
        datasetFile: writeDataset(dir, [INSTANCE]),
        workDir: join(dir, "work"),
        python: "python3",
        judgeScript: join(dir, "judge.py"),
        budget: { maxTurns: 10, wallClockMs: 60_000 },
      });
      const [instance] = source.instances();
      assert.ok(instance !== undefined);
      const sessionId = newSessionId();
      const label = `pigeon.eval-root=${dir}`;
      const prepared = await source.prepare(instance, {
        governanceRoot: dir,
        sessionId,
        condition: "none",
        attempt: 1,
      });
      const host = prepared.host;
      assert.ok(host !== undefined);
      assert.equal(host.root, "/testbed");
      assert.equal((await listContainersByLabel(label)).length, 1);

      // 容器执行端带了测试环境的 PATH：python 是 testbed 环境的，不是 conda base 的
      const python = await host.exec(
        { program: "python", args: ["-c", "import sys; print(sys.prefix)"], verbatim: false },
        { env: {}, timeoutMs: 60_000, maxOutputBytes: 4096, signal: undefined }
      );
      assert.equal(python.output.trim(), "/opt/miniconda3/envs/testbed");

      // 历史已清：没有标签，--all 可达的提交数等于 HEAD 可达数，最新的提交就是 HEAD；基准提交仍在
      const history = await host.exec(
        {
          program: "/bin/sh",
          args: [
            "-c",
            'echo "tags=$(git tag | wc -l) all=$(git rev-list --all --count) head=$(git rev-list HEAD --count) refs=$(git for-each-ref | wc -l) top=$(git log --all -1 --format=%H) cur=$(git rev-parse HEAD)"',
          ],
          verbatim: false,
        },
        { env: {}, timeoutMs: 60_000, maxOutputBytes: 4096, signal: undefined }
      );
      const facts = Object.fromEntries(
        history.output
          .trim()
          .split(" ")
          .map((pair) => pair.split("=") as [string, string])
      );
      assert.equal(facts.tags, "0");
      assert.equal(facts.all, facts.head);
      assert.equal(facts.refs, "1");
      assert.equal(facts.top, facts.cur);
      assert.ok(Number(facts.head) > 1000, "HEAD 可达的历史应完整保留");
      // 判分侧不动：同一镜像另起的干净容器里标签仍在
      const pristine = spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "--network",
          "none",
          swebenchImageName(INSTANCE),
          "sh",
          "-c",
          "cd /testbed && git tag | wc -l",
        ],
        { encoding: "utf8", timeout: 120_000 }
      );
      assert.ok(Number(pristine.stdout.trim()) > 0, "评测镜像本身不应被改动");

      // 无网络：容器里只有回环接口；取软件包索引必失败（此前默认网络下返回 200）
      const interfaces = await host.exec(
        { program: "ls", args: ["/sys/class/net"], verbatim: false },
        { env: {}, timeoutMs: 60_000, maxOutputBytes: 4096, signal: undefined }
      );
      assert.equal(interfaces.output.trim(), "lo");
      const fetched = await host.exec(
        {
          program: "python",
          args: [
            "-c",
            "import urllib.request; urllib.request.urlopen('https://pypi.org/simple/', timeout=8); print('REACHED')",
          ],
          verbatim: false,
        },
        { env: {}, timeoutMs: 60_000, maxOutputBytes: 4096, signal: undefined }
      );
      assert.notEqual(fetched.exitCode, 0);
      assert.doesNotMatch(fetched.output, /REACHED/);

      // 工具边界：测试文件经 edit_file 改不了
      const edit = createReplaceEditTool(host);
      const protectedFile = await host.readText(
        await host.resolveExisting("tests/test_pycode_ast.py")
      );
      // 取文件开头几行当原文：单独一行（如文档字符串的引号）可能在文件里不唯一
      const firstLine = protectedFile.split("\n").slice(0, 4).join("\n");
      await assert.rejects(
        edit.execute("c1", {
          path: "tests/test_pycode_ast.py",
          old_string: firstLine,
          new_string: `${firstLine} # tampered`,
        }),
        WorkspaceReadonlyError
      );
      // 源码照常可改
      const sourceText = await host.readText(await host.resolveExisting("sphinx/pycode/ast.py"));
      const sourceFirst = sourceText.split("\n").slice(0, 4).join("\n");
      await edit.execute("c2", {
        path: "sphinx/pycode/ast.py",
        old_string: sourceFirst,
        new_string: `${sourceFirst}\n# pigeon-source-change`,
      });
      // 经命令：改测试文件（拦不住，靠取 diff 时排除）、新建文件、再改一次镜像自带就脏的 setup.py
      const shell = await host.exec(
        {
          program: "/bin/sh",
          args: [
            "-c",
            "echo '# tampered-by-shell' >> tests/test_pycode_ast.py && echo 'print(1)' > repro_new.py && echo '# pigeon-setup-change' >> setup.py",
          ],
          verbatim: false,
        },
        { env: {}, timeoutMs: 60_000, maxOutputBytes: 4096, signal: undefined }
      );
      assert.equal(shell.exitCode, 0);

      const judge = await prepared.judge();
      // 判分前工作区容器已放掉
      assert.equal((await listContainersByLabel(label)).length, 0);
      assert.deepEqual(judge.undeterminedExitCodes, [2]);
      assert.deepEqual(judge.command, [...prepared.judgeCommandHint]);
      assert.ok(judge.command.includes(INSTANCE));
      const [predictionsFile] = judge.assets;
      assert.ok(predictionsFile !== undefined);
      const [prediction] = JSON.parse(readFileSync(predictionsFile, "utf8")) as Array<{
        instance_id: string;
        model_patch: string;
      }>;
      assert.equal(prediction?.instance_id, INSTANCE);
      const patch = prediction?.model_patch ?? "";
      const changed = [...patch.matchAll(/^diff --git a\/(\S+) b\//gm)].map((match) => match[1]);
      // 相对仓库根；含源码改动、新文件与 agent 对 setup.py 的那一行；不含测试文件
      assert.deepEqual([...changed].sort(), ["repro_new.py", "setup.py", "sphinx/pycode/ast.py"]);
      assert.match(patch, /^\+# pigeon-source-change$/m);
      assert.doesNotMatch(patch, /tampered/);
      // setup.py 只有 agent 加的那一行：镜像自带的未提交改动不在补丁里（否则判分时打不上）
      const setupHunk = patch.slice(patch.indexOf("diff --git a/setup.py"));
      const setupAdded = setupHunk
        .slice(
          0,
          setupHunk.indexOf("diff --git", 10) === -1
            ? undefined
            : setupHunk.indexOf("diff --git", 10)
        )
        .split("\n")
        .filter((line) => /^[+-][^+-]/.test(line));
      assert.deepEqual(setupAdded, ["+# pigeon-setup-change"]);
      // 释放幂等
      await prepared.release();

      // 残留清理：进程死于中途留下的容器按输出目录标签认领
      const leftover = await source.prepare(instance, {
        governanceRoot: dir,
        sessionId: newSessionId(),
        condition: "none",
        attempt: 1,
      });
      assert.ok(leftover.host !== undefined);
      assert.equal((await listContainersByLabel(label)).length, 1);
      await source.cleanupStale?.(dir);
      assert.equal((await listContainersByLabel(label)).length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

if (skip !== undefined) {
  test(`SWE-bench 任务源（真容器）已跳过：${skip}`, { skip: true }, () => {});
}
