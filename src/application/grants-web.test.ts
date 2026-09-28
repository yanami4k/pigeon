// /grants 与 /revoke、/grants save 对按网站放权的处理（决策 290）：展示“仅限网站 <主机名>”；升格进 grants.json 时带 host；
// 撤销立即生效。接进现有的放权存取与显示，不另起一套。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import { loadGrantConfig } from "../persistence/grants-config.ts";
import { newSessionId } from "../state/ids.ts";
import { runGrantCommand } from "./grants.ts";

test("/grants 展示按网站放权；/grants save 升格带 host；/revoke 撤销后不再命中", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-grants-web-"));
  try {
    const store = new SessionGrantStore({ workspaceRoot: root });
    const grant = store.create({
      tool: "web_fetch",
      host: "docs.example",
      firstCall: { toolCallId: "toolu_01", args: { url: "https://docs.example/a", prompt: "x" } },
    });
    const lines: string[] = [];
    const ctx = {
      root,
      store,
      configRules: [],
      sessionId: newSessionId(),
      write: (text: string) => lines.push(text),
    };
    assert.equal(runGrantCommand(["grants"], ctx), true);
    assert.match(lines.join(""), /web_fetch ｜ 仅限网站 docs\.example ｜/);

    assert.equal(runGrantCommand(["grants", "save", grant.grantId], ctx), true);
    const saved = loadGrantConfig(root);
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.tool, "web_fetch");
    assert.equal(saved[0]?.host, "docs.example");
    assert.equal(saved[0]?.pathPrefix, undefined);
    assert.equal(saved[0]?.promotedFrom.grantId, grant.grantId);

    assert.equal(runGrantCommand(["revoke", grant.grantId], ctx), true);
    assert.equal(store.match("web_fetch", { url: "https://docs.example/b" }), null);
    lines.length = 0;
    runGrantCommand(["grants"], { ...ctx, configRules: saved });
    assert.match(lines.join(""), /会话放权（0）/);
    assert.match(lines.join(""), /config#0 ｜ web_fetch ｜ 仅限网站 docs\.example ｜/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
