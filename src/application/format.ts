// Actor 报告共用通俗措辞格式化助手（trace / replay / resume 菜单等共用，单一约定，禁止各视图
// 自造第二套措辞）。住在 application/（M2 S1，决策 025）：它是 cli 与将来的 tui 唯一同时
// 可达的共享层——resume 流程（application/resume.ts）与 CLI 各只读视图（cli/）都从这里取措辞。
import type { FailureClass } from "../state/classification.ts";
import type { ToolExecutionDecision } from "../state/tool-execution.ts";

// 参数摘要上限（字符）；超出截断并标注原长，防大参数刷屏
const ARGS_SUMMARY_LIMIT = 160;

// 审批来源行（M5.5 S3，决策 040）：worker 的审批汇聚到父级时标明来源；主会话自己的请求无来源行。
// cli 与 tui 两个审批 Actor 共用
export function approvalSourceLine(request: {
  readonly sessionId?: string;
  readonly worker?: { readonly name: string; readonly role: string };
}): string | undefined {
  if (request.worker === undefined) {
    return undefined;
  }
  return (
    `来源：worker ${request.worker.name}（${request.worker.role}）` +
    (request.sessionId !== undefined ? ` ｜ 会话 ${shortId(request.sessionId)}` : "")
  );
}

// worker 放权的作用范围注记（[a]/[d] 在 worker 请求上创建的 grant 只在该 worker 会话内生效）
export function workerGrantScopeNote(request: {
  readonly worker?: { readonly name: string };
}): string {
  return request.worker !== undefined ? `，只在 worker ${request.worker.name} 会话内生效` : "";
}

// 稳定 id 短哈希：`exec_` 等前缀 + ULID 前 8 位 + 省略号；非稳定 id（toolCallId 等）原样
export function shortId(id: string): string {
  const match = /^[a-z]+_[0-9A-HJKMNP-TV-Z]{8}/.exec(id);
  return match === null ? id : `${match[0]}…`;
}

// 模型原始参数的单行摘要；不可序列化时如实说明
export function summarizeArgs(args: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(args) ?? "undefined";
  } catch {
    return "<不可序列化参数>";
  }
  if (json.length <= ARGS_SUMMARY_LIMIT) {
    return json;
  }
  // 切点不劈开代理对：切点前一个码元是高位代理时少取一个码元，被劈开的字符整个落到截断部分之外
  let cut = ARGS_SUMMARY_LIMIT;
  const before = json.charCodeAt(cut - 1);
  if (before >= 0xd800 && before <= 0xdbff) {
    cut -= 1;
  }
  return `${json.slice(0, cut)}…（共 ${json.length} 字符）`;
}

// 批准来源 → 通俗措辞（决策 4 证据链：策略决定不能伪装成人工；M4 S6：grant 出处如实标明）
const APPROVED_BY_LABEL: Record<string, string> = {
  human: "人工",
  "policy:yolo": "yolo 批发授权",
  "policy:auto": "策略自动放行",
  "policy:deny": "策略拒绝",
  "human:grant": "人工授权（会话 grant）",
  "policy:config": "策略放行（固化配置）",
};

// 审批决定 → 通俗措辞裁决：人工区分批准/拒绝；策略来源直接给标签（不伪装成人工）
export function approvalVerdict(decision: ToolExecutionDecision): string {
  const label = APPROVED_BY_LABEL[decision.approvedBy] ?? decision.approvedBy;
  return label === "人工" ? (decision.outcome === "approved" ? "人工批准" : "人工拒绝") : label;
}

// FailureClass → 通俗措辞徽章（D7：「用户取消」与「治理熔断」必须一眼可分）。
// 自 state/trace.ts 归位（M2 S5，决策 032）：徽章是 Actor 共用措辞（cli trace/replay 与
// tui 终态摘要同一口径），不是冷投影结构——state 只留判据（classification.ts），措辞归本模块
export function failureBadge(failure: FailureClass | null | undefined): string {
  if (failure === null || failure === undefined) {
    return "正常";
  }
  switch (failure.category) {
    case "cancelled":
      return failure.breaker ? "治理熔断" : "取消";
    case "business":
      return "业务失败";
    case "infrastructure":
      return "基础设施错误";
    case "unknown":
      return "未知";
  }
}

// Eval 验证器三值判决（M6.5 S3，决策 058）→ 通俗措辞：trace Run 头、replay 时间线与 Eval 报告同一口径
export function evalVerdictLabel(verdict: "pass" | "fail" | "undetermined"): string {
  return verdict === "pass" ? "通过" : verdict === "fail" ? "失败" : "未判定";
}

// 终端控制序列净化（决策 036，M2 审计 P2-1）：半信任内容——模型流式文本、工具参数、
// diff 预览里的工作区文件内容、错误消息——可能携带终端控制序列，而 pi-tui 的 Text 与
// cli 的 stdout 都把 ESC 序列原样直通真实终端（实证：OSC 52 剪贴板劫持、OSC 8 伪装
// 超链接、CSI 光标定位/擦除可伪造审批屏、打乱差分渲染器行跟踪）。两个 Actor 在各自
// 终端边界（tui MessageFlow / cli sanitizedWriter）统一调用本函数。
// 策略是「可见化，绝不静默丢弃」——控制内容以标记形态留在屏上作审计痕迹：
//   - ESC（0x1B）→ ␛（U+241B）：CSI/OSC/DCS/APC/PM/SOS/双字符序列全部因失去 ESC
//     引导字节而惰性化，序列其余可打印字节原样保留可见；
//   - 其余 C0（0x00–0x1F）→ 对应控制图形（U+2400+码位），但 \n \t 保留（排版语义），
//     \r → ␍（U+240D：CRLF 差异在 diff 中如实呈现，不许回车吞字）；
//   - DEL（0x7F）→ ␡（U+2421）。
// 不做 SGR 白名单：模型没有业务理由向终端发颜色，白名单只是额外攻击面。幂等——
// 标记字符（U+2400 区段）不在 C0/DEL 区间，净化两次结果相同（流式累积 setText 每帧
// 重净化以此为前提；序列跨 delta 劈开时，中间帧的裸 ESC 显示为 ␛ 是正常形态）。
export function sanitizeTerminalText(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\n" || ch === "\t") {
      out += ch;
    } else if (code === 0x1b) {
      out += "␛";
    } else if (code === 0x7f) {
      out += "␡";
    } else if (code < 0x20) {
      out += String.fromCodePoint(0x2400 + code);
    } else {
      out += ch;
    }
  }
  return out;
}
