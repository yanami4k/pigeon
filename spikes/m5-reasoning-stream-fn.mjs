// M5 验收用真实 StreamFn：与 real-stream-fn.mjs 同一线路（Kimi For Coding，anthropic-messages），
// 额外带上推理档位，使 thinking 块能在 TUI 流式与历史渲染里被实地观察（决策 045 的验收项）。
// Adapter 不设推理档位（M5 不裁决推理档位配置），故只在验收探针里补；缺省 medium，
// 可用环境变量 PIGEON_REASONING 覆盖（off 表示不传）。密钥只从 KIMI_API_KEY 读，不落任何文件。
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { KIMI_CODING_MODELS } from "@earendil-works/pi-ai/providers/kimi-coding.models";

const apiKey = process.env.KIMI_API_KEY;
if (!apiKey) {
  throw new Error("缺少 KIMI_API_KEY 环境变量");
}

const realModel = KIMI_CODING_MODELS["kimi-for-coding"];
if (!realModel) {
  throw new Error("pi-ai 目录中找不到 kimi-for-coding 模型");
}

const level = process.env.PIGEON_REASONING ?? "medium";

export default function reasoningStreamFn(_model, context, options) {
  return streamSimple(realModel, context, {
    ...options,
    apiKey,
    ...(level === "off" ? {} : { reasoning: options?.reasoning ?? level }),
  });
}
