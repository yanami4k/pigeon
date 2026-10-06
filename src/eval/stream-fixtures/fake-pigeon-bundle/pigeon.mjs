// 假打包产物（测试夹具，真容器用）：模拟容器里 pigeon run 的契约——从 stdin 读任务、经网关（DEEPSEEK_BASE_URL）
// 发一次请求、在治理根（--governance-root）的 .pigeon/state/sessions 下写一条会话记录（含任务文本，供跨题检索计数）、
// 按题面写工作区文件（题面提到 src/b.test.sh 即写 src/b.txt，否则写 src/a.txt）、结果 JSON 打到标准输出。
// 模式由同目录的 fake-mode.txt 决定（测试在临时副本里写）：缺省正常；fail-once 为本次治理目录里没有标记时
// 写完会话记录即退出 3（不打印结果，模拟作废），并留下标记；hang 挂起（不退出）。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("9.9.9-fake");
  process.exit(0);
}
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const root = argValue("--root") ?? process.cwd();
const gov = argValue("--governance-root") ?? root;
let task = "";
for await (const chunk of process.stdin) task += chunk;

const modePath = new URL("./fake-mode.txt", import.meta.url);
const mode = existsSync(modePath) ? readFileSync(modePath, "utf8").trim() : "work";
if (mode === "hang") {
  // 挂起：一直活着，由跑批器的看守杀掉
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

const sessionsDir = path.join(gov, ".pigeon", "state", "sessions");
const sessionsFound = !existsSync(sessionsDir)
  ? 0
  : readdirSync(sessionsDir, { recursive: true }).filter((f) => String(f).endsWith(".jsonl"))
      .length;

// 经网关发一次请求（Anthropic 消息、占位 key）
let httpStatus = null;
const baseUrl = process.env.DEEPSEEK_BASE_URL;
if (baseUrl) {
  const resp = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.DEEPSEEK_API_KEY ?? "",
    },
    body: JSON.stringify({
      model: "deepseek-flash",
      max_tokens: 1024,
      messages: [{ role: "user", content: task.slice(0, 80) }],
    }),
  });
  httpStatus = resp.status;
  await resp.text();
}

// 在治理根写一条会话记录（含任务文本，后面的题检索得到）
const enc = "--testbed--";
mkdirSync(path.join(sessionsDir, enc), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(
  path.join(sessionsDir, enc, `${stamp}_sess_fake.jsonl`),
  `${JSON.stringify({ type: "task", text: task })}\n`
);

// 工作区改动
mkdirSync(path.join(root, "src"), { recursive: true });
if (task.includes("b.test.sh")) {
  writeFileSync(path.join(root, "src", "b.txt"), "beta\n");
} else {
  writeFileSync(path.join(root, "src", "a.txt"), "alpha\n");
}

if (mode === "fail-once") {
  const marker = path.join(gov, ".pigeon", "state", "failed-once");
  if (!existsSync(marker)) {
    // 已写会话记录但不打印结果：这一步作废，会话应被移出治理根
    writeFileSync(marker, "x\n");
    process.exit(3);
  }
}

const result = {
  sessionId: "sess_fake",
  status: "completed",
  durationMs: 1,
  turns: 1,
  toolCalls: 1,
  approvalsNeeded: 0,
  usage: {
    input: 5,
    output: 7,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 12,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  report: { sessionsFound, cwd: process.cwd(), home: process.env.HOME ?? "", httpStatus },
};
process.stdout.write(`${JSON.stringify(result)}\n`);
