// CLI 审批交互（M3 决策 3 + M4 S6 决策 3：REPL 内联、单进程最小闭环）。
// 被 Adapter 审批闸调用：终端展示工具名、参数（pretty JSON）与 diff 预览（若有），
// 交互四键——[y] 批准一次 / [n] 拒绝 / [a] 本会话允许（工具级 grant）/
// [d] 本会话允许（仅限当前调用所在目录）。决策 1：只有批准/拒绝两态，无"人工改参数"。
// [a]/[d] 创建会话 grant：事件写盘失败 = grant 不生效（fail-closed，见 store.create）
// M5.5 S3（决策 040）：与 tui 版同口径——worker 请求标明来源，放权写进请求来源会话的存储
// M5.5 S5（决策 048 及其修订）：exec 档原样显示将执行的命令串，需 shell 时标明；[a] 收窄为这条一模一样的
// 命令串（需 shell 的带 shell 标记），不提供 [d]
// 决策 290：网络档（web_fetch）显示将访问的网站，[a] 为"以后都允许访问该网站"（按主机名放权），不提供 [d]
import { approvalSourceLine, workerGrantScopeNote } from "../application/format.ts";
import type { SessionGrantStore } from "../approvals/grant-store.ts";
import {
  type ApprovalHandler,
  commandScopeNote,
  execCommandLine,
  execGrantKeyLabel,
  grantScopeFor,
  hostGrantKeyLabel,
  offersDirectoryGrant,
  protectedPathLine,
} from "../approvals/handler.ts";
import type { AskFn, WriteFn } from "./repl.ts";

export interface CliApprovalOptions {
  // M4 S6（决策 3）：会话 grant 存储——缺省时只提供 y/n 两键（测试/无放权场景）
  grants?: SessionGrantStore;
}

export function createCliApprovalHandler(
  ask: AskFn,
  write: WriteFn,
  options: CliApprovalOptions = {}
): ApprovalHandler {
  return async (request) => {
    // 放权落点跟随请求来源：worker 请求自带其会话存储，主会话请求用绑定存储
    const grants = request.grants ?? options.grants;
    write("\n—— 人工审批 ——\n");
    const source = approvalSourceLine(request);
    if (source !== undefined) {
      write(`${source}\n`);
    }
    write(`工具：${request.toolName}\n`);
    const protectedLine = protectedPathLine(request);
    if (protectedLine !== undefined) {
      write(`${protectedLine}\n`);
    }
    const commandLine = execCommandLine(request);
    if (commandLine !== undefined) {
      write(`${commandLine}\n`);
    }
    if (request.host !== undefined) {
      write(`网站：${request.host}
`);
    }
    write(`参数：\n${JSON.stringify(request.args, null, 2)}\n`);
    if (request.diffPreview !== undefined) {
      write(`改动预览：\n${request.diffPreview}\n`);
    }
    // [d] 仅在调用带 path 参数时提供（决策 3a：目录限定的前提是调用可定位目录）；exec 档无 [d]；
    // 不能建目录放权的会话（日常沙箱，决策 253）同样不提供
    // 决策 326 ①：受保护路径的请示只有批准一次或拒绝，不提供放权键
    const prompt =
      grants === undefined || request.protectedPath !== undefined
        ? "批准执行？[y/N] "
        : request.host !== undefined
          ? `批准执行？[y] 批准一次 / [n] 拒绝 / ${hostGrantKeyLabel(request)} `
          : request.tier === "exec"
            ? `批准执行？[y] 批准一次 / [n] 拒绝 / ${execGrantKeyLabel(request)} `
            : offersDirectoryGrant(request, grants)
              ? "批准执行？[y] 批准一次 / [n] 拒绝 / [a] 本会话允许 / [d] 本会话允许(仅限当前调用所在目录) "
              : "批准执行？[y] 批准一次 / [n] 拒绝 / [a] 本会话允许 ";
    const answer = await ask(prompt);
    const normalized = answer?.trim().toLowerCase() ?? "";
    if ((normalized === "a" || normalized === "d") && request.protectedPath === undefined) {
      if (grants === undefined) {
        // 无放权通道时 a/d 不具语义——按拒绝流程走（理由可空，由 Adapter 落默认文案）
        const reasonInput = await ask("拒绝理由（可空，将逐字反馈给模型）：");
        const reason = reasonInput?.trim() ?? "";
        // 决策 066：输入了理由记为人写；留空不带理由，由治理层落默认文案并记为系统默认
        return reason === ""
          ? { approved: false }
          : { approved: false, reason, reasonSource: "human" };
      }
      // 与 tui 版同一份放权作用域（approvals/handler.ts grantScopeFor）
      const scope = grantScopeFor(request, normalized, grants);
      if (scope === null) {
        write("定位不到命令串，未创建放权（按批准一次处理）\n");
        return { approved: true };
      }
      const grant = grants.create({
        tool: request.toolName,
        ...scope,
        firstCall: { toolCallId: request.toolCallId, args: request.args },
        ...(request.runId !== undefined ? { runId: request.runId } : {}),
      });
      write(
        `已创建会话放权 ${grant.grantId}（${grant.tool}${commandScopeNote(scope)}）${workerGrantScopeNote(request)}\n`
      );
      return { approved: true };
    }
    const approved = normalized === "y" || normalized === "yes";
    if (approved) {
      return { approved: true };
    }
    const reasonInput = await ask("拒绝理由（可空，将逐字反馈给模型）：");
    const reason = reasonInput?.trim() ?? "";
    // 空理由按 undefined 传，由治理层落默认文案并记为系统默认；有理由记为人写（决策 066）
    return reason === "" ? { approved: false } : { approved: false, reason, reasonSource: "human" };
  };
}
