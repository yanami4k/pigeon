// TUI 审批面板 handler（M2 S3；ROADMAP §M2：审批四键作为同一治理状态的投影继承，
// 零新增治理语义）。与 cli/approval-ui.ts 同一治理语义、同一措辞口径：
// 四键 [y/n/a/d]；审批动作集只有批准/拒绝（决策 001，无"人工改参数"）；[a]/[d] 经
// SessionGrantStore 创建会话 grant（store.create fail-closed：grant.created 事件写盘
// 失败则 grant 不生效，异常上抛由审批闸转阻断）；[d] 仅限 args.path 可定位目录的调用
//（决策 3a；无 path 时提示不提供该键，仍按下则与 cli 版同语义退化为工具级，同 [a]）。
// M5.5 S5（决策 048 及其修订）：exec 档原样显示将执行的命令串，需 shell 时标明；[a] 收窄为这条一模一样的命令串
// （需 shell 的带 shell 标记），不提供 [d]。
// 决策 290：网络档（web_fetch）显示将访问的网站，[a] 为"以后都允许访问该网站"（按主机名放权），不提供 [d]。
//
// 面板交互语义（决策 029）：
// - ApprovalHandler 是异步函数（M2 开工 5a 第 2 件）：面板把 Promise 挂起，
//   addInputListener 接管四键，按键 resolve；接口形状不动。
// - 面板期间普通输入忽略（简单语义）：除四键外一律吞掉——不进输入缓冲、不提交、不回显。
// - 无墙钟审批超时（与 cli 版一致：等人是审批语义本身）；取消路径一律 fail-closed
//   按拒绝处理、理由逐字回模型（决策 001 的自我修正闭环不断）：壳停止
//   （APPROVAL_CANCEL_CLOSED）、面板未装配（APPROVAL_CANCEL_DETACHED）、并发审批防御
//   （APPROVAL_CANCEL_BUSY）。
// - [n] 单按即拒绝、不带理由：reason 缺省，由治理层落默认文案「人工拒绝」并记为系统默认。
// - [r]（决策 066）：拒绝并说明——打开理由行（Esc 回面板不算拒绝，回车提交），理由逐字回模型
//   并在决定记录里记为人写。
import {
  approvalSourceLine,
  approvalVerdict,
  workerGrantScopeNote,
} from "../application/format.ts";
import type { SessionGrantStore } from "../approvals/grant-store.ts";
import {
  type ApprovalDecision,
  type ApprovalHandler,
  type ApprovalRequest,
  commandScopeNote,
  execCommandLine,
  execGrantKeyLabel,
  grantScopeFor,
  hostGrantKeyLabel,
  offersDirectoryGrant,
} from "../approvals/handler.ts";

// 取消路径的逐字理由（fail-closed 按拒绝处理）
export const APPROVAL_CANCEL_CLOSED = "TUI 已停止，审批面板关闭，本次调用按拒绝处理";
export const APPROVAL_CANCEL_DETACHED = "TUI 审批面板未装配，本次调用按拒绝处理";
export const APPROVAL_CANCEL_BUSY = "已有另一审批进行中，本次调用按拒绝处理（串行不变量防御）";
// 决策 303：worker 的请求等满时限无人批，面板撤下
export const APPROVAL_WITHDRAWN =
  "[审批] 请求等待超时，已撤回；这个 worker 停下交回，可稍后补批续做";

export type ApprovalPanelKey = "y" | "n" | "a" | "d";

// 面板决议：四键之一；r = 拒绝并说明（决策 066，携带人写理由）；
// cancel = 面板未能完成交互（壳停止/并发防御），携带逐字理由
export type ApprovalPanelResult =
  | { key: ApprovalPanelKey }
  | { key: "r"; reason: string }
  | { key: "cancel"; reason: string };

// 面板面：PigeonTuiShell 实现——渲染审批块、挂起等四键、回显结果行。
// 装配顺序上 handler 先于 shell 构造（buildRuntime 收 handler 工厂），故工厂收 face
// getter 晚绑定；getter 返回 undefined = 壳未就位（装配级故障），fail-closed
export interface TuiApprovalFace {
  // directoryGrant：审批块提供不提供 [d]（缺省按调用带不带 path 判定）
  askApproval(request: ApprovalRequest, directoryGrant?: boolean): Promise<ApprovalPanelResult>;
  noteApproval(line: string): void;
}

// 审批块文本：与 cli 版同口径（工具名 + exec 命令行 + pretty JSON 参数 + diff 预览 + 四键提示）；
// [d] 仅在调用可定位目录时提供（决策 3a）；exec 档 [a] 为精确命令放权（决策 048 及其修订）
// 决策 301：主会话自己的请求的来源行
export const MAIN_SOURCE_LINE = "来源：主会话";

export function approvalBlockText(
  request: ApprovalRequest,
  directoryGrant: boolean = offersDirectoryGrant(request, undefined),
  // 决策 301：面板不在主会话视图里弹出时，主会话自己的请求也写明来源
  labelMainSource = false
): string {
  const lines = ["—— 人工审批 ——"];
  // M5.5 S3（决策 040）：worker 请求标明来源
  const source = approvalSourceLine(request);
  if (source !== undefined) {
    lines.push(source);
  } else if (labelMainSource) {
    lines.push(MAIN_SOURCE_LINE);
  }
  lines.push(`工具：${request.toolName}`);
  const commandLine = execCommandLine(request);
  if (commandLine !== undefined) {
    lines.push(commandLine);
  }
  if (request.host !== undefined) {
    lines.push(`网站：${request.host}`);
  }
  lines.push("参数：");
  lines.push(JSON.stringify(request.args, null, 2) ?? "undefined");
  if (request.diffPreview !== undefined) {
    lines.push("改动预览：", request.diffPreview);
  }
  lines.push(
    request.host !== undefined
      ? `批准执行？[y] 批准一次 / [n] 拒绝 / [r] 拒绝并说明 / ${hostGrantKeyLabel(request)}`
      : request.tier === "exec"
        ? `批准执行？[y] 批准一次 / [n] 拒绝 / [r] 拒绝并说明 / ${execGrantKeyLabel(request)}`
        : directoryGrant
          ? "批准执行？[y] 批准一次 / [n] 拒绝 / [r] 拒绝并说明 / [a] 本会话允许 / [d] 本会话允许(仅限当前调用所在目录)"
          : "批准执行？[y] 批准一次 / [n] 拒绝 / [r] 拒绝并说明 / [a] 本会话允许"
  );
  return lines.join("\n");
}

// 决议措辞复用 application/format.ts 的 approvalVerdict（通俗措辞单一约定，不造第二套）；
// 它只读 approvedBy/outcome
function verdictLine(
  outcome: "approved" | "rejected",
  approvedBy: "human" | "human:grant"
): string {
  return `审批结果：${approvalVerdict({ outcome, approvedBy })}`;
}

// 面板版 handler 工厂（决策 025 的注入形态：装配根先建 grantStore，[a]/[d] 放权键需要它）
export function createTuiApprovalHandler(
  grants: SessionGrantStore,
  face: () => TuiApprovalFace | undefined
): ApprovalHandler {
  return async (request): Promise<ApprovalDecision> => {
    const panel = face();
    if (panel === undefined) {
      return { approved: false, reason: APPROVAL_CANCEL_DETACHED };
    }
    // 放权落点跟随请求来源——worker 请求自带其会话存储
    const target = request.grants ?? grants;
    // 不能建目录放权的会话（日常沙箱，决策 253）不提供 [d]
    const result = await panel.askApproval(request, offersDirectoryGrant(request, target));
    // 决策 303：请求已撤回，这次决定不被采用，不再回显裁决
    if (request.signal?.aborted === true) {
      return { approved: false, reason: APPROVAL_WITHDRAWN, reasonSource: "system-default" };
    }
    if (result.key === "cancel") {
      panel.noteApproval(`审批结果：人工拒绝（${result.reason}）`);
      return { approved: false, reason: result.reason };
    }
    if (result.key === "a" || result.key === "d") {
      // 与 cli 版同一份放权作用域（approvals/handler.ts grantScopeFor）
      const scope = grantScopeFor(request, result.key, target);
      if (scope === null) {
        panel.noteApproval(verdictLine("approved", "human"));
        panel.noteApproval("定位不到命令串，未创建放权（按批准一次处理）");
        return { approved: true };
      }
      // 与 cli 版同一份放权语义：grant.created 事件先于运行态（store.create fail-closed）
      const grant = target.create({
        tool: request.toolName,
        ...scope,
        firstCall: { toolCallId: request.toolCallId, args: request.args },
        ...(request.runId !== undefined ? { runId: request.runId } : {}),
      });
      panel.noteApproval(verdictLine("approved", "human:grant"));
      panel.noteApproval(
        `已创建会话放权 ${grant.grantId}（${grant.tool}${commandScopeNote(scope)}）${workerGrantScopeNote(request)}`
      );
      return { approved: true };
    }
    if (result.key === "y") {
      panel.noteApproval(verdictLine("approved", "human"));
      return { approved: true };
    }
    // [r]（决策 066）：拒绝并说明——理由逐字回模型，记为人写
    if (result.key === "r") {
      panel.noteApproval(verdictLine("rejected", "human"));
      return { approved: false, reason: result.reason, reasonSource: "human" };
    }
    // [n]：单按即拒绝，不带理由；治理层落默认文案「人工拒绝」并记为系统默认
    panel.noteApproval(verdictLine("rejected", "human"));
    return { approved: false };
  };
}
