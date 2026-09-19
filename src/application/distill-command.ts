// pigeon distill（M7 S4，决策 074）：手动提炼一组或多组尝试。与自动触发同一派发器、同一选对规则。
// - --task <key>：在本治理根里找派出记录带该任务标识的宿主会话（并行同任务派发的父会话），记录写回该会话；
//   宿主会话正被另一进程持有时按会话锁响亮失败；
// - --eval-results <dir>：Eval 结果目录是另一个治理根，只读读取其会话文件，按任务编号成组（同任务认定用任务编号，决策 069）；
//   本治理根新建一个宿主会话承载派出、候选与跳过记录，候选暂存到本治理根，结果目录不写任何东西；
// - 全成功或全失败的组缺省不提炼、留跳过记录；--force 强制提炼：全失败只取最早收尾的失败侧（只产出教训），全成功取总轮数最少的成功侧。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { contrastTarget, forcedSelection } from "../distillation/target.ts";
import type { WorkerRuntimeFactory } from "../orchestration/workers.ts";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { listSessionIds, materializeSession } from "../persistence/session-read.ts";
import type { ReviewGate } from "../review/scheduler.ts";
import {
  type Attempt,
  buildTaskAttempt,
  type ContrastSkipReason,
  selectContrast,
} from "../state/episode.ts";
import type { WorkerLimits } from "../state/event-log.ts";
import { asRunId, asSessionId, newSessionId, type SessionId } from "../state/ids.ts";
import type { MaterializedSession } from "../state/materialize.ts";
import { createDistillDispatcher, type DistillOutcome } from "./distill-runtime.ts";

export interface DistillCommandInput {
  // 本治理根（暂存目录与宿主会话所在）
  root: string;
  taskKey?: string;
  evalResults?: string;
  force?: boolean;
  createRuntime: WorkerRuntimeFactory;
  gate?: ReviewGate;
  budget?: Partial<WorkerLimits>;
}

export interface DistillGroupReport {
  key: string;
  attempts: Attempt[];
  skip?: ContrastSkipReason;
  distill?: DistillOutcome;
}

export interface DistillCommandResult {
  hostSessionId: SessionId;
  groups: DistillGroupReport[];
}

interface AttemptGroup {
  key: string;
  attempts: Attempt[];
}

const sessionsDirOf = (root: string) => path.join(root, ".pigeon", "sessions");

// --task：宿主会话即派出记录带该任务标识的那个会话
function findTaskHost(root: string, taskKey: string): MaterializedSession {
  const dir = sessionsDirOf(root);
  for (const sessionId of listSessionIds(dir)) {
    const session = materializeSession(dir, sessionId, { content: false });
    if (session.childSpawneds.some((record) => record.taskKey === taskKey)) {
      return session;
    }
  }
  throw new Error(`找不到派出记录带任务标识 ${taskKey} 的会话（${dir}）`);
}

function taskGroup(root: string, host: MaterializedSession, taskKey: string): AttemptGroup {
  const dir = sessionsDirOf(root);
  const attempts: Attempt[] = [];
  for (const spawned of host.childSpawneds) {
    if (spawned.taskKey !== taskKey || spawned.role === "distiller") {
      continue;
    }
    const session = materializeSession(dir, spawned.childSessionId, { content: false });
    try {
      attempts.push(
        buildTaskAttempt({ governanceRoot: root, session, verificationSources: [host] })
      );
    } catch {
      // 没有 Run 的尝试（派出失败）不进对比
    }
  }
  return { key: taskKey, attempts };
}

// --eval-results：results.jsonl 每行一次运行；缺会话或 Run 的行跳过
function evalGroups(evalDir: string): AttemptGroup[] {
  const resultsPath = path.join(evalDir, "results.jsonl");
  if (!existsSync(resultsPath)) {
    throw new Error(`Eval 结果目录里没有 results.jsonl：${evalDir}`);
  }
  const dir = sessionsDirOf(evalDir);
  const groups = new Map<string, Attempt[]>();
  for (const line of readFileSync(resultsPath, "utf8").split(/\r?\n/)) {
    if (line.trim() === "") {
      continue;
    }
    const row = JSON.parse(line) as { taskId?: unknown; sessionId?: unknown; runId?: unknown };
    if (
      typeof row.taskId !== "string" ||
      typeof row.sessionId !== "string" ||
      typeof row.runId !== "string"
    ) {
      continue;
    }
    const session = materializeSession(dir, asSessionId(row.sessionId), { content: false });
    const attempt = buildTaskAttempt({
      governanceRoot: evalDir,
      session,
      runId: asRunId(row.runId),
    });
    groups.set(row.taskId, [...(groups.get(row.taskId) ?? []), attempt]);
  }
  return [...groups].map(([key, attempts]) => ({ key, attempts }));
}

export async function runDistillCommand(input: DistillCommandInput): Promise<DistillCommandResult> {
  if ((input.taskKey === undefined) === (input.evalResults === undefined)) {
    throw new Error("pigeon distill 需要且只需要 --task <任务标识> 或 --eval-results <目录> 之一");
  }
  let hostSessionId: SessionId;
  let groups: AttemptGroup[];
  if (input.taskKey !== undefined) {
    const host = findTaskHost(input.root, input.taskKey);
    hostSessionId = host.sessionId;
    groups = [taskGroup(input.root, host, input.taskKey)];
  } else {
    groups = evalGroups(path.resolve(input.evalResults as string));
    hostSessionId = newSessionId();
  }
  // 宿主会话正被另一进程持有时，会话锁在此响亮失败
  const hostLog = new JsonlEventLog(sessionsDirOf(input.root), hostSessionId);
  try {
    const dispatcher = createDistillDispatcher({
      governanceRoot: input.root,
      hostSessionId,
      hostLog,
      // 提炼器只拿两个豁免子集约束的只读工具；父策略不放任何工具、不放宽审批
      parentPolicy: { allow: [], deny: [], approvalMode: "prompt" },
      createRuntime: input.createRuntime,
      ...(input.gate !== undefined ? { gate: input.gate } : {}),
      ...(input.budget !== undefined ? { budget: input.budget } : {}),
    });
    const reports: DistillGroupReport[] = [];
    for (const group of groups) {
      const selection = selectContrast(group.attempts);
      const chosen =
        selection.skip === undefined
          ? selection
          : input.force === true
            ? forcedSelection(group.attempts)
            : undefined;
      if (chosen === undefined) {
        const reason = selection.skip ?? "no-contrast";
        hostLog.appendDistillSkipped({
          taskKey: group.key,
          reason,
          attempts: group.attempts.map((attempt) => ({
            sessionId: attempt.sessionId,
            runId: attempt.runId,
            label: attempt.label,
          })),
        });
        reports.push({ key: group.key, attempts: group.attempts, skip: reason });
        continue;
      }
      const distill = await dispatcher.distill(
        contrastTarget({ kind: "task", taskKey: group.key, selection: chosen })
      );
      reports.push({ key: group.key, attempts: group.attempts, distill });
    }
    return { hostSessionId, groups: reports };
  } finally {
    hostLog.close();
  }
}

// 人读报告（cli 与 tui 共用措辞）
export function renderDistillReport(result: DistillCommandResult): string {
  const lines = [`宿主会话 ${result.hostSessionId}`];
  for (const group of result.groups) {
    const labels = group.attempts.map((attempt) => attempt.label).join("、");
    if (group.skip !== undefined) {
      lines.push(`  ${group.key} ｜ 尝试 ${labels} ｜ 不提炼：${group.skip}`);
      continue;
    }
    const written = group.distill?.persisted?.written ?? [];
    const rejected = group.distill?.persisted?.rejected ?? [];
    lines.push(
      `  ${group.key} ｜ 尝试 ${labels} ｜ 提炼 ${group.distill?.status ?? "未派出"} ｜ 候选 ${written.length} 个` +
        (written.length > 0
          ? `：${written.map((item) => `${item.kind}/${item.name}（${item.contrast?.form ?? ""}）`).join("、")}`
          : "") +
        (rejected.length > 0 ? ` ｜ 丢弃 ${rejected.length} 项` : "")
    );
  }
  return lines.join("\n");
}
