// 开工状态块的标签与识别（决策 363）：开工状态块与状态追加以用户消息存进会话，但不是人输入的话。
// 读会话的地方（会话列表的第一句、会话检索、回看、分叉的缺省分叉点）据此跳过或另行显示
export const STATUS_TAG = "pigeon-status";
export const STATUS_UPDATE_TAG = "pigeon-status-update";

export function isStatusText(text: string): boolean {
  return text.startsWith(`<${STATUS_TAG}>`) || text.startsWith(`<${STATUS_UPDATE_TAG}>`);
}

// 回看时的一行：哪几节
export function statusSummary(text: string): string {
  const names = [...text.matchAll(/<pigeon-section name="([^"]+)">/g)].map((match) => match[1]);
  const kind = text.startsWith(`<${STATUS_UPDATE_TAG}>`) ? "开工状态更新" : "开工状态";
  return `[${kind}] ${names.length > 0 ? names.join("、") : "（无内容）"}`;
}
