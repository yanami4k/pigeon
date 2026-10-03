// 冒烟测试的假模型（决策 351）：仓库的 createFakeStreamFn，回一句文字收尾；每次请求在环境变量 SMOKE_LOG 指的文件里记一行
// 自进程启动起的毫秒数。它从 node_modules 另加载一份 pi-ai，正好验证打包产物与包外的接入模块能配合
import { appendFileSync } from "node:fs";
import { createFakeStreamFn } from "../src/pi-runtime/fixtures.ts";
import type { StreamFn } from "../src/pi-runtime/index.ts";

const reply = createFakeStreamFn({ replies: [{ text: "完成。" }] });

const streamFn: StreamFn = (model, context, options) => {
  const log = process.env.SMOKE_LOG;
  if (log !== undefined) appendFileSync(log, `${performance.now().toFixed(1)}\n`);
  return reply(model, context, options);
};

export default streamFn;
