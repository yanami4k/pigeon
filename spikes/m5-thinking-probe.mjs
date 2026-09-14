// M5 thinking 映射探针（决策 045 验收项）：直连 pi-ai streamSimple，对 Kimi For Coding
// 分别在不设推理档位与 reasoning=medium 下各调用一次，统计流式事件类型、thinking 增量字符数
// 与终态消息的内容块类型，回答"开源模型的思维链能否映射为 thinking 块"。
// 只打印 JSON 到 stdout，不写文件；密钥只从 KIMI_API_KEY 读。从仓库根目录运行：
//   node spikes/m5-thinking-probe.mjs
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { KIMI_CODING_MODELS } from "@earendil-works/pi-ai/providers/kimi-coding.models";

const apiKey = process.env.KIMI_API_KEY;
if (!apiKey) {
  throw new Error("缺少 KIMI_API_KEY 环境变量");
}
const model = KIMI_CODING_MODELS["kimi-for-coding"];
if (!model) {
  throw new Error("pi-ai 目录中找不到 kimi-for-coding 模型");
}

async function probe(reasoning) {
  const stream = streamSimple(
    model,
    {
      systemPrompt: "你是测试助手。",
      messages: [
        { role: "user", content: "17 乘以 23 等于多少？先想一想再回答，最后只给数字。", timestamp: Date.now() },
      ],
    },
    { apiKey, ...(reasoning === undefined ? {} : { reasoning }) }
  );
  const eventCounts = {};
  let thinkingChars = 0;
  for await (const event of stream) {
    eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
    if (event.type === "thinking_delta") {
      thinkingChars += event.delta.length;
    }
  }
  const message = await stream.result();
  return {
    reasoning: reasoning ?? "未设置",
    eventCounts,
    thinkingChars,
    blockTypes: message.content.map((block) => block.type),
    redactedThinking: message.content.some((block) => block.type === "thinking" && block.redacted === true),
    stopReason: message.stopReason,
    usage: { output: message.usage.output, reasoning: message.usage.reasoning },
  };
}

console.log(
  JSON.stringify(
    {
      model: { id: model.id, api: model.api, reasoningCapable: model.reasoning },
      runs: [await probe(undefined), await probe("medium")],
    },
    null,
    1
  )
);
