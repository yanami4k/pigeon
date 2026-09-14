// shell 标记的精确命令放权（048 修订）：只有带 shell 标记的 grant 与固化规则能免审一条需 shell 的命令；
// 缺省（旧记录）视为 false；匹配仍是精确字符串。
import assert from "node:assert/strict";
import { test } from "node:test";
import { newGrantId, newSessionId } from "../state/ids.ts";
import { matchConfigGrants, scopeMatches } from "./grants.ts";

const COMMAND = "npm test | tee out.txt";

test("会话放权：需 shell 的调用只被带 shell 标记的 grant 命中；不需 shell 的调用不受标记影响", () => {
  const args = { command: COMMAND };
  assert.equal(
    scopeMatches(undefined, "run_command", undefined, "run_command", args, COMMAND, true, true),
    true
  );
  assert.equal(
    scopeMatches(undefined, "run_command", undefined, "run_command", args, COMMAND, false, true),
    false
  );
  assert.equal(
    scopeMatches(
      undefined,
      "run_command",
      undefined,
      "run_command",
      args,
      COMMAND,
      undefined,
      true
    ),
    false
  );
  assert.equal(
    scopeMatches(
      undefined,
      "run_command",
      undefined,
      "run_command",
      { command: "node --test" },
      "node --test",
      undefined,
      false
    ),
    true
  );
  // 精确字符串不因 shell 标记放宽
  assert.equal(
    scopeMatches(
      undefined,
      "run_command",
      undefined,
      "run_command",
      { command: `${COMMAND} ` },
      COMMAND,
      true,
      true
    ),
    false
  );
});

test("固化规则：旧规则缺省 shell 为 false，不能免审需 shell 的命令；带 shell 标记的规则可以", () => {
  const promotedFrom = {
    grantId: newGrantId(),
    sessionId: newSessionId(),
    firstCall: { toolCallId: "toolu_1", args: { command: COMMAND } },
    promotedAt: 1,
  };
  const legacy = { tool: "run_command", command: COMMAND, promotedFrom };
  const shellRule = {
    ...legacy,
    shell: true,
    promotedFrom: { ...promotedFrom, grantId: newGrantId() },
  };
  assert.equal(
    matchConfigGrants([legacy], undefined, "run_command", { command: COMMAND }, true),
    null
  );
  assert.deepEqual(
    matchConfigGrants([legacy, shellRule], undefined, "run_command", { command: COMMAND }, true),
    {
      source: "config-rule",
      refId: shellRule.promotedFrom.grantId,
    }
  );
});
