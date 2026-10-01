// /grants save 与 /revoke 落在项目个人设置（决策 325）：升格写 .pigeon/settings.local.json 的 permissions 一节、本会话求值冻结、
// 下次会话（重新读设置快照）生效；/grants 按层列出三层的放权规则；/revoke config#N 只按项目个人一层的序号移除。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import { loadSettings } from "../persistence/settings.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { projectLocalSettingsPath, projectSettingsPath, userSettingsPath } from "../state/paths.ts";
import { runGrantCommand } from "./grants.ts";
import { buildRuntime, disposeRuntime } from "./runtime.ts";

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

function rule(grantId: string, tool: string) {
  return {
    tool,
    promotedFrom: {
      grantId,
      sessionId: "sess_01J5Z7K8W9ABCDEFGHJKMNPQRS",
      firstCall: { toolCallId: "t0", args: {} },
      promotedAt: 1,
    },
  };
}

async function editRun(root: string, home: string) {
  writeFileSync(join(root, "a.txt"), "a\n");
  const asked: string[] = [];
  const bundle = buildRuntime({
    streamFn: createFakeStreamFn({
      replies: [
        { text: "读", toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] },
        {
          text: "改",
          toolCalls: [
            { name: "edit_file", args: { path: "a.txt", old_string: "a", new_string: "b" } },
          ],
        },
        { text: "完" },
      ],
    }),
    workspaceRoot: root,
    settings: loadSettings(root, { homeDir: home }),
    sessionId: newSessionId(),
    yolo: false,
    provider: "fake",
    modelId: "fake",
    editMode: "replace",
    createApprovalHandler: () => async (request) => {
      asked.push(request.toolName);
      return { approved: true };
    },
  });
  try {
    const result = await bundle.adapter.run("改");
    return { asked, approvedBy: result.toolExecutions.at(-1)?.decision?.approvedBy };
  } finally {
    await disposeRuntime(bundle);
  }
}

test("/grants save 写入项目个人设置的 permissions 一节，下次会话读设置时生效", async () => {
  const root = temp("pigeon-grants-settings-");
  const home = temp("pigeon-grants-home-");
  // 本会话：没有放权，写操作要人批
  const before = await editRun(root, home);
  assert.deepEqual(before.asked, ["edit_file"]);
  const store = new SessionGrantStore({ workspaceRoot: root });
  const grant = store.create({ tool: "edit_file", firstCall: { toolCallId: "t1", args: {} } });
  const lines: string[] = [];
  runGrantCommand(["grants", "save", grant.grantId], {
    root,
    store,
    configRules: [],
    sessionId: newSessionId(),
    write: (text) => lines.push(text),
  });
  assert.match(lines.join(""), /\.pigeon\/settings\.local\.json 的 permissions 一节/);
  const onDisk = JSON.parse(readFileSync(projectLocalSettingsPath(root), "utf8"));
  assert.equal(onDisk.permissions.grants[0].promotedFrom.grantId, grant.grantId);
  // 下次会话：重新读设置快照，配置放权生效
  const next = await editRun(root, home);
  assert.deepEqual(next.asked, []);
  assert.equal(next.approvedBy, "policy:config");
});

test("/grants 按层列出三层的放权规则；/revoke config#N 只移除项目个人一层的那一条", () => {
  const root = temp("pigeon-grants-layers-");
  const home = temp("pigeon-grants-layers-home-");
  mkdirSync(join(root, ".pigeon"), { recursive: true });
  mkdirSync(join(home, ".pigeon"), { recursive: true });
  writeFileSync(
    userSettingsPath(home),
    JSON.stringify({
      permissions: { grants: [rule("grant_01J5Z7K8W9ABCDEFGHJKMNPQR1", "read_file")] },
    })
  );
  writeFileSync(
    projectSettingsPath(root),
    JSON.stringify({
      permissions: { grants: [rule("grant_01J5Z7K8W9ABCDEFGHJKMNPQR2", "web_fetch")] },
    })
  );
  writeFileSync(
    projectLocalSettingsPath(root),
    JSON.stringify({
      permissions: {
        grants: [
          rule("grant_01J5Z7K8W9ABCDEFGHJKMNPQR3", "edit_file"),
          rule("grant_01J5Z7K8W9ABCDEFGHJKMNPQR4", "run_command"),
        ],
      },
    })
  );
  const snapshot = loadSettings(root, { homeDir: home });
  const lines: string[] = [];
  const ctx = {
    root,
    store: new SessionGrantStore({ workspaceRoot: root }),
    configRules: snapshot.grants.map((entry) => entry.rule),
    layeredRules: snapshot.grants,
    sessionId: newSessionId(),
    write: (text: string) => lines.push(text),
  };
  runGrantCommand(["grants"], ctx);
  const listed = lines.join("");
  assert.match(listed, /固化规则（4，三层设置的 permissions 一节）/);
  assert.match(listed, /config#0 ｜ edit_file/);
  assert.match(listed, /config#1 ｜ run_command/);
  assert.match(listed, /项目共享#0 ｜ web_fetch/);
  assert.match(listed, /用户级#0 ｜ read_file/);
  assert.match(listed, /不能用 \/revoke 移除/);
  runGrantCommand(["revoke", "config#1"], ctx);
  const after = loadSettings(root, { homeDir: home });
  assert.deepEqual(
    after.grants.map((entry) => `${entry.layer}:${entry.rule.tool}`),
    ["local:edit_file", "project:web_fetch", "user:read_file"]
  );
});
