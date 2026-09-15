// Eval 任务目录（M6.5 S2，决策 057）：一任务一目录 eval/tasks/<id>/，入库——task.md 任务说明、task.json 元数据、
// verify 脚本、assets/ 下的验证资产（按工作区相对路径排布，验证前由 runner 覆盖写回工作区，058 修订）、
// README.md（测什么能力、来源与许可）。代码快照以 git 引用给出：repo.path 为 "." 时指任务目录所在仓库的主仓库根，
// runner 经 WorkspaceProvider 从 repo.ref 开工作树。验证器命令是参数数组，不经 shell；{TASK_DIR} 替换为任务目录。
// 第二层反向断言（reverseAssertions）只留字段与形状校验，M6.5 不执行。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { mainRepoRoot } from "../orchestration/worktree.ts";

export const EVAL_TASK_VERSION = 1;

// 三向对照条件（059）：无 Skill / 候选 / 已批准，由 skillRoots 切换
export const EVAL_CONDITIONS = ["none", "candidate", "approved"] as const;
export type EvalCondition = (typeof EVAL_CONDITIONS)[number];

// 验证器命令里的任务目录占位
export const TASK_DIR_TOKEN = "{TASK_DIR}";

export class EvalTaskError extends Error {}

const CommandSchema = Type.Object({
  command: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  timeoutMs: Type.Integer({ minimum: 1 }),
});

export const EvalTaskSchema = Type.Object({
  version: Type.Literal(EVAL_TASK_VERSION),
  // 与目录名一致；最长 24，使 worker 名 <id>-<condition>-<n> 落在 worker 名上限内
  id: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,23}$" }),
  // 说明文件（任务目录相对路径）
  instructions: Type.String({ minLength: 1 }),
  repo: Type.Object({
    path: Type.String({ minLength: 1 }),
    ref: Type.String({ minLength: 1 }),
  }),
  budget: Type.Object({
    maxTurns: Type.Integer({ minimum: 1 }),
    wallClockMs: Type.Integer({ minimum: 1 }),
    maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  }),
  verifier: CommandSchema,
  // 回填文件清单：工作区相对路径，源文件在 assets/<路径>
  assets: Type.Array(Type.String({ minLength: 1 })),
  tags: Type.Array(Type.String({ minLength: 1 })),
  holdout: Type.Boolean(),
  // 第二层误成功（反向断言，如未改测试文件）：M6.5 只留接口
  reverseAssertions: Type.Optional(CommandSchema),
});
export type EvalTask = Static<typeof EvalTaskSchema>;

export interface LoadedEvalTask {
  // 任务目录绝对路径
  dir: string;
  spec: EvalTask;
  // 说明正文（agent 收到的任务描述）
  instructions: string;
  // 快照所在仓库的根（repo.path 为 "." 时为主仓库根）
  repoRoot: string;
}

// 任务目录内的相对路径：不得越出基准目录
function insideRelative(value: string): boolean {
  const normalized = path.posix.normalize(value.split("\\").join("/"));
  return !path.posix.isAbsolute(normalized) && normalized !== ".." && !normalized.startsWith("../");
}

function requireFile(file: string, what: string): void {
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new EvalTaskError(`${what}不存在：${file}`);
  }
}

export function loadEvalTask(dirInput: string): LoadedEvalTask {
  const dir = path.resolve(dirInput);
  const specFile = path.join(dir, "task.json");
  requireFile(specFile, "task.json ");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(specFile, "utf8"));
  } catch (error) {
    throw new EvalTaskError(
      `task.json 不是合法 JSON：${specFile}（${error instanceof Error ? error.message : String(error)}）`
    );
  }
  let spec: EvalTask;
  try {
    spec = Value.Parse(EvalTaskSchema, raw);
  } catch (error) {
    throw new EvalTaskError(
      `task.json 形状不符：${specFile}（${error instanceof Error ? error.message : String(error)}）`
    );
  }
  if (spec.id !== path.basename(dir)) {
    throw new EvalTaskError(`任务 id ${spec.id} 与目录名 ${path.basename(dir)} 不一致`);
  }
  if (!insideRelative(spec.instructions)) {
    throw new EvalTaskError(`说明文件路径越出任务目录：${spec.instructions}`);
  }
  const instructionsFile = path.join(dir, spec.instructions);
  requireFile(instructionsFile, "说明文件");
  requireFile(path.join(dir, "README.md"), "README.md ");
  for (const asset of spec.assets) {
    if (!insideRelative(asset)) {
      throw new EvalTaskError(`验证资产路径越出工作区根：${asset}（任务 ${spec.id}）`);
    }
    requireFile(path.join(dir, "assets", asset), `验证资产 ${asset} `);
  }
  const repoRoot = spec.repo.path === "." ? mainRepoRoot(dir) : path.resolve(dir, spec.repo.path);
  return {
    dir,
    spec,
    instructions: readFileSync(instructionsFile, "utf8"),
    repoRoot,
  };
}

// 任务集：目录自身有 task.json 即单个任务，否则加载其下带 task.json 的子目录（按目录名排序）
export function loadEvalTasks(rootInput: string): LoadedEvalTask[] {
  const root = path.resolve(rootInput);
  if (existsSync(path.join(root, "task.json"))) {
    return [loadEvalTask(root)];
  }
  if (!existsSync(root)) {
    throw new EvalTaskError(`任务目录不存在：${root}`);
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(root, entry.name, "task.json")))
    .map((entry) => entry.name)
    .sort()
    .map((name) => loadEvalTask(path.join(root, name)));
}
