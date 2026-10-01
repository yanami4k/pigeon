// .pigeon/verify.json 读取（M8 S1，决策 081）：验证命令的项目级配置——人配一次，本项目所有会话继承。
// 文件缺失 = 未配置（合法；标签现算为未知，决策 072 的"宁可标未知不可标错"）；存在但不是合法 JSON、
// schema 不符或命令全是空白 → 响亮失败。验证命令决定成败标签，语义不明绝不静默降级为"未配置"。
// 写入方只有人（手工编辑），本模块只读；形态与 commands.json / grants.json / mcp.json 三份项目配置一致。
import { existsSync, readFileSync } from "node:fs";
import { Value } from "typebox/value";
import {
  VERIFY_CONFIG_VERSION,
  type VerifyConfigFile,
  VerifyConfigFileSchema,
  type VerifyStep,
} from "../state/attempt-config.ts";
import { verifyConfigPathOf } from "../state/paths.ts";
import {
  isKnownCheckTool,
  normalizeStepCwd,
  TOOL_CRASH_EXIT_CODES,
  verifyStepsDisplay,
} from "../state/verify-steps.ts";

export class VerifyConfigError extends Error {}

// 超时缺省与启动参数同值（5 分钟）；常量在 application/launch-flags.ts，此处不反向依赖，由调用方传入
export const DEFAULT_PROJECT_VERIFY_TIMEOUT_MS = 5 * 60_000;

export function verifyConfigPath(governanceRoot: string): string {
  return verifyConfigPathOf(governanceRoot);
}

// 项目级验证命令；未配置返回 undefined。命名分步（决策 159）在场时 command 为各步的展示串，超时按每步各自计时
export function loadVerifyConfig(
  governanceRoot: string,
  defaultTimeoutMs: number = DEFAULT_PROJECT_VERIFY_TIMEOUT_MS
): { command: string; timeoutMs: number; source: "project"; steps?: VerifyStep[] } | undefined {
  const file = readVerifyConfigFile(governanceRoot);
  if (file === undefined) {
    return undefined;
  }
  const timeoutMs = file.timeoutMs ?? defaultTimeoutMs;
  if (file.steps !== undefined) {
    const steps = file.steps.map((step) => {
      const cwd = normalizeStepCwd(step.cwd);
      return {
        name: step.name,
        command: step.command,
        ...(typeof cwd === "string" ? { cwd } : {}),
        ...(step.tool !== undefined ? { tool: step.tool } : {}),
      };
    });
    return { command: verifyStepsDisplay(steps), timeoutMs, source: "project", steps };
  }
  return { command: file.command ?? "", timeoutMs, source: "project" };
}

// 项目级回炉轮数（决策 142 / 143）；文件缺失或未写该字段返回 undefined
export function loadProjectRepairRounds(governanceRoot: string): number | undefined {
  return readVerifyConfigFile(governanceRoot)?.repairRounds;
}

// 读取并校验 .pigeon/verify.json；缺失返回 undefined，畸形响亮失败
function readVerifyConfigFile(governanceRoot: string): VerifyConfigFile | undefined {
  const path = verifyConfigPath(governanceRoot);
  if (!existsSync(path)) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new VerifyConfigError(
      `verify 配置不是合法 JSON：${path}：${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!Value.Check(VerifyConfigFileSchema, raw)) {
    const problems = [...Value.Errors(VerifyConfigFileSchema, raw)]
      .map((failure) => {
        const where = "path" in failure ? failure.path : "/";
        return `${where === "" ? "/" : where}：${failure.message}`;
      })
      .join("；");
    throw new VerifyConfigError(
      `verify 配置校验失败（当前格式版本 ${VERIFY_CONFIG_VERSION}）：${path}：${problems}`
    );
  }
  const file = raw as VerifyConfigFile;
  // 决策 159：单条命令与命名分步二选一
  if ((file.command === undefined) === (file.steps === undefined)) {
    throw new VerifyConfigError(
      `verify 配置须在 command（单条命令）与 steps（命名分步）中恰好给出一项：${path}`
    );
  }
  if (file.command !== undefined && file.command.trim() === "") {
    throw new VerifyConfigError(`verify 配置的命令是空白：${path}`);
  }
  const names = new Set<string>();
  for (const step of file.steps ?? []) {
    if (step.name.trim() === "" || step.command.trim() === "") {
      throw new VerifyConfigError(`verify 配置的分步名或命令是空白：${path}`);
    }
    if (normalizeStepCwd(step.cwd) === null) {
      throw new VerifyConfigError(
        `verify 配置的分步执行目录须是工作区内的相对路径：${step.name}：${step.cwd ?? ""}：${path}`
      );
    }
    // 决策 170 ③：声明的检查工具须在崩溃退出码表里——写错的工具名会让崩溃识别悄悄失效
    if (step.tool !== undefined && !isKnownCheckTool(step.tool)) {
      throw new VerifyConfigError(
        `verify 配置的分步声明了不认识的检查工具：${step.name}：${step.tool}（可用：${Object.keys(TOOL_CRASH_EXIT_CODES).join("、")}）：${path}`
      );
    }
    if (names.has(step.name)) {
      throw new VerifyConfigError(`verify 配置的分步名重复：${step.name}：${path}`);
    }
    names.add(step.name);
  }
  return file;
}
