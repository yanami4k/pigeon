// 开工状态块的标签与识别（决策 363）：开工状态块与状态追加以用户消息存进会话，但不是人输入的话。
// 这类消息带结构化标记（消息对象上的 pigeonStatus: true，随消息原样存进会话记录；交给模型之前去掉），
// 读会话的地方（会话列表的第一句、会话检索、回看、分叉的缺省分叉点）按标记跳过或另行显示，不看正文开头——
// 人输入的话即使以 <pigeon-status> 开头也照常算人说的
export const STATUS_TAG = "pigeon-status";
export const STATUS_UPDATE_TAG = "pigeon-status-update";
export const STATUS_MARKER = "pigeonStatus";

// 是不是 Pigeon 附上的开工状态消息（按标记）
export function isStatusMessage(message: unknown): boolean {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const record = message as Record<string, unknown>;
  return record.role === "user" && record[STATUS_MARKER] === true;
}

// 交给模型之前去掉标记（各 provider 不认识的字段不往外发）
export function withoutStatusMarker<T extends object>(message: T): T {
  if (!(STATUS_MARKER in message)) {
    return message;
  }
  const { [STATUS_MARKER]: _marker, ...rest } = message as Record<string, unknown>;
  return rest as T;
}

// 回看时的一行：哪几节（只对已按标记认出的状态消息用）
export function statusSummary(text: string): string {
  const names = [...text.matchAll(/<pigeon-section name="([^"]+)">/g)].map((match) => match[1]);
  const kind = text.startsWith(`<${STATUS_UPDATE_TAG}>`) ? "开工状态更新" : "开工状态";
  return `[${kind}] ${names.length > 0 ? names.join("、") : "（无内容）"}`;
}
