// 流式重复检测（决策 367）：两种判据（逐字周期、段落相似度）在缺省档（omp）参数下的命中与不命中，中文模板段不误判，
// 两种判据都看到全部增量；包装模型调用时掐断模式以 length 收尾并中止内层请求，只记录模式照常转发；只看正文与思考，不看工具参数
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import { test } from "vitest";
import { OMP_REPETITION_PARAMS } from "../state/runaway-config.ts";
import { createFakeStreamFn, type FakeReply } from "./fixtures.ts";
import { guardRepetition, RepetitionDetector, type RepetitionHit } from "./repetition-guard.ts";

const PREFIX = "开头说明一下情况";
const UNIT = "再读一遍文件。";

function feed(text: string, chunk: number) {
  const detector = new RepetitionDetector(OMP_REPETITION_PARAMS);
  for (let i = 0; i < text.length; i += chunk) {
    const [hit] = detector.push(text.slice(i, i + chunk));
    if (hit !== undefined) return hit;
  }
  return detector.flush()[0];
}

test("逐字周期：末尾由同一单元重复构成即命中，报单元长度、遍数、起点与触发位置；只在检查点上判", () => {
  // 30 字一段：收到 150 字时重复段 142 字不足短周期门槛 180，300 字时 292 字（41 遍）命中
  assert.deepEqual(feed(PREFIX + UNIT.repeat(60), 30), {
    criterion: "cycle",
    periodChars: UNIT.length,
    repeats: 41,
    startChar: PREFIX.length,
    atChar: 300,
  });
});

test("逐字周期：长单元重复不到 3 遍或不到 1,024 字不命中、都到了即命中；不含文字的单元（分隔线）不算", () => {
  const unit =
    "检查第一个函数的返回值，然后对照调用处的参数逐个核对类型，确认没有遗漏的分支与边界条件。"; // 44 字
  const long = `${unit}之后再看看。`.padEnd(70, "啊"); // 70 字，超过短周期上限 60
  assert.equal(feed(long.repeat(14), 70), undefined, "980 字");
  assert.equal(feed(long.repeat(15), 70)?.periodChars, 70);
  // 610 字、内部没有周期的单元：两遍 1,220 字够 1,024 字但不到 3 遍
  const sentences = Array.from({ length: 120 }, (_, i) => `第${i}句。`).join("");
  assert.equal(feed(sentences.repeat(2), 100), undefined, "两遍");
  assert.equal(feed("-=".repeat(400), 50), undefined);
});

// 63 字：过了按字符计的段长门槛（60）
const paragraph = (i: number) =>
  `第${i}次：我先检查配置文件里的端口设置和超时参数，然后重新启动服务，看看日志里有没有报错或者警告，再根据结果决定下一步怎么处理。`;
const sentences = [
  "先读一下入口文件，弄清楚命令行参数是怎么解析的，以及缺省值放在哪里。",
  "测试里有一个用例在临时目录下创建会话文件，我看看它清理目录的时机对不对。",
  "错误信息说找不到模块，可能是相对路径写错了，也可能是构建产物没有更新。",
  "把重复的判断提成一个函数，调用处改成传参，顺手补上中文注释说明用途。",
  "日志显示请求在第三次重试后成功，说明退避的间隔偏短，可以适当拉长一些。",
  "这个类型定义里有一个可选字段在序列化时被丢掉了，需要在写入前剥掉空值。",
  "运行全部测试之前，先单独跑改动涉及的两个文件，确认没有新的失败再提交。",
  "最后核对一遍文档里的参数表，和代码里的缺省值对上，避免使用者照着配错。",
];
// 各不相同的长段：每段两句不同的话
const distinct = sentences.map((line, i) => line + (sentences[(i + 3) % sentences.length] ?? ""));

test("段落相似度：攒满 8 段后近似段达 4 段、且连续 3 段近似即命中（中文逐字成词），起点为最早的近似段；各不相同的段落不命中", () => {
  const looping = Array.from({ length: 8 }, (_, i) => paragraph(i + 1)).join("\n\n");
  const hit = feed(looping, 40);
  assert.equal(hit?.criterion, "paragraph");
  assert.equal(hit?.repeats, 8);
  assert.equal(hit?.startChar, 0);
  assert.equal(feed(distinct.join("\n\n"), 40), undefined);
  // 连续 3 段近似、但最近的段里近似的不到 4 段：不判
  const tail = [...distinct.slice(0, 5), paragraph(1), paragraph(2), paragraph(3)];
  assert.equal(feed(tail.join("\n\n"), 40), undefined);
});

test("中文模板段不误判：只差编号的短行（不足 60 字）不参与比较；长模板段与不同的段交替出现时不算连续近似", () => {
  // 41 字的分步说明：规范化后（逐字成词）超过 60，按字符计不足 60
  const step = (i: number) =>
    `第${i}步：张三把第${i}个配置文件从工作目录复制到备份目录，然后核对权限和属主是否一致。`;
  assert.equal(feed(Array.from({ length: 12 }, (_, i) => step(i + 1)).join("\n\n"), 40), undefined);
  const interleaved = distinct.flatMap((other, i) => [paragraph(i + 1), other]).join("\n\n");
  assert.equal(feed(interleaved, 40), undefined);
});

test("两种判据都看到全部增量：逐字周期命中的那段增量照样进段落切分，之后的段落位置不错位", () => {
  const detector = new RepetitionDetector(OMP_REPETITION_PARAMS);
  const head = `\n\n${"哈".repeat(200)}`;
  assert.deepEqual(
    detector.push(head).map((hit) => hit.criterion),
    ["cycle"]
  );
  const rest = `\n\n${Array.from({ length: 8 }, (_, i) => paragraph(i + 1)).join("\n\n")}\n\n`;
  const hits = [];
  for (let i = 0; i < rest.length; i += 40) {
    hits.push(...detector.push(rest.slice(i, i + 40)));
  }
  const paragraphHit = hits.find((hit) => hit.criterion === "paragraph");
  assert.equal(paragraphHit?.startChar, head.length + 2);
});

const MODEL = {
  id: "fake",
  name: "fake",
  api: "unknown",
  provider: "fake",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 0,
  maxTokens: 0,
} as Model<Api>;

async function guarded(reply: FakeReply, mode: "abort" | "log") {
  const inner = createFakeStreamFn({ replies: [reply] });
  const hits: RepetitionHit[] = [];
  const streamFn = guardRepetition(inner, {
    mode,
    params: OMP_REPETITION_PARAMS,
    onHit: (hit) => hits.push(hit),
  });
  const stream = await streamFn(MODEL, { systemPrompt: "", messages: [] }, {});
  const message = await stream.result();
  const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  return { message, text, hits, innerAborted: inner.calls[0]?.options?.signal?.aborted };
}

test("掐断模式：命中即中止内层请求，本条回复以 length 收尾、内容截至命中处", async () => {
  const full = PREFIX + UNIT.repeat(60);
  const cut = await guarded({ text: full, chunkSize: 30 }, "abort");
  assert.equal(cut.message.stopReason, "length");
  assert.equal(cut.text, full.slice(0, 300));
  assert.equal(cut.hits.length, 1);
  assert.equal(cut.innerAborted, true);
});

test("只记录模式：命中照报（同一通道同一判据只报第一次），回复原样收尾、不中止内层请求", async () => {
  const full = PREFIX + UNIT.repeat(60);
  const logged = await guarded({ text: full, chunkSize: 30 }, "log");
  assert.equal(logged.message.stopReason, "stop");
  assert.equal(logged.text, full);
  assert.deepEqual(
    logged.hits.map((hit) => [hit.channel, hit.criterion]),
    [["text", "cycle"]]
  );
  assert.equal(logged.innerAborted, false);
});

test("只看正文与思考：思考里的重复命中并标明通道，工具参数里的重复不看", async () => {
  const { hits } = await guarded(
    {
      thinking: UNIT.repeat(60),
      text: "好",
      toolCalls: [{ name: "echo", args: { text: UNIT.repeat(60) } }],
    },
    "log"
  );
  assert.deepEqual(
    hits.map((hit) => [hit.channel, hit.criterion]),
    [["thinking", "cycle"]]
  );
});
