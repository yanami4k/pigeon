// 结构化记忆的推送（决策 134 / 135 / 136 / 157）：只在开局与回炉两个时机由程序推送。
// - 开局：按题面挑选，拼成系统提示里一个独立段落（与常驻 Memory 分开计预算），随注入快照冻结，run.started 记给了哪几条；
// - 回炉：按本次失败各步的指纹挑选，附在回炉反馈之后（走回炉的附加内容注入点），该轮回炉 Run 的 run.started 记给了哪几条；
// - 固定挑选（157）：调用方指定开局与回炉给哪几条（或一条都不给），除挑选结果外推送路径与正式使用完全相同；
// - 开关：关闭时两处都不推送（"去掉记忆"条件），run.started 仍记下开关状态。
// 记忆只取以往会话的事实：当前会话自己的记录不参与挑选。
// 故障（决策 136 平移口径）：派生、缓存读写、挑选或核验出错即"这次不给"，按类去重向标准错误告警（一次运行里同一类只报一次，
// 文案说明后果），运行照常完成、结论不受影响；不新增账本记录。

import {
  checkEntry,
  type EntryChecker,
  failingFingerprints,
  type MemoryPick,
  renderOpeningSection,
  renderRepairAppendix,
  selectFixed,
  selectOpening,
  selectRepair,
  taskReferencedFiles,
  type WorkspaceProbe,
  workspaceProbe,
} from "../memory/structured-select.ts";
import {
  buildMemoryEntries,
  loadStructuredMemory,
  type MemoryEntry,
  StructuredMemoryCacheError,
} from "../memory/structured-store.ts";
import type { SessionId } from "../state/ids.ts";
import type {
  StructuredMemoryManifest,
  StructuredMemorySelection,
} from "../state/injection-manifest.ts";
import type { FrictionFact } from "../state/structured-memory.ts";
import { LEGACY_VERIFY_STEP_NAME, type VerifyStepResult } from "../state/verify-steps.ts";
import type { RepairAppendix } from "./repair-loop.ts";

// 可替换的阶段实现（测试以抛错的实现模拟各类故障）
export interface StructuredMemoryPhases {
  // 派生（含缓存读写）：全部以往会话的摩擦事实
  load(governanceRoot: string): FrictionFact[];
  // 挑选
  selectOpening: typeof selectOpening;
  selectRepair: typeof selectRepair;
  selectFixed: typeof selectFixed;
  // 核验
  check: EntryChecker;
}

export interface StructuredMemoryOptions {
  // 缺省开启；关闭时两处都不推送
  enabled?: boolean;
  // 固定挑选（决策 157）：给了即不再按题面与报错挑选；空数组即一条都不给
  fixed?: { opening?: readonly string[]; repair?: readonly string[] };
  phases?: Partial<StructuredMemoryPhases>;
  // 告警出口（缺省标准错误）
  warn?: (line: string) => void;
}

export interface StructuredMemoryOpening {
  // 拼进系统提示的段落；没有条目为空串
  section: string;
  manifest: StructuredMemoryManifest;
}

export interface StructuredMemorySummary {
  opening: string[];
  // 每轮回炉给了哪几条（按轮次）
  repair: string[][];
}

export interface StructuredMemoryPush {
  opening(task: string | undefined): StructuredMemoryOpening;
  // 回炉附加内容：挑选并成文，同时把这一轮给的条目登记给下一个 Run 的 run.started
  repairAppendix: RepairAppendix;
  // 下一个 Run 开始时取走这一轮回炉给的条目（只取一次）
  takeRepairIds(): string[] | undefined;
  summary(): StructuredMemorySummary;
}

const DEFAULT_PHASES: StructuredMemoryPhases = {
  load: (governanceRoot) => loadStructuredMemory(governanceRoot).facts,
  selectOpening,
  selectRepair,
  selectFixed,
  check: checkEntry,
};

type FaultPhase = "派生" | "缓存读写" | "挑选" | "核验";

class PhaseError extends Error {
  readonly phase: FaultPhase;
  constructor(phase: FaultPhase, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.phase = phase;
  }
}

function stderrWarn(line: string): void {
  process.stderr.write(`${line}\n`);
}

export function createStructuredMemoryPush(input: {
  governanceRoot: string;
  workspaceRoot: string;
  sessionId: SessionId;
  options: StructuredMemoryOptions;
}): StructuredMemoryPush {
  const { options } = input;
  const enabled = options.enabled ?? true;
  const phases: StructuredMemoryPhases = { ...DEFAULT_PHASES, ...options.phases };
  const selection: StructuredMemorySelection = options.fixed !== undefined ? "fixed" : "auto";
  const warn = options.warn ?? stderrWarn;
  const warned = new Set<FaultPhase>();
  const summary: StructuredMemorySummary = { opening: [], repair: [] };
  let pendingRepair: string[] | undefined;
  let entries: MemoryEntry[] | undefined;
  let probe: WorkspaceProbe | undefined;

  const report = (error: unknown, when: string): void => {
    const phase = error instanceof PhaseError ? error.phase : "挑选";
    if (warned.has(phase)) {
      return;
    }
    warned.add(phase);
    const detail = error instanceof Error ? error.message : String(error);
    warn(
      `结构化记忆告警：${phase}出错（${detail}）；${when}不推送结构化记忆，运行照常完成、结论不受影响` +
        "（同类故障本次运行不再重复告警）"
    );
  };

  // 以往会话的记忆条目（当前会话的事实不参与）；首次用到时加载，失败下次再试
  const loadEntries = (): MemoryEntry[] => {
    if (entries !== undefined) {
      return entries;
    }
    let facts: FrictionFact[];
    try {
      facts = phases.load(input.governanceRoot);
    } catch (error) {
      throw new PhaseError(
        error instanceof StructuredMemoryCacheError ? "缓存读写" : "派生",
        error
      );
    }
    entries = buildMemoryEntries(facts.filter((fact) => fact.sessionId !== input.sessionId));
    return entries;
  };
  const probeOf = (): WorkspaceProbe => {
    probe ??= workspaceProbe(input.workspaceRoot);
    return probe;
  };
  const check: EntryChecker = (entry, workspace) => {
    try {
      return phases.check(entry, workspace);
    } catch (error) {
      throw new PhaseError("核验", error);
    }
  };
  const ids = (picks: readonly MemoryPick[]): string[] => picks.map((pick) => pick.entry.id);

  return {
    opening(task) {
      const manifest = (opening: string[]): StructuredMemoryManifest => ({
        enabled,
        selection,
        opening,
      });
      if (!enabled) {
        return { section: "", manifest: manifest([]) };
      }
      try {
        const loaded = loadEntries();
        const workspace = probeOf();
        const picks =
          options.fixed !== undefined
            ? phases.selectFixed(loaded, options.fixed.opening ?? [], workspace, check)
            : task === undefined
              ? []
              : phases.selectOpening(
                  loaded,
                  taskReferencedFiles(task, workspace),
                  workspace,
                  check
                );
        summary.opening = ids(picks);
        return { section: renderOpeningSection(picks), manifest: manifest(ids(picks)) };
      } catch (error) {
        report(error, "本次开局");
        return { section: "", manifest: manifest([]) };
      }
    },
    repairAppendix(context) {
      if (!enabled) {
        // 关闭时每轮都记"一条也没给"，留痕与开启时同形
        summary.repair.push([]);
        pendingRepair = [];
        return undefined;
      }
      let picks: MemoryPick[] = [];
      try {
        const loaded = loadEntries();
        const workspace = probeOf();
        // 单条命令的旧配置视为一步
        const steps: readonly VerifyStepResult[] = context.steps ?? [
          {
            name: LEGACY_VERIFY_STEP_NAME,
            exitCode: context.outcome.exitCode,
            verdict: context.outcome.verdict,
            output: context.outcome.output,
            truncated: context.outcome.truncated,
          },
        ];
        picks =
          options.fixed !== undefined
            ? phases.selectFixed(loaded, options.fixed.repair ?? [], workspace, check)
            : phases.selectRepair(
                loaded,
                failingFingerprints(steps, input.workspaceRoot),
                workspace,
                check
              );
      } catch (error) {
        report(error, `第 ${context.round} 轮回炉`);
        picks = [];
      }
      summary.repair.push(ids(picks));
      pendingRepair = ids(picks);
      const text = renderRepairAppendix(picks);
      return text === "" ? undefined : text;
    },
    takeRepairIds() {
      const taken = pendingRepair;
      pendingRepair = undefined;
      return taken;
    },
    summary: () => ({
      opening: [...summary.opening],
      repair: summary.repair.map((round) => [...round]),
    }),
  };
}
