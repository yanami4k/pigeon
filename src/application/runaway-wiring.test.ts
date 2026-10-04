// 撞上限续跑与流式重复检测的装配（决策 367）：装配根按设置快照接上——没有设置时两项都开（续跑、omp 档掐断）；
// 设置里关掉续跑、检测改为只记录即照办
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { locateSessionFile } from "../persistence/session-reader.ts";
import { loadStoreSessionFile } from "../persistence/session-view.ts";
import { createFakeStreamFn, type FakeReply } from "../pi-runtime/fixtures.ts";
import { SessionEntryType } from "../state/session-entries.ts";
import { emptySettingsSnapshot, type SettingsSnapshot } from "../state/settings.ts";
import { runHeadless } from "./headless-core.ts";

async function headless(root: string, replies: FakeReply[], settings?: SettingsSnapshot) {
  const streamFn = createFakeStreamFn({ replies });
  const result = await runHeadless({
    task: "做事",
    governanceRoot: root,
    workspaceRoot: root,
    streamFn,
    yolo: true,
    homeDir: root,
    skillRoots: [],
    agentsMd: false,
    ...(settings !== undefined ? { settings } : {}),
  });
  const located = locateSessionFile(join(root, ".pigeon", "state", "sessions"), result.sessionId);
  const main = located !== undefined ? (loadStoreSessionFile(located.path)?.main ?? []) : [];
  const custom = (type: string) =>
    main.filter((entry) => entry.type === "custom" && entry.customType === type);
  return { calls: streamFn.calls.length, custom };
}

test("装配：没有设置时撞上限即续跑；设置关掉续跑、检测只记录时，截断即收尾、重复只记不掐", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-runaway-wiring-"));
  try {
    const repeated = `开头${"再读一遍文件。".repeat(60)}`;
    const byDefault = await headless(root, [
      { text: "写了一半", stopReason: "length" },
      { text: "改好了" },
    ]);
    assert.equal(byDefault.calls, 2);
    assert.equal(byDefault.custom(SessionEntryType.Continuation).length, 1);

    const empty = emptySettingsSnapshot(root);
    const configured = await headless(
      root,
      [{ text: repeated, chunkSize: 30, stopReason: "length" }, { text: "用不到" }],
      {
        ...empty,
        merged: {
          ...empty.merged,
          truncationContinuation: { enabled: false },
          repetitionGuard: { mode: "log" },
        },
      }
    );
    assert.equal(configured.calls, 1);
    assert.equal(configured.custom(SessionEntryType.Continuation).length, 0);
    assert.deepEqual(
      configured
        .custom(SessionEntryType.Repetition)
        .map((entry) => (entry.data as { mode: string }).mode),
      ["log"]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
