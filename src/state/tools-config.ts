// 工具的上限类设置：settings.json 的 tools 一节，按工具分子键（小驼峰）。grep、glob 的结果条数上限（决策 368），
// read_file 的单次字节与单行字符上限（决策 357），run_command 的输出头尾与落盘总量（决策 356）、单次超时与后台作业
// （决策 365）；不给的取缺省。
import { type Static, Type } from "typebox";

export const DEFAULT_GREP_MAX_RESULTS = 200;
export const DEFAULT_GLOB_MAX_RESULTS = 100;
export const DEFAULT_READ_FILE_MAX_BYTES = 50 * 1024;
export const DEFAULT_READ_FILE_MAX_LINE_CHARS = 2000;
export const DEFAULT_RUN_COMMAND_OUTPUT_HEAD_BYTES = 8 * 1024;
export const DEFAULT_RUN_COMMAND_OUTPUT_TAIL_BYTES = 24 * 1024;
export const DEFAULT_SAVED_OUTPUTS_MAX_BYTES = 200 * 1024 * 1024;
// 决策 365：单次超时的缺省与上限（秒）
export const DEFAULT_RUN_COMMAND_TIMEOUT_SECONDS = 120;
export const DEFAULT_RUN_COMMAND_MAX_TIMEOUT_SECONDS = 600;
// 决策 365：后台作业——每会话同时在跑的个数、整次运行同时在跑的总数、单个作业输出文件的上限（超出只留末尾）、
// 无人值守收尾时等在跑作业的总时限（秒）
export const DEFAULT_MAX_BACKGROUND_JOBS = 2;
export const DEFAULT_MAX_BACKGROUND_JOBS_TOTAL = 8;
export const DEFAULT_BACKGROUND_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_BACKGROUND_CLOSEOUT_SECONDS = 600;

const Closed = { additionalProperties: false } as const;

const MaxResultsSchema = Type.Object(
  { maxResults: Type.Optional(Type.Integer({ minimum: 1 })) },
  Closed
);

export const ToolsSectionSchema = Type.Object(
  {
    grep: Type.Optional(MaxResultsSchema),
    glob: Type.Optional(MaxResultsSchema),
    readFile: Type.Optional(
      Type.Object(
        {
          // 单次读取返回的正文至多这么多字节
          maxBytes: Type.Optional(Type.Integer({ minimum: 1 })),
          // 单行超过这么多字符即截断并注明
          maxLineChars: Type.Optional(Type.Integer({ minimum: 1 })),
        },
        Closed
      )
    ),
    runCommand: Type.Optional(
      Type.Object(
        {
          // 输出超长时保留的开头与末尾（字节）
          outputHeadBytes: Type.Optional(Type.Integer({ minimum: 1 })),
          outputTailBytes: Type.Optional(Type.Integer({ minimum: 0 })),
          // 每个会话落盘的完整输出总量上限（字节），满了删最旧的
          savedOutputsMaxBytes: Type.Optional(Type.Integer({ minimum: 1 })),
          // 单次超时：不给 timeout 参数时的缺省与参数的上限（秒）
          timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
          maxTimeoutSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
          // 后台作业：每会话同时在跑的上限、整次运行（主会话加 worker）同时在跑的上限
          maxBackgroundJobs: Type.Optional(Type.Integer({ minimum: 1 })),
          maxBackgroundJobsTotal: Type.Optional(Type.Integer({ minimum: 1 })),
          // 单个作业输出文件的上限（字节），超出只留末尾
          backgroundOutputMaxBytes: Type.Optional(Type.Integer({ minimum: 1024 })),
          // 无人值守收尾前等在跑作业的总时限（秒），计入运行墙钟预算
          backgroundCloseoutSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
        },
        Closed
      )
    ),
  },
  Closed
);
export type ToolsSection = Static<typeof ToolsSectionSchema>;

export interface SearchLimits {
  grepMaxResults: number;
  globMaxResults: number;
}

export function searchLimits(section: ToolsSection | undefined): SearchLimits {
  return {
    grepMaxResults: section?.grep?.maxResults ?? DEFAULT_GREP_MAX_RESULTS,
    globMaxResults: section?.glob?.maxResults ?? DEFAULT_GLOB_MAX_RESULTS,
  };
}

export interface ReadFileLimits {
  maxBytes: number;
  maxLineChars: number;
}

export function readFileLimits(section: ToolsSection | undefined): ReadFileLimits {
  return {
    maxBytes: section?.readFile?.maxBytes ?? DEFAULT_READ_FILE_MAX_BYTES,
    maxLineChars: section?.readFile?.maxLineChars ?? DEFAULT_READ_FILE_MAX_LINE_CHARS,
  };
}

export interface RunCommandOutputLimits {
  headBytes: number;
  tailBytes: number;
  savedOutputsMaxBytes: number;
}

export function runCommandOutputLimits(section: ToolsSection | undefined): RunCommandOutputLimits {
  return {
    headBytes: section?.runCommand?.outputHeadBytes ?? DEFAULT_RUN_COMMAND_OUTPUT_HEAD_BYTES,
    tailBytes: section?.runCommand?.outputTailBytes ?? DEFAULT_RUN_COMMAND_OUTPUT_TAIL_BYTES,
    savedOutputsMaxBytes:
      section?.runCommand?.savedOutputsMaxBytes ?? DEFAULT_SAVED_OUTPUTS_MAX_BYTES,
  };
}

export interface RunCommandTimeouts {
  defaultSeconds: number;
  maxSeconds: number;
}

// 缺省大于上限时按上限
export function runCommandTimeouts(section: ToolsSection | undefined): RunCommandTimeouts {
  const maxSeconds =
    section?.runCommand?.maxTimeoutSeconds ?? DEFAULT_RUN_COMMAND_MAX_TIMEOUT_SECONDS;
  const defaultSeconds = Math.min(
    section?.runCommand?.timeoutSeconds ?? DEFAULT_RUN_COMMAND_TIMEOUT_SECONDS,
    maxSeconds
  );
  return { defaultSeconds, maxSeconds };
}

export interface BackgroundJobLimits {
  perSession: number;
  total: number;
  outputMaxBytes: number;
  closeoutSeconds: number;
}

export function backgroundJobLimits(section: ToolsSection | undefined): BackgroundJobLimits {
  const runCommand = section?.runCommand;
  return {
    perSession: runCommand?.maxBackgroundJobs ?? DEFAULT_MAX_BACKGROUND_JOBS,
    total: runCommand?.maxBackgroundJobsTotal ?? DEFAULT_MAX_BACKGROUND_JOBS_TOTAL,
    outputMaxBytes: runCommand?.backgroundOutputMaxBytes ?? DEFAULT_BACKGROUND_OUTPUT_MAX_BYTES,
    closeoutSeconds: runCommand?.backgroundCloseoutSeconds ?? DEFAULT_BACKGROUND_CLOSEOUT_SECONDS,
  };
}
