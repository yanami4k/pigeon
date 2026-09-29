// 审批排队（M5.5 S3，决策 040）：主会话与各 worker 的审批请求汇聚到同一个人——一次一个、先到先问。
// 包装任意 ApprovalHandler，不改其语义：取消、fail-closed、放权都仍由被包装的 handler 决定；
// 前一个请求抛错或拒绝都不堵住后面的请求。
import type { ApprovalHandler } from "./handler.ts";

export interface ApprovalQueue {
  wrap(handler: ApprovalHandler): ApprovalHandler;
  // 在问与排队中的请求数
  pending(): number;
}

export function createApprovalQueue(): ApprovalQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  return {
    wrap: (handler) => (request) => {
      pending += 1;
      // 决策 303：排队期间已撤回的请求不再交给 handler（不上面板），按拒绝回话
      const turn = tail.then(() =>
        request.signal?.aborted === true
          ? {
              approved: false,
              reason: "请求已撤回（等待审批超时）",
              reasonSource: "system-default" as const,
            }
          : handler(request)
      );
      tail = turn.catch(() => undefined);
      return turn.finally(() => {
        pending -= 1;
      });
    },
    pending: () => pending,
  };
}
