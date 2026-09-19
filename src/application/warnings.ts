// 后台故障告警（M7 收口）：快照器与提炼派发器的内部故障原本只进各自的内部错误清单，生产代码里没有消费者，
// 运行时完全静默。改为向标准错误输出告警，口径与上游版本探测的告警一致：文案说明后果，
// 一次运行里同一类故障只说一次（同一类故障常常每次工具调用都复发，不去重会刷屏盖住正常输出）。
// 不为这类故障新增账本记录族：账本只记运行事实，内部故障属于运行时诊断。

export type WarnSink = (line: string) => void;

export const stderrWarn: WarnSink = (line) => {
  process.stderr.write(`${line}\n`);
};

// 故障类别：错误类型 + 首个"："之前的摘要。git 失败的具体 stderr（含临时索引路径等一次性内容）不进类别，
// 同一类故障因此只告警一次。
export function failureKey(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  return `${name}|${(message.split("：")[0] ?? "").slice(0, 120)}`;
}

export function failureDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 按类别去重的告警器：同一类只输出一次
export function dedupedWarner(sink: WarnSink = stderrWarn): (error: unknown, line: string) => void {
  const seen = new Set<string>();
  return (error, line) => {
    const key = failureKey(error);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    sink(line);
  };
}
