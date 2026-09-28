// 会话 grant 存储（M4 S6，决策 3 + 3b）：审批提示 [a]/[d] 键创建的会话级放权的运行态。
// 运行态以本存储为准，持久态是会话存储里的授权建立与撤销条目；
// 不进 InjectionSnapshot（约束 4：grant 必须可撤销，与快照冻结矛盾）。匹配语义复用
// tools/grants.ts（与固化规则同一判定）。
// M5.5 S5（决策 048 及其修订）：exec 档放权带 command——只匹配这条一模一样的命令串；带 shell 标记的才能免审
// 一条需 shell 的命令。

import type { ActiveGrant } from "../state/grants.ts";
import { asGrantId, type GrantId, newGrantId, type RunId } from "../state/ids.ts";
import type { GrantCreatedInput, GrantRevokedInput } from "../state/session-payloads.ts";
import { type GrantMatchOutcome, scopeMatches } from "../tools/grants.ts";

// 会话 grant 的运行态视图：命中次数是进程内派生计数（/grants 展示面，不落盘）
export interface SessionGrantView extends ActiveGrant {
  hitCount: number;
}

export class GrantNotFoundError extends Error {}

// 授权建立与撤销的落盘口（装配根接到会话存储；返回值无关——落盘副作用才是契约）
type GrantEventSink = {
  appendGrantCreated(input: GrantCreatedInput): unknown;
  appendGrantRevoked(input: GrantRevokedInput): unknown;
};

export interface SessionGrantStoreOptions {
  // 目录限定匹配的 realpath 解析根
  workspaceRoot: string;
  // 授权建立与撤销的落盘口；缺省 = 纯内存（不留持久痕迹）
  sink?: GrantEventSink;
  // 冷恢复种子（决策 3b）：会话存储里生效授权的还原——崩溃后会话
  // grant 静默继续有效，恢复屏不加确认环节（用户裁决：重复确认是纯摩擦）
  restored?: readonly ActiveGrant[] | undefined;
}

export class SessionGrantStore {
  readonly #workspaceRoot: string;
  readonly #sink: GrantEventSink | undefined;
  readonly #grants = new Map<GrantId, SessionGrantView>();

  constructor(options: SessionGrantStoreOptions) {
    this.#workspaceRoot = options.workspaceRoot;
    this.#sink = options.sink;
    for (const grant of options.restored ?? []) {
      this.#grants.set(grant.grantId, { ...grant, hitCount: 0 });
    }
  }

  // 审批提示 [a]/[d] 键触发：先交给落盘口再入运行态（落盘口抛错则 grant 不生效）
  create(input: {
    tool: string;
    pathPrefix?: string;
    command?: string;
    shell?: boolean;
    firstCall: { toolCallId: string; args: unknown };
    runId?: RunId;
  }): SessionGrantView {
    const grantId = newGrantId();
    const createdAt = Date.now();
    const scope = {
      ...(input.pathPrefix !== undefined ? { pathPrefix: input.pathPrefix } : {}),
      ...(input.command !== undefined ? { command: input.command } : {}),
      ...(input.shell === true ? { shell: true } : {}),
    };
    this.#sink?.appendGrantCreated({
      grantId,
      tool: input.tool,
      ...scope,
      createdAt,
      firstCall: input.firstCall,
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
    });
    const grant: SessionGrantView = {
      grantId,
      tool: input.tool,
      ...scope,
      createdAt,
      firstCall: input.firstCall,
      hitCount: 0,
    };
    this.#grants.set(grantId, grant);
    return grant;
  }

  // /revoke <id>：先交给落盘口再从运行态删除——撤销立即生效（免审停止）；未知 id 响亮报错
  revoke(grantId: GrantId, runId?: RunId): void {
    if (!this.#grants.has(grantId)) {
      throw new GrantNotFoundError(`grant 不存在或已撤销：${grantId}`);
    }
    this.#sink?.appendGrantRevoked({
      grantId,
      revokedAt: Date.now(),
      ...(runId !== undefined ? { runId } : {}),
    });
    this.#grants.delete(grantId);
  }

  // 纯求值（无副作用）：命中计数由 noteEffectiveHit 在放行实际生效后单独记——
  // deny 压过 grant 时不计命中（审计口径：命中 = 实际免审放行）
  match(
    toolName: string,
    args: unknown,
    context: { needsShell?: boolean } = {}
  ): GrantMatchOutcome | null {
    for (const grant of this.#grants.values()) {
      if (
        scopeMatches(
          this.#workspaceRoot,
          grant.tool,
          grant.pathPrefix,
          toolName,
          args,
          grant.command,
          grant.shell,
          context.needsShell
        )
      ) {
        return { source: "session-grant", refId: grant.grantId };
      }
    }
    return null;
  }

  // 放行生效后的命中留痕（adapter 在 decision.grant 成立时调用）
  noteEffectiveHit(outcome: GrantMatchOutcome): void {
    if (outcome.source !== "session-grant") {
      return;
    }
    const grant = this.#grants.get(asGrantId(outcome.refId));
    if (grant !== undefined) {
      grant.hitCount += 1;
    }
  }

  // 生效 grant 快照（/grants 展示）
  list(): SessionGrantView[] {
    return [...this.#grants.values()];
  }

  get(grantId: GrantId): SessionGrantView | undefined {
    return this.#grants.get(grantId);
  }
}
