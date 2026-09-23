// 经跑批网关的模型接入（决策 155）：模型元数据取上游目录里的真实条目（含兼容开关与思考级别映射），只把基址换成
// 网关给这个作业的地址；请求里的 key 是占位，真 key 只在网关里注入。上游与协议同外部基准的真实链路：
// Kimi For Coding 的 anthropic-messages 线路。
// 模型目录在运行时按需加载：它的类型声明以 JSON 导入写成，在本仓库的 NodeNext 设定下过不了类型检查
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";

// 交给网关的占位 key：网关一律换成真 key，它本身不能用于上游
export const GATEWAY_PLACEHOLDER_KEY = "pigeon-gateway";

export const DEFAULT_GATEWAY_MODEL_ID = "kimi-for-coding";

const CATALOG_MODULE = "@earendil-works/pi-ai/providers/kimi-coding.models";

type CatalogModel = Parameters<typeof streamSimple>[0];

let catalog: Promise<Record<string, CatalogModel | undefined>> | undefined;

async function catalogModel(modelId: string): Promise<CatalogModel> {
  catalog ??= import(CATALOG_MODULE).then(
    (m: { KIMI_CODING_MODELS: Record<string, CatalogModel | undefined> }) => m.KIMI_CODING_MODELS
  );
  const model = (await catalog)[modelId];
  if (model === undefined) throw new Error(`上游目录里没有模型 ${modelId}`);
  return model;
}

// 上游基址（网关转发的目标）
export async function gatewayUpstreamBaseUrl(modelId = DEFAULT_GATEWAY_MODEL_ID): Promise<string> {
  return (await catalogModel(modelId)).baseUrl.replace(/\/+$/, "");
}

export function gatewayStreamFn(baseUrl: string, modelId = DEFAULT_GATEWAY_MODEL_ID): StreamFn {
  // 调用方传入的 model 只是快照身份占位，忽略之，用目录里的真实元数据
  return async (_model, context, options) => {
    const routed = { ...(await catalogModel(modelId)), baseUrl };
    return streamSimple(routed, context, { ...options, apiKey: GATEWAY_PLACEHOLDER_KEY });
  };
}
