// 编辑模式装配（决策 061 S0，决策 062）：显式 hashline 时，发给模型的 system prompt、edit_file 与 read_file 的工具描述与
// 参数形状与 061 之前逐字一致；缺省编辑模式为 replace。编辑模式经 headless 入口透传到装配根。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { DEFAULT_EDIT_MODE, type EditMode } from "../tools/edit-mode.ts";
import { REPLACE_EDIT_DESCRIPTION } from "../tools/replace-edit.ts";
import { runCommandTexts } from "../tools/run-command.ts";
import { runHeadless } from "./headless-core.ts";

// 截断后拆小引导（决策 063 第 2 件）：两种编辑模式的 system prompt 都追加
const TRUNCATION_GUIDANCE =
  "工具调用若因输出上限未执行，把改动拆成几次较小的调用重发，不要原样重发；单次编辑只改需要改的那一段。";

// hashline 模式下的逐字基准：编辑句与决策 061 之前一致，其后追加截断引导（决策 063）
const HASHLINE_PROMPT =
  "你是 Pigeon 编程助手。用 read_file 读取文件（输出带 N#TAG 行锚点与 [PATH#TAG] 快照），" +
  "用 edit_file 按锚点编辑。" +
  // 决策 353：引导把互不依赖的读取放进同一次回复
  "互不依赖的读取与搜索放在同一次回复里一起发。" +
  TRUNCATION_GUIDANCE +
  // 审批与 run_command 的说法按执行端与审批状态生成（170 ④）；本文件的运行一律 yolo、本地执行端
  "写操作自动批准。" +
  runCommandTexts({ platform: process.platform, approval: "yolo" }).prompt +
  "需要以前会话里的信息时，可用 list_sessions 浏览本项目以前的会话，用 search_sessions 按关键词检索以前会话里的对话，" +
  "再用 read_session_entry 按 entryId 读原文；检索片段只是线索，结论要回查原文。";

const HASHLINE_EDIT_DESCRIPTION =
  "编辑工作区内已存在的文本文件。必须先用 read_file 读取：edits 按 N#TAG 锚点寻址" +
  "（read 输出的行前缀），snapshot 填 read 输出的 [PATH#TAG] 中的快照标签。" +
  "操作：replace（换 anchor 到 endAnchor 的行）/ insertAfter（anchor 后插入）/ delete（删行）。" +
  "多处编辑全部预检通过才落盘；文件读后已变化（快照过期）会被拒绝，需重新 read_file。";

const HASHLINE_READ_DESCRIPTION =
  "读取工作区内文本文件。输出每行带锚点前缀 N#TAG（N 为行号，TAG 为内容哈希），" +
  "头部 [PATH#TAG] 是全文件快照。edit_file 编辑时必须使用本工具给出的锚点与快照；" +
  "文件被截断时按提示的 offset 继续读取。";

interface AdvertisedTool {
  name: string;
  description: string;
  parameters: { properties?: Record<string, unknown> };
}

async function advertised(editMode: EditMode | undefined) {
  const root = mkdtempSync(join(tmpdir(), "pigeon-edit-mode-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-edit-mode-home-"));
  try {
    writeFileSync(join(root, "a.txt"), "alpha\n");
    const streamFn = createFakeStreamFn({ replies: [{ text: "好" }] });
    await runHeadless({
      task: "你好",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn,
      yolo: true,
      homeDir: home,
      skillRoots: [],
      agentsMd: false,
      ...(editMode !== undefined ? { editMode } : {}),
    });
    const context = streamFn.calls[0]?.context;
    const tools = (context?.tools ?? []) as unknown as AdvertisedTool[];
    return {
      systemPrompt: context?.systemPrompt,
      edit: tools.find((tool) => tool.name === "edit_file"),
      read: tools.find((tool) => tool.name === "read_file"),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

test("两种编辑模式的 system prompt 都包含截断后拆小引导（决策 063）", async () => {
  for (const editMode of ["hashline", "replace"] as const) {
    const { systemPrompt } = await advertised(editMode);
    assert.ok(systemPrompt?.includes(TRUNCATION_GUIDANCE), `${editMode}：${systemPrompt}`);
  }
});

test("编辑模式显式 hashline：edit_file 与 read_file 的描述和参数与决策 061 之前逐字一致；system prompt 的 hashline 编辑句不变并追加截断引导", async () => {
  const { systemPrompt, edit, read } = await advertised("hashline");
  assert.equal(systemPrompt, HASHLINE_PROMPT);
  assert.equal(edit?.description, HASHLINE_EDIT_DESCRIPTION);
  assert.equal(read?.description, HASHLINE_READ_DESCRIPTION);
  assert.deepEqual(Object.keys(edit?.parameters.properties ?? {}).sort(), [
    "edits",
    "path",
    "snapshot",
  ]);
});

test("编辑模式缺省为 replace：不传编辑模式时装配出 replace 版 edit_file 与 read_file", async () => {
  assert.equal(DEFAULT_EDIT_MODE, "replace");
  const { systemPrompt, edit, read } = await advertised(undefined);
  assert.equal(edit?.description, REPLACE_EDIT_DESCRIPTION);
  assert.deepEqual(Object.keys(edit?.parameters.properties ?? {}).sort(), [
    "new_string",
    "old_string",
    "path",
  ]);
  assert.match(read?.description ?? "", /不要带行号前缀/);
  assert.match(systemPrompt ?? "", /old_string/);
  assert.doesNotMatch(systemPrompt ?? "", /N#TAG/);
});
