// 测试设施（决策 363）：从假模型收到的一次调用里取开工状态块与状态追加。只给测试用
import type { FakeStreamCall } from "../pi-runtime/fixtures.ts";
import { STATUS_TAG, STATUS_UPDATE_TAG } from "../state/status-text.ts";

// 交给模型的请求里没有标记（交出之前已去掉），测试按正文开头辨认 Pigeon 附上的状态消息
export function isStatusText(text: string): boolean {
  return text.startsWith(`<${STATUS_TAG}>`) || text.startsWith(`<${STATUS_UPDATE_TAG}>`);
}

// 一次调用里全部用户消息的正文（开工状态块与状态追加也是用户消息）
export function userTexts(call: FakeStreamCall | undefined): string[] {
  return (call?.context.messages ?? []).flatMap((message) => {
    if (message.role !== "user") {
      return [];
    }
    const content = message.content;
    if (typeof content === "string") {
      return [content];
    }
    return [content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")];
  });
}

// 一次调用里的状态消息（完整块与追加），按出现先后拼在一起；没有为空串
export function statusTextOf(call: FakeStreamCall | undefined): string {
  return userTexts(call).filter(isStatusText).join("\n");
}

// 一次调用里不是状态消息的用户消息
export function humanTexts(call: FakeStreamCall | undefined): string[] {
  return userTexts(call).filter((text) => !isStatusText(text));
}
