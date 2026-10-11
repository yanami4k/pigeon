// 模型请求的失败重试（决策 420）：在装配层包一层 streamFn，每次调用把重试次数作为 maxRetries 交给 pi-ai。重试本身由 pi-ai 的
// retryProviderRequest 做（与官方 SDK 一致：连接失败、408、409、429、5xx 重试，遵从 Retry-After、最长 60 秒，否则指数退避；
// 400 等请求本身有错的不重试），只覆盖开始收回复之前的失败，回复流中途断开不在此列。
// 记录：pi-ai 的重试在其内部，onResponse 只在最终成功时回调一次、onPayload 只在第一次发送前回调一次，都看不出重试。Pigeon 经调用
// 选项里公开的 fetch 接管每一次 HTTP 尝试：一次尝试失败（非 2xx 响应或连接失败）之后又发起了下一次，即为一次重试，记下第几次、
// 上一次的状态码（连接失败记错误文字）与两次之间的实测等待。pi-ai 0.84.4 的 Google 两条线路拒收自带的 fetch，Bedrock 不走 fetch，
// 故只在接入模块声明的线路（modelInfo.api）是下面几条时才接管；其余线路照样传重试次数，只是不记。不改 pi-ai 的内部。
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { RunId } from "../state/ids.ts";
import {
  SESSION_ENTRY_VERSION,
  type SessionCustomEntry,
  SessionEntryType,
} from "../state/session-entries.ts";

// pi-ai 0.84.4 里用 retryProviderRequest 重试、并经调用选项的 fetch 发聊天请求的线路（SDK 自身的重试关着，一次尝试一次 fetch）
const FETCH_OBSERVABLE_APIS: ReadonlySet<string> = new Set([
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
]);

export function retriesObservable(api: string | undefined): boolean {
  return api !== undefined && FETCH_OBSERVABLE_APIS.has(api);
}

// 一次重试：retry 为这次模型请求里的第几次重试（1 起）；上一次尝试的 HTTP 状态码，连接失败时没有、改记错误文字；
// waitMs 为上一次失败到这次重发之间的实测毫秒数
export interface RequestRetry {
  retry: number;
  status?: number;
  error?: string;
  waitMs: number;
}

const ERROR_TEXT_CHARS = 200;

// 会话记录里的一条（Run 之外的请求不带 runId）
export function requestRetryEntry(
  retry: RequestRetry,
  runId: RunId | undefined
): SessionCustomEntry {
  return {
    customType: SessionEntryType.RequestRetry,
    data: {
      version: SESSION_ENTRY_VERSION,
      ...(runId !== undefined ? { runId } : {}),
      ...retry,
      retriedAt: Date.now(),
    },
  };
}

export function withRequestRetries(
  streamFn: StreamFn,
  options: { maxRetries: number; onRetry?: (retry: RequestRetry) => void }
): StreamFn {
  const onRetry = options.onRetry;
  return (model, context, callOptions) =>
    streamFn(model, context, {
      ...callOptions,
      maxRetries: options.maxRetries,
      ...(onRetry !== undefined
        ? { fetch: observeAttempts(callOptions?.fetch ?? globalThis.fetch, onRetry) }
        : {}),
    });
}

// 每次模型请求一个：数尝试，失败之后又来一次尝试即记一次重试
function observeAttempts(base: typeof fetch, onRetry: (retry: RequestRetry) => void): typeof fetch {
  let retries = 0;
  let failed: { status?: number; error?: string; at: number } | undefined;
  return async (input, init) => {
    if (failed !== undefined) {
      retries += 1;
      const { at, ...outcome } = failed;
      failed = undefined;
      try {
        onRetry({ retry: retries, ...outcome, waitMs: Math.max(0, Date.now() - at) });
      } catch {
        // 记录出错不挡请求
      }
    }
    try {
      const response = await base(input, init);
      if (!response.ok) {
        failed = { status: response.status, at: Date.now() };
      }
      return response;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      failed = { error: text.slice(0, ERROR_TEXT_CHARS), at: Date.now() };
      throw error;
    }
  };
}
