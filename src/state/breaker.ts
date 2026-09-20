// 熔断的两段判据（M3 决策 1/2/4，spike S2a/S4/S5）：计数键的构造与上游拦截连击的状态机。
// 纯函数与纯状态机，零依赖零 IO——落闸动作（abort、留证）在 Controller 层。

// 阻断计数的粒度（P2-1c 裁决）：按拒绝性质不对称。
//   - "tool"：policy:deny 系绝对拒绝（deny 清单 / 无审批通道 fail-closed）——参数改不改都照样拒，
//     任何重试皆徒劳，按工具名计数，参数微变不能重置连击；
//   - "fingerprint"：人工拒绝与闸内异常——决策 1 鼓励模型改参数重提，按 工具名+参数指纹 计数，
//     改参后的重提不累积（修订循环是期望行为）。
export type BreakerScope = "tool" | "fingerprint";

// 畸形参数（循环引用等）序列化会抛：退化为固定串并入同一指纹桶——
// 宁可按工具名合并计数，也不让熔断因异常参数失效
export function breakerCountKey(scope: BreakerScope, toolName: string, rawArgs: unknown): string {
  if (scope === "tool") {
    return `tool\n${toolName}`;
  }
  let argsKey: string;
  try {
    argsKey = JSON.stringify(rawArgs) ?? "";
  } catch {
    argsKey = "<unserializable>";
  }
  return `fingerprint\n${toolName}\n${argsKey}`;
}

// 上游拦截连击（事件级）：覆盖两类 beforeToolCall 之前的上游拦截——
//   ① 幽灵工具名（从未广告）：prepareToolCall 以 "Tool <name> not found" 拦截；
//   ② 已广告但参数畸形：validateToolArguments 在 hook 前抛错 → immediate error result。
// 两类 hook 都不可见，只能按事件计数兜底。
//
// 判据由调用方给出（settled 且 isError 且账本无此 toolCallId 记录 ⟺ hook 从未运行 ⟺ 被上游拦截）；
// 本状态机只管连击：同一工具名连续拦截才累加，换了工具名从 1 起算，
// 任何一次非拦截的收尾（hook 跑过的 settled，含执行出错）把连击清零。
export class InterceptStreak {
  #toolName = "";
  #count = 0;

  // 记一次收尾；返回当前连击次数（非拦截收尾返回 0）
  observe(toolName: string, intercepted: boolean): number {
    if (!intercepted) {
      this.reset();
      return 0;
    }
    if (this.#toolName === toolName) {
      this.#count += 1;
    } else {
      this.#toolName = toolName;
      this.#count = 1;
    }
    return this.#count;
  }

  reset(): void {
    this.#toolName = "";
    this.#count = 0;
  }
}
