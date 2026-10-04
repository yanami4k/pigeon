// 计时用的极简假模型（决策 351）：不加载仓库与上游的任何模块（免得假模型自己的加载时间算进去），只回一句文字收尾；
// 每次请求在环境变量 SMOKE_LOG 指的文件里记一行自进程启动起的毫秒数。实现 pi 的 AssistantMessageEventStream 最小形状。
import { appendFileSync } from "node:fs";

export default function measureStreamFn(model) {
  const log = process.env.SMOKE_LOG;
  if (log !== undefined) appendFileSync(log, `${performance.now().toFixed(1)}\n`);
  const usage = {
    input: 0,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "完成。" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const events = [
    { type: "start", partial: { ...message, content: [] } },
    { type: "done", reason: "stop", message },
  ];
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    result: async () => message,
  };
}
