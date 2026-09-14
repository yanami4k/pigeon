// load_skill（M5 S4，决策 043）：按需读取登记过的 Skill 及其资源文件的 read 档工具（§3.9 第 5 档
// 自动放行）。三重约束 fail-closed，任一不满足即报错说明理由、什么都不注入：
//   1. 来源只认会话开始时登记过的 Skill 名；
//   2. 资源路径 realpath 后必须仍在该 Skill 目录内（../、符号链接、目录联接逃逸一律拒绝）；
//   3. 单文件大小上限默认 64 KiB，超出可见截断并带全文哈希（截断不是拒绝，但必须看得见）。
// 另比对开会话时的哈希清单：文件被改或是会话中新增的，拒绝并提示下个会话生效（§2 规则 4）。
// scripts 在 M5 只读不执行。Skill 是文本，工具照旧经六档排律，不扩权由构造保证。
// 每次成功读取回调 skill.loaded 载荷，由装配根写成观察记录（skills 层不触达落盘）。
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { sha256Hex, truncateUtf8 } from "../state/message-content.ts";
import type { SkillLoadedPayload } from "../state/runtime-events.ts";
import type { ToolRegistration } from "../tools/registry.ts";
import type { PigeonAgentTool, PigeonToolResult } from "../tools/wrap.ts";
import type { SkillCatalog } from "./catalog.ts";

export const LOAD_SKILL_TOOL = "load_skill";
export const DEFAULT_SKILL_FILE_LIMIT_BYTES = 64 * 1024;

// 域错误（模型给错名字或路径、Skill 已变更）
export class LoadSkillError extends Error {}

export const LoadSkillParamsSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  // 相对 Skill 目录的资源路径；缺省读 SKILL.md
  resource: Type.Optional(Type.String({ minLength: 1 })),
});
export type LoadSkillParams = Static<typeof LoadSkillParamsSchema>;

export interface LoadSkillToolOptions {
  catalog: SkillCatalog;
  maxBytes?: number;
  // 每次成功读取的留痕回调（装配根接到 Adapter.recordObservation）
  onLoaded?: (payload: SkillLoadedPayload) => void;
}

export function createLoadSkillTool(
  options: LoadSkillToolOptions
): PigeonAgentTool<typeof LoadSkillParamsSchema, SkillLoadedPayload> {
  const maxBytes = options.maxBytes ?? DEFAULT_SKILL_FILE_LIMIT_BYTES;
  return {
    name: LOAD_SKILL_TOOL,
    label: LOAD_SKILL_TOOL,
    description:
      "按名读取会话开始时登记的 Skill：不给 resource 时读 SKILL.md，给 resource 时读该 Skill 目录下的" +
      "资源文件（如 references/x.md）。只能读登记过的 Skill 目录内的文件；scripts 只读不执行。",
    parameters: LoadSkillParamsSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params): Promise<PigeonToolResult<SkillLoadedPayload>> {
      const args = Value.Parse(LoadSkillParamsSchema, params);
      const skill = options.catalog.skills.find((entry) => entry.name === args.name);
      if (skill === undefined) {
        const available = options.catalog.skills.map((entry) => entry.name).join("、");
        throw new LoadSkillError(
          `未登记的 Skill：${args.name}（只认会话开始时登记的 Skill；可用：${available || "无"}）`
        );
      }
      const resource = args.resource ?? "SKILL.md";
      let realDir: string;
      try {
        realDir = realpathSync(skill.dir);
      } catch {
        throw new LoadSkillError(`Skill 目录已不可读：${skill.displayPath}（下个会话重新登记）`);
      }
      let realTarget: string;
      try {
        realTarget = realpathSync(path.resolve(realDir, resource));
      } catch {
        throw new LoadSkillError(`资源不存在：${resource}（Skill ${skill.name}）`);
      }
      const relative = path.relative(realDir, realTarget);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new LoadSkillError(
          `路径越出 Skill 目录（含符号链接或目录联接逃逸）：${resource}（Skill ${skill.name}）`
        );
      }
      if (relative === "" || !statSync(realTarget).isFile()) {
        throw new LoadSkillError(`不是文件：${resource}（Skill ${skill.name}）`);
      }
      const resourcePath = relative.split(path.sep).join("/");
      const raw = readFileSync(realTarget);
      const hash = sha256Hex(raw);
      const frozen = skill.files.find((file) => file.path === resourcePath);
      if (frozen === undefined || frozen.hash !== hash) {
        throw new LoadSkillError(
          `该 Skill 已变更：${skill.name}/${resourcePath} ` +
            `${frozen === undefined ? "是会话开始后新增的文件" : "与会话开始时的哈希清单不符"}，下个会话生效`
        );
      }
      const cut = truncateUtf8(raw.toString("utf8"), maxBytes);
      const payload: SkillLoadedPayload = {
        name: skill.name,
        resourcePath,
        hash,
        bytes: raw.length,
        truncated: cut.truncated,
      };
      options.onLoaded?.(payload);
      const lines = [`[Skill ${skill.name}｜${resourcePath}｜${raw.length} 字节｜sha256 ${hash}]`];
      if (cut.truncated) {
        lines.push(
          `（已截断：文件 ${raw.length} 字节超出 ${maxBytes} 字节上限，只返回前 ${Buffer.byteLength(cut.text)} 字节；全文哈希 ${hash}）`
        );
      }
      if (resourcePath.startsWith("scripts/")) {
        lines.push("（scripts 在 M5 只读不执行：以下是脚本文本，不会被运行）");
      }
      lines.push(cut.text);
      return { content: [{ type: "text", text: lines.join("\n") }], details: payload };
    },
  };
}

// 装配根注册用的元数据：read 档，路径活动范围 = 项目级与用户级两个 Skill 根
export function loadSkillRegistration(catalog: SkillCatalog): ToolRegistration {
  return {
    name: LOAD_SKILL_TOOL,
    description: "按名读取会话开始时登记的 Skill 及其资源文件",
    parameters: LoadSkillParamsSchema,
    tier: "read",
    pathConfinement: { kind: "roots", roots: catalog.roots },
    executionMode: "parallel",
  };
}
