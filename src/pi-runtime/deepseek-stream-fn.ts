// 日常使用的 DeepSeek 模型接入入口：默认导出 StreamFn，供 --stream-fn 或环境变量 PIGEON_STREAM_FN 指定本文件。
// 加载时即从环境变量 DEEPSEEK_API_KEY 取 key，缺失即报错（见 deepseek-stream.ts）。
// 具名导出 modelInfo（决策 362）：模型身份、官方人民币价、窗口与输出上限，Pigeon 加载时一并取出。
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { deepseekModelInfo } from "./deepseek-model.ts";
import { createDeepSeekStreamFn } from "./deepseek-stream.ts";

export const modelInfo = deepseekModelInfo();

const deepseekStreamFn: StreamFn = createDeepSeekStreamFn(process.env);
export default deepseekStreamFn;
