// 脚本续跑的调用指纹（决策 312）：每个 agent 调用按任务文字、角色、输出格式与开工起点（本次脚本的主目录快照，或所接力调用的
// 指纹）算一份内容指纹；同一次执行里内容相同的调用按出现先后再加序号。指纹与派出先后无关：流水线各项的派出顺序变了，
// 同一内容的调用照样对得上。输出格式按键序规范化后再算。
import { createHash } from "node:crypto";
import { canonicalJson } from "../state/json-schema-check.ts";

export interface ScriptCallContent {
  task: string;
  role: string;
  schema?: unknown;
  // 接力时为所接力调用的指纹；缺省即从本次脚本的主目录快照开工
  relay?: string;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export function scriptCallContentKey(content: ScriptCallContent): string {
  return sha256(
    canonicalJson({
      task: content.task,
      role: content.role,
      schema: content.schema ?? null,
      start: content.relay !== undefined ? `relay:${content.relay}` : "snapshot",
    })
  );
}

// 一次脚本执行里的指纹分配：同内容的第 n 次出现（从 0 起）
export class ScriptFingerprints {
  readonly #seen = new Map<string, number>();

  next(content: ScriptCallContent): string {
    const key = scriptCallContentKey(content);
    const index = this.#seen.get(key) ?? 0;
    this.#seen.set(key, index + 1);
    return sha256(`${key}#${index}`).slice(0, 32);
  }
}
