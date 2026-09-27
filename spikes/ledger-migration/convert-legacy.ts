// 旧账本 → 新会话存储的转换器（决策 180 / 187）：只用于对照验证，产品不读旧格式。
// 新代码在账本重构收尾后不再读旧格式，所以本转换器只依赖旧代码里一直存在的模块（persistence/event-log.ts 的物化与正文读取、
// pi-runtime/session-tree.ts 的消息投影）与上游 JsonlSessionRepo，放进只读旧版工作树（455d88d）里照样能跑。
// 新条目的形状照 src/state/session-entries.ts 的 v1 schema 内联写出（旧版代码里没有那个文件）；两边须保持一致，
// 在新代码上跑样例（sample.ts）时会按新 schema 校验转换结果。
//
// 用法：node spikes/ledger-migration/convert-legacy.ts <旧会话目录> <会话号> <输出会话根> [--cwd <工作目录>]
//   旧会话目录即 <治理根>/.pigeon/sessions；工作目录缺省为治理根（worker 与分支会话取其工作树）。
//
// 转换口径（与双写的新文件对照时的预期差异见 README.md）：
// - 消息：按旧账本 entry 的落盘顺序，经 ledgerTreeMessages 由正文文件与运行事件投影；条目号沿用旧 EntryId；
// - Run 开始：run.started 的配置，系统提示全文取正文文件的 system 记录（每个运行面只存一次，之后的 Run 沿用最近一次）；
// - Run 收尾：run.ended 处写，结束方式由撞上限、熔断记录与末轮停止原因推出；没有 run.ended 的 Run 不写；
// - 验证、代码快照、worker 派出与收尾、分叉、授权：按旧记录落盘位置逐条转换；
// - worker 与分支会话头：写进新文件头（父会话号与 metadata）。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  JsonlEventLog,
  materializeSession,
  readMessageContentFileDetailed,
} from "../../src/persistence/event-log.ts";
import { ledgerTreeMessages } from "../../src/pi-runtime/session-tree.ts";

type Json = Record<string, unknown>;

// 剥掉值为 undefined 的键（上游序列化会拒绝）
function clean<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface ConvertResult {
  path: string;
  messages: number;
  customs: Record<string, number>;
}

export async function convertLegacySession(input: {
  sessionsDir: string;
  sessionId: string;
  outRoot: string;
  cwd?: string;
}): Promise<ConvertResult> {
  const old = materializeSession(input.sessionsDir, input.sessionId as never);
  const content = readMessageContentFileDetailed(
    JsonlEventLog.contentFilePathFor(input.sessionsDir, input.sessionId as never)
  ).records;
  const contentByEntryId = new Map(content.map((record) => [record.entryId as string, record]));
  const projected = new Map(
    ledgerTreeMessages({ records: old.records, contentByEntryId }).map((item) => [
      item.id,
      item.message,
    ])
  );
  const systemByRun = new Map<string, string>();
  for (const record of content) {
    if (record.role === "system") {
      const text = record.blocks.flatMap((block) => (block.type === "text" ? [block.text] : []));
      systemByRun.set(record.runId, text.join(""));
    }
  }
  const limitByRun = new Map<string, string>(
    old.limitHits.map((hit) => [hit.runId, hit.payload.limit])
  );
  const breakerRuns = new Set<string>(old.breakers.map((breaker) => breaker.runId));
  const stopByRun = new Map<string, string>();
  const errorByRun = new Map<string, string>();
  for (const event of old.runtimeEvents) {
    if (event.kind === "turn.completed") {
      stopByRun.set(event.runId, event.payload.stopReason);
      if (event.payload.errorMessage !== undefined) {
        errorByRun.set(event.runId, event.payload.errorMessage);
      }
    }
  }

  const workerHeader = old.sessionHeader;
  const branchHeader = old.branchHeader;
  const cwd =
    input.cwd ??
    (workerHeader?.workspace.kind === "git-worktree" ? workerHeader.workspace.path : undefined) ??
    branchHeader?.workspace.path ??
    path.dirname(path.dirname(input.sessionsDir));
  const parentSessionId = workerHeader?.parentSessionId ?? branchHeader?.sourceSessionId;
  const metadata =
    workerHeader !== undefined || branchHeader !== undefined
      ? {
          pigeon: clean({
            version: 1,
            worker:
              workerHeader !== undefined
                ? {
                    parentRunId: workerHeader.parentRunId,
                    name: workerHeader.worker.name,
                    role: workerHeader.worker.role,
                    workspace: workerHeader.workspace,
                    startedAt: workerHeader.startedAt,
                  }
                : undefined,
            branch:
              branchHeader !== undefined
                ? {
                    sourceSessionId: branchHeader.sourceSessionId,
                    forkPoint: branchHeader.forkPoint,
                    checkpoint: branchHeader.checkpoint,
                    workspace: branchHeader.workspace,
                    trigger: branchHeader.trigger,
                    startedAt: branchHeader.startedAt,
                  }
                : undefined,
          }),
        }
      : undefined;

  const repo = new JsonlSessionRepo({
    fs: new NodeExecutionEnv({ cwd: input.outRoot }),
    sessionsRoot: input.outRoot,
  });
  const session = await repo.create({
    id: input.sessionId,
    cwd,
    ...(parentSessionId !== undefined ? { parentSessionId } : {}),
    ...(metadata !== undefined ? { metadata: metadata as never } : {}),
  });
  const customs: Record<string, number> = {};
  const custom = async (customType: string, data: Json) => {
    customs[customType] = (customs[customType] ?? 0) + 1;
    await session.appendCustomEntry(customType, clean(data));
  };
  let messages = 0;
  let systemPrompt = "";
  for (const record of old.records) {
    switch (record.kind) {
      case "entry": {
        const message = projected.get(record.id);
        if (message !== undefined) {
          await session.appendEntry(
            { type: "message", id: record.id, message: clean(message) },
            "main"
          );
          messages += 1;
        }
        break;
      }
      case "run.started": {
        systemPrompt = systemByRun.get(record.runId) ?? systemPrompt;
        const {
          systemPromptHash: _hash,
          stepStart: _stepStart,
          structuredMemory: _memory,
          ...config
        } = record.payload as Json;
        await custom("pigeon.run-start", {
          version: 1,
          runId: record.runId,
          startedAt: record.timestamp,
          ...config,
          systemPrompt,
        });
        break;
      }
      case "run.ended": {
        const stopReason = stopByRun.get(record.runId);
        const limit = limitByRun.get(record.runId);
        const ending =
          limit ??
          (stopReason === "aborted"
            ? breakerRuns.has(record.runId)
              ? "breaker"
              : "aborted"
            : stopReason === "stop" || stopReason === "length" || stopReason === "deferred"
              ? "completed"
              : "error");
        await custom("pigeon.run-end", {
          version: 1,
          runId: record.runId,
          ending,
          stopReason,
          errorMessage: errorByRun.get(record.runId),
          messageCount: record.payload.messageCount,
          endedAt: record.timestamp,
        });
        break;
      }
      case "attempt.verified": {
        const { version: _v, id: _id, sessionId: _s, kind: _k, timestamp: _t, ...rest } = record;
        await custom("pigeon.verification", { version: 1, ...rest });
        break;
      }
      case "workspace.checkpoint": {
        const { afterRunSeq: _seq, ...payload } = record.payload;
        await custom("pigeon.checkpoint", { version: 1, runId: record.runId, ...payload });
        break;
      }
      case "child.spawned": {
        const { version: _v, id: _id, sessionId: _s, kind: _k, timestamp: _t, taskKey: _key, ...rest } =
          record;
        await custom("pigeon.worker", { version: 1, event: "spawned", ...rest });
        break;
      }
      case "child.settled": {
        const { version: _v, id: _id, sessionId: _s, kind: _k, timestamp: _t, result, ...rest } =
          record;
        await custom("pigeon.worker", {
          version: 1,
          event: "settled",
          ...rest,
          result:
            result !== undefined
              ? {
                  branch: result.branch,
                  changedFiles: result.changedFiles,
                  summary: result.summary,
                  summaryTruncated: result.summaryTruncated,
                }
              : undefined,
        });
        break;
      }
      case "session.forked": {
        const forkEntry = old.entries.find(
          (entry) =>
            entry.runId === record.forkPoint.runId && entry.runSeq === record.forkPoint.runSeq
        );
        await custom("pigeon.fork", {
          version: 1,
          runId: record.runId,
          branchSessionId: record.branchSessionId,
          forkPoint: record.forkPoint,
          forkEntryId: forkEntry?.id,
          checkpoint: record.checkpoint,
          trigger: record.trigger,
          forkedAt: record.forkedAt,
        });
        break;
      }
      case "grant.created": {
        const { version: _v, id: _id, sessionId: _s, kind: _k, timestamp: _t, ...rest } = record;
        await custom("pigeon.grant", { version: 1, event: "created", ...rest });
        break;
      }
      case "grant.revoked": {
        const { version: _v, id: _id, sessionId: _s, kind: _k, timestamp: _t, ...rest } = record;
        await custom("pigeon.grant", { version: 1, event: "revoked", ...rest });
        break;
      }
      default:
        // 停写清单里的记录（运行事件、请求观察、技能加载、SWE 验证、意图、审批、回执、对账）不转
        break;
    }
  }
  return { path: (await session.getMetadata()).path, messages, customs };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const cwdAt = args.indexOf("--cwd");
  const cwd = cwdAt >= 0 ? args[cwdAt + 1] : undefined;
  const [sessionsDir, sessionId, outRoot] = args.filter(
    (_arg, index) => cwdAt < 0 || (index !== cwdAt && index !== cwdAt + 1)
  );
  if (sessionsDir === undefined || sessionId === undefined || outRoot === undefined) {
    process.stderr.write(
      "用法：node spikes/ledger-migration/convert-legacy.ts <旧会话目录> <会话号> <输出会话根> [--cwd <工作目录>]\n"
    );
    process.exit(2);
  }
  const result = await convertLegacySession({
    sessionsDir: path.resolve(sessionsDir),
    sessionId,
    outRoot: path.resolve(outRoot),
    ...(cwd !== undefined ? { cwd: path.resolve(cwd) } : {}),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
