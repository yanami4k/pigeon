// 编辑模式装配（决策 061 S0，决策 062）：显式 hashline 时，发给模型的 system prompt 带 hashline 编辑句并追加截断引导，
// edit_file 与 read_file 的工具描述带锚点与快照的关键说法、参数形状不变；缺省编辑模式为 replace。编辑模式经 headless 入口
// 透传到装配根。
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
import { TRUNCATION_GUIDANCE } from "./runtime.ts";

// 文字里依次含有各段（只核对关键片段与先后，不逐字比对整段）
function assertInOrder(text: string | undefined, segments: readonly string[]): void {
  let from = 0;
  for (const segment of segments) {
    const at = text?.indexOf(segment, from) ?? -1;
    assert.ok(at >= 0, `缺少「${segment}」（或次序不对）：${text}`);
    from = at + segment.length;
  }
}

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

test("编辑模式显式 hashline：edit_file 与 read_file 的描述带锚点与快照的关键说法、参数不变；system prompt 带 hashline 编辑句并追加截断引导", async () => {
  const { systemPrompt, edit, read } = await advertised("hashline");
  // system prompt 按段依次核对：hashline 编辑句、其后追加的截断引导（决策 063）、run_command 的说法（按执行端与审批状态
  // 生成，170 ④；本文件的运行一律 yolo、本地执行端）、以前会话的检索一句
  assertInOrder(systemPrompt, [
    "用 edit_file 按锚点编辑。",
    TRUNCATION_GUIDANCE,
    runCommandTexts({ platform: process.platform, approval: "yolo" }).prompt,
    "list_sessions",
  ]);
  assertInOrder(edit?.description, ["N#TAG", "snapshot", "快照过期"]);
  assert.match(edit?.description ?? "", /replace[^\n]*insertAfter[^\n]*delete/);
  assertInOrder(read?.description, ["N#TAG", "[PATH#TAG]", "offset"]);
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
  // 截断后拆小引导（决策 063）：replace 模式同样追加（hashline 模式由上一条核对）
  assert.ok(systemPrompt?.includes(TRUNCATION_GUIDANCE), `replace：${systemPrompt}`);
  // 引导的关键说法（常量本身在这里用字面片段钉住）
  assert.match(TRUNCATION_GUIDANCE, /输出上限未执行[^。]*拆成几次较小的调用重发，不要原样重发/);
});
