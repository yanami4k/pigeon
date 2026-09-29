// 模态与按键路由（决策 067 拆分自 shell.ts）：审批面板（S3，决策 029）、退出布防与取消键（S5 裁决 032 / 033）。
// 状态（待审批、退出布防时刻）一律由壳本体持有，本模块只经窄接口读写，不各自存一份。
// 决策 286：恢复菜单（S4 决策 031 的 1/2/3 单键决议）自决策 183 起已无调用方，连同状态行提示删除。
import type { ApprovalRequest } from "../approvals/handler.ts";
import {
  APPROVAL_CANCEL_BUSY,
  APPROVAL_CANCEL_CLOSED,
  APPROVAL_WITHDRAWN,
  type ApprovalPanelResult,
  approvalBlockText,
} from "./approval.ts";

// 挂起中的审批决议（resolve 四键或 cancel）；串行不变量（决策 002）下同时最多一个
export interface PendingApproval {
  resolve: (result: ApprovalPanelResult) => void;
  // 决策 303（脚本部分）：面板提供 [s] 本次脚本内同类都允许
  scriptKind?: boolean;
}

// 壳侧窄接口：模态状态的读写与壳动作（状态本体在壳里）
export interface ModalHost {
  isStarted(): boolean;
  isRunning(): boolean;
  pendingApproval(): PendingApproval | null;
  setPendingApproval(pending: PendingApproval | null): void;
  lastCtrlCAt(): number | null;
  setLastCtrlCAt(at: number | null): void;
  // 决策 066：理由行输入模式——[r] 打开，回车提交，Esc 回面板（不算拒绝）
  reasonMode(): boolean;
  setReasonMode(on: boolean): void;
  exitWindowMs(): number;
  addSystem(line: string): void;
  clearInput(): void;
  render(): void;
  updateStatus(): void;
  requestExit(): void;
  requestInterrupt(): void;
  // 决策 301：审批面板的各行（审批块、撤回、理由行提示）写到哪里——就地显示在当前视图；缺省即 addSystem
  addApprovalLine?(line: string): void;
  // 决策 301：当前不在主会话视图（审批块里给主会话的请求写明来源）；缺省即在
  outsideMainView?(): boolean;
}

function approvalLine(host: ModalHost, line: string): void {
  if (host.addApprovalLine !== undefined) host.addApprovalLine(line);
  else host.addSystem(line);
}

// 渲染审批块并挂起等四键；返回面板决议。串行不变量（决策 002）下同一会话同时最多
// 一个待审批调用——重入是上游/装配 bug，防御性 fail-closed（按拒绝处理），绝不排队
export function askApprovalPanel(
  host: ModalHost,
  request: ApprovalRequest,
  directoryGrant?: boolean
): Promise<ApprovalPanelResult> {
  // M5.5 S4：壳已停止——排队中轮到的审批（worker 的请求）不再渲染到已停的界面上吊死，
  // 与停止时挂起的审批同一 fail-closed 口径（决策 029）
  if (!host.isStarted()) {
    return Promise.resolve({ key: "cancel", reason: APPROVAL_CANCEL_CLOSED });
  }
  if (host.pendingApproval() !== null) {
    return Promise.resolve({ key: "cancel", reason: APPROVAL_CANCEL_BUSY });
  }
  approvalLine(host, approvalBlockText(request, directoryGrant, host.outsideMainView?.() === true));
  const { promise, resolve } = Promise.withResolvers<ApprovalPanelResult>();
  const pending: PendingApproval = {
    resolve,
    ...(request.script?.kind !== undefined ? { scriptKind: true } : {}),
  };
  host.setPendingApproval(pending);
  host.updateStatus();
  host.render();
  // 决策 303：请求方撤回（worker 的请求等满时限无人批）——面板撤下，按取消收口
  const signal = request.signal;
  if (signal !== undefined) {
    const withdraw = (): void => {
      if (host.pendingApproval() !== pending) return;
      host.setPendingApproval(null);
      host.setReasonMode(false);
      approvalLine(host, APPROVAL_WITHDRAWN);
      host.updateStatus();
      host.render();
      resolve({ key: "cancel", reason: APPROVAL_WITHDRAWN });
    };
    if (signal.aborted) withdraw();
    else signal.addEventListener("abort", withdraw, { once: true });
  }
  return promise;
}

// 壳停止时的模态收口：挂起的审批 fail-closed 按拒绝处理（理由逐字），不吊死 Run
export function closePendingModals(host: ModalHost): void {
  const approval = host.pendingApproval();
  if (approval !== null) {
    host.setPendingApproval(null);
    host.setReasonMode(false);
    approval.resolve({ key: "cancel", reason: APPROVAL_CANCEL_CLOSED });
  }
}

// 壳级键控路由：退出键（Ctrl+C）最先——模态吞键语义不得吃掉退出布防（033：模态
// 单击仍计布防第一次）；其后模态键控（决策 029/031），最后是取消键（S5 裁决 032）
export function handleShellKey(host: ModalHost, data: string): { consume: true } | undefined {
  if (data === "\x03") {
    handleCtrlC(host);
    return { consume: true };
  }
  if (handleModalKey(host, data) !== undefined) return { consume: true };
  // 取消键（S5）：Esc = 裸 "\x1b"（方向键等转义序列是多字节，不会误判）；Ctrl+C 不进
  // 本路径——永不绑定取消（033），退出语义由 handleCtrlC 承载。仅运行中消费；
  // 空闲 Esc 放行给输入框（Editor 在没有补全菜单时不处理 Esc，语义为空）
  if (data === "\x1b" && host.isRunning()) {
    host.requestInterrupt();
    return { consume: true };
  }
  return undefined;
}

// Ctrl+C（S5+，裁决 033）：单击布防——非模态清输入缓冲并留 [cleared] 提示（措辞与
// [cancel] 同款 ASCII 括号；无历史召回语义，清空即丢弃）；模态期间不清缓冲
// 不留提示（029/031 吞键语义），但仍计布防第一次。窗口内第二次（任意模式含模态）
// 优雅退出；窗口过期则本次退化为单击并重新布防
export function handleCtrlC(host: ModalHost): void {
  const now = Date.now();
  const last = host.lastCtrlCAt();
  if (last !== null && now - last <= host.exitWindowMs()) {
    host.setLastCtrlCAt(null);
    host.requestExit();
    return;
  }
  host.setLastCtrlCAt(now);
  if (host.pendingApproval() === null) {
    host.clearInput();
    host.addSystem("[cleared] 输入已清空（再按一次 Ctrl+C 退出）");
    host.render();
  }
}

// 模态键控：审批面板（S3）挂起期间接管终端输入——决议键 resolve，其余一律吞掉（决策 029 简单语义：
// 普通输入忽略，不进缓冲、不提交、不回显；输入区里已有的内容不动，面板关闭后继续编辑）
export function handleModalKey(host: ModalHost, data: string): { consume: true } | undefined {
  const approval = host.pendingApproval();
  if (approval !== null) {
    // 理由行（决策 066）：按键交给输入区编辑（回车提交在壳的提交路径上决议），
    // 只有 Esc 归模态——回到面板、不算拒绝，审批仍挂起
    if (host.reasonMode()) {
      if (data === "\x1b") {
        host.setReasonMode(false);
        host.clearInput();
        approvalLine(host, "已取消拒绝理由，回到审批面板");
        host.updateStatus();
        host.render();
        return { consume: true };
      }
      return undefined;
    }
    const key = data.toLowerCase();
    // [r] 拒绝并说明（决策 066）：打开理由行，不在此决议
    if (key === "r") {
      host.setReasonMode(true);
      approvalLine(host, "拒绝理由（回车提交，Esc 返回面板）：");
      host.updateStatus();
      host.render();
      return { consume: true };
    }
    if (
      key === "y" ||
      key === "n" ||
      key === "a" ||
      key === "d" ||
      (key === "s" && approval.scriptKind === true)
    ) {
      host.setPendingApproval(null);
      host.updateStatus();
      approval.resolve({ key });
    }
    return { consume: true };
  }
  return undefined;
}
