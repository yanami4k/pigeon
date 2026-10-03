// 模型接入的模型信息（决策 362）：接入模块声明的 modelInfo 与 pi-ai 自带目录的查询，随它的 StreamFn 登记；装配运行面时按
// StreamFn 取出（worker、续接与 /reload 重建拿的是同一个函数，不必逐层传）。没登记的 StreamFn（测试夹具等）两样都没有。
// 目录用 pi-ai 0.84.4 公开的 providers/all 查询函数，不碰其内部；只在声明没给全时才动态加载（日常的 DeepSeek 接入声明齐全，
// 不加载）。
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { Value } from "typebox/value";
import {
  type CatalogLookup,
  DEFAULT_CURRENCY,
  type ModelInfoDeclaration,
  ModelInfoDeclarationSchema,
  type ModelInfoValues,
} from "../state/model-info.ts";

export interface ModelAccessInfo {
  declared?: ModelInfoDeclaration;
  catalog?: CatalogLookup;
}

const registry = new WeakMap<StreamFn, ModelAccessInfo>();

export function registerModelAccess(streamFn: StreamFn, info: ModelAccessInfo): StreamFn {
  registry.set(streamFn, info);
  return streamFn;
}

export function modelAccessOf(streamFn: StreamFn): ModelAccessInfo | undefined {
  return registry.get(streamFn);
}

// 接入模块导出的 modelInfo：不合规即报错，指出字段
export function parseModelInfoDeclaration(value: unknown, where: string): ModelInfoDeclaration {
  if (Value.Check(ModelInfoDeclarationSchema, value)) {
    return value;
  }
  const problems = [...Value.Errors(ModelInfoDeclarationSchema, value)].map((failure) => {
    const path = "instancePath" in failure ? String(failure.instancePath) : "";
    return `${path === "" ? "/" : path}：${failure.message}`;
  });
  throw new Error(`${where} 导出的 modelInfo 不合规：${problems.join("；")}`);
}

// 声明是否已给全价格、窗口与输出上限（给全了就不必加载目录）
export function declarationComplete(declared: ModelInfoDeclaration | undefined): boolean {
  return (
    declared?.cost !== undefined &&
    declared.contextWindow !== undefined &&
    declared.maxTokens !== undefined
  );
}

const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

// 目录模块的说明符经变量给出：它的类型声明引用 JSON 不带 import 属性，本仓库的 tsc 设置（skipLibCheck 关着）下会报错，
// 故不让 tsc 解析其类型，只取运行时的 getBuiltinModel
const CATALOG_MODULE = "@earendil-works/pi-ai/providers/all";

// pi-ai 自带目录的查询（价格为美元/百万 token；没有缓存保留时长）。目录里窗口或上限不是正整数的项当作没给
export async function loadCatalogLookup(): Promise<CatalogLookup> {
  const catalog = (await import(CATALOG_MODULE)) as { getBuiltinModel: unknown };
  const lookup = catalog.getBuiltinModel as (provider: string, id: string) => unknown;
  return (provider, id) => {
    const model = lookup(provider, id) as Partial<Record<string, unknown>> | undefined;
    if (typeof model !== "object" || model === null) return undefined;
    const cost = model.cost as Partial<Record<string, unknown>> | undefined;
    const values: ModelInfoValues = {};
    if (
      typeof cost === "object" &&
      cost !== null &&
      [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].every(
        (n) => typeof n === "number" && n >= 0
      )
    ) {
      values.cost = {
        input: cost.input as number,
        output: cost.output as number,
        cacheRead: cost.cacheRead as number,
        cacheWrite: cost.cacheWrite as number,
        currency: DEFAULT_CURRENCY,
      };
    }
    if (positiveInteger(model.contextWindow)) values.contextWindow = model.contextWindow;
    if (positiveInteger(model.maxTokens)) values.maxTokens = model.maxTokens;
    return values;
  };
}
