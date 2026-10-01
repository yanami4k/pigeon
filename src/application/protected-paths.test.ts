// 第一道防线（决策 326 ①）：写入类文件工具写项目的 .pigeon 下任何路径须人逐次批准——会话放权、配置放权都不放行，
// worker 自己工作树内的默认放行也不适用；yolo 下放行；符号链接指进 .pigeon 的写入同样要批；批准提示写明受保护路径。
// 判定本身（词法、真实路径、大小写）另有单元用例。
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { localDockerHost } from "../execution/local-docker-fixtures.ts";
import { loadSettings } from "../persistence/settings.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import type { ActiveGrant, ConfigGrantRule } from "../state/grants.ts";
import { asGrantId, newSessionId } from "../state/ids.ts";
import { noMcpSession } from "./mcp.ts";
import { createProtectedPathResolver } from "./protected-paths.ts";
import { buildRuntime, disposeRuntime, type RuntimeDeps } from "./runtime.ts";
import { openSessionRuntime } from "./session-runtime.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "pigeon-protected-"));
  roots.push(root);
  mkdirSync(join(root, ".pigeon"), { recursive: true });
  writeFileSync(join(root, ".pigeon", "settings.json"), "a\n");
  writeFileSync(join(root, "plain.txt"), "a\n");
  return root;
}

const GRANT = asGrantId("grant_01J5Z7K8W9ABCDEFGHJKMNPQRS");

const sessionGrant: ActiveGrant = {
  grantId: GRANT,
  tool: "edit_file",
  createdAt: 1,
  firstCall: { toolCallId: "t0", args: {} },
};

const configRule: ConfigGrantRule = {
  tool: "edit_file",
  promotedFrom: {
    grantId: GRANT,
    sessionId: newSessionId(),
    firstCall: { toolCallId: "t0", args: {} },
    promotedAt: 1,
  },
};

// 读后改两步：先改受保护路径，再改普通文件（对照：放权对普通文件照常生效）
function editScript(target: string) {
  return createFakeStreamFn({
    replies: [
      { text: "读", toolCalls: [{ name: "read_file", args: { path: target } }] },
      { text: "读", toolCalls: [{ name: "read_file", args: { path: "plain.txt" } }] },
      {
        text: "改",
        toolCalls: [
          { name: "edit_file", args: { path: target, old_string: "a", new_string: "B" } },
        ],
      },
      {
        text: "改",
        toolCalls: [
          { name: "edit_file", args: { path: "plain.txt", old_string: "a", new_string: "B" } },
        ],
      },
      { text: "完" },
    ],
  });
}

async function runEdits(
  root: string,
  target: string,
  extra: Partial<RuntimeDeps>
): Promise<ApprovalRequest[]> {
  const asked: ApprovalRequest[] = [];
  const bundle = buildRuntime({
    streamFn: editScript(target),
    workspaceRoot: root,
    sessionId: newSessionId(),
    yolo: false,
    provider: "fake",
    modelId: "fake",
    editMode: "replace",
    createApprovalHandler: () => async (request) => {
      asked.push(request);
      return { approved: true };
    },
    ...extra,
  });
  try {
    await bundle.adapter.run("改");
  } finally {
    await disposeRuntime(bundle);
  }
  return asked;
}

test("会话放权在场：写 .pigeon 仍要人批（提示写明受保护路径），普通文件照常免审", async () => {
  const root = project();
  const asked = await runEdits(root, ".pigeon/settings.json", { restoredGrants: [sessionGrant] });
  assert.deepEqual(
    asked.map((request) => [request.toolName, request.protectedPath]),
    [["edit_file", ".pigeon/settings.json"]]
  );
  assert.equal(readFileSync(join(root, "plain.txt"), "utf8"), "B\n");
});

test("配置放权在场：写 .pigeon 仍要人批，普通文件照常免审", async () => {
  const root = project();
  const asked = await runEdits(root, ".pigeon/settings.json", { configGrants: [configRule] });
  assert.deepEqual(
    asked.map((request) => request.protectedPath),
    [".pigeon/settings.json"]
  );
});

test("yolo 下放行：写 .pigeon 不问人", async () => {
  const root = project();
  const asked = await runEdits(root, ".pigeon/settings.json", { yolo: true });
  assert.deepEqual(asked, []);
  assert.equal(readFileSync(join(root, ".pigeon", "settings.json"), "utf8"), "B\n");
});

test("worker 在自己工作树里写 .pigeon 要人批（不再默认放行），普通文件照常默认放行", async () => {
  const root = project();
  const asked = await runEdits(root, ".pigeon/settings.json", {
    toolPolicy: { allow: ["read_file", "edit_file"], deny: [], approvalMode: "prompt" },
    ownWorkspaceWrites: true,
  });
  assert.deepEqual(
    asked.map((request) => request.protectedPath),
    [".pigeon/settings.json"]
  );
});

test("符号链接指进 .pigeon：经链接写入同样要人批", async () => {
  const root = project();
  symlinkSync(join(root, ".pigeon"), join(root, "cfg"));
  const asked = await runEdits(root, "cfg/settings.json", { restoredGrants: [sessionGrant] });
  assert.deepEqual(
    asked.map((request) => request.protectedPath),
    [".pigeon/settings.json"]
  );
});

test("判定：词法与真实路径；子目录里同名的普通文件夹不算；大小写不敏感的文件系统按不敏感比较", () => {
  const root = project();
  mkdirSync(join(root, "sub", ".pigeon"), { recursive: true });
  symlinkSync(join(root, ".pigeon"), join(root, "link"));
  const resolve = createProtectedPathResolver({
    workspaceRoot: root,
    governanceRoot: root,
    realPaths: true,
  });
  assert.equal(resolve(".pigeon/settings.json"), ".pigeon/settings.json");
  assert.equal(resolve(".pigeon"), ".pigeon");
  assert.equal(resolve("./x/../.pigeon/state/new/file.txt"), ".pigeon/state/new/file.txt");
  assert.equal(resolve(join(root, ".pigeon", "skills", "a.md")), ".pigeon/skills/a.md");
  assert.equal(resolve("link/not-yet.json"), ".pigeon/not-yet.json");
  assert.equal(resolve("sub/.pigeon/file"), undefined);
  assert.equal(resolve("plain.txt"), undefined);
  assert.equal(resolve(".pigeonx/a"), undefined);
  // 容器工作区只做词法判定：链接不解析
  const lexical = createProtectedPathResolver({
    workspaceRoot: root,
    governanceRoot: root,
    realPaths: false,
  });
  assert.equal(lexical(".pigeon/a"), ".pigeon/a");
  assert.equal(lexical("link/a"), undefined);
  // 大小写：不敏感的文件系统上 .PIGEON 即 .pigeon；敏感的文件系统上是另一个目录
  const insensitive = createProtectedPathResolver({
    workspaceRoot: root,
    governanceRoot: root,
    realPaths: true,
    caseInsensitive: true,
  });
  assert.equal(insensitive(".PIGEON/Settings.json"), ".pigeon/settings.json");
  const sensitive = createProtectedPathResolver({
    workspaceRoot: root,
    governanceRoot: root,
    realPaths: true,
    caseInsensitive: false,
  });
  assert.equal(sensitive(".PIGEON/Settings.json"), undefined);
});

test("判定：worker 的工作树在治理根的 .pigeon/state 下——树里的普通文件不算，树自己的 .pigeon 与指回治理根 .pigeon 的链接算", () => {
  const root = project();
  const tree = join(root, ".pigeon", "state", "worktrees", "s-w1");
  mkdirSync(join(tree, ".pigeon"), { recursive: true });
  writeFileSync(join(tree, "a.ts"), "a\n");
  symlinkSync(join(root, ".pigeon"), join(tree, "up"));
  const resolve = createProtectedPathResolver({
    workspaceRoot: tree,
    governanceRoot: root,
    realPaths: true,
  });
  assert.equal(resolve("a.ts"), undefined);
  assert.equal(resolve("src/new.ts"), undefined);
  assert.equal(resolve(".pigeon/settings.json"), ".pigeon/settings.json");
  assert.equal(resolve("up/settings.json"), ".pigeon/settings.json");
});

test("沙箱（容器执行端）：写成容器内绝对路径的 .pigeon 写入、经容器里的符号链接写进 .pigeon 都要人批；配置放权对普通文件照常生效", async () => {
  const governance = mkdtempSync(join(tmpdir(), "pigeon-protected-gov-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-protected-home-"));
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "pigeon-protected-box-")));
  roots.push(governance, home, workspace);
  const { host, containerRoot, cleanup } = localDockerHost(workspace);
  try {
    mkdirSync(join(workspace, ".pigeon"), { recursive: true });
    writeFileSync(join(workspace, ".pigeon", "settings.json"), "a\n");
    writeFileSync(join(workspace, "plain.txt"), "a\n");
    symlinkSync(".pigeon", join(workspace, "cfg"));
    mkdirSync(join(governance, ".pigeon"), { recursive: true });
    writeFileSync(
      join(governance, ".pigeon", "settings.local.json"),
      JSON.stringify({ permissions: { grants: [configRule] } })
    );
    const absolute = `${containerRoot}/.pigeon/settings.json`;
    const edits = (target: string) => [
      { text: "读", toolCalls: [{ name: "read_file", args: { path: target } }] },
      {
        text: "改",
        toolCalls: [
          { name: "edit_file", args: { path: target, old_string: "a", new_string: "B" } },
        ],
      },
    ];
    const asked: ApprovalRequest[] = [];
    const opened = await openSessionRuntime({
      governanceRoot: governance,
      settings: loadSettings(governance, { homeDir: home }),
      sessionId: newSessionId(),
      streamFn: createFakeStreamFn({
        replies: [
          ...edits(absolute),
          ...edits("cfg/new.json"),
          ...edits("plain.txt"),
          { text: "完" },
        ],
      }),
      flags: { yolo: false, provider: "fake", modelId: "fake", persistThinking: true },
      workspaceHost: host,
      homeDir: home,
      startMcp: noMcpSession,
      createApprovalHandler: () => async (request) => {
        asked.push(request);
        return { approved: false };
      },
    });
    try {
      await opened.bundle.adapter.run("改");
    } finally {
      await disposeRuntime(opened.bundle);
    }
    assert.deepEqual(
      asked.map((request) => [request.toolName, request.protectedPath]),
      [
        ["edit_file", ".pigeon/settings.json"],
        ["edit_file", ".pigeon/new.json"],
      ]
    );
    assert.equal(readFileSync(join(workspace, ".pigeon", "settings.json"), "utf8"), "a\n");
    assert.equal(readFileSync(join(workspace, "plain.txt"), "utf8"), "B\n");
  } finally {
    cleanup();
  }
});

test("判定：符号链接与 .. 组合——POSIX 把链接替换发生在 .. 之前；Windows 与词法一致（复审 P2 回归）", () => {
  const root = project();
  mkdirSync(join(root, "a", "b"), { recursive: true });
  symlinkSync(join(root, "a", "b"), join(root, "lnk"));
  const resolve = createProtectedPathResolver({
    workspaceRoot: root,
    governanceRoot: root,
    realPaths: true,
  });
  if (process.platform === "win32") {
    // Windows 与词法一致：.. 文本折叠先行
    assert.equal(resolve("lnk/../../.pigeon/x"), undefined);
    assert.equal(resolve("lnk/../.pigeon/x"), ".pigeon/x");
    return;
  }
  // POSIX：lnk 先替换为 a/b，.. 作用于替换后的真实路径——/a/.pigeon/x 不受保护，/.pigeon/x 受保护
  assert.equal(resolve("lnk/../.pigeon/x"), undefined);
  assert.equal(resolve("lnk/../../.pigeon/x"), ".pigeon/x");
  assert.equal(resolve(join(root, "lnk", "..", "..", ".pigeon", "x")), ".pigeon/x");
  // 不带 .. 的写法照旧（词法捷径不变）
  assert.equal(resolve(".pigeon/x"), ".pigeon/x");
  assert.equal(resolve(join(root, "a", ".pigeon", "x")), undefined);
});

test("容器判定：符号链接与 .. 组合按容器内核顺序（复审 P2 回归）；词法捷径与出区围栏不变", async () => {
  // 桩执行端：POSIX readlink -f 语义（链接先替换、.. 再作用于替换后路径），越出 /work 或不存在即拒
  const dirs = new Set(["/work", "/work/.pigeon", "/work/a", "/work/a/b", "/work/sub"]);
  const resolveRaw = (input: string): string | undefined => {
    const p = input.replace(/^\/work\/lnk(?=\/|$)/, "/work/a/b");
    // 折叠 . 与 ..（.. 作用于已替换后的真实路径）
    const out: string[] = [];
    for (const seg of p.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        out.pop();
        continue;
      }
      out.push(seg);
    }
    const target = `/${out.join("/")}`;
    // POSIX realpath：除最后一段外各段都须存在，存在即返回规范化后的完整目标
    if (dirs.has(target)) return target;
    const parent = target.replace(/\/[^/]*$/, "");
    if (parent !== "" && dirs.has(parent)) return target;
    return undefined;
  };
  const { createHostProtectedPathResolver } = await import("./protected-paths.ts");
  const resolve = createHostProtectedPathResolver({
    root: "/work",
    resolveExisting: (inputPath) => {
      const hit = resolveRaw(inputPath);
      return hit === undefined ? Promise.reject(new Error("不存在")) : Promise.resolve(hit);
    },
  });
  // 链接后跟两层 ..：真实落点是 /work/.pigeon/x（受保护），词法折叠曾把它判成不受保护
  assert.equal(await resolve("/work/lnk/../../.pigeon/x"), ".pigeon/x");
  assert.equal(await resolve("lnk/../../.pigeon/x"), ".pigeon/x");
  // 链接后跟一层 ..：真实落点是 /work/a/.pigeon/x（子目录同名，不受保护），词法折叠曾误报受保护
  assert.equal(await resolve("/work/lnk/../.pigeon/x"), undefined);
  // 目录内用 .. 回到 .pigeon：受保护
  assert.equal(await resolve("/work/sub/../.pigeon/x"), ".pigeon/x");
  // 词法捷径与既有判定照旧
  assert.equal(await resolve(".pigeon/x"), ".pigeon/x");
  assert.equal(await resolve("/work/.pigeon/x"), ".pigeon/x");
  assert.equal(await resolve("plain.txt"), undefined);
  assert.equal(await resolve("/work/a/.pigeon/x"), undefined);
  // 越出工作区根的写法不受保护（写入侧由执行端围栏拒绝）
  assert.equal(await resolve("/work/../etc/x"), undefined);
});
