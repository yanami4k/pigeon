// 以错误收尾的运行怎么归类（原外部基准 runner 的判法，决策 205 随旧跑批退役搬到提交流）：内容审核拒答与确定性错误
// 照常判分，其余以错误收尾的由调用方按模型服务故障处理
import { isContextOverflowError } from "../pi-runtime/index.ts";

// 确定性错误的种类：目前只有上下文超长
export type DeterministicError = "context-overflow";

// 内容审核类拒答：provider 以错误收尾，但原因是内容审核而非服务故障——重跑大概率重复，故不按错误行补跑
const CONTENT_REFUSAL_PATTERN =
  /refused to complete|stopped with: sensitive|content[_ -]?(filter|policy|moderation)|high risk|内容审核|敏感内容|违规/i;

export function isContentRefusal(errorMessage: string | undefined): boolean {
  return errorMessage !== undefined && CONTENT_REFUSAL_PATTERN.test(errorMessage);
}

// 确定性错误：同样的请求重发必然再错，补跑只会原样复现，故不按错误行处理。判据是"错误由请求内容本身决定、
// 与服务端当时的状态无关"；目前只认上下文超长（识别用上游按各 provider 报错文案的判定，限额类先排除）。
// 认证失败、泛化的 400、模型不存在等虽然也会复现，但原因在配置而不在这道题，是否同样处理留待裁决，暂按服务故障
export function deterministicErrorOf(
  errorMessage: string | undefined
): DeterministicError | undefined {
  if (errorMessage === undefined) {
    return undefined;
  }
  return isContextOverflowError(errorMessage) ? "context-overflow" : undefined;
}
