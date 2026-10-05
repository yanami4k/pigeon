// 外部 agent 条件（实验设施）的配置解析与校验、工具目录摘要、自报版本的读法、条件与配置的对应、产物目录的分配、
// 身份段的写入与续跑比对、改动提取的排除口径（不排除时脚本与之前逐字一致）。真容器里跑完整一步见
// stream-external-docker.test.ts。
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { externalAgentsFor } from "./stream-experiment.ts";
import {
  artifactsDirFor,
  ExternalAgentConfigError,
  externalAgentIdentity,
  externalConditionSpec,
  externalContainerArgs,
  loadExternalAgentConfig,
  normalizeExcludePath,
  parseExternalAgentConfig,
  parseSelfReport,
  readLauncherResult,
  toolDirDigest,
} from "./stream-external.ts";
import { checkOrWriteIdentity, type StreamRunIdentity } from "./stream-identity.ts";
import { isExternalCondition, type StreamCondition } from "./stream-results.ts";
import { dockerStreamEnvs } from "./stream-runner.ts";
import { StreamWorkspace } from "./stream-workspace.ts";

function withTmp(run: (dir: string) => void | Promise<void>) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pigeon-ext-"));
    try {
      await run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const valid = (toolDir: string) => ({
  name: "fake-1",
  toolDir,
  command: ["/opt/pigeon-agent/bin/launch", "--quiet"],
  excludePaths: [".agent-state", "./tmp//cache/"],
  env: { AGENT_MODE: "batch", LOG_LEVEL: "info" },
});

test(
  "配置解析：合法的配置读成规整的值；相对的工具目录按配置文件所在目录解析；command 可给单个字符串",
  withTmp((dir) => {
    mkdirSync(path.join(dir, "tools"));
    const config = parseExternalAgentConfig(valid("tools"), "c.json", dir);
    assert.deepEqual(config, {
      name: "fake-1",
      toolDir: path.join(dir, "tools"),
      command: ["/opt/pigeon-agent/bin/launch", "--quiet"],
      excludePaths: [".agent-state", "tmp/cache"],
      env: { AGENT_MODE: "batch", LOG_LEVEL: "info" },
    });
    const single = parseExternalAgentConfig(
      { name: "a", toolDir: path.join(dir, "tools"), command: "/x" },
      "c.json",
      "/elsewhere"
    );
    assert.deepEqual(single.command, ["/x"]);
    assert.deepEqual(single.excludePaths, []);
    assert.deepEqual(single.env, {});
    const file = path.join(dir, "agent.json");
    writeFileSync(file, JSON.stringify(valid("tools")));
    assert.equal(loadExternalAgentConfig(file).toolDir, path.join(dir, "tools"));
    writeFileSync(file, "{not json");
    assert.throws(() => loadExternalAgentConfig(file), /不是合法 JSON/);
  })
);

test(
  "配置校验：名字不合白名单、未知字段、缺或不存在的工具目录、启动命令不是容器内绝对路径、排除路径越界，都拒绝",
  withTmp((dir) => {
    mkdirSync(path.join(dir, "tools"));
    writeFileSync(path.join(dir, "file"), "x");
    const tools = path.join(dir, "tools");
    const bad: Array<[string, Record<string, unknown>, RegExp]> = [
      ["名字含大写", { ...valid(tools), name: "Fake" }, /name/],
      ["名字含下划线", { ...valid(tools), name: "a_b" }, /name/],
      ["名字太长", { ...valid(tools), name: "a".repeat(33) }, /name/],
      ["名字为空", { ...valid(tools), name: "" }, /name/],
      ["名字以连字符开头", { ...valid(tools), name: "-a" }, /name/],
      ["未知字段", { ...valid(tools), image: "x" }, /未知字段 image/],
      ["缺工具目录", { ...valid(tools), toolDir: undefined }, /toolDir/],
      ["工具目录不存在", { ...valid(tools), toolDir: path.join(dir, "nope") }, /不是存在的目录/],
      ["工具目录是文件", { ...valid(tools), toolDir: path.join(dir, "file") }, /不是存在的目录/],
      ["启动命令相对路径", { ...valid(tools), command: ["bin/launch"] }, /绝对路径/],
      ["启动命令为空数组", { ...valid(tools), command: [] }, /command/],
      ["启动命令含空串", { ...valid(tools), command: ["/x", ""] }, /command/],
      ["排除绝对路径", { ...valid(tools), excludePaths: ["/etc"] }, /excludePaths/],
      ["排除含 ..", { ...valid(tools), excludePaths: ["a/../../b"] }, /excludePaths/],
      ["排除 .git", { ...valid(tools), excludePaths: [".git/hooks"] }, /excludePaths/],
      ["排除空串", { ...valid(tools), excludePaths: [""] }, /excludePaths/],
      ["排除只有 .", { ...valid(tools), excludePaths: ["./"] }, /excludePaths/],
      ["排除不是数组", { ...valid(tools), excludePaths: ".a" }, /excludePaths/],
      ["不是对象", [] as unknown as Record<string, unknown>, /JSON 对象/],
    ];
    for (const [label, raw, pattern] of bad) {
      assert.throws(
        () => parseExternalAgentConfig(raw, "c.json", dir),
        (error: Error) => error instanceof ExternalAgentConfigError && pattern.test(error.message),
        label
      );
    }
  })
);

test(
  "配置校验：附加环境变量不得含密钥（名字像 key 的一律拒绝）、不得与跑批器自己设的变量重名、名字与取值须合法",
  withTmp((dir) => {
    const tools = path.join(dir, "tools");
    mkdirSync(tools);
    for (const name of [
      "OPENAI_API_KEY",
      "ANTHROPIC_APIKEY",
      "GITHUB_TOKEN",
      "MY_SECRET",
      "DB_PASSWORD",
      "AWS_CREDENTIALS",
      "SSH_PRIVATE_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "auth_header",
      // SECRET_ENV 之外、配置校验另行拒绝的
      "DEEPSEEK_KEY",
      "OPENAI_KEY",
      "ACCESS_KEY",
      "KEY",
      "KEY_ID",
      "SIGNING_KEYS",
      "DB_PASS",
      "PASSPHRASE",
      "SESSION_COOKIE",
      "BEARER",
      "HTTP_BEARER_VALUE",
      "SESSION_ID",
      "CLIENT_CERT",
    ]) {
      assert.throws(
        () => parseExternalAgentConfig({ ...valid(tools), env: { [name]: "x" } }, "c.json", dir),
        /不得含密钥类变量/,
        name
      );
    }
    for (const name of ["PIGEON_STEP_MARKER", "PIGEON_MODEL_BASE_URL", "PIGEON_MODEL_API_KEY"]) {
      assert.throws(
        () => parseExternalAgentConfig({ ...valid(tools), env: { [name]: "x" } }, "c.json", dir),
        /不得含密钥类变量|由跑批器设置/,
        name
      );
    }
    assert.throws(
      () => parseExternalAgentConfig({ ...valid(tools), env: { "A-B": "x" } }, "c.json", dir),
      /变量名/
    );
    // 不像密钥的照常放行（KEY 只在独立成段时算）
    for (const name of ["KEYBOARD_LAYOUT", "MONKEY_MODE", "LOG_LEVEL", "AGENT_MODE", "PATH"]) {
      assert.deepEqual(
        parseExternalAgentConfig({ ...valid(tools), env: { [name]: "x" } }, "c.json", dir).env,
        { [name]: "x" },
        name
      );
    }
    assert.throws(
      () => parseExternalAgentConfig({ ...valid(tools), env: { A: 1 } }, "c.json", dir),
      /须为字符串/
    );
    assert.throws(
      () => parseExternalAgentConfig({ ...valid(tools), env: ["A=1"] }, "c.json", dir),
      /env 须为对象/
    );
  })
);

test("排除路径的规整与条件说明、作业容器参数", () => {
  assert.equal(normalizeExcludePath("./a//b/"), "a/b");
  assert.equal(normalizeExcludePath(".gitignore"), ".gitignore");
  assert.equal(normalizeExcludePath(".git"), undefined);
  assert.equal(normalizeExcludePath("a\\b"), undefined);
  const config = {
    name: "fake",
    toolDir: "/host/tools",
    command: ["/opt/pigeon-agent/x"],
    excludePaths: [".s"],
    env: {},
  };
  assert.deepEqual(externalConditionSpec(config), {
    name: "ext-fake",
    agent: "ext-fake",
    sessionSearch: false,
    pushedMemory: false,
    network: "gateway-only",
    excludePaths: [".s"],
    verbatimRequestBody: true,
  });
  assert.deepEqual(externalContainerArgs(config, "net-1"), [
    "--network",
    "net-1",
    "--mount",
    "type=bind,source=/host/tools,target=/opt/pigeon-agent,readonly",
  ]);
  assert.equal(isExternalCondition("ext-fake"), true);
  assert.equal(isExternalCondition("ext-"), false);
  assert.equal(isExternalCondition("ext-Fake"), false);
  assert.equal(isExternalCondition("minimal"), false);
});

test(
  "工具目录摘要：内容、可执行位、文件名、符号链接任一变化即变；同样的内容两次相同",
  withTmp((dir) => {
    const tools = path.join(dir, "tools");
    mkdirSync(path.join(tools, "bin"), { recursive: true });
    writeFileSync(path.join(tools, "bin", "run"), "#!/bin/sh\n");
    writeFileSync(path.join(tools, "README"), "x\n");
    const first = toolDirDigest(tools);
    assert.match(first, /^sha256:[0-9a-f]{64}$/);
    assert.equal(toolDirDigest(tools), first);
    writeFileSync(path.join(tools, "README"), "y\n");
    const changed = toolDirDigest(tools);
    assert.notEqual(changed, first);
    if (process.platform !== "win32") {
      chmodSync(path.join(tools, "bin", "run"), 0o755);
      assert.notEqual(toolDirDigest(tools), changed, "可执行位进摘要");
    }
  })
);

test("自报的版本：取标准输出最后一个非空行，是 JSON 即按 JSON 记，否则记原文；没有输出记 null", () => {
  assert.deepEqual(parseSelfReport('banner\n{"version":"1.2.3"}\n\n'), { version: "1.2.3" });
  assert.equal(parseSelfReport("tool 1.2.3\n"), "tool 1.2.3");
  assert.equal(parseSelfReport("\n \n"), null);
});

test("条件与配置的对应：ext- 条件须有同名配置；配置须对应所跑的条件；名字不重复；按条件顺序给出", () => {
  const config = (name: string) => ({
    name,
    toolDir: "/t",
    command: ["/x"],
    excludePaths: [],
    env: {},
  });
  assert.deepEqual(
    externalAgentsFor({
      conditions: ["neither", "ext-b", "ext-a"],
      externalAgents: [config("a"), config("b")],
    }).map((c) => c.name),
    ["b", "a"]
  );
  assert.deepEqual(externalAgentsFor({ conditions: ["neither", "minimal"] }), []);
  assert.throws(
    () => externalAgentsFor({ conditions: ["ext-a"], externalAgents: [] }),
    /没有外部 agent 配置/
  );
  assert.throws(
    () => externalAgentsFor({ conditions: ["neither"], externalAgents: [config("a")] }),
    /没跑它的条件 ext-a/
  );
  assert.throws(
    () => externalAgentsFor({ conditions: ["ext-a"], externalAgents: [config("a"), config("a")] }),
    /名字重复/
  );
});

test(
  "产物目录：按步与尝试分目录，重做取下一个序号，不覆盖",
  withTmp((dir) => {
    const first = artifactsDirFor(dir, 3);
    const second = artifactsDirFor(dir, 3);
    assert.equal(first, path.join(dir, "external", "step-3", "try-1"));
    assert.equal(second, path.join(dir, "external", "step-3", "try-2"));
    assert.ok(existsSync(first) && existsSync(second));
    assert.equal(artifactsDirFor(dir, 4), path.join(dir, "external", "step-4", "try-1"));
  })
);

const baseCore = (): StreamRunIdentity["core"] => ({
  repo: "toy",
  manifestDigest: "m",
  image: "img",
  budget: { maxTurns: 10, wallClockMs: 1000 },
  conditions: ["neither"],
  stepScope: "s",
  promptFormat: "test-files",
  promptLayout: "l",
  taskSelection: { method: "all" },
  maxSteps: null,
  agents: {},
});
const info = { concurrency: 1, harness: { commit: "abc", dirty: false } };

test(
  "身份：外部 agent 记在 agents 下（按条件名）、不进身份摘要；续跑时两边都记了才比对，自报版本或工具目录摘要变了即拒绝",
  withTmp((dir) => {
    const config = {
      name: "fake",
      toolDir: "/host/tools",
      command: ["/opt/pigeon-agent/x"],
      excludePaths: [".s"],
      env: { A: "1" },
    };
    const ext = externalAgentIdentity(config, "sha256:aa", { version: "1" });
    assert.deepEqual(ext, {
      config: {
        name: "fake",
        command: ["/opt/pigeon-agent/x"],
        excludePaths: [".s"],
        env: { A: "1" },
        mount: "/opt/pigeon-agent",
      },
      toolDirDigest: "sha256:aa",
      network: "gateway-only",
      selfReported: { version: "1" },
    });
    assert.ok(!JSON.stringify(ext).includes("/host/tools"), "不记宿主路径");
    // 旧目录（没有外部 agent）续跑加跑外部条件：摘要不变，并进身份头
    const oldDigest = checkOrWriteIdentity(dir, { core: baseCore(), info });
    const withExt = {
      core: { ...baseCore(), conditions: ["ext-fake"], agents: { "ext-fake": ext } },
      info,
    } as StreamRunIdentity;
    assert.equal(checkOrWriteIdentity(dir, withExt), oldDigest);
    // 同样的身份段续跑通过
    assert.equal(checkOrWriteIdentity(dir, withExt), oldDigest);
    // 自报版本变了即拒绝，并指出哪一项
    const newer = {
      core: {
        ...baseCore(),
        conditions: ["ext-fake"],
        agents: { "ext-fake": externalAgentIdentity(config, "sha256:aa", { version: "2" }) },
      },
      info,
    } as StreamRunIdentity;
    assert.throws(() => checkOrWriteIdentity(dir, newer), /agents\.ext-fake\.selfReported/);
    const otherTools = {
      core: {
        ...baseCore(),
        conditions: ["ext-fake"],
        agents: { "ext-fake": externalAgentIdentity(config, "sha256:bb", { version: "1" }) },
      },
      info,
    } as StreamRunIdentity;
    assert.throws(() => checkOrWriteIdentity(dir, otherTools), /agents\.ext-fake\.toolDirDigest/);
    // 只跑内置条件续跑（这次没记外部 agent）照常通过
    assert.equal(checkOrWriteIdentity(dir, { core: baseCore(), info }), oldDigest);
  })
);

test(
  "配置的 settings（设置的逐项说明）：解析进配置、原样记进身份段；续跑时设置变了即拒绝；非对象拒绝",
  withTmp((dir) => {
    mkdirSync(path.join(dir, "tools"));
    const withSettings = parseExternalAgentConfig(
      {
        ...valid("tools"),
        settings: { thinking: "high", maxOutputTokens: "256K", sessionRetention: false },
      },
      "c.json",
      dir
    );
    assert.deepEqual(withSettings.settings, {
      thinking: "high",
      maxOutputTokens: "256K",
      sessionRetention: false,
    });
    // 缺省不记（身份段没有 settings 键）
    const plain = parseExternalAgentConfig(valid("tools"), "c.json", dir);
    assert.equal("settings" in plain, false);
    assert.equal(
      "settings" in externalAgentIdentity(plain, "sha256:aa", null),
      false
    );
    // 给了即原样进身份段
    const identity = externalAgentIdentity(withSettings, "sha256:aa", null);
    assert.deepEqual(identity.settings, withSettings.settings);
    // 不是对象即拒绝
    for (const bad of [["high"], "high", null] as const) {
      assert.throws(
        () =>
          parseExternalAgentConfig(
            { ...valid("tools"), settings: bad as unknown as Record<string, unknown> },
            "c.json",
            dir
          ),
        /settings/
      );
    }
    // 续跑比对：设置不同即拒绝（判为不同条件），并指出哪一项
    const base = {
      core: {
        ...baseCore(),
        conditions: ["ext-fake-1"],
        agents: { "ext-fake-1": identity },
      },
      info,
    } as StreamRunIdentity;
    const digest = checkOrWriteIdentity(dir, base);
    assert.equal(checkOrWriteIdentity(dir, base), digest, "同样的设置续跑通过");
    const changed = {
      core: {
        ...baseCore(),
        conditions: ["ext-fake-1"],
        agents: {
          "ext-fake-1": externalAgentIdentity(
            { ...withSettings, settings: { ...withSettings.settings, thinking: "low" } },
            "sha256:aa",
            null
          ),
        },
      },
      info,
    } as StreamRunIdentity;
    assert.throws(() => checkOrWriteIdentity(dir, changed), /agents\.ext-fake-1\.settings/);
  })
);

// 记下脚本的假工作区 shell：比对改动提取的脚本口径
function recordingShell() {
  const calls: Array<{ script: string; args: readonly string[] }> = [];
  return {
    calls,
    shell: {
      root: "/testbed",
      async sh(script: string, options: { args?: readonly string[] } = {}) {
        calls.push({ script, args: options.args ?? [] });
        return { exitCode: 0, stdout: "tree\n", stderr: "", stdoutBytes: Buffer.from("tree\n") };
      },
    },
  };
}

test("改动提取：不排除时取树的脚本与参数与之前逐字一致；排除时起止两次同一口径，按字面路径从工作区根排除", async () => {
  const plain = recordingShell();
  const ws = new StreamWorkspace(plain.shell as never);
  await ws.worktreeTree();
  await ws.worktreeTree([]);
  await ws.worktreeTree(undefined);
  assert.equal(plain.calls.length, 3);
  for (const call of plain.calls) {
    assert.equal(call.script, plain.calls[0]?.script);
    assert.deepEqual(call.args, []);
  }
  assert.match(plain.calls[0]?.script ?? "", /GIT_INDEX_FILE="\$t" git add -A &&/);
  const excluded = recordingShell();
  const ws2 = new StreamWorkspace(excluded.shell as never);
  await ws2.worktreeTree([".agent-state", "tmp/cache"]);
  await ws2.worktreeTree([".agent-state", "tmp/cache"]);
  assert.equal(excluded.calls[0]?.script, excluded.calls[1]?.script);
  assert.match(excluded.calls[0]?.script ?? "", /git add -A -- \. "\$@"/);
  assert.deepEqual(excluded.calls[0]?.args, [
    ":(top,exclude,literal).agent-state",
    ":(top,exclude,literal)tmp/cache",
  ]);
  // 除了暂存那一句，其余与不排除时相同
  assert.equal(
    excluded.calls[0]?.script.replace('git add -A -- . "$@"', "git add -A"),
    plain.calls[0]?.script
  );
});

// 假 docker：记下每次调用的参数；遇到 run 即失败退出（只看开容器的参数，不往下走）
function fakeDocker(dir: string): { docker: string[]; calls: () => string[][] } {
  const log = path.join(dir, "calls.jsonl");
  const script = path.join(dir, "fake-docker.mjs");
  writeFileSync(
    script,
    [
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
      'process.exit(process.argv[2] === "run" ? 1 : 0);',
    ].join("\n")
  );
  return {
    docker: [process.execPath, script],
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as string[])
        : [],
  };
}

test(
  "作业容器的网络参数：不配外部 agent 时与之前一样断网（--network none）；外部 agent 条件换成内部网络与只读挂载，其余条件照旧",
  withTmp(async (dir) => {
    const human = { bundle: () => Buffer.from("") } as never;
    const config = {
      name: "fake",
      toolDir: "/host/tools",
      command: ["/opt/pigeon-agent/x"],
      excludePaths: [],
      env: {},
    };
    const runArgsOf = async (
      condition: StreamCondition,
      conditionArgs?: (c: StreamCondition) => readonly string[] | undefined
    ) => {
      const fake = fakeDocker(mkdtempSync(path.join(dir, "d-")));
      const envs = dockerStreamEnvs({
        image: "img",
        human,
        prefix: "p",
        docker: fake.docker,
        ...(conditionArgs !== undefined ? { conditionArgs } : {}),
      });
      await assert.rejects(envs.open({ stream: "s", condition, attempt: 1 }, { startCommit: "c" }));
      const run = fake.calls().find((c) => c[0] === "run");
      assert.ok(run !== undefined);
      return run;
    };
    const plain = await runArgsOf("neither");
    const index = plain.indexOf("--network");
    assert.deepEqual(plain.slice(index, index + 2), ["--network", "none"]);
    assert.equal(plain.filter((a) => a === "--network").length, 1);
    assert.ok(!plain.includes("--mount"));
    const args = (c: StreamCondition) =>
      c === "ext-fake" ? externalContainerArgs(config, "net-x") : undefined;
    assert.deepEqual(await runArgsOf("minimal", args), await runArgsOf("minimal"));
    const ext = await runArgsOf("ext-fake", args);
    assert.deepEqual(ext.slice(ext.indexOf("--network"), ext.indexOf("--network") + 2), [
      "--network",
      "net-x",
    ]);
    assert.ok(!ext.includes("none"));
    assert.ok(ext.includes("type=bind,source=/host/tools,target=/opt/pigeon-agent,readonly"));
    assert.ok(!ext.includes("--user"), "用户照镜像的 USER");
  })
);

test(
  "结果文件不可信：是指向宿主路径的符号链接即拒读；普通文件照读，不是 JSON 对象为 undefined",
  withTmp((dir) => {
    const hostFile = path.join(dir, "host-secret.json");
    writeFileSync(hostFile, JSON.stringify({ status: "completed", report: { leaked: true } }));
    const io = path.join(dir, "io");
    mkdirSync(io);
    const result = path.join(io, "result.json");
    let linked = true;
    try {
      symlinkSync(hostFile, result);
    } catch {
      linked = false;
    }
    if (linked) assert.equal(readLauncherResult(result), undefined, "链接到宿主路径的结果文件拒读");
    rmSync(result, { force: true });
    writeFileSync(result, JSON.stringify({ status: "completed", turns: 3 }));
    assert.deepEqual(readLauncherResult(result), { status: "completed", turns: 3 });
    writeFileSync(result, "[1,2]");
    assert.equal(readLauncherResult(result), undefined);
    assert.equal(readLauncherResult(path.join(io, "missing.json")), undefined);
    mkdirSync(path.join(io, "dir.json"));
    assert.equal(readLauncherResult(path.join(io, "dir.json")), undefined, "目录不是普通文件");
  })
);

test(
  "工具目录：含逗号、引号或换行的路径拒绝（原样拼进 --mount 会改变参数含义）；根目录与家目录拒绝",
  withTmp((dir) => {
    const comma = path.join(dir, "a,b");
    mkdirSync(comma);
    for (const [label, toolDir, pattern] of [
      ["逗号", comma, /逗号、引号或换行/],
      ["双引号", path.join(dir, 'a"b'), /逗号、引号或换行/],
      ["单引号", path.join(dir, "a'b"), /逗号、引号或换行/],
      ["换行", path.join(dir, "a\nb"), /逗号、引号或换行/],
      ["根目录", path.parse(dir).root, /根目录/],
      ["家目录", homedir(), /家目录/],
    ] as const) {
      assert.throws(
        () => parseExternalAgentConfig({ ...valid(toolDir), toolDir }, "c.json", dir),
        (error: Error) => error instanceof ExternalAgentConfigError && pattern.test(error.message),
        label
      );
    }
  })
);
