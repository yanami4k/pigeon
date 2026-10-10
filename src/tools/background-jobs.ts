// 后台作业（决策 365）：run_command 带 background 启动后立即交回作业号，命令在执行端里继续跑；job_output 读状态与新增输出，
// job_kill 停掉。本模块是作业表与它的不变式，通知、收尾与会话记录的接法在应用层（application/background-jobs.ts）。
// - 输出持续落盘：写进本会话落盘目录（决策 356）的下一个编号，单个文件超过上限时只留末尾（文件里砍掉前一半，记下砍掉的
//   字节数，读新增输出按"逻辑偏移"算）；作业结束时按写下的身份记进落盘索引，此后可用 read_file 按虚拟路径读全文。
//   作业在跑时只经 job_output 读（读的是本进程持有的同一个文件描述符，不经路径，命令换不掉它）。
// - 上限：每会话同时在跑的个数、整次运行（同一进程里的主会话与 worker）同时在跑的总数；超出直接拒绝并列出在跑的作业，不排队。
// - 期间变化：作业开始与结束各取一次证比出，扣除这期间 Pigeon 已知的前台改动（前台命令报出的与写工具改过的路径），注明
//   可能不精确。
// - 记录：每个在跑的作业在治理目录的 state/jobs 下有一个记录文件（所属进程号、认进程的信息），结束即删；崩溃后下次启动
//   按记录清理（cleanupOrphanedJobs）。记录在工作区里、命令改得动：清理只认记录里的进程号、标记与容器名，核对启动时间与
//   标记（或命令行）一致才杀，不采用记录里的任何程序路径。
// - 决策 409：会话结束后保留的作业（keep）——进程直接写输出文件，收尾不等、会话结束不停（killAll 不含它），不写记录文件
//   （崩溃后的清理碰不到它）；会话结束时记一条"保留"、交出跟踪（detachKept），登记进作业池的保留名单。
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { VIRTUAL_PATH_HINT } from "../state/paths.ts";
import type { CommandOutputStore, OutputSlot } from "./command-output.ts";
import { killLocalOrphan, type OrphanCleanup } from "./process-identity.ts";
import type {
  FileChanges,
  HostExecPlan,
  HostJob,
  HostJobExit,
  JobProcessRecord,
  WorkspaceHost,
} from "./workspace-host.ts";

export const JOB_OUTPUT_TOOL = "job_output";
export const JOB_KILL_TOOL = "job_kill";
// job_output 等待时长的上限（秒）
export const JOB_WAIT_MAX_SECONDS = 600;

// 拒绝启动、作业号不存在等（域错误）
export class BackgroundJobError extends Error {
  readonly pigeonToolErrorKind = "domain";
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

// 一个作业的输出文件：只追加；超过上限时砍掉前面、留下末尾一半。偏移按逻辑算（砍掉的也计在内）。
// 决策 409：保留的作业由进程直接写（openForChild 之后），大小按文件现有的算，不砍前面
class JobOutputFile {
  readonly #fd: number;
  readonly #max: number;
  readonly #file: string;
  readonly dev: string;
  readonly ino: string;
  #size = 0;
  #dropped = 0;
  #closed = false;
  #external = false;
  error: string | undefined;

  constructor(file: string, maxBytes: number) {
    this.#file = file;
    mkdirSync(path.dirname(file), { recursive: true });
    this.#fd = openSync(
      file,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600
    );
    const stat = fstatSync(this.#fd, { bigint: true });
    this.dev = String(stat.dev);
    this.ino = String(stat.ino);
    this.#max = maxBytes;
  }

  // 决策 409：给进程直接写的描述符——同一个文件另以追加方式打开（与本对象读用的描述符不共用读写位置），核对是同一个文件。
  // 调用方交给进程后关掉；此后本对象只读不写
  openForChild(): number {
    const fd = openSync(this.#file, constants.O_WRONLY | constants.O_APPEND | NOFOLLOW);
    const stat = fstatSync(fd, { bigint: true });
    if (String(stat.dev) !== this.dev || String(stat.ino) !== this.ino) {
      closeSync(fd);
      throw new Error("作业的输出文件已被替换");
    }
    this.#external = true;
    return fd;
  }

  // 已写出的总字节数（含砍掉的）与砍掉的字节数
  get total(): number {
    if (this.#external && !this.#closed) {
      try {
        this.#size = fstatSync(this.#fd).size;
      } catch {
        // 取不到即按上次的
      }
    }
    return this.#dropped + this.#size;
  }

  get dropped(): number {
    return this.#dropped;
  }

  #writeAt(buffer: Buffer, position: number): void {
    for (let done = 0; done < buffer.length; ) {
      const wrote = writeSync(this.#fd, buffer, done, buffer.length - done, position + done);
      if (wrote <= 0) throw new Error("落盘写不进去");
      done += wrote;
    }
  }

  append(chunk: Buffer): void {
    if (this.#closed || this.error !== undefined || chunk.length === 0) return;
    try {
      this.#writeAt(chunk, this.#size);
      this.#size += chunk.length;
      if (this.#size > this.#max) {
        const keep = Math.floor(this.#max / 2);
        const tail = Buffer.alloc(keep);
        readSync(this.#fd, tail, 0, keep, this.#size - keep);
        ftruncateSync(this.#fd, 0);
        this.#writeAt(tail, 0);
        this.#dropped += this.#size - keep;
        this.#size = keep;
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  // 逻辑偏移 from 之后的输出，至多 maxBytes（多了只留末尾）；skipped 为 from 之后没交回的字节（被砍掉或超出 maxBytes）。
  // 文件描述符已释放时读不到（全文另经落盘目录读）
  read(from: number, maxBytes: number): { text: string; skipped: number; end: number } {
    const end = this.total;
    if (this.#closed) return { text: "", skipped: Math.max(0, end - from), end };
    const start = Math.max(from, this.#dropped, end - maxBytes);
    const length = Math.max(0, end - start);
    const buffer = Buffer.alloc(length);
    if (length > 0) {
      try {
        readSync(this.#fd, buffer, 0, length, start - this.#dropped);
      } catch {
        return { text: "", skipped: end - from, end };
      }
    }
    // 从中间截起时去掉开头不完整的 UTF-8 字符
    let cut = 0;
    if (start > from) {
      while (cut < buffer.length && cut < 3 && ((buffer[cut] ?? 0) & 0xc0) === 0x80) cut += 1;
    }
    return { text: buffer.subarray(cut).toString("utf8"), skipped: start - from + cut, end };
  }

  // 结束：算出写下的内容的 sha256，交回身份（文件描述符留着给 job_output 与通知读新增输出与末尾，交给模型之后释放）
  finish(): { bytes: number; dev: string; ino: string; sha256: string } {
    // 进程直接写的：先取一次现有大小
    void this.total;
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    for (let position = 0; position < this.#size; ) {
      const read = readSync(this.#fd, buffer, 0, buffer.length, position);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
      position += read;
    }
    return { bytes: this.#size, dev: this.dev, ino: this.ino, sha256: hash.digest("hex") };
  }

  release(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      closeSync(this.#fd);
    } catch {
      // 已关
    }
  }
}

export type JobState = "running" | "exited" | "killed" | "failed";
// 停止的来由：job_kill、会话或运行结束（中止）、无人值守收尾的总时限
export type JobKillReason = "job_kill" | "aborted" | "closeout";

// 作业事件（应用层写成会话记录）
export type BackgroundJobEvent =
  | {
      phase: "started";
      jobId: string;
      command: string;
      marker: string;
      output: string;
      toolCallId?: string;
      // 决策 409：会话结束后保留
      keep?: true;
    }
  // 决策 409：会话结束时作业还在跑、标了保留：不停，记这一条（本机作业带进程号）
  | { phase: "kept"; jobId: string; pid?: number }
  | {
      phase: "ended";
      jobId: string;
      state: Exclude<JobState, "running">;
      exitCode: number | null;
      signal?: string;
      reason?: JobKillReason;
      output?: string;
      outputBytes: number;
    };

export interface BackgroundJob {
  readonly id: string;
  readonly command: string;
  // 决策 409：会话结束后保留
  readonly keep: boolean;
  readonly startedAt: number;
  readonly state: JobState;
  readonly endedAt: number | undefined;
  readonly exit: HostJobExit | undefined;
  readonly killedBy: JobKillReason | undefined;
  // 落盘的虚拟路径（作业结束后可用 read_file 读）与未能落盘的原因
  readonly outputUri: string;
  readonly outputSaved: boolean;
  readonly outputError: string | undefined;
  readonly outputBytes: number;
  readonly outputDropped: number;
  readonly fileChanges: FileChanges | undefined;
  // 已交回模型的输出到哪（逻辑偏移）
  readOffset: number;
  // 结束状态已交给模型（通知已递出或 job_output 已交回）
  reported: boolean;
}

class Job implements BackgroundJob {
  readonly id: string;
  readonly command: string;
  readonly keep: boolean;
  readonly marker: string;
  readonly startedAt = Date.now();
  state: JobState = "running";
  endedAt: number | undefined;
  exit: HostJobExit | undefined;
  killedBy: JobKillReason | undefined;
  readonly outputUri: string;
  outputSaved = false;
  outputError: string | undefined;
  fileChanges: FileChanges | undefined;
  readOffset = 0;
  reported = false;
  // 期间 Pigeon 已知的前台改动
  readonly foreground = new Set<string>();
  host: HostJob | undefined;
  readonly output: JobOutputFile;
  readonly slot: OutputSlot;
  finished!: Promise<void>;
  // 决策 409：会话结束时已交出（保留的作业）：此后结束不再记录、不再通知
  detached = false;

  constructor(id: string, command: string, slot: OutputSlot, maxBytes: number, keep: boolean) {
    this.id = id;
    this.command = command;
    this.keep = keep;
    this.marker = randomBytes(12).toString("hex");
    this.slot = slot;
    this.outputUri = slot.uri;
    this.output = new JobOutputFile(slot.temp, maxBytes);
  }

  get outputBytes(): number {
    return this.output.total;
  }

  get outputDropped(): number {
    return this.output.dropped;
  }
}

// 记录文件的内容
interface JobRecordFile {
  ownerPid: number;
  sessionId: string;
  jobId: string;
  command: string;
  startedAt: number;
  process: JobProcessRecord;
}

// 决策 409：会话结束后保留中的作业（无人值守运行的结果据此列出）
export interface KeptJob {
  sessionId: string;
  jobId: string;
  command: string;
  // 本机作业的进程号（容器里的作业没有）
  pid?: number;
}

// 整次运行的作业池：同一进程里的各会话共用，管总数上限、记录文件与保留名单
export class JobPool {
  total: number;
  readonly recordsDir: string | undefined;
  readonly #running = new Set<BackgroundJob>();
  readonly #kept: KeptJob[] = [];

  constructor(options: { total: number; recordsDir?: string }) {
    this.total = options.total;
    this.recordsDir = options.recordsDir;
  }

  running(): BackgroundJob[] {
    return [...this.#running];
  }

  reserve(job: BackgroundJob): void {
    this.#running.add(job);
  }

  release(job: BackgroundJob): void {
    this.#running.delete(job);
  }

  noteKept(job: KeptJob): void {
    this.#kept.push(job);
  }

  // 各会话结束时保留下来的作业（按会话结束的先后）
  keptJobs(): KeptJob[] {
    return [...this.#kept];
  }

  writeRecord(marker: string, record: JobRecordFile): void {
    if (this.recordsDir === undefined) return;
    try {
      mkdirSync(this.recordsDir, { recursive: true });
      const temp = path.join(this.recordsDir, `.${marker}.${randomBytes(4).toString("hex")}.tmp`);
      writeFileSync(temp, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
      renameSync(temp, path.join(this.recordsDir, `${marker}.json`));
    } catch {
      // 记录写不成只影响崩溃后的清理，不挡作业
    }
  }

  removeRecord(marker: string): void {
    if (this.recordsDir === undefined) return;
    try {
      unlinkSync(path.join(this.recordsDir, `${marker}.json`));
    } catch {
      // 已不在
    }
  }
}

// 同一进程里按治理目录共用一个作业池（总数上限取最近一次装配时的设置）
const pools = new Map<string, JobPool>();

export function jobPoolFor(recordsDir: string, total: number): JobPool {
  const existing = pools.get(recordsDir);
  if (existing !== undefined) {
    existing.total = total;
    return existing;
  }
  const pool = new JobPool({ total, recordsDir });
  pools.set(recordsDir, pool);
  return pool;
}

export interface SessionJobsOptions {
  sessionId: string;
  host: WorkspaceHost;
  store: CommandOutputStore;
  pool: JobPool;
  // 每会话同时在跑的上限与单个输出文件的上限
  perSession: number;
  outputMaxBytes: number;
  // 作业号从这之后编（续跑时接着上一进程用过的号）
  firstId?: number;
  // 作业启动与结束（应用层写成会话记录；/reload 交接时改挂新运行面，见 setEventSink）
  onEvent?: (event: BackgroundJobEvent) => void;
}

export interface JobStartInput {
  command: string;
  plan: HostExecPlan;
  env: NodeJS.ProcessEnv;
  toolCallId?: string;
  // 决策 409：会话结束后保留
  keep?: boolean;
  // 作业结束时比出期间变化（开始时的取证由调用方先取好、封在里面）；不给即不报期间变化
  periodChanges?: () => Promise<FileChanges>;
}

const PERIOD_NOTE =
  "作业开始与结束时的取证比出，已扣除这期间 Pigeon 已知的前台改动；作业与前台改了同一个文件、或有不经 Pigeon 的改动时不精确";

// 一个会话的后台作业
export class SessionJobs {
  readonly #options: SessionJobsOptions;
  readonly #jobs = new Map<string, Job>();
  #seq: number;
  #closed: string | undefined;
  readonly #settled = new Set<(job: BackgroundJob) => void>();
  readonly #reported = new Set<(job: BackgroundJob) => void>();
  #idleQueries = 0;
  #onEvent: ((event: BackgroundJobEvent) => void) | undefined;
  // 本次运行的收尾：总时限的截止时刻（收尾开始时定，每次运行重新计）
  #closeoutDeadline: number | undefined;

  constructor(options: SessionJobsOptions) {
    this.#options = options;
    this.#seq = options.firstId ?? 0;
    this.#onEvent = options.onEvent;
  }

  // 本会话的落盘目录（/reload 交接时新运行面沿用同一个，免得两份索引互相覆盖）
  get store(): CommandOutputStore {
    return this.#options.store;
  }

  setEventSink(onEvent: (event: BackgroundJobEvent) => void): void {
    this.#onEvent = onEvent;
  }

  get sessionId(): string {
    return this.#options.sessionId;
  }

  // 整次运行共用的作业池（决策 409：无人值守结果从它的保留名单里取）
  get pool(): JobPool {
    return this.#options.pool;
  }

  get available(): boolean {
    return this.#options.host.startJob !== undefined;
  }

  // 每会话同时在跑的上限
  get perSession(): number {
    return this.#options.perSession;
  }

  list(): BackgroundJob[] {
    return [...this.#jobs.values()];
  }

  running(): BackgroundJob[] {
    return this.list().filter((job) => job.state === "running");
  }

  // 决策 409：在跑、会话收尾时要等要停的（不含保留的）
  toSettle(): BackgroundJob[] {
    return this.running().filter((job) => !job.keep);
  }

  get(id: string): BackgroundJob {
    const job = this.#jobs.get(id.trim());
    if (job === undefined) {
      const known = this.list().map((item) => item.id);
      throw new BackgroundJobError(
        `本会话没有作业 ${id}${known.length > 0 ? `（本会话的作业：${known.join("、")}）` : "（本会话还没有后台作业）"}`
      );
    }
    return job;
  }

  // 此后拒绝新开作业（无人值守收尾的总时限已到等；下一次运行开始时解除）
  close(reason: string): void {
    this.#closed ??= reason;
  }

  // 决策 365：每次运行开始时调用——收尾的总时限与"拒绝新开"都按运行各自计
  beginRun(): void {
    this.#closeoutDeadline = undefined;
    this.#closed = undefined;
  }

  // 本次运行的收尾：还没开始即以 ms 定下截止时刻并交回 started 为真；已开始的交回原截止时刻
  beginCloseout(ms: number): { deadline: number; started: boolean } {
    if (this.#closeoutDeadline !== undefined) {
      return { deadline: this.#closeoutDeadline, started: false };
    }
    this.#closeoutDeadline = Date.now() + Math.max(0, ms);
    return { deadline: this.#closeoutDeadline, started: true };
  }

  // job_output 的等待上限：收尾期间不超过剩余时限（不在收尾里为 undefined）
  waitCapMs(): number | undefined {
    return this.#closeoutDeadline === undefined
      ? undefined
      : Math.max(0, this.#closeoutDeadline - Date.now());
  }

  onSettled(listener: (job: BackgroundJob) => void): () => void {
    this.#settled.add(listener);
    return () => this.#settled.delete(listener);
  }

  onReported(listener: (job: BackgroundJob) => void): () => void {
    this.#reported.add(listener);
    return () => this.#reported.delete(listener);
  }

  // 结束状态已经由 job_output / job_kill 交给模型（通知不再重复）
  markReported(job: BackgroundJob): void {
    if (job.state === "running" || job.reported) return;
    job.reported = true;
    // 输出都交给模型了：释放文件描述符（全文另经落盘目录读）
    if (job.readOffset >= job.outputBytes) (job as Job).output.release();
    for (const listener of this.#reported) listener(job);
  }

  // 运行面释放时：释放已结束作业的输出文件描述符（在跑的先由 killAll 停掉）
  dispose(): void {
    for (const job of this.#jobs.values()) {
      if (job.state !== "running") job.output.release();
    }
  }

  // 期间 Pigeon 已知的前台改动：记到每个在跑的作业上，结束时从期间变化里扣除
  noteForegroundChanges(paths: Iterable<string>): void {
    const running = [...this.#jobs.values()].filter((job) => job.state === "running");
    if (running.length === 0) return;
    for (const file of paths) {
      for (const job of running) job.foreground.add(file);
    }
  }

  // job_output 不带等待时长的连续查询（决策 365：不计入打转检测，另计）；返回连续的次数。等待、作业结束与别的工具调用清零
  noteQuery(waited: boolean): number {
    this.#idleQueries = waited ? 0 : this.#idleQueries + 1;
    return this.#idleQueries;
  }

  resetQueries(): void {
    this.#idleQueries = 0;
  }

  async start(input: JobStartInput): Promise<BackgroundJob> {
    const host = this.#options.host;
    if (host.startJob === undefined) {
      throw new BackgroundJobError("本执行端不支持后台作业");
    }
    if (this.#closed !== undefined) {
      throw new BackgroundJobError(`不再接受新的后台作业：${this.#closed}`);
    }
    const running = this.running();
    if (running.length >= this.#options.perSession) {
      throw new BackgroundJobError(
        `本会话同时在跑的后台作业已达上限（${this.#options.perSession} 个），拒绝启动、不排队。${listRunning(running)}` +
          "可以用 job_output 等它们结束，或用 job_kill 停掉不需要的"
      );
    }
    const pool = this.#options.pool;
    const all = pool.running();
    if (all.length >= pool.total) {
      throw new BackgroundJobError(
        `整次运行同时在跑的后台作业已达上限（${pool.total} 个，含 worker 的），拒绝启动、不排队。${listRunning(all)}` +
          "可以用 job_output 等本会话的作业结束，或用 job_kill 停掉不需要的"
      );
    }
    const slot = this.#options.store.next();
    const keep = input.keep === true;
    const job = new Job(
      `j${this.#seq + 1}`,
      input.command,
      slot,
      this.#options.outputMaxBytes,
      keep
    );
    // 决策 409：保留的作业由进程直接写输出文件
    let writer: number | undefined;
    try {
      writer = keep ? job.output.openForChild() : undefined;
    } catch (error) {
      job.output.release();
      this.#options.store.discard(slot);
      throw error;
    }
    this.#seq += 1;
    this.#jobs.set(job.id, job);
    pool.reserve(job);
    this.#onEvent?.({
      phase: "started",
      jobId: job.id,
      command: job.command,
      marker: job.marker,
      output: job.outputUri,
      ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
      ...(keep ? { keep: true as const } : {}),
    });
    let handle: HostJob;
    try {
      handle = host.startJob(input.plan, {
        env: input.env,
        marker: job.marker,
        onOutput: (chunk) => job.output.append(chunk),
        ...(writer !== undefined ? { keep: { outputFd: writer } } : {}),
      });
    } finally {
      // 进程已有自己的一份
      if (writer !== undefined) closeSync(writer);
    }
    job.host = handle;
    // 决策 409：保留的作业不写记录文件——崩溃后的清理按记录找进程，碰不到它
    void (keep ? Promise.resolve(undefined) : handle.record()).then((record) => {
      if (record !== undefined && job.state === "running") {
        pool.writeRecord(job.marker, {
          ownerPid: process.pid,
          sessionId: this.#options.sessionId,
          jobId: job.id,
          command: job.command,
          startedAt: job.startedAt,
          process: record,
        });
      }
    });
    job.finished = handle.done.then((exit) => this.#finish(job, exit, input.periodChanges));
    return job;
  }

  async #finish(
    job: Job,
    exit: HostJobExit,
    periodChanges: JobStartInput["periodChanges"]
  ): Promise<void> {
    // 会话结束时已交出的保留作业：会话记录已关，不再记、不再通知
    if (job.detached) return;
    job.exit = exit;
    if (periodChanges !== undefined) {
      try {
        const changes = await periodChanges();
        const keep = (files: string[]) => files.filter((file) => !job.foreground.has(file));
        job.fileChanges = {
          added: keep(changes.added),
          removed: keep(changes.removed),
          modified: keep(changes.modified),
          truncated: changes.truncated,
          note: changes.note !== undefined ? `${PERIOD_NOTE}；${changes.note}` : PERIOD_NOTE,
        };
      } catch (error) {
        job.fileChanges = {
          added: [],
          removed: [],
          modified: [],
          truncated: true,
          note: `作业结束时的取证失败（${error instanceof Error ? error.message : String(error)}），期间变化未知`,
        };
      }
    }
    const store = this.#options.store;
    try {
      const written = job.output.finish();
      if (job.output.error !== undefined) throw new Error(job.output.error);
      store.commit(job.slot, written);
      job.outputSaved = true;
    } catch (error) {
      job.outputError = error instanceof Error ? error.message : String(error);
      store.discard(job.slot);
    }
    job.state =
      exit.spawnError !== undefined ? "failed" : job.killedBy !== undefined ? "killed" : "exited";
    job.endedAt = Date.now();
    this.#options.pool.release(job);
    this.#options.pool.removeRecord(job.marker);
    this.#idleQueries = 0;
    this.#onEvent?.({
      phase: "ended",
      jobId: job.id,
      state: job.state,
      exitCode: exit.exitCode,
      ...(exit.signal !== undefined ? { signal: exit.signal } : {}),
      ...(job.killedBy !== undefined ? { reason: job.killedBy } : {}),
      ...(job.outputSaved ? { output: job.outputUri } : {}),
      outputBytes: job.outputBytes,
    });
    for (const listener of this.#settled) {
      try {
        listener(job);
      } catch {
        // 监听方的故障不挡收尾
      }
    }
  }

  // 等这个作业结束，至多 ms 毫秒；中止即返回。返回是否已结束
  async wait(job: BackgroundJob, ms: number, signal?: AbortSignal): Promise<boolean> {
    if (job.state !== "running") return true;
    await raceWithTimeout([(job as Job).finished], ms, signal);
    return job.state !== "running";
  }

  // 等在跑的任意一个结束，至多 ms 毫秒；返回结束了的（没有为空）。among 给出时只等其中的
  async waitAny(
    ms: number,
    signal?: AbortSignal,
    among?: readonly BackgroundJob[]
  ): Promise<BackgroundJob[]> {
    const running = [...this.#jobs.values()].filter(
      (job) => job.state === "running" && (among === undefined || among.includes(job))
    );
    if (running.length === 0) return [];
    await raceWithTimeout(
      running.map((job) => job.finished),
      ms,
      signal
    );
    return running.filter((job) => job.state !== "running");
  }

  // 停掉一个作业，等它收尾
  async kill(job: BackgroundJob, reason: JobKillReason): Promise<void> {
    const target = job as Job;
    if (target.state !== "running") return;
    target.killedBy ??= reason;
    await target.host?.kill();
    await target.finished;
  }

  // 停掉全部在跑的作业（会话或运行结束、收尾总时限到），交回停掉的。决策 409：保留的不停
  async killAll(reason: JobKillReason): Promise<BackgroundJob[]> {
    const running = this.toSettle();
    await Promise.allSettled(running.map((job) => this.kill(job, reason)));
    return running;
  }

  // 决策 409：会话结束时，还在跑的保留作业不等、不停——记一条"保留"，交出作业池与执行端的跟踪（进程照常跑，输出照样写进
  // 那个文件；不再拖住 Pigeon 进程退出），登记进作业池的保留名单。交回这些作业
  detachKept(): BackgroundJob[] {
    const kept = [...this.#jobs.values()].filter(
      (job) => job.state === "running" && job.keep && !job.detached
    );
    for (const job of kept) {
      job.detached = true;
      job.host?.detach?.();
      const pid = job.host?.pid;
      this.#options.pool.release(job);
      this.#options.pool.noteKept({
        sessionId: this.#options.sessionId,
        jobId: job.id,
        command: job.command,
        ...(pid !== undefined ? { pid } : {}),
      });
      job.output.release();
      this.#onEvent?.({ phase: "kept", jobId: job.id, ...(pid !== undefined ? { pid } : {}) });
    }
    return kept;
  }
}

function raceWithTimeout(
  promises: Promise<unknown>[],
  ms: number,
  signal: AbortSignal | undefined
): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, Math.max(0, ms));
    const onAbort = (): void => done();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) done();
    for (const promise of promises) promise.then(done, done);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
  });
}

// 毫秒 → 时长说法
export function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`;
}

function listRunning(jobs: readonly BackgroundJob[]): string {
  const now = Date.now();
  return `在跑的作业：${jobs.map((job) => `${job.id}（${job.command}，已 ${elapsedText(now - job.startedAt)}）`).join("；")}。`;
}

// 一个作业的状态一句
export function jobStateText(job: BackgroundJob, now = Date.now()): string {
  if (job.state === "running") {
    return `在跑（已 ${elapsedText(now - job.startedAt)}${job.keep ? "；会话结束后保留" : ""}）`;
  }
  const took = `用时 ${elapsedText((job.endedAt ?? now) - job.startedAt)}`;
  const exit = job.exit;
  if (job.state === "failed") {
    return exit?.spawnError?.code === "ENOENT"
      ? `没有启动：命令不存在`
      : `没有启动：${exit?.spawnError?.message ?? "未知原因"}`;
  }
  const code = `退出码 ${exit?.exitCode ?? "无"}${exit?.signal !== undefined ? `（信号 ${exit.signal}）` : ""}`;
  if (job.state === "killed") {
    const by = {
      job_kill: "已用 job_kill 停止",
      aborted: "会话结束时停止",
      closeout: "无人值守收尾的总时限到了，已停止",
    }[job.killedBy ?? "job_kill"];
    return `${by}（${code}，${took}）`;
  }
  return `已结束（${code}，${took}）`;
}

// 作业的输出去向一句：结束后可用 read_file 读全文；在跑时用 job_output
export function jobOutputText(job: BackgroundJob): string {
  const dropped =
    job.outputDropped > 0
      ? `；输出超过单个文件的上限，文件里只留了末尾，前面 ${job.outputDropped} 字节已丢弃`
      : "";
  if (job.state === "running") {
    return `输出共 ${job.outputBytes} 字节，持续写入 ${job.outputUri}（作业结束后可用 read_file 读取；在跑时用 job_output 读新增的）；${VIRTUAL_PATH_HINT}${dropped}`;
  }
  if (job.outputSaved) {
    return `输出共 ${job.outputBytes} 字节，全文存为 ${job.outputUri}，可用 read_file 按 offset 读取；${VIRTUAL_PATH_HINT}${dropped}`;
  }
  return `输出共 ${job.outputBytes} 字节，全文未能保存（${job.outputError ?? "未知原因"}）`;
}

// 期间变化一句（没取证的不写）
export function jobChangesText(job: BackgroundJob): string | undefined {
  const changes = job.fileChanges;
  if (changes === undefined) return undefined;
  const listed = (label: string, files: string[]) =>
    files.length > 0
      ? `；${label}：${files.slice(0, 20).join("、")}${files.length > 20 ? " 等" : ""}`
      : "";
  return (
    `作业期间的文件变化：新增 ${changes.added.length} / 删除 ${changes.removed.length} / 修改 ${changes.modified.length}` +
    `${listed("新增", changes.added)}${listed("删除", changes.removed)}${listed("修改", changes.modified)}` +
    `（${changes.note ?? PERIOD_NOTE}）`
  );
}

// 读一段新增输出（从上次交回处起，至多 maxBytes，多了只留末尾）并前移已读位置
export function takeNewOutput(job: BackgroundJob, maxBytes: number): string {
  const read = (job as Job).output.read(job.readOffset, maxBytes);
  job.readOffset = read.end;
  if (read.text === "" && read.skipped === 0) return "（没有新输出）";
  return read.skipped > 0 ? `…（新增输出前面省略 ${read.skipped} 字节）\n${read.text}` : read.text;
}

// 输出末尾一段（通知用；不动已读位置）
export function outputTail(job: BackgroundJob, maxBytes: number): string {
  return (job as Job).output.read(Math.max(0, job.outputBytes - maxBytes), maxBytes).text;
}

// 崩溃后清理的一项结果
export interface OrphanReport {
  sessionId: string;
  jobId: string;
  command: string;
  result: OrphanCleanup | "container-unavailable";
}

const MARKER_PATTERN = /^[0-9a-f]{24}$/;
const CONTAINER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function ownerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// 崩溃后下次启动：记录文件里所属进程已不在的作业，按记录核对后清理，删掉记录。容器里的经 killContainer 按标记查杀
//（由装配方给，缺省不处理容器记录、只删记录）
export async function cleanupOrphanedJobs(
  recordsDir: string,
  options: {
    killContainer?: (record: { container: string; marker: string }) => Promise<boolean>;
    killLocal?: typeof killLocalOrphan;
  } = {}
): Promise<OrphanReport[]> {
  let names: string[];
  try {
    names = readdirSync(recordsDir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const reports: OrphanReport[] = [];
  for (const name of names) {
    const file = path.join(recordsDir, name);
    let record: JobRecordFile;
    try {
      record = JSON.parse(readFileSync(file, "utf8")) as JobRecordFile;
    } catch {
      continue;
    }
    if (
      typeof record?.ownerPid !== "number" ||
      record.ownerPid === process.pid ||
      ownerAlive(record.ownerPid)
    ) {
      continue;
    }
    const proc = record.process;
    let result: OrphanReport["result"] = "gone";
    if (
      proc?.kind === "local" &&
      Number.isSafeInteger(proc.pid) &&
      proc.pid > 1 &&
      typeof proc.startTime === "string" &&
      MARKER_PATTERN.test(proc.marker)
    ) {
      result = await (options.killLocal ?? killLocalOrphan)(proc);
    } else if (
      proc?.kind === "container" &&
      CONTAINER_PATTERN.test(proc.container) &&
      MARKER_PATTERN.test(proc.marker) &&
      options.killContainer !== undefined
    ) {
      result = (await options.killContainer({ container: proc.container, marker: proc.marker }))
        ? "killed"
        : "container-unavailable";
    }
    // 查询失败、认不出（unknown）或容器不可用的记录留着，下次启动再试
    if (result !== "unknown" && result !== "container-unavailable") {
      try {
        unlinkSync(file);
      } catch {
        // 已不在
      }
    }
    reports.push({
      sessionId: String(record.sessionId),
      jobId: String(record.jobId),
      command: String(record.command),
      result,
    });
  }
  return reports;
}
