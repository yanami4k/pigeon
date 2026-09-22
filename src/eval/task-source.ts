// 任务源接口（决策 102）：把"跑什么题"抽成一层，由实现提供四样东西——实例清单、该实例的环境准备方式、判据命令、
// 元数据（难度、holdout 标记、对应能力）。跑批设施、结果行、统计、报告与账本记录一律不感知题目来源；
// 冒烟用的自造题（local-source.ts）与外部基准（swebench-source.ts）各为一个实现。
// 判据只有一个形状（096 ②）：执行一条命令、三值判决——外部基准的判分脚本即为该命令，不另开判据路径。
import type { SessionId } from "../state/ids.ts";
import type { WorkspaceHost } from "../tools/workspace-host.ts";
import type { EvalCondition } from "./task.ts";

export interface EvalInstanceBudget {
  maxTurns: number;
  wallClockMs: number;
  maxTokens?: number;
}

export interface EvalInstance {
  // 结果行与验证记录里的任务 id
  id: string;
  // agent 收到的任务描述
  instructions: string;
  // 系统指令（可选）：只说工作方式、不含任务内容的一段话，追加进 system prompt 并随之冻结进该次运行的注入快照。
  // 它属于被测条件；与任务说明分开——任务说明是题目，这一句是 harness 对"怎么干活"的交代
  systemDirective?: string;
  budget: EvalInstanceBudget;
  // 元数据
  holdout: boolean;
  // 对应能力
  tags: readonly string[];
  // 题源自带的难度标记（自造题没有）
  difficulty?: string;
}

// 判据命令：参数数组不经 shell，作为独立子进程执行；退出码 0 通过、非 0 失败，超时、被信号终止或拉不起来为未判定
export interface JudgeCommand {
  command: string[];
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  // 判分前备好的材料（冒烟题：回填到工作区的验证资产；外部基准：取出的补丁文件）
  assets: string[];
  // 约定：判据命令 stdout 尾行可以是一个 JSON 对象，原样收入验证记录。runner 认其中两个字段：
  //   emptyPatch 为 true —— 交来的改动为空（判决仍按退出码，通常为失败），结果行加"空补丁"标注；
  //   progress —— 连续指标 { target: { passed, total }, regression?: { passed, total } }：目标用例与回归用例各通过几条，
  //   只回答"离通过有多远"，不影响判决
  // 判据自身出错（而非任务失败）时约定使用的退出码：命中即未判定，不算任务失败
  undeterminedExitCodes?: readonly number[];
}

export interface PrepareContext {
  // 本次跑批的治理根（输出目录）
  governanceRoot: string;
  sessionId: SessionId;
  condition: EvalCondition;
  // 第几次（从 1 起）
  attempt: number;
}

export interface PreparedInstance {
  // 宿主侧的工作区根；容器工作区下只是占位目录（账本与治理按它登记，工具不经它读写）
  workspaceRoot: string;
  // 执行端（决策 098）；缺省为 workspaceRoot 上的本地实现
  host?: WorkspaceHost;
  // agent 收工后调用：备好判分材料并给出判据命令。备料失败抛错（记未判定）
  judge(): Promise<JudgeCommand>;
  // 判分失败时也要有一条可记录的命令
  readonly judgeCommandHint: readonly string[];
  // 释放环境（工作树与分支、容器）；幂等
  release(): Promise<void>;
}

export interface TaskSource {
  // 题源名（报告与日志用）
  readonly name: string;
  instances(): readonly EvalInstance[];
  // 准备该实例的运行环境；失败抛错——跑批设施记为错误行（基础设施错误，不算任务失败，重跑时补跑）
  prepare(instance: EvalInstance, context: PrepareContext): Promise<PreparedInstance>;
  // 续跑前清理上次进程死于中途留下的环境
  cleanupStale?(governanceRoot: string): Promise<void>;
}
