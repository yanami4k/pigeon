// 会话树存储契约测试（M7 S6，决策 068 / 077）：对象是 pi-agent-core 0.84.4 的 v4 JSONL 格式，使用上游
// createSessionBackendConformance。上游格式或语义漂移时，这组测试先于运行失败。
// 上游用例调用 create / fork 时不带 cwd，而 JsonlSessionRepo 需要 cwd：以每个用例独立的临时根包一层补上。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createSessionBackendConformance } from "@earendil-works/pi-agent-core/session/testing";

const cases = createSessionBackendConformance(async () => {
  const dir = await mkdtemp(join(tmpdir(), "pigeon-tree-contract-"));
  const env = new NodeExecutionEnv({ cwd: dir });
  const inner = new JsonlSessionRepo({ fs: env, sessionsRoot: join(dir, "trees") });
  const repository = {
    create: (options: Parameters<typeof inner.create>[0] | { id?: string }) =>
      inner.create({ cwd: dir, ...options }),
    open: (metadata: Parameters<typeof inner.open>[0]) => inner.open(metadata),
    list: () => inner.list(),
    delete: (metadata: Parameters<typeof inner.delete>[0]) => inner.delete(metadata),
    fork: (source: Parameters<typeof inner.fork>[0], options: object) =>
      inner.fork(source, { cwd: dir, ...options } as Parameters<typeof inner.fork>[1]),
  };
  return {
    repository: repository as never,
    [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }),
  };
});

const groups = new Map<string, typeof cases>();
for (const entry of cases) {
  groups.set(entry.group, [...(groups.get(entry.group) ?? []), entry]);
}
for (const [group, entries] of groups) {
  describe(`会话树契约（core 0.84.4 v4 JSONL）：${group}`, () => {
    for (const entry of entries) {
      it(entry.name, () => entry.run());
    }
  });
}
