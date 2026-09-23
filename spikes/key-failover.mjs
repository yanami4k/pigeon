// 多 key 限额切换（real-stream-fn.mjs 用；纯逻辑，不含网络与密钥读取，便于脱网自检）。
// 口径：
//   - 只有限额类错误（HTTP 429，或响应体表明配额/额度耗尽、频率超限）才切 key；认证失败、模型不存在、请求格式错
//     是配置问题，切了只会掩盖，原样交回；
//   - 切换后保持使用新 key，不每次请求来回试；并行的请求共用同一个"当前 key"；
//   - 手上的 key 都撞限额时指数退避 5 秒、15 秒、45 秒（上限三次），仍失败才把错误交回；并行的请求共用同一段退避，
//     但各按自己的中止信号退出（退避本身不挂任何一个请求的信号，谁中止只影响谁）；
//   - 包装层自身出错时交回一个错误事件（带原因），不只结束流——否则调用方拿到的是一个没有任何事件的空响应；
//   - 只在请求的第一个事件就是错误时重试：上游在拿到成功响应后才发 start，限额错误必然是首个事件；
//     内容已经开始往外发之后的错误无法重放，原样交回；
//   - 每次切换与退避向标准错误输出一行告警（第几个 key、发生了什么）；告警与交回的错误文本里都不出现 key 及其任何片段。

// 限额识别口径、去 key 与退避间隔只留一份，在 src/eval/model-limits.ts（延续式跑批的网关同用）
import { BACKOFF_DELAYS_MS, isQuotaError, scrubKeys } from "../src/eval/model-limits.ts";

export { BACKOFF_DELAYS_MS, isQuotaError, scrubKeys };

export function createKeyFailover({
  keys,
  call,
  createStream,
  warn = (line) => process.stderr.write(`${line}\n`),
  sleep = abortableSleep,
  delays = BACKOFF_DELAYS_MS,
  now = () => new Date().toISOString(),
}) {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error("至少需要一个 key");
  }
  // 并行请求共用的状态：当前 key 的下标、进行中的退避
  let active = 0;
  let sharedBackoff = null;
  const label = (index) => `第 ${index + 1} 个 key`;
  const say = (text) => warn(`[real-stream-fn] ${now()} ${scrubKeys(text, keys)}`);

  const backoff = async (level, signal) => {
    if (sharedBackoff === null) {
      const delayMs = delays[level];
      say(
        `${keys.length > 1 ? "两个 key 都撞限额" : "key 撞限额"}，第 ${level + 1} 次退避 ${Math.round(delayMs / 1000)} 秒` +
          `（上限 ${delays.length} 次）后用${label(active)}重试；退避期间并行的请求一起等待`
      );
      // 共用的那段等待不挂信号：发起它的请求中止时，一起等待的请求不受影响
      const pending = sleep(delayMs).finally(() => {
        if (sharedBackoff === pending) {
          sharedBackoff = null;
        }
      });
      sharedBackoff = pending;
    }
    await untilAborted(sharedBackoff, signal);
  };

  return function failoverStream(context, options) {
    const out = createStream();
    const signal = options?.signal;
    (async () => {
      // 本请求在当前退避轮次里已经撞过限额的 key
      let limited = new Set();
      let backoffs = 0;
      for (;;) {
        const index = active;
        const inner = call(keys[index], context, options);
        let first = true;
        let retry = false;
        let lastError;
        for await (const event of inner) {
          if (
            first &&
            event.type === "error" &&
            event.reason !== "aborted" &&
            isQuotaError(event.error?.errorMessage)
          ) {
            retry = true;
            lastError = event;
            break;
          }
          first = false;
          out.push(event.type === "error" ? scrubEvent(event, keys) : event);
        }
        if (!retry) {
          out.end();
          return;
        }
        limited.add(index);
        const other = keys.findIndex((_, candidate) => !limited.has(candidate));
        if (other !== -1) {
          // 还有没撞过的 key：切过去（别的并行请求已经切走时不重复告警）
          if (active === index) {
            active = other;
            say(`${label(index)}撞限额，切换到${label(other)}，后续请求保持使用${label(other)}`);
          }
          continue;
        }
        if (backoffs >= delays.length) {
          say(`退避 ${delays.length} 次后仍撞限额，放弃本次请求并向上报错（当前${label(active)}）`);
          out.push(scrubEvent(lastError, keys));
          out.end();
          return;
        }
        try {
          await backoff(backoffs, signal);
        } catch {
          out.push(abortedEvent(scrubEvent(lastError, keys)));
          out.end();
          return;
        }
        backoffs += 1;
        limited = new Set();
      }
    })().catch((error) => {
      // 包装层自身的意外：按错误事件交回，不让调用方悬着，也不让它拿到一个空响应
      const reason = scrubKeys(error instanceof Error ? error.message : String(error), keys);
      say(`包装层内部错误：${reason}`);
      out.push(internalErrorEvent(`双 key 包装层内部错误：${reason}`));
      out.end();
    });
    return out;
  };
}

function scrubEvent(event, keys) {
  if (event?.error?.errorMessage === undefined) {
    return event;
  }
  return {
    ...event,
    error: { ...event.error, errorMessage: scrubKeys(event.error.errorMessage, keys) },
  };
}

function internalErrorEvent(errorMessage) {
  return {
    type: "error",
    reason: "error",
    error: {
      role: "assistant",
      content: [],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage,
      timestamp: Date.now(),
    },
  };
}

// 等一个共用的 promise，但按本请求自己的信号提前退出
function untilAborted(promise, signal) {
  if (signal === undefined) {
    return promise;
  }
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function abortedEvent(event) {
  return { ...event, reason: "aborted", error: { ...event.error, stopReason: "aborted" } };
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
