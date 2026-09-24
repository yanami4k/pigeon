// 模型请求的限额口径与限额控制器（决策 144 及其修订、155）。所有条件的模型请求都经跑批进程内置的网关
// （model-gateway.ts），网关把上游的限额信号交给这里统一处理：
//   429：双 key 轮换加共享退避（5、15、45 秒），在网关里就地处理；退避用满仍撞，按频率限制整批暂停并探测；
//   403 额度用完：按报错文案区分 5 小时、每周、每月三种额度（文案里分不出窗口的额度类 403 按 5 小时处理）——
//     整批暂停，探测用极小的请求，间隔从 5 分钟逐步拉长到 30 分钟，总等待上限 6 小时；每月额度直接停下并告警；
//   403 并发受限：先降一路并行，已是 1 路仍受限则暂停；
//   告警写标准错误输出、同类只报一次（去重），文案说明后果。
// 限额识别的底层口径（明说用量上限的 403 算限额、其余 401/403 算认证、上下文超长不算）与外部基准的双 key 探针同一份，
// 探针改为从这里取。

export const BACKOFF_DELAYS_MS: readonly number[] = [5_000, 15_000, 45_000];

const AUTH_PATTERN =
  /^(401|403)\b|authentication|unauthorized|invalid[ _-]?api[ _-]?key|permission[ _-]denied|forbidden/i;
// 不收"exceeded"这类宽词：上下文超长（context length exceeded）是请求问题，不是限额
const QUOTA_PATTERN =
  /^429\b|rate[ _-]?limit|too many requests|quota|insufficient[ _-]?(balance|quota|credit)|限额|额度|配额|余额不足|频率限制|请求过于频繁/i;
// 响应体明说是用量上限或额度用完：即便状态码是 403 也是限额（5 小时窗口的额度用完即 403 permission_error）
const EXPLICIT_QUOTA_PATTERN = /usage limit|quota will reset|额度已用完|用量上限/i;

// 限额类错误：先认明说的用量上限，再排除认证类（401/403 的响应体里也可能出现 limit 一类字眼）
export function isQuotaError(message: unknown): boolean {
  const text = String(message ?? "");
  if (EXPLICIT_QUOTA_PATTERN.test(text)) return true;
  if (AUTH_PATTERN.test(text)) return false;
  return QUOTA_PATTERN.test(text);
}

// 文本里不得出现 key：逐个替换成占位
export function scrubKeys(text: unknown, keys: readonly (string | undefined)[]): string {
  let out = String(text ?? "");
  for (const key of keys) {
    if (key) out = out.split(key).join("[key]");
  }
  return out;
}

export type LimitKind = "5h" | "weekly" | "monthly" | "concurrency" | "rate-limit";

const CONCURRENCY_PATTERN = /concurren|too many (parallel|simultaneous)|并发/i;
const MONTHLY_PATTERN = /month|每月|本月|月度/i;
const WEEKLY_PATTERN = /week|每周|本周|周度/i;

export function classifyUpstreamFailure(
  status: number,
  body: string
): { kind: LimitKind } | { kind: "auth" } | { kind: "other" } {
  if (status === 429) return { kind: "rate-limit" };
  if (status !== 403) return { kind: "other" };
  if (CONCURRENCY_PATTERN.test(body)) return { kind: "concurrency" };
  if (!isQuotaError(body)) return { kind: "auth" };
  if (MONTHLY_PATTERN.test(body)) return { kind: "monthly" };
  if (WEEKLY_PATTERN.test(body)) return { kind: "weekly" };
  return { kind: "5h" };
}

// 探测间隔：5 分钟起逐步拉长，到 30 分钟封顶
export const PROBE_SCHEDULE_MS: readonly number[] = [5, 10, 15, 20, 25, 30].map((m) => m * 60_000);
export const DEFAULT_MAX_WAIT_MS = 6 * 60 * 60_000;

export interface PauseRecord {
  kind: LimitKind;
  startedAt: string;
  endedAt: string | null;
}

export interface LimitControllerOptions {
  // 极小的探测请求：上游恢复即 true
  probe(): Promise<boolean>;
  // 初始并行路数（在途的 agent 步数上限）
  slots: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  warn?: (line: string) => void;
}

export type LimitState = "running" | "paused" | "stopped";

export class LimitController {
  state: LimitState = "running";
  slots: number;
  // 暂停编号：每开一次暂停加一
  epoch = 0;
  // 限额信号计数：每收到一次（含只降路、不暂停的并发受限）加一；一步前后计数不同，即这一步撞上过限额，作废重做
  signals = 0;
  stopReason: string | undefined;
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly records: { epoch: number; record: PauseRecord }[] = [];
  private resumed: Promise<void> = Promise.resolve();
  private resolveResumed: (() => void) | undefined;
  private rejectResumed: ((error: Error) => void) | undefined;
  private readonly warned = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly options: LimitControllerOptions;

  constructor(options: LimitControllerOptions) {
    this.options = options;
    this.slots = options.slots;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private warn(key: string, line: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    (this.options.warn ?? ((l: string) => process.stderr.write(`[限额] ${l}\n`)))(line);
  }

  // 订阅限额信号与状态变化（在途步骤的看守据此立即中止，不必等轮询）；返回退订函数
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // 看守自己的故障不影响限额处理
      }
    }
  }

  // 上游报来限额信号
  onLimit(kind: LimitKind): void {
    if (this.state === "stopped") return;
    this.signals += 1;
    if (kind === "monthly") {
      this.stop(
        "每月额度用完：跑批停下，额度恢复前不再发请求（已完成的步保留，之后在同一输出目录续跑）"
      );
    } else if (kind === "concurrency" && this.slots > 1) {
      this.slots -= 1;
      this.warn(
        `concurrency-${this.slots}`,
        `模型服务报并发受限：并行降为 ${this.slots} 路（在途的步骤作废重做）`
      );
    } else {
      this.pause(kind);
    }
    this.notify();
  }

  private stop(reason: string): void {
    this.state = "stopped";
    this.stopReason = reason;
    this.warn(`stop-${reason}`, reason);
    this.rejectResumed?.(new Error(reason));
    this.rejectResumed = undefined;
    this.resolveResumed = undefined;
    for (const wake of this.waiting.splice(0)) wake();
  }

  private pause(kind: LimitKind): void {
    if (this.state !== "running") return;
    this.state = "paused";
    this.epoch += 1;
    const record: PauseRecord = {
      kind,
      startedAt: new Date(this.now()).toISOString(),
      endedAt: null,
    };
    this.records.push({ epoch: this.epoch, record });
    this.resumed = new Promise<void>((resolve, reject) => {
      this.resolveResumed = resolve;
      this.rejectResumed = reject;
    });
    // 等待方各自处理拒绝；这里只防止无人等待时的未处理拒绝
    this.resumed.catch(() => {});
    this.warn(
      `pause-${this.epoch}`,
      `模型服务额度受限（${kind}）：整批暂停，在途的步骤作废、恢复后重做；按 5 至 30 分钟的间隔探测，最长等待 ${Math.round(
        (this.options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS) / 60_000
      )} 分钟`
    );
    void this.probeLoop(record);
  }

  private async probeLoop(record: PauseRecord): Promise<void> {
    const sleep =
      this.options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const maxWait = this.options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    const started = this.now();
    for (let i = 0; ; i++) {
      const delay = PROBE_SCHEDULE_MS[Math.min(i, PROBE_SCHEDULE_MS.length - 1)] ?? 30 * 60_000;
      await sleep(delay);
      if (this.state !== "paused") return;
      let ok = false;
      try {
        ok = await this.options.probe();
      } catch {
        ok = false;
      }
      if (ok) {
        record.endedAt = new Date(this.now()).toISOString();
        this.state = "running";
        this.warn(
          `resume-${this.epoch}`,
          `模型服务恢复：整批继续（暂停 ${Math.round((this.now() - started) / 60_000)} 分钟）`
        );
        this.resolveResumed?.();
        this.resolveResumed = undefined;
        this.rejectResumed = undefined;
        return;
      }
      if (this.now() - started >= maxWait) {
        record.endedAt = new Date(this.now()).toISOString();
        this.stop(
          `模型服务额度受限（${record.kind}），等待逾 ${Math.round(maxWait / 60_000)} 分钟仍未恢复：跑批停下`
        );
        return;
      }
    }
  }

  // 等到可以继续（暂停中则等恢复；已停止则抛错）
  async ready(): Promise<void> {
    if (this.state === "stopped") throw new Error(this.stopReason ?? "跑批已停止");
    if (this.state === "paused") await this.resumed;
  }

  // 占一路在途步骤；返回释放函数
  async acquire(): Promise<() => void> {
    for (;;) {
      await this.ready();
      if (this.active < this.slots) {
        this.active += 1;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.active -= 1;
          this.waiting.shift()?.();
        };
      }
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
  }

  // 自某个暂停编号之后（不含）开过的暂停记录
  pausesSince(epoch: number): PauseRecord[] {
    return this.records.filter((r) => r.epoch > epoch).map((r) => ({ ...r.record }));
  }
}
