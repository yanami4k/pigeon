// 运行期告警的出口切换（决策 286 第 6 项）：压缩、会话存储、工作区快照等运行期告警原本直接写标准错误输出，
// 会打乱终端界面的差分渲染。壳接管终端期间改落消息区；接管之前（启动告警）与壳停止之后照旧写标准错误输出。
// 去重与文案仍由各告警方（application/warnings.ts 的 dedupedWarner 等）负责，这里只换出口。
import { stderrWarn, type WarnSink } from "../application/warnings.ts";

export interface SwitchableWarn {
  warn: WarnSink;
  // 壳接管终端后调用：此后的告警交给 target
  attach(target: (line: string) => void): void;
  // 壳停止时调用：此后的告警回到标准错误输出
  detach(): void;
}

export function switchableWarn(fallback: WarnSink = stderrWarn): SwitchableWarn {
  let target: ((line: string) => void) | undefined;
  return {
    warn: (line) => (target ?? fallback)(line),
    attach: (next) => {
      target = next;
    },
    detach: () => {
      target = undefined;
    },
  };
}
