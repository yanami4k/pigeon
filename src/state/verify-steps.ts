// 验证分步（决策 159）的纯判据：分步清单的归一、各步结论的合取，以及验证记录上的各步结论。
// 单条命令的旧配置视为只有一步；旧验证记录没有各步字段，读取时由整体结论还原成同名的一步。纯函数，无 IO。
import { type Static, Type } from "typebox";
import type { VerifyConfig, VerifyStep } from "./attempt-config.ts";
import { type EvalVerdict, EvalVerdictSchema } from "./runtime-events.ts";

// 单条命令的旧配置视为一步时用的步名
export const LEGACY_VERIFY_STEP_NAME = "验证";

// 验证记录上的一步结论（加法式可选字段，决策 159）：步名、退出码、结论与输出末尾
export const VerifyStepResultSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  verdict: EvalVerdictSchema,
  output: Type.String(),
  truncated: Type.Boolean(),
  // 这一步的执行目录（相对工作区根）；缺省即工作区根
  cwd: Type.Optional(Type.String({ minLength: 1 })),
});
export type VerifyStepResult = Static<typeof VerifyStepResultSchema>;

// 步骤执行目录的规范写法：正斜杠、去掉开头的 ./ 与结尾斜杠；"." 或空即工作区根（返回 undefined）。
// 绝对路径、含 .. 段的越界写法返回 null（配置读取时据此响亮失败）
export function normalizeStepCwd(cwd: string | undefined): string | undefined | null {
  if (cwd === undefined) {
    return undefined;
  }
  const normalized = cwd
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "");
  if (normalized === "" || normalized === ".") {
    return undefined;
  }
  if (/^([A-Za-z]:)?\//.test(normalized) || normalized.split("/").includes("..")) {
    return null;
  }
  return normalized;
}

// 工具在某一步的执行目录下报出的路径 → 相对工作区根的路径（绝对路径由调用方另行相对化）
export function underStepCwd(file: string, cwd: string | undefined): string {
  const normalized = file.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  if (cwd === undefined || /^([A-Za-z]:)?\//.test(normalized)) {
    return normalized;
  }
  const parts: string[] = cwd.split("/");
  for (const part of normalized.split("/")) {
    if (part === "..") {
      parts.pop();
    } else if (part !== "." && part !== "") {
      parts.push(part);
    }
  }
  return parts.join("/");
}

// 配置里要执行的各步；没有分步即旧配置，视为一步
export function verifyStepsOf(config: Pick<VerifyConfig, "command" | "steps">): VerifyStep[] {
  return config.steps !== undefined && config.steps.length > 0
    ? config.steps.map((step) => {
        const cwd = normalizeStepCwd(step.cwd);
        return {
          name: step.name,
          command: step.command,
          ...(typeof cwd === "string" ? { cwd } : {}),
        };
      })
    : [{ name: LEGACY_VERIFY_STEP_NAME, command: config.command }];
}

// 分步配置的展示串：[步名] 命令，按顺序以全角分号连接
export function verifyStepsDisplay(steps: readonly VerifyStep[]): string {
  return steps
    .map(
      (step) => `[${step.name}${step.cwd !== undefined ? ` @ ${step.cwd}` : ""}] ${step.command}`
    )
    .join("；");
}

// 整体结论为各步合取：任一步失败即失败；无失败但有步无法判定即无法判定；全部通过才通过（没有步骤算无法判定）
export function combineStepVerdicts(verdicts: readonly EvalVerdict[]): EvalVerdict {
  if (verdicts.includes("fail")) {
    return "fail";
  }
  if (verdicts.length === 0 || verdicts.includes("undetermined")) {
    return "undetermined";
  }
  return "pass";
}

// 一条验证记录的各步结论；旧记录（或单条命令配置写下的记录）没有各步字段，由整体结论还原成一步
export function recordStepsOf(record: {
  steps?: readonly VerifyStepResult[];
  exitCode: number | null;
  verdict: EvalVerdict;
  output: string;
  truncated: boolean;
}): VerifyStepResult[] {
  if (record.steps !== undefined) {
    return record.steps.map((step) => ({ ...step }));
  }
  return [
    {
      name: LEGACY_VERIFY_STEP_NAME,
      exitCode: record.exitCode,
      verdict: record.verdict,
      output: record.output,
      truncated: record.truncated,
    },
  ];
}
