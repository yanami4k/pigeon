// 模型请求的限额口径与限额控制器（决策 144 及其修订、155）。所有条件的模型请求都经跑批进程内置的网关
// （model-gateway.ts）。网关按账号（一个 key 一个账号）处理上游的限额信号，只在全部账号都不可用时交给这里整批处理：
//   429：按账号各自退避（5、15、45 秒），退避用满仍撞即该账号暂时不可用、请求换号；
//   403 额度用完：只停该账号、请求换号；按报错文案区分 5 小时、每周、每月三种额度（文案里分不出窗口的额度类 403
//     按 5 小时处理）；每月额度用完的账号不再恢复；
//   403 并发受限：降该账号的并发上限，已是 1 时派出的请求仍受限则该账号暂时不可用；
//   401 与文案明确是认证问题的 403：该账号停用（不探测恢复，需人工处理），这一步按上游故障作废重做；认不出的 403
//     原样交回、记上游故障（这一步作废），不停用账号；
//   放行（决策 163）：同时在跑的 agent 数须小于网关报来的可用容量（未停用账号当前并发上限之和）且不超过配置路数，
//     否则在步与步之间等，按先来后到放行（各条件公平）；等待不计入该步的墙钟预算、不作废、不耗额度，时长记入结果行；
//   全部账号都不可用：整批暂停并探测，间隔从 5 分钟逐步拉长到 30 分钟，总等待上限 6 小时；暂停期间网关的任一账号
//     单独探测恢复即通知这里立即恢复整批（recovered），不等下一轮探测；全部账号都不会自行恢复（每月额度用完或认证失败）
//     则直接停下并告警；
//   告警写标准错误输出、同类只报一次（去重），文案说明后果。
// 限额识别的底层口径与外部基准的双 key 探针同一份，探针改为从这里取：明说用量上限的 403 算限额；401 与文案明确是
// 认证问题的 403 算认证；其余认不出的 403 不算认证（原样交回、记上游故障）；上下文超长不算限额。

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

// auth：账号认证失败（401 或认证类 403），停用、不探测恢复，需人工处理
export type LimitKind = "5h" | "weekly" | "monthly" | "concurrency" | "rate-limit" | "auth";

// 文案明确是认证问题：只认这些，单写 forbidden、permission denied 之类认不出（5 小时额度用完也是 permission_error）
const EXPLICIT_AUTH_PATTERN =
  /authentication|unauthori[sz]ed|invalid[ _-]?(x-)?api[ _-]?key|api[ _-]?key\b.*\b(invalid|expired|revoked|disabled)|认证失败|鉴权失败|密钥无效|无效的?\s*(api\s*)?key/i;
const CONCURRENCY_PATTERN = /concurren|too many (parallel|simultaneous)|并发/i;
const MONTHLY_PATTERN = /month|每月|本月|月度/i;
const WEEKLY_PATTERN = /week|每周|本周|周度/i;

export function classifyUpstreamFailure(
  status: number,
  body: string
): { kind: LimitKind } | { kind: "other" } {
  if (status === 429) return { kind: "rate-limit" };
  if (status === 401) return { kind: "auth" };
  if (status !== 403) return { kind: "other" };
  if (CONCURRENCY_PATTERN.test(body)) return { kind: "concurrency" };
  if (!isQuotaError(body))
    return EXPLICIT_AUTH_PATTERN.test(body) ? { kind: "auth" } : { kind: "other" };
  if (MONTHLY_PATTERN.test(body)) return { kind: "monthly" };
  if (WEEKLY_PATTERN.test(body)) return { kind: "weekly" };
  return { kind: "5h" };
}

// 一步累计等空闲账号超过这么久即作废重做（与上游故障同一口径，不看 agent 种类）：正常情况下路数不超过各账号并发之和，
// 不应排队；明显排队说明有账号受限（退避中、停用或降了上限），这一步受了限额事件的影响
export const QUEUE_VOID_MS = 30_000;

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
  // 可用容量（网关按账号统计）；缺省不限。变化时调用 capacityChanged
  capacity?: () => number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  warn?: (line: string) => void;
}

export type LimitState = "running" | "paused" | "stopped";

// 放行：调用即释放这一路；waitedMs 为这一路在放行前等了多久（含整批暂停）
export type Admission = (() => void) & { waitedMs: number };

export class LimitController {
  state: LimitState = "running";
  slots: number;
  // 暂停编号：每开一次暂停加一
  epoch = 0;
  // 限额信号计数：每收到一次加一；一步前后计数不同，即这一步撞上过整批限额，作废重做
  signals = 0;
  stopReason: string | undefined;
  // 收到过停止信号（SIGTERM）即记下原因：跑批器据此把判题或测量途中的步作废、不写行。不用信号计数，暂停也会加计数
  shutdownReason: string | undefined;
  private active = 0;
  private closed = false;
  // 当前这次暂停：记录与开始时刻
  private current: { record: PauseRecord; started: number } | undefined;
  // 取消探测循环正在等的间隔（缺省计时器才有）
  private cancelWait: (() => void) | undefined;
  // 等放行的各路（先来先放）：以 true 唤醒即已放行（已占一路），false 为停下后请它重查
  private readonly waiting: ((granted: boolean) => void)[] = [];
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

  // 网关的全部账号都不可用：整批暂停（kind 为让最后一个账号不可用的原因）；全部账号都不会自行恢复则停下——
  // 全是每月额度用完报 monthly，其中有认证失败的报 auth
  onLimit(kind: LimitKind): void {
    if (this.state === "stopped") return;
    this.signals += 1;
    if (kind === "monthly") {
      this.stop(
        "每月额度用完：跑批停下，额度恢复前不再发请求（已完成的步保留，之后在同一输出目录续跑）"
      );
    } else if (kind === "auth") {
      this.stop(
        "模型服务的账号全部不可用且不会自行恢复（有账号认证失败，需人工检查 key；其余每月额度用完）：跑批停下（已完成的步保留，处理后在同一输出目录续跑）"
      );
    } else {
      this.pause(kind);
    }
    this.notify();
  }

  // 进程收到停止信号（systemd 停服、整机关机）：与每月额度用完同一路径——计一次信号，在途的步中止并作废，不再取新步；
  // 已完成的步保留，之后在同一输出目录续跑
  shutdown(reason: string): void {
    if (this.state === "stopped") return;
    this.shutdownReason = reason;
    this.signals += 1;
    this.stop(reason);
    this.notify();
  }

  private stop(reason: string): void {
    this.state = "stopped";
    this.stopReason = reason;
    this.warn(`stop-${reason}`, reason);
    this.rejectResumed?.(new Error(reason));
    this.rejectResumed = undefined;
    this.resolveResumed = undefined;
    this.current = undefined;
    this.cancelWait?.();
    for (const wake of this.waiting.splice(0)) wake(false);
  }

  // 网关的某个账号单独探测恢复：暂停中即立即恢复整批，不等下一轮探测
  recovered(): void {
    this.resume();
  }

  private resume(): void {
    const current = this.current;
    if (this.state !== "paused" || current === undefined) return;
    current.record.endedAt = new Date(this.now()).toISOString();
    this.state = "running";
    this.current = undefined;
    this.warn(
      `resume-${this.epoch}`,
      `模型服务恢复：整批继续（暂停 ${Math.round((this.now() - current.started) / 60_000)} 分钟）`
    );
    this.resolveResumed?.();
    this.resolveResumed = undefined;
    this.rejectResumed = undefined;
    this.cancelWait?.();
    this.admit();
  }

  // 收尾：取消探测循环的定时，跑完后进程不因它多挂
  close(): void {
    this.closed = true;
    this.cancelWait?.();
  }

  private wait(ms: number): Promise<void> {
    if (this.options.sleep !== undefined) return this.options.sleep(ms);
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.cancelWait = undefined;
        resolve();
      }, ms);
      this.cancelWait = () => {
        clearTimeout(timer);
        this.cancelWait = undefined;
        resolve();
      };
    });
  }

  private pause(kind: LimitKind): void {
    // 已关闭：不再开暂停、不再设探测定时
    if (this.closed || this.state !== "running") return;
    this.state = "paused";
    this.epoch += 1;
    const record: PauseRecord = {
      kind,
      startedAt: new Date(this.now()).toISOString(),
      endedAt: null,
    };
    this.records.push({ epoch: this.epoch, record });
    this.current = { record, started: this.now() };
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
    const maxWait = this.options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    const started = this.now();
    // 只管开它的这一次暂停：网关通知恢复之后又开了新的暂停，旧循环醒来即退出，不替新暂停收尾
    const epoch = this.epoch;
    const mine = () => !this.closed && this.state === "paused" && this.epoch === epoch;
    for (let i = 0; ; i++) {
      const delay = PROBE_SCHEDULE_MS[Math.min(i, PROBE_SCHEDULE_MS.length - 1)] ?? 30 * 60_000;
      await this.wait(delay);
      if (!mine()) return;
      let ok = false;
      try {
        ok = await this.options.probe();
      } catch {
        ok = false;
      }
      if (!mine()) return;
      if (ok) {
        this.resume();
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

  // 同时在跑的 agent 数上限：配置路数与可用容量取小
  admitLimit(): number {
    return Math.min(this.slots, this.options.capacity?.() ?? Number.POSITIVE_INFINITY);
  }

  // 网关报来可用容量变了：按先来后到放行等待的各路
  capacityChanged(): void {
    this.admit();
  }

  private admit(): void {
    while (this.state === "running" && this.waiting.length > 0 && this.active < this.admitLimit()) {
      this.active += 1;
      this.waiting.shift()?.(true);
    }
  }

  // 等放行、占一路在途步骤（每步 agent 开始之前调用）：暂停中等恢复，同时在跑的数已达上限即排在后面等；
  // 返回释放函数，带这一路等了多久
  async acquire(): Promise<Admission> {
    const from = this.now();
    for (;;) {
      await this.ready();
      // ready() 放行之后、进入排队之前可能已停下（停止信号在这之间到达）：停下时排队者已全部唤醒过，此时再排队
      // 就没人唤醒了，所以先看一次
      if (this.state === "stopped") throw new Error(this.stopReason ?? "跑批已停止");
      let granted: boolean;
      if (this.waiting.length === 0 && this.active < this.admitLimit()) {
        this.active += 1;
        granted = true;
      } else {
        granted = await new Promise<boolean>((resolve) => this.waiting.push(resolve));
      }
      if (!granted) continue;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.admit();
      };
      return Object.assign(release, { waitedMs: this.now() - from });
    }
  }

  // 自某个暂停编号之后（不含）开过的暂停记录
  pausesSince(epoch: number): PauseRecord[] {
    return this.records.filter((r) => r.epoch > epoch).map((r) => ({ ...r.record }));
  }
}
