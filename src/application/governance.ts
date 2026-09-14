// 工具调用治理（M5.5 S0，决策 049）：审批闸整族逻辑自 PiRuntimeAdapter 原样搬入 Controller 层，
// 零行为变化。M3 治理闭环：策略判定 → 人工审批 / 自动放行 → block + ToolExecution 账本 + 熔断
// （决策 1/2/4，spike S2a/S4/S5）；M4 S6 grant 求值排律；决策 1 证据链 intent / decision / receipt。
// 上游拦截（幽灵工具名 not-found / 已广告但参数校验失败）hook 不可见：上游 prepareToolCall
// 在 hook 前拦截，事件级连续计数熔断兜底（spikes/notfound-spike.mjs 实证 tool_execution_end 照常到达）。
import type { ApprovalHandler } from "../approvals/handler.ts";
import type {
  GovernanceHost,
  GovernanceRunOutcome,
  GovernanceVerdict,
  ToolCallProposal,
  ToolGovernance,
  ToolGovernanceFactory,
} from "../pi-runtime/governance.ts";
import type { ConfigGrantRule } from "../state/grants.ts";
import { newReceiptId } from "../state/ids.ts";
import { RECEIPT_VERSION, type Receipt } from "../state/receipt.ts";
import type { ToolSettledPayload } from "../state/runtime-events.ts";
import {
  advanceToolExecution,
  proposeToolExecution,
  recordDecision,
  type ToolExecution,
} from "../state/tool-execution.ts";
import { type GrantMatchOutcome, matchConfigGrants } from "../tools/grants.ts";
import { evaluateToolPolicy } from "../tools/policy.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { CommandInspection, ExecEvidence, ExecEvidenceTool } from "../tools/run-command.ts";
import type { ContentEvidence } from "../tools/wrap.ts";

// receipt 的 exec 证据：暂存证据去掉进程启动标记（它只用于 executed 判定）
function receiptExecOf(evidence: ExecEvidence): NonNullable<Receipt["exec"]> {
  const { spawned: _spawned, ...exec } = evidence;
  return exec;
}

// M4 S6（决策 3）：会话 grant 匹配注入面——approvals/grant-store.ts 的 SessionGrantStore
// 满足该结构；测试可注入假实现。match 纯求值（无副作用）；命中计数在放行实际生效后
// 调 noteEffectiveHit（deny 压过 grant 的求值不计命中——审计口径：命中 = 实际免审放行）
export interface SessionGrantMatcher {
  // context.needsShell（048 修订）：需 shell 的调用只被带 shell 标记的放权命中
  match(
    toolName: string,
    args: unknown,
    context?: { needsShell?: boolean }
  ): GrantMatchOutcome | null;
  noteEffectiveHit(outcome: GrantMatchOutcome): void;
}

export interface ToolGovernanceOptions {
  // M3：工具注册表（策略判定的 tier/元数据来源）；缺省 = 空注册表（一切工具调用 fail-closed）
  registry?: ToolRegistry;
  // M3：人工审批注入点（策略判定为 prompt 时调用）；缺省时 prompt 一律 fail-closed 拒绝
  approvalHandler?: ApprovalHandler;
  // M4 S6（决策 3）：会话 grant 存储——审批提示 [a]/[d] 键创建的放权由此注入求值；
  // 治理面运行时状态，不进 InjectionSnapshot（约束 4：grant 必须可撤销，与快照冻结矛盾）
  sessionGrants?: SessionGrantMatcher;
  // M4 S6（D6）：固化配置规则（.pigeon/grants.json，启动时装载、会话内冻结）；
  // 命中记 approvedBy=policy:config，intent 回指规则的 promotedFrom.grantId（收口决策 ①：稳定身份）
  configGrants?: readonly ConfigGrantRule[];
  // 目录限定匹配（pathPrefix）的 realpath 解析根；缺省 = 带 pathPrefix 的规则一律不匹配
  // （fail-closed 到人工审批——授权判定不猜）
  workspaceRoot?: string;
  // 熔断阈值：同一 工具名+参数指纹 在同一 Run 内被阻断的次数上限（spike S4：上游无循环护栏）
  circuitBreakerThreshold?: number;
}

// 装配根组装治理后交给 Adapter；Adapter 构造时绑定宿主能力，一个 Adapter 一份实例
export function createToolGovernance(options: ToolGovernanceOptions = {}): ToolGovernanceFactory {
  return (host) => new GovernedToolCalls(options, host);
}

class GovernedToolCalls implements ToolGovernance {
  readonly #host: GovernanceHost;
  // M3 治理件：注册表（策略判定元数据）/ 审批注入点 / 熔断阈值
  readonly #registry: ToolRegistry;
  readonly #breakerThreshold: number;
  readonly #approvalHandler: ApprovalHandler | undefined;
  // M4 S6（决策 3）：grant 求值件（会话 grant 匹配 + 固化配置规则 + 目录解析根）
  readonly #sessionGrants: SessionGrantMatcher | undefined;
  readonly #configGrants: readonly ConfigGrantRule[];
  readonly #workspaceRoot: string | undefined;
  // ToolExecution 账本：toolCallId → 记录
  readonly #executions = new Map<string, ToolExecution>();
  // key 带粒度前缀——`tool\n<名字>`：policy:deny 系绝对拒绝（deny 清单 / 无审批通道
  // fail-closed），参数改不改都照样拒，任何重试皆徒劳，按工具名计数；
  // `fingerprint\n<名字>\n<参数 JSON>`：人工拒绝与闸内异常，决策 1 鼓励模型改参重提，
  // 指纹级计数给修订循环留路（见 #blockWithBreaker 注释）。
  readonly #blockCounts = new Map<string, number>();
  // 上游拦截熔断（事件级）连击状态：toolName + 连续次数。两类拦截 hook 都不可见：
  //   ① 幽灵工具名（从未广告）：prepareToolCall 以 "Tool not found" 拦截（agent-loop.js:392-399）；
  //   ② 已广告但参数畸形：validateToolArguments 在 hook 前抛错（agent-loop.js:399-448）。
  // 两者审批闸/账本/#blockCounts 全部不可见；但 tool_execution_end 照常发出
  // （spikes/notfound-spike.mjs 实证：isError=true）。故判据取"settled 且 isError 且
  // 账本无此 toolCallId 记录"——无记录 ⟺ hook 从未运行 ⟺ 被上游拦截，一并兜底。
  #interceptedStreak = { toolName: "", count: 0 };
  // 本次 Run 的账本 toolCallId 序列（RunResult.toolExecutions 的选取依据）
  #runToolCallIds: string[] = [];
  // 本次 Run 是否发生过熔断落闸（D7 Run 级「治理熔断」子类的活侧判据；breaker 记录是冷侧判据）
  #breakerTripped = false;

  constructor(options: ToolGovernanceOptions, host: GovernanceHost) {
    this.#host = host;
    this.#registry = options.registry ?? new ToolRegistry();
    this.#approvalHandler = options.approvalHandler;
    this.#breakerThreshold = options.circuitBreakerThreshold ?? 3;
    // M4 S6（决策 3）：grant 求值件——会话 grant 优先于固化配置规则（排律第 3 档内次序）
    this.#sessionGrants = options.sessionGrants;
    this.#configGrants = options.configGrants ?? [];
    this.#workspaceRoot = options.workspaceRoot;
    // 广告了未在注册表登记的工具 = 配置错误，构造期 fail-fast
    for (const name of host.tools.keys()) {
      if (!this.#registry.has(name)) {
        throw new Error(`广告的工具未在注册表登记：${name}`);
      }
    }
  }

  beginRun(): void {
    this.#blockCounts.clear();
    this.#interceptedStreak.toolName = "";
    this.#interceptedStreak.count = 0;
    this.#breakerTripped = false;
    this.#runToolCallIds = [];
  }

  // 审批闸入口：自包 try/catch——spike 证明 hook 抛错上游会兜底降级，但那是
  // "错误文案反馈模型"，不是治理决定；账本/审批代码自身异常一律转为 block（fail-closed）
  async decide(call: ToolCallProposal): Promise<GovernanceVerdict> {
    try {
      return await this.#decideInner(call);
    } catch (error) {
      // fail-closed 语义不变（异常一律转 block），但阻断必须过熔断计数（P2-1b）：
      // 账本写盘持续失败 + 顽固模型 = 无限阻断循环。rawArgs 可能正是异常源
      // （structuredClone 失败），故取原始参数做指纹，由 #blockWithBreaker 兜底不抛
      return this.#blockWithBreaker(
        call.toolName,
        call.toolCallId,
        call.args,
        `审批闸内部异常（fail-closed 阻断）：${error instanceof Error ? error.message : String(error)}`,
        "fingerprint"
      );
    }
  }

  governs(toolCallId: string): boolean {
    return this.#executions.has(toolCallId);
  }

  // 账本联动：tool_execution_end 到达即 settled——被阻断者从 approval 落（决策已 rejected），
  // 执行完毕者从 execution 落；spike S1/S2a：无论放行与否 end 事件都保证到达。
  // 例外留痕：approved 但停在 approval = intent 写盘失败被 fail-closed 阻断（从未 dispatch），
  // 不迁移状态（审计可见的异常记录），也不产生 receipt。
  settle(settlement: ToolSettledPayload): void {
    // 账本联动隔离在独立 try/catch（P2-2）：receipt 写盘失败只进内部异常观察口，
    // 绝不让 settled 事件本体因此丢失（Adapter 侧事件落日志与转发无条件）
    try {
      const existing = this.#executions.get(settlement.toolCallId);
      if (
        existing !== undefined &&
        (existing.state === "execution" ||
          (existing.state === "approval" && existing.decision?.outcome === "rejected"))
      ) {
        const settled = advanceToolExecution(existing, "settled", Date.now());
        this.#executions.set(settlement.toolCallId, settled);
        this.#persistReceipt(settled, settlement.isError);
      }
    } catch (error) {
      this.#host.reportError(error);
    }
    this.#countUpstreamInterceptedAndMaybeBreak(settlement);
  }

  runOutcome(): GovernanceRunOutcome {
    return {
      breakerTripped: this.#breakerTripped,
      // 本次 Run 的账本记录终态快照（waitForIdle 之后所有 tool.settled 已处理，记录已定型）
      toolExecutions: structuredClone(
        this.#runToolCallIds
          .map((id) => this.#executions.get(id))
          .filter((record) => record !== undefined)
      ),
    };
  }

  toolExecutions(): ToolExecution[] {
    return structuredClone([...this.#executions.values()]);
  }

  async #decideInner(call: ToolCallProposal): Promise<GovernanceVerdict> {
    const { toolName, toolCallId } = call;
    // rawArgs 快照（spike S5）：账本留模型原始参数。决策 1 无改参通道，
    // 原始参数 = 批准参数 = 执行参数，无需写回 ctx.args。
    const rawArgs = structuredClone(call.args);
    const proposed = proposeToolExecution({ toolCallId, toolName, rawArgs, at: Date.now() });
    let record = advanceToolExecution(proposed, "approval", Date.now());
    this.#executions.set(toolCallId, record);
    this.#runToolCallIds.push(toolCallId);

    const policy = this.#host.policy;
    // 排律（决策 3）：deny 清单 → 会话 grant → 配置 grant → yolo → read 自动 → prompt——
    // 前二档收在 evaluateToolPolicy 内（deny 绝对优先，grant 不豁免）；grant 匹配在此注入：
    // 会话 grant 优先于固化配置规则。匹配纯求值不计命中，命中计数在放行实际生效后记
    // 048 修订：exec 工具只读判定这条命令是否需 shell——需 shell 时只有带 shell 标记的放权能免审
    const inspection = this.#inspectCommand(toolName, rawArgs);
    const needsShell = inspection?.needsShell === true;
    const grantHit =
      this.#sessionGrants?.match(toolName, rawArgs, { needsShell }) ??
      matchConfigGrants(this.#configGrants, this.#workspaceRoot, toolName, rawArgs, needsShell);
    const decision = evaluateToolPolicy(this.#registry, toolName, policy, grantHit ?? undefined);

    // deny 清单绝对 / 未注册 fail-closed：自动拒绝，不弹人工审批
    if (decision.kind === "deny") {
      record = recordDecision(record, {
        outcome: "rejected",
        approvedBy: "policy:deny",
        reason: decision.reason,
        decidedAt: Date.now(),
      });
      this.#executions.set(toolCallId, record);
      this.#persistDecision(record);
      return this.#blockWithBreaker(toolName, toolCallId, rawArgs, decision.reason, "tool");
    }

    // 自动放行：grant 命中（human:grant / policy:config，回指出处）> yolo 批发授权
    // （policy:yolo）> prompt 模式下 read 层（policy:auto）。
    // sequential 模式下 hook 放行即进入执行（上游无独立 execution-start 事件），
    // 故 dispatch/execution 两个时间戳在放行时一并盖章
    if (decision.kind === "auto-allow") {
      const grant = decision.grant;
      const approvedBy =
        grant?.source === "session-grant"
          ? "human:grant"
          : grant?.source === "config-rule"
            ? "policy:config"
            : policy.approvalMode === "yolo"
              ? "policy:yolo"
              : "policy:auto";
      record = recordDecision(record, {
        outcome: "approved",
        approvedBy,
        // 每次免审放行回指具体 grant/配置条目（决策 3）：可审计"这次写操作凭什么没问人"
        ...(grant !== undefined ? { grantRef: { kind: grant.source, id: grant.refId } } : {}),
        decidedAt: Date.now(),
      });
      // 决策 1 证据链分层（M4 S6 G）：读层调用只留事件级记录——无副作用，intent/receipt
      // 级持久化冗余；写/exec 层维持 §3.2 三族齐全（intent 写盘失败 = fail-closed 不放行）
      if (this.#registry.get(toolName)?.tier !== "read") {
        await this.#persistIntent(record);
      }
      if (grant !== undefined) {
        this.#sessionGrants?.noteEffectiveHit(grant);
      }
      // 需 shell 的命令到这里只有两种放行：带 shell 标记的放权（人确认过这条一模一样的命令）或 yolo（004）
      this.#authorizeShell(toolName, toolCallId, needsShell);
      record = advanceToolExecution(record, "dispatch", Date.now());
      record = advanceToolExecution(record, "execution", Date.now());
      this.#executions.set(toolCallId, record);
      return { kind: "allow" };
    }

    // prompt：必须人工批准；未配置审批通道 = fail-closed 拒绝
    if (this.#approvalHandler === undefined) {
      record = recordDecision(record, {
        outcome: "rejected",
        approvedBy: "policy:deny",
        reason: "策略要求人工审批但未配置审批通道（fail-closed）",
        decidedAt: Date.now(),
      });
      this.#executions.set(toolCallId, record);
      this.#persistDecision(record);
      return this.#blockWithBreaker(
        toolName,
        toolCallId,
        rawArgs,
        "策略要求人工审批但未配置审批通道",
        "tool"
      );
    }
    const tier = this.#registry.get(toolName)?.tier;
    // 写工具的 diff 预览：工具有 preview 能力就带上；预览失败不阻断审批（审批仍可看参数）
    let diffPreview: string | undefined;
    const tool = this.#host.tools.get(toolName);
    if (tool !== undefined && "preview" in tool && typeof tool.preview === "function") {
      try {
        diffPreview = await tool.preview(call.preparedArgs);
      } catch {
        diffPreview = undefined;
      }
    }
    const approval = await this.#approvalHandler({
      toolName,
      toolCallId,
      args: rawArgs,
      ...(diffPreview !== undefined ? { diffPreview } : {}),
      // M5.5 S5（决策 048）：风险分层——exec 档的 [a] 收窄为这条一模一样的命令
      ...(tier !== undefined ? { tier } : {}),
      // 048 修订：面板原样显示将执行的命令串，需 shell 时标明
      ...(inspection !== undefined ? { command: inspection.command, needsShell } : {}),
      // 出处 run：审批提示创建 grant（[a]/[d]）时写入 grant.created 事件
      runId: this.#host.activeRunId(),
    });
    if (!approval.approved) {
      const reason = approval.reason ?? "人工拒绝";
      record = recordDecision(record, {
        outcome: "rejected",
        approvedBy: "human",
        reason,
        decidedAt: Date.now(),
      });
      this.#executions.set(toolCallId, record);
      this.#persistDecision(record);
      return this.#blockWithBreaker(toolName, toolCallId, rawArgs, reason, "fingerprint");
    }
    record = recordDecision(record, {
      outcome: "approved",
      approvedBy: "human",
      ...(approval.reason !== undefined ? { reason: approval.reason } : {}),
      decidedAt: Date.now(),
    });
    // ROADMAP §3.2：dispatch 前先持久化意图；写盘失败 = fail-closed（异常由外层转 block）
    await this.#persistIntent(record);
    // 人在面板上看到了原样命令串与"经 shell"并批准
    this.#authorizeShell(toolName, toolCallId, needsShell);
    record = advanceToolExecution(record, "dispatch", Date.now());
    record = advanceToolExecution(record, "execution", Date.now());
    this.#executions.set(toolCallId, record);
    return { kind: "allow" };
  }

  // exec 工具的只读命令检查（048 修订）；工具无此能力或检查失败返回 undefined（参数问题由执行时的校验报出）
  #inspectCommand(toolName: string, args: unknown): CommandInspection | undefined {
    const tool = this.#host.tools.get(toolName);
    if (
      tool === undefined ||
      !("inspectCommand" in tool) ||
      typeof tool.inspectCommand !== "function"
    ) {
      return undefined;
    }
    try {
      return (tool as unknown as ExecEvidenceTool).inspectCommand(args);
    } catch {
      return undefined;
    }
  }

  // 放行一条需 shell 的命令：按调用授予工具 shell 确认，一次一用
  #authorizeShell(toolName: string, toolCallId: string, needsShell: boolean): void {
    if (!needsShell) {
      return;
    }
    const tool = this.#host.tools.get(toolName);
    if (
      tool !== undefined &&
      "authorizeShell" in tool &&
      typeof tool.authorizeShell === "function"
    ) {
      (tool as unknown as ExecEvidenceTool).authorizeShell(toolCallId);
    }
  }

  // dispatch 前持久化调用意图（ROADMAP §3.2）。写盘失败向上抛——外层 catch 转成 block，
  // 即 fail-closed：事件日志写不进就不放行，未留证的副作用一律不得发生。
  // M4 S2（D5）：写工具 intent 携带内容哈希三元组（工具探针零副作用算出改前/预期改后）；
  // 探针无能力或失败 → 字段缺省，该悬账冷恢复时降级为人工对账，不阻断审批流
  async #persistIntent(record: ToolExecution): Promise<void> {
    const eventLog = this.#host.eventLog;
    if (eventLog === undefined) {
      return;
    }
    const decision = record.decision;
    if (decision === undefined) {
      throw new Error("账本 intent 缺失决定快照");
    }
    let contentHashes: ContentEvidence | null = null;
    const tool = this.#host.tools.get(record.toolName);
    if (
      this.#registry.get(record.toolName)?.tier === "write" &&
      tool !== undefined &&
      "probeContentEvidence" in tool &&
      typeof tool.probeContentEvidence === "function"
    ) {
      try {
        contentHashes = await tool.probeContentEvidence(record.rawArgs);
      } catch {
        contentHashes = null;
      }
    }
    eventLog.appendIntent({
      executionId: record.executionId,
      toolCallId: record.toolCallId,
      toolName: record.toolName,
      rawArgs: record.rawArgs,
      decision,
      ...(contentHashes != null ? { contentHashes } : {}),
      at: Date.now(),
      runId: this.#host.activeRunId(),
    });
  }

  // 拒绝决定落盘（决策 4 证据链：拒绝理由必须在场，进程退出后不蒸发）。
  // 失败语义：调用已被阻断（副作用已防住），写盘失败不得改变结果——故自包 catch 进
  // 内部异常观察口，而非上抛让外层 catch 把逐字拒绝理由换成内部异常文案
  #persistDecision(record: ToolExecution): void {
    const eventLog = this.#host.eventLog;
    if (eventLog === undefined) {
      return;
    }
    const decision = record.decision;
    if (decision === undefined) {
      throw new Error("账本 decision 缺失决定快照");
    }
    try {
      eventLog.appendDecision({
        executionId: record.executionId,
        toolCallId: record.toolCallId,
        toolName: record.toolName,
        rawArgs: record.rawArgs,
        decision,
        at: Date.now(),
        runId: this.#host.activeRunId(),
      });
    } catch (error) {
      this.#host.reportError(error);
    }
  }

  // tool_execution_end 后写 Receipt 并回填 receiptId（三层关联 executionId/toolCallId/receiptId）。
  // executed 判据：到达 execution 阶段且执行结果无错误。M3 两个自建工具的唯一副作用都在
  // 最后一次写盘调用（edit_file 全部预检通过才落盘），故"执行过且无错"≡副作用发生；
  // 阻断/拒绝路径 executionStartedAt 为空 → executed=false（副作用从未发生）。
  // 崩溃点：进程死于 end 事件前则 receipt 永不落盘——approved 路径冷启动 reconcile 报
  // OutcomeUnknown；rejected 路径已有 decision 行闭环，归 rejected 不入 unknown。
  #persistReceipt(record: ToolExecution, isError: boolean): void {
    const eventLog = this.#host.eventLog;
    if (eventLog === undefined) {
      return;
    }
    // 决策 1 证据链分层（M4 S6 G）：读层调用只留事件级记录——receipt 不落盘
    // （无副作用可对账；内存账本与事件流仍完整）
    if (this.#registry.get(record.toolName)?.tier === "read") {
      return;
    }
    const decision = record.decision;
    if (decision === undefined) {
      return;
    }
    // M5.5 S5（决策 048）：exec 工具的执行证据（命令、退出码、输出哈希与截断输出、文件清单差异），
    // 取一次即删；取证失败只让字段缺省，不改变 receipt 落盘
    let exec: ExecEvidence | undefined;
    const execTool = this.#host.tools.get(record.toolName);
    if (
      execTool !== undefined &&
      "takeExecEvidence" in execTool &&
      typeof execTool.takeExecEvidence === "function"
    ) {
      try {
        exec = (execTool as unknown as ExecEvidenceTool).takeExecEvidence(record.toolCallId);
      } catch {
        exec = undefined;
      }
    }
    // exec 工具出错时进程可能已经跑过（超时终止、被中止）：进程启动过即按副作用可能发生记
    const executed =
      record.executionStartedAt !== undefined && (!isError || exec?.spawned === true);
    // M4 S2（D5）：执行成功且工具具备内容证据能力时，实测目标现状哈希随 receipt 落盘
    // （实测而非采信工具自报，撕裂写会在冷恢复三方比对中现形）；测不得则缺省
    let contentAfterHash: string | null = null;
    if (executed) {
      const tool = this.#host.tools.get(record.toolName);
      if (
        tool !== undefined &&
        "hashContentTarget" in tool &&
        typeof tool.hashContentTarget === "function"
      ) {
        try {
          contentAfterHash = tool.hashContentTarget(record.rawArgs);
        } catch {
          contentAfterHash = null;
        }
      }
    }
    const receipt: Receipt = {
      version: RECEIPT_VERSION,
      id: newReceiptId(),
      executionId: record.executionId,
      toolCallId: record.toolCallId,
      approvedBy: decision.approvedBy,
      executed,
      isError,
      startedAt: record.executionStartedAt ?? record.proposedAt,
      finishedAt: record.settledAt ?? Date.now(),
      summary: executed
        ? `${record.toolName} 执行完成${exec !== undefined ? `（退出码 ${exec.exitCode ?? "无"}${exec.timedOut ? "，超时终止" : ""}）` : ""}`
        : `${record.toolName} 未产生副作用（${decision.outcome === "rejected" ? "已拒绝" : "执行出错"}）`,
      ...(contentAfterHash !== null ? { contentAfterHash } : {}),
      ...(exec !== undefined ? { exec: receiptExecOf(exec) } : {}),
    };
    eventLog.appendReceipt({ receipt, runId: this.#host.activeRunId() });
    // settled 后回填 receiptId：schema 允许的回填，不是状态迁移
    this.#executions.set(record.toolCallId, { ...record, receiptId: receipt.id });
  }

  // 阻断 + 熔断（spike S4：上游无循环护栏，模型可无限重发被拦调用）。
  // 计数粒度按拒绝性质不对称（P2-1c 裁决）：
  //   - "tool"：policy:deny 系绝对拒绝（deny 清单 / 无审批通道 fail-closed）——
  //     参数改不改都照样拒，任何重试皆徒劳，按工具名计数，参数微变不能重置连击；
  //   - "fingerprint"：人工拒绝与闸内异常——决策 1 鼓励模型改参数重提，
  //     按 工具名+参数指纹 计数，改参后的重提不累积（修订循环是期望行为）。
  // 同一 Run 内同一粒度 key 计数达阈值即中止整个 Run。
  // 取舍：选 abort 而非 terminate:true——terminate 只在"批次内全部 result 都 terminate"
  // 时停批次，且终态 stopReason 停在 toolUse（无"已熔断"语义）；abort 的终态是明确的 aborted。
  // 代价：abort 后本次 block 的 reason 被上游覆盖为 "Operation aborted"（agent-loop.js:410-416）。
  #blockWithBreaker(
    toolName: string,
    toolCallId: string,
    rawArgs: unknown,
    reason: string,
    scope: "tool" | "fingerprint"
  ): GovernanceVerdict {
    // 畸形参数（循环引用等）序列化会抛：退化为固定串并入同一指纹桶——
    // 宁可按工具名合并计数，也不让熔断因异常参数失效
    let argsKey: string;
    try {
      argsKey = JSON.stringify(rawArgs) ?? "";
    } catch {
      argsKey = "<unserializable>";
    }
    const key = scope === "tool" ? `tool\n${toolName}` : `fingerprint\n${toolName}\n${argsKey}`;
    const count = (this.#blockCounts.get(key) ?? 0) + 1;
    this.#blockCounts.set(key, count);
    if (count >= this.#breakerThreshold) {
      this.#breakerTripped = true;
      this.#persistBreaker({
        toolName,
        toolCallId,
        scope,
        count,
        threshold: this.#breakerThreshold,
      });
      this.#host.abort();
    }
    return { kind: "block", reason };
  }

  // 熔断落闸留证（M4 S2，D7「治理熔断」判据行）：落闸决定已生效（abort 不可逆），
  // 写盘失败只进内部异常观察口，绝不改变熔断行为
  #persistBreaker(input: {
    toolName: string;
    toolCallId: string;
    scope: "tool" | "fingerprint" | "intercepted";
    count: number;
    threshold: number;
  }): void {
    const eventLog = this.#host.eventLog;
    if (eventLog === undefined) {
      return;
    }
    try {
      eventLog.appendBreaker({ ...input, at: Date.now(), runId: this.#host.activeRunId() });
    } catch (error) {
      this.#host.reportError(error);
    }
  }

  // 上游拦截熔断（事件级）：覆盖两类 beforeToolCall 之前的上游拦截——
  //   ① 幽灵工具名（从未广告）：prepareToolCall 以 "Tool <name> not found" 拦截
  //      （agent-loop.js:392-399，spikes/notfound-spike.mjs 实证 end 事件照常到达）；
  //   ② 已广告但参数畸形：validateToolArguments 在 hook 前抛错 → immediate error result
  //      （agent-loop.js:399-448，sequential 执行器对 immediate 结果照常发 start/end）。
  // 判据：settled 且 isError 且 账本无此 toolCallId 记录——无记录 ⟺ hook 从未运行 ⟺
  // 被上游拦截；它同时吞并原"toolName 不在广告集"判据（幽灵调用 hook 同样未运行）。
  // 同一工具名连续达阈值即 abort（与 hook 级熔断共用 #breakerThreshold）；
  // 任何 hook 跑过的 settled（含执行出错）或非错误 settled 重置连击。
  // 审计留痕：此路径 hook 从未运行，不可能有 ToolExecution 账本记录；
  // 事件日志里的 tool.proposed/tool.settled 序列即为拦截循环的审计轨迹。
  #countUpstreamInterceptedAndMaybeBreak(payload: ToolSettledPayload): void {
    if (payload.isError && !this.#executions.has(payload.toolCallId)) {
      if (this.#interceptedStreak.toolName === payload.toolName) {
        this.#interceptedStreak.count += 1;
      } else {
        this.#interceptedStreak.toolName = payload.toolName;
        this.#interceptedStreak.count = 1;
      }
      if (this.#interceptedStreak.count >= this.#breakerThreshold) {
        this.#breakerTripped = true;
        this.#persistBreaker({
          toolName: payload.toolName,
          toolCallId: payload.toolCallId,
          scope: "intercepted",
          count: this.#interceptedStreak.count,
          threshold: this.#breakerThreshold,
        });
        this.#host.abort();
      }
    } else {
      this.#interceptedStreak.toolName = "";
      this.#interceptedStreak.count = 0;
    }
  }
}
