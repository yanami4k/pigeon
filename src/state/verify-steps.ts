// 验证分步（决策 159）的纯判据：分步清单的归一、各步结论的合取，以及验证记录上的各步结论。
// 单条命令的旧配置视为只有一步；旧验证记录没有各步字段，读取时由整体结论还原成同名的一步。
// 检查工具自身崩溃（决策 170 ③）的识别表与"整体结论只看其余步"的合取也在这里。纯函数，无 IO。
import { type Static, Type } from "typebox";
import type { VerifyConfig, VerifyStep } from "./attempt-config.ts";
import { type EvalVerdict, EvalVerdictSchema } from "./runtime-events.ts";

// 检查工具自身崩溃的退出码表（决策 170 ③）：各工具公开的"非正常结束"退出码，与"检查出了问题"（通常为 1）区分开。
//   pytest：3 内部错误、4 命令行用法错误（1 为有用例失败、2 为被中断、5 为没收集到用例，都不算崩溃）；
//   mypy：2 致命错误（内部崩溃，即提示 --show-traceback 的那种，以及配置或参数错误；1 为有类型错误）；
//   ruff：2 非正常结束（配置或参数错误、内部错误；1 为有违规）。
// 步配置以 tool 声明所用工具；没声明、或声明的工具不在表里的一律不识别（不按命令行去猜）。支持新工具即在表里加一行
export const TOOL_CRASH_EXIT_CODES: Readonly<Record<string, readonly number[]>> = {
  pytest: [3, 4],
  mypy: [2],
  ruff: [2],
};

// 表里有没有这个工具（项目验证配置读取时据此拒绝写错的工具名）
export function isKnownCheckTool(tool: string): boolean {
  return Object.hasOwn(TOOL_CRASH_EXIT_CODES, tool);
}

// 这次执行是不是检查工具自身崩溃：声明了表里的工具，且退出码是它的崩溃码（超时、拉不起来没有退出码，不算）
export function isToolCrash(tool: string | undefined, exitCode: number | null): boolean {
  if (tool === undefined || exitCode === null || !isKnownCheckTool(tool)) {
    return false;
  }
  return TOOL_CRASH_EXIT_CODES[tool]?.includes(exitCode) === true;
}

// 整体结论：只看不是工具故障的步（工具故障的步重跑一次仍崩溃，不因它判失败）；全是工具故障即无法判定
export function verdictOfSteps(
  steps: readonly { verdict: EvalVerdict; toolFault?: true }[]
): EvalVerdict {
  return combineStepVerdicts(
    steps.filter((step) => step.toolFault !== true).map((step) => step.verdict)
  );
}

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

// 执行验证得到的一步结论：另带工具故障标记（决策 170 ③；新存储的验证记录收它，见 session-entries.ts 的 VerificationStepSchema）
export type VerifyStepOutcome = VerifyStepResult & { toolFault?: true };

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
          ...(step.tool !== undefined ? { tool: step.tool } : {}),
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
