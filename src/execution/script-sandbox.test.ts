// 编排脚本的隔离（决策 310）：执行器的受限上下文里读文件、跑命令、联网、require、import、process、读时间与取随机数一律报错；
// 由字符串生成代码与借积木的构造器逃出上下文同样不成；积木只收发字符串。容器参数钉住：不挂目录、断网、限资源、只读根、去能力。
// 本文件用本机进程版驱动同一个执行器；真容器的端到端用例在 script-docker.test.ts（服务器上跑）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  localScriptLauncher,
  SCRIPT_CONTAINER_LIMITS,
  type ScriptExecutorMessage,
  scriptContainerArgs,
} from "./script-sandbox.ts";

// 跑一段脚本，agent 调用交给 answer 回话；返回收到的全部消息与结局
async function runScript(
  source: string,
  answer: (payload: unknown) => unknown = () => ({ ok: true })
): Promise<{ messages: ScriptExecutorMessage[]; end: ScriptExecutorMessage }> {
  const proc = localScriptLauncher()({ runId: "t" });
  const messages: ScriptExecutorMessage[] = [];
  const end = new Promise<ScriptExecutorMessage>((resolve) => {
    proc.onMessage((message) => {
      messages.push(message);
      if (message.t === "call") {
        proc.send({ t: "result", id: message.id, value: answer(message.payload) });
      }
      if (message.t === "done" || message.t === "error") resolve(message);
    });
  });
  proc.send({ t: "start", source, args: null });
  const result = await Promise.race([
    end,
    proc.exited.then((exit) => ({ t: "error" as const, message: `退出：${exit.stderr}` })),
  ]);
  await proc.kill();
  return { messages, end: result };
}

const FORBIDDEN: ReadonlyArray<[string, string, RegExp]> = [
  ["读文件", 'return require("node:fs").readFileSync("/etc/hostname", "utf8");', /require/],
  ["跑命令", 'return require("node:child_process").execSync("echo hi").toString();', /require/],
  ["联网", 'return await fetch("http://example.com");', /fetch/],
  ["process", "return process.env;", /process/],
  ["动态 import", 'const fs = await import("node:fs"); return typeof fs;', /import|dynamic/i],
  ["Date.now", "return Date.now();", /读时间/],
  ["new Date()", "return new Date().getTime();", /读时间/],
  ["Date()", "return Date();", /读时间/],
  ["Math.random", "return Math.random();", /随机数/],
  ["eval", 'return eval("1 + 1");', /EvalError|Code generation|disallowed/i],
  [
    "借积木的构造器逃出",
    'return agent.constructor.constructor("return process")().pid;',
    /EvalError|Code generation|disallowed/i,
  ],
  ["经日期原型拿回原构造器", "return new Date(0).constructor.now();", /读时间/],
  ["格式化当前时间", "return new Intl.DateTimeFormat().format();", /Intl/],
];

for (const [what, source, pattern] of FORBIDDEN) {
  test(`隔离：脚本里${what}报错`, async () => {
    const { end } = await runScript(source);
    assert.equal(end.t, "error", `${what} 应报错，实际 ${JSON.stringify(end)}`);
    assert.match((end as { message: string }).message, pattern);
  });
}

test("隔离：静态 import 是语法错误", async () => {
  const { end } = await runScript('import fs from "node:fs";\nreturn 1;');
  assert.equal(end.t, "error");
  assert.match((end as { message: string }).message, /SyntaxError/);
});

test("隔离：给了参数的 new Date(x) 与纯计算照常可用；积木收发的是 JSON", async () => {
  const { end, messages } = await runScript(
    [
      "const d = new Date(0).toISOString();",
      'const r = await agent("任务", { role: "explorer", relay: { ref: "abc" } });',
      "return { d, ok: r.ok, keys: Object.keys(r), sorted: [3, 1, 2].sort() };",
    ].join("\n"),
    () => ({ ok: true, extra: 1 })
  );
  assert.deepEqual(end, {
    t: "done",
    value: { d: "1970-01-01T00:00:00.000Z", ok: true, keys: ["ok", "extra"], sorted: [1, 2, 3] },
  });
  const call = messages.find((message) => message.t === "call");
  assert.deepEqual((call as { payload: unknown }).payload, {
    task: "任务",
    role: "explorer",
    relay: "abc",
  });
});

test("容器参数：不挂目录、断网、限内存与进程数、只读根、去能力、不提权，--rm", () => {
  const args = scriptContainerArgs({ image: "img:1", name: "pigeon-script-x-1", source: "SRC" });
  assert.ok(!args.includes("-v") && !args.includes("--volume") && !args.includes("--mount"));
  assert.ok(!args.some((arg) => arg.startsWith("-v") || arg.startsWith("--mount")));
  const at = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(at("--network"), "none");
  assert.equal(at("--memory"), SCRIPT_CONTAINER_LIMITS.memory);
  assert.equal(at("--memory-swap"), SCRIPT_CONTAINER_LIMITS.memory);
  assert.equal(at("--pids-limit"), String(SCRIPT_CONTAINER_LIMITS.pids));
  assert.equal(at("--cap-drop"), "ALL");
  assert.equal(at("--security-opt"), "no-new-privileges");
  assert.ok(args.includes("--read-only") && args.includes("--rm") && args.includes("-i"));
  assert.deepEqual(args.slice(-5), [
    "img:1",
    "node",
    `--max-old-space-size=${SCRIPT_CONTAINER_LIMITS.heapMb}`,
    "-e",
    "SRC",
  ]);
});
