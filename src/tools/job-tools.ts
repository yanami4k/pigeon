// job_output 与 job_kill（决策 365）：查看与停掉本会话的后台作业（run_command 带 background 启动的）。
// job_output 是读类工具（可与别的读类并行，登记在 application/tool-execution-modes.ts），不计入打转检测；不带等待时长的
// 连续查询另计，连续到上限即拒绝、请模型带上等待时长或先做别的。job_kill 只停本会话的作业，缺省串行。
// 结束状态经这两个工具交回过的作业，结束通知不再重复（SessionJobs.markReported）。
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  type BackgroundJob,
  BackgroundJobError,
  JOB_KILL_TOOL,
  JOB_OUTPUT_TOOL,
  JOB_WAIT_MAX_SECONDS,
  jobChangesText,
  jobOutputText,
  jobStateText,
  type SessionJobs,
  takeNewOutput,
} from "./background-jobs.ts";
import type { PigeonAgentTool, PigeonToolResult } from "./wrap.ts";

// 不带等待时长、作业又都没变化的连续查询到这么多次即拒绝
export const JOB_IDLE_QUERY_LIMIT = 5;
// 一次交回的新增输出至多这么多字节（多了只留末尾）
export const DEFAULT_JOB_OUTPUT_BYTES = 32 * 1024;

export const JobOutputParamsSchema = Type.Object({
  job_id: Type.Optional(Type.String({ minLength: 1 })),
  wait_seconds: Type.Optional(Type.Integer({ minimum: 0, maximum: JOB_WAIT_MAX_SECONDS })),
});
export type JobOutputParams = Static<typeof JobOutputParamsSchema>;

export const JobKillParamsSchema = Type.Object({
  job_id: Type.String({ minLength: 1 }),
});
export type JobKillParams = Static<typeof JobKillParamsSchema>;

export interface JobToolDetails {
  jobs: Array<{ id: string; state: BackgroundJob["state"]; exitCode?: number | null }>;
}

export const JOB_OUTPUT_DESCRIPTION =
  "查看本会话后台作业（run_command 带 background 启动的）的状态与新增输出。" +
  "给 job_id：交回这个作业的状态与上次查看之后的新增输出，已结束的另给退出码、全文位置与作业期间的文件变化；" +
  `带 wait_seconds（至多 ${JOB_WAIT_MAX_SECONDS}）先等它结束，到时没结束也照样交回。` +
  "不给 job_id：带 wait_seconds 等任意一个作业结束，不带则列出本会话的全部作业。" +
  `要等作业就带 wait_seconds，不带等待的连续查询至多 ${JOB_IDLE_QUERY_LIMIT - 1} 次。`;

export const JOB_KILL_DESCRIPTION =
  "停掉本会话的一个后台作业（连同它起的子进程），交回最后的状态、输出位置与作业期间的文件变化。";

function details(jobs: readonly BackgroundJob[]): JobToolDetails {
  return {
    jobs: jobs.map((job) => ({
      id: job.id,
      state: job.state,
      ...(job.exit !== undefined ? { exitCode: job.exit.exitCode } : {}),
    })),
  };
}

// 一个作业的完整交回：状态、命令、新增输出、输出去向，结束了的再加期间变化
function jobText(job: BackgroundJob, outputBytes: number): string {
  const changes = job.state === "running" ? undefined : jobChangesText(job);
  return [
    `作业 ${job.id}：${jobStateText(job)}`,
    `$ ${job.command}`,
    takeNewOutput(job, outputBytes),
    jobOutputText(job),
    ...(changes !== undefined ? [changes] : []),
  ].join("\n");
}

function listText(jobs: readonly BackgroundJob[]): string {
  return jobs.map((job) => `${job.id}：${jobStateText(job)}　$ ${job.command}`).join("\n");
}

export function createJobOutputTool(
  jobs: SessionJobs,
  options: { outputBytes?: number } = {}
): PigeonAgentTool<typeof JobOutputParamsSchema, JobToolDetails> {
  const outputBytes = options.outputBytes ?? DEFAULT_JOB_OUTPUT_BYTES;
  return {
    name: JOB_OUTPUT_TOOL,
    label: JOB_OUTPUT_TOOL,
    description: JOB_OUTPUT_DESCRIPTION,
    parameters: JobOutputParamsSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal): Promise<PigeonToolResult<JobToolDetails>> {
      const parsed = Value.Parse(JobOutputParamsSchema, params);
      const waitMs = (parsed.wait_seconds ?? 0) * 1000;
      const all = jobs.list();
      if (all.length === 0) {
        return {
          content: [{ type: "text", text: "本会话还没有后台作业" }],
          details: details([]),
        };
      }
      const idle = jobs.noteQuery(waitMs > 0);
      if (waitMs === 0 && idle >= JOB_IDLE_QUERY_LIMIT && jobs.running().length > 0) {
        throw new BackgroundJobError(
          `已连续 ${idle} 次不带 wait_seconds 查询后台作业，作业都还在跑、没有变化。` +
            "要等它们就带 wait_seconds（会在作业结束时提前返回），或者先去做别的事，作业结束时会通知你"
        );
      }
      if (parsed.job_id !== undefined) {
        const job = jobs.get(parsed.job_id);
        if (waitMs > 0) await jobs.wait(job, waitMs, signal);
        const text = jobText(job, outputBytes);
        jobs.markReported(job);
        return { content: [{ type: "text", text }], details: details([job]) };
      }
      if (waitMs > 0 && jobs.running().length > 0) {
        const ended = await jobs.waitAny(waitMs, signal);
        const rest = jobs.list().filter((job) => !ended.includes(job));
        const parts =
          ended.length > 0
            ? ended.map((job) => jobText(job, outputBytes))
            : [`等了 ${parsed.wait_seconds} 秒，没有作业结束`];
        for (const job of ended) jobs.markReported(job);
        if (rest.length > 0) parts.push(`其余作业：\n${listText(rest)}`);
        return { content: [{ type: "text", text: parts.join("\n\n") }], details: details(all) };
      }
      return { content: [{ type: "text", text: listText(all) }], details: details(all) };
    },
  };
}

export function createJobKillTool(
  jobs: SessionJobs,
  options: { outputBytes?: number } = {}
): PigeonAgentTool<typeof JobKillParamsSchema, JobToolDetails> {
  const outputBytes = options.outputBytes ?? DEFAULT_JOB_OUTPUT_BYTES;
  return {
    name: JOB_KILL_TOOL,
    label: JOB_KILL_TOOL,
    description: JOB_KILL_DESCRIPTION,
    parameters: JobKillParamsSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params): Promise<PigeonToolResult<JobToolDetails>> {
      const parsed = Value.Parse(JobKillParamsSchema, params);
      const job = jobs.get(parsed.job_id);
      const wasRunning = job.state === "running";
      await jobs.kill(job, "job_kill");
      const text = `${wasRunning ? "" : "作业已经结束，不用停。\n"}${jobText(job, outputBytes)}`;
      jobs.markReported(job);
      return { content: [{ type: "text", text }], details: details([job]) };
    },
  };
}
