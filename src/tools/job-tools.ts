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
import { commandLabel } from "./command-echo.ts";
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
  "Shows the status and new output of this session's background jobs (started by run_command with background). " +
  "With job_id: returns that job's status and the output added since you last checked; for a finished job, also its exit code, " +
  "where the full output is saved, and the file changes during the job. " +
  `With wait_seconds (at most ${JOB_WAIT_MAX_SECONDS}), it first waits for the job to end, and returns anyway when the time is up. ` +
  "Without job_id: with wait_seconds, it waits for any job to end; without it, it lists all jobs in this session. " +
  `To wait for jobs, pass wait_seconds; at most ${JOB_IDLE_QUERY_LIMIT - 1} queries in a row without waiting are allowed.`;

export const JOB_KILL_DESCRIPTION =
  "Stops one of this session's background jobs (along with the processes it started) and returns its final status, " +
  "where its output is saved, and the file changes during the job.";

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
    `Job ${job.id}: ${jobStateText(job)}`,
    `$ ${commandLabel(job.command)}`,
    takeNewOutput(job, outputBytes),
    jobOutputText(job),
    ...(changes !== undefined ? [changes] : []),
  ].join("\n");
}

function listText(jobs: readonly BackgroundJob[]): string {
  return jobs
    .map((job) => `${job.id}: ${jobStateText(job)}  $ ${commandLabel(job.command)}`)
    .join("\n");
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
      // 无人值守收尾期间，等待不超过收尾的剩余时限
      const cap = jobs.waitCapMs();
      const waitMs = Math.min((parsed.wait_seconds ?? 0) * 1000, cap ?? Number.POSITIVE_INFINITY);
      const waited = parsed.wait_seconds !== undefined && parsed.wait_seconds > 0;
      const all = jobs.list();
      if (all.length === 0) {
        return {
          content: [{ type: "text", text: "This session has no background jobs yet" }],
          details: details([]),
        };
      }
      const idle = jobs.noteQuery(waited);
      if (waitMs === 0 && idle >= JOB_IDLE_QUERY_LIMIT && jobs.running().length > 0) {
        throw new BackgroundJobError(
          `You have queried background jobs ${idle} times in a row without wait_seconds, and they are all still running with no change. ` +
            "To wait for them, pass wait_seconds (it returns early when a job ends), or do something else first; " +
            "you will be notified when a job ends"
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
            : [
                `Waited ${Math.round(waitMs / 1000)} second${Math.round(waitMs / 1000) === 1 ? "" : "s"}; no job ended`,
              ];
        for (const job of ended) jobs.markReported(job);
        if (rest.length > 0) parts.push(`Other jobs:\n${listText(rest)}`);
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
      const text = `${wasRunning ? "" : "The job had already ended; there was nothing to stop.\n"}${jobText(job, outputBytes)}`;
      jobs.markReported(job);
      return { content: [{ type: "text", text }], details: details([job]) };
    },
  };
}
