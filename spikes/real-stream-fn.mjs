// 一次性验收用真实 StreamFn（tmp/ 不入库）：Kimi For Coding 订阅端点 + pi-ai anthropic-messages streamSimple。
// 背景：用户指定 KIMI_API_KEY；api.moonshot.cn/.ai 的 OpenAI 兼容端点对该 key 均 401，
// 按既定顺序落到 Kimi For Coding（api.kimi.com/coding，anthropic-messages 线路，模型目录见
// pi-ai providers/data/kimi-coding.json）。密钥只从环境变量读，不落任何文件。
// 形状同 pi-agent-core StreamFn：(model, context, options?) => AssistantMessageEventStream。
// CLI 传入的 model 是快照身份占位（api:"unknown"/baseUrl:""），忽略之，改用目录中的真实模型元数据
// （含 compat.allowEmptySignature / forceAdaptiveThinking 与 thinkingLevelMap）。
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { KIMI_CODING_MODELS } from "@earendil-works/pi-ai/providers/kimi-coding.models";

const apiKey = process.env.KIMI_API_KEY;
if (!apiKey) {
	throw new Error("缺少 KIMI_API_KEY 环境变量");
}

// kimi-for-coding = Kimi K2.7 Code（订阅额度计费，工具调用可靠）；如需更强可换 "k3"
const realModel = KIMI_CODING_MODELS["kimi-for-coding"];
if (!realModel) {
	throw new Error("pi-ai 目录中找不到 kimi-for-coding 模型");
}

export default function realStreamFn(_model, context, options) {
	return streamSimple(realModel, context, { ...options, apiKey });
}
