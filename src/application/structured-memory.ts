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
  FixedSelectionError,
  failingFingerprints,
  type MemoryPick,
  type MemorySelection,
  type RenderedMemory,
  renderOpeningSection,
  renderRepairAppendix,
  StructuredMemoryBudgetError,
  selectFixed,
  selectOpening,
  selectRepair,
} from "../memory/structured-select.ts";
import {
  buildMemoryEntries,
  loadStructuredMemory,
  type MemoryEntry,
  StructuredMemoryCacheError,
} from "../memory/structured-store.ts";
import {
  hostWorkspaceAccess,
  localWorkspaceAccess,
  StructuredMemoryGitTimeoutError,
  taskReferencedFiles,
  type WorkspaceProbe,
  workspaceProbe,
} from "../memory/structured-workspace.ts";
import type { SessionId } from "../state/ids.ts";
import type {
  StructuredMemoryManifest,
  StructuredMemorySelection,
} from "../state/injection-manifest.ts";
import type { FrictionFact } from "../state/structured-memory.ts";
import { describeFingerprint } from "../state/verify-fingerprint.ts";
import { LEGACY_VERIFY_STEP_NAME, type VerifyStepResult } from "../state/verify-steps.ts";
import type { WorkspaceHost } from "../tools/workspace-host.ts";
import type { RepairAppendix } from "./repair-loop.ts";

// 可替换的阶段实现（测试以抛错的实现模拟各类故障）
export interface StructuredMemoryPhases {
  // 派生（含缓存读写）：全部以往会话的摩擦事实
  load(governanceRoot: string): FrictionFact[];
  // 挑选
  selectOpening: typeof selectOpening;
  selectRepair: typeof selectRepair;
  selectFixed: typeof selectFixed;
  // 工作区探针（改名追踪、改动幅度、受跟踪文件）
  probe: (root: string) => WorkspaceProbe;
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
  // 开关状态（区分"关闭"与"开启但一条没给"）
  enabled: boolean;
  opening: string[];
  // 开局挑出来、但用前核验没过而被拦下的
  openingBlocked: string[];
  // 每轮回炉给了哪几条、被拦下哪几条（按轮次）
  repair: string[][];
  repairBlocked: string[][];
}

// 一轮回炉交给下一个 Run 的 run.started 的留痕
export interface RepairHandoff {
  given: string[];
  blocked: string[];
}

const NOTHING: MemorySelection = { picks: [], blocked: [] };

export interface StructuredMemoryPush {
  opening(task: string | undefined): StructuredMemoryOpening;
  // 回炉附加内容：挑选并成文，同时把这一轮给的条目登记给下一个 Run 的 run.started
  repairAppendix: RepairAppendix;
  // 下一个 Run 开始时取走这一轮回炉给的条目（只取一次）
  takeRepairIds(): RepairHandoff | undefined;
  summary(): StructuredMemorySummary;
}

// pigeon memory list（只读）：列出当前项目的记忆条目——锚点、指纹、次数、来源会话，另附此刻的用前核验结果。
// 从账本现算、不回写缓存，不写账本与工作区
export interface StructuredMemoryListing {
  id: string;
  anchor: string;
  kind: "regression";
  step: string;
  fingerprint: string;
  names: string[];
  count: number;
  sessions: string[];
  lastAt: number;
  check: { ok: boolean; reason?: string };
}

export function listStructuredMemory(governanceRoot: string): StructuredMemoryListing[] {
  const entries = buildMemoryEntries(
    loadStructuredMemory(governanceRoot, { persist: false }).facts
  );
  const probe = workspaceProbe(governanceRoot);
  return entries.map((entry) => {
    const result = checkEntry(entry, probe);
    return {
      id: entry.id,
      anchor: entry.anchor,
      kind: entry.kind,
      step: entry.stepName,
      fingerprint: describeFingerprint(entry.fingerprint),
      names: [...entry.fingerprint.names],
      count: entry.count,
      sessions: [...entry.sessions],
      lastAt: entry.latest.at,
      check: { ok: result.ok, ...(result.reason !== undefined ? { reason: result.reason } : {}) },
    };
  });
}

export function renderStructuredMemoryList(listing: readonly StructuredMemoryListing[]): string {
  if (listing.length === 0) {
    return "本项目还没有结构化记忆。\n";
  }
  const lines = listing.map(
    (item) =>
      `${item.id} ｜ 锚点 ${item.anchor} ｜ 红转绿 ｜ ` +
      `「${item.step}」${item.fingerprint}${item.names.length > 0 ? `（${item.names.join("、")}）` : ""} ｜ ` +
      `${item.count} 次 ｜ 最近 ${new Date(item.lastAt).toISOString()} ｜ 来源会话 ${item.sessions.join("、")} ｜ ` +
      `核验${item.check.ok ? "通过" : `不过：${item.check.reason ?? ""}`}`
  );
  return `${lines.join("\n")}\n共 ${listing.length} 条\n`;
}

const DEFAULT_PHASES: StructuredMemoryPhases = {
  load: (governanceRoot) => loadStructuredMemory(governanceRoot).facts,
  selectOpening,
  selectRepair,
  selectFixed,
  check: checkEntry,
  probe: workspaceProbe,
};

type FaultPhase = "派生" | "缓存读写" | "挑选" | "核验" | "工作区 git 超时";

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

// 工作区在执行端另一侧（容器）时：探针、派生里的工作区查询与核验都经执行端在容器里做。以往会话的验证记录里记的工作区
// 是执行端的工作区根（同一作业的各步共用一个容器），据此认出经执行端访问
function hostPhases(host: WorkspaceHost): Pick<StructuredMemoryPhases, "load" | "probe"> {
  const access = hostWorkspaceAccess(host);
  return {
    load: (governanceRoot) =>
      loadStructuredMemory(governanceRoot, {
        accessFor: (workspace) =>
          workspace === host.root ? access : localWorkspaceAccess(workspace),
      }).facts,
    probe: () => access.probe(),
  };
}

export function createStructuredMemoryPush(input: {
  governanceRoot: string;
  workspaceRoot: string;
  // 工作区在执行端另一侧（容器）时给出；workspaceRoot 此时只是宿主侧占位目录
  workspaceHost?: WorkspaceHost;
  sessionId: SessionId;
  options: StructuredMemoryOptions;
}): StructuredMemoryPush {
  const { options } = input;
  const enabled = options.enabled ?? true;
  const phases: StructuredMemoryPhases = {
    ...DEFAULT_PHASES,
    ...(input.workspaceHost?.runSync !== undefined ? hostPhases(input.workspaceHost) : {}),
    ...options.phases,
  };
  // 报错里的路径相对哪里：容器工作区为执行端的工作区根
  const workspaceRoot = input.workspaceHost?.root ?? input.workspaceRoot;
  const selection: StructuredMemorySelection = options.fixed !== undefined ? "fixed" : "auto";
  const warn = options.warn ?? stderrWarn;
  const warned = new Set<FaultPhase>();
  const summary: StructuredMemorySummary = {
    enabled,
    opening: [],
    openingBlocked: [],
    repair: [],
    repairBlocked: [],
  };
  let pendingRepair: RepairHandoff | undefined;
  let entries: MemoryEntry[] | undefined;
  let probe: WorkspaceProbe | undefined;

  const report = (error: unknown, when: string): void => {
    // git 超时不论出在哪个阶段都算同一类（探针锁定后各处都会抛同一个超时错误）
    const cause = error instanceof PhaseError ? error.cause : error;
    const phase: FaultPhase =
      cause instanceof StructuredMemoryGitTimeoutError
        ? "工作区 git 超时"
        : error instanceof PhaseError
          ? error.phase
          : "挑选";
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

  // 以往会话的记忆条目（当前会话的事实不参与）；首次用到时加载。加载失败即本次运行内不再重试（避免每轮回炉
  // 都同步阻塞、吃掉墙钟预算），后续各处直接不给
  let loadFailure: PhaseError | undefined;
  const loadEntries = (): MemoryEntry[] => {
    if (entries !== undefined) {
      return entries;
    }
    if (loadFailure !== undefined) {
      throw loadFailure;
    }
    let facts: FrictionFact[];
    try {
      facts = phases.load(input.governanceRoot);
    } catch (error) {
      loadFailure = new PhaseError(
        error instanceof StructuredMemoryCacheError ? "缓存读写" : "派生",
        error
      );
      throw loadFailure;
    }
    entries = buildMemoryEntries(facts.filter((fact) => fact.sessionId !== input.sessionId));
    return entries;
  };
  const probeOf = (): WorkspaceProbe => {
    probe ??= phases.probe(workspaceRoot);
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
      const manifest = (
        given: readonly MemoryPick[],
        blocked: readonly string[]
      ): StructuredMemoryManifest => ({
        enabled,
        selection,
        opening: ids(given),
        ...(blocked.length > 0 ? { openingBlocked: [...blocked] } : {}),
      });
      if (!enabled) {
        return { section: "", manifest: manifest([], []) };
      }
      try {
        const loaded = loadEntries();
        if (options.fixed !== undefined) {
          // 固定挑选开局时一次核对（含回炉那一组）：编号不存在、或成文后超出字符预算，即调用方配置有误，响亮失败
          const byId = new Map(loaded.map((entry) => [entry.id, entry]));
          const unknown = [
            ...(options.fixed.opening ?? []),
            ...(options.fixed.repair ?? []),
          ].filter((id) => !byId.has(id));
          if (unknown.length > 0) {
            throw new FixedSelectionError(
              `固定挑选指定的记忆条目不存在：${[...new Set(unknown)].join("、")}`
            );
          }
          const picksOf = (list: readonly string[] | undefined): MemoryPick[] =>
            [...new Set(list ?? [])].map((id) => ({
              entry: byId.get(id) as MemoryEntry,
              changedLines: 0,
            }));
          renderOpeningSection(picksOf(options.fixed.opening), { strict: true });
          renderRepairAppendix(picksOf(options.fixed.repair), { strict: true });
        }
        const workspace = probeOf();
        const chosen =
          options.fixed !== undefined
            ? phases.selectFixed(loaded, options.fixed.opening ?? [], workspace, check)
            : task === undefined
              ? NOTHING
              : phases.selectOpening(
                  loaded,
                  taskReferencedFiles(task, workspace),
                  workspace,
                  check
                );
        const rendered = renderOpeningSection(chosen.picks, {
          strict: options.fixed !== undefined,
        });
        summary.opening = ids(rendered.given);
        summary.openingBlocked = [...chosen.blocked];
        return { section: rendered.text, manifest: manifest(rendered.given, chosen.blocked) };
      } catch (error) {
        if (error instanceof FixedSelectionError || error instanceof StructuredMemoryBudgetError) {
          throw error;
        }
        report(error, "本次开局");
        return { section: "", manifest: manifest([], []) };
      }
    },
    repairAppendix(context) {
      if (!enabled) {
        // 关闭时每轮都记"一条也没给"，留痕与开启时同形
        summary.repair.push([]);
        summary.repairBlocked.push([]);
        pendingRepair = { given: [], blocked: [] };
        return undefined;
      }
      let chosen: MemorySelection = NOTHING;
      let rendered: RenderedMemory = { text: "", given: [] };
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
        chosen =
          options.fixed !== undefined
            ? phases.selectFixed(loaded, options.fixed.repair ?? [], workspace, check)
            : phases.selectRepair(
                loaded,
                failingFingerprints(steps, workspaceRoot),
                workspace,
                check
              );
        // 成文也在兜底之内：事实字段损坏导致成文出错时，这一轮一条不给
        rendered = renderRepairAppendix(chosen.picks, { strict: options.fixed !== undefined });
      } catch (error) {
        report(error, `第 ${context.round} 轮回炉`);
        chosen = NOTHING;
        rendered = { text: "", given: [] };
      }
      summary.repair.push(ids(rendered.given));
      summary.repairBlocked.push([...chosen.blocked]);
      pendingRepair = { given: ids(rendered.given), blocked: [...chosen.blocked] };
      return rendered.text === "" ? undefined : rendered.text;
    },
    takeRepairIds() {
      const taken = pendingRepair;
      pendingRepair = undefined;
      return taken;
    },
    summary: () => ({
      enabled,
      opening: [...summary.opening],
      openingBlocked: [...summary.openingBlocked],
      repair: summary.repair.map((round) => [...round]),
      repairBlocked: summary.repairBlocked.map((round) => [...round]),
    }),
  };
}
