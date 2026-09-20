// 回放的临时治理根（M8 S3，决策 085 / 083）：经验按正常格式放入、走真激活同一条路径；
// 宿主的经验目录一个字节都不写；固化命令规则与放权规则随行。
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sha256Hex } from "../state/message-content.ts";
import { seedRerunRoot } from "./materials.ts";

function hostRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-rerun-host-"));
  mkdirSync(join(dir, ".pigeon", "memory"), { recursive: true });
  mkdirSync(join(dir, ".pigeon", "skills", "old-skill"), { recursive: true });
  writeFileSync(join(dir, ".pigeon", "commands.json"), '{"version":1,"commands":{}}', "utf8");
  writeFileSync(join(dir, ".pigeon", "grants.json"), '{"version":1,"grants":[]}', "utf8");
  writeFileSync(join(dir, ".pigeon", "mcp.json"), '{"version":1,"servers":{}}', "utf8");
  writeFileSync(join(dir, ".pigeon", "memory", "team.md"), "团队约定", "utf8");
  writeFileSync(join(dir, ".pigeon", "skills", "old-skill", "SKILL.md"), "老技能", "utf8");
  writeFileSync(join(dir, ".pigeon", "skills", "old-skill", "ref.md"), "附属资源", "utf8");
  return dir;
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "pigeon-rerun-temp-"));
}

// 宿主经验目录的快照：用来证明回放没写它一个字节
function snapshotHost(dir: string): string {
  const parts: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1
    )) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path, `${prefix}${entry.name}/`);
      } else {
        parts.push(`${prefix}${entry.name}:${sha256Hex(readFileSync(path))}`);
      }
    }
  };
  walk(join(dir, ".pigeon"), "");
  return parts.join("\n");
}

test("临时治理根：固化命令规则与放权规则随行，MCP 配置不随行", () => {
  const host = hostRoot();
  const temp = tempRoot();
  seedRerunRoot({ hostGovernanceRoot: host, tempGovernanceRoot: temp });
  assert.ok(existsSync(join(temp, ".pigeon", "commands.json")));
  assert.ok(existsSync(join(temp, ".pigeon", "grants.json")));
  assert.ok(!existsSync(join(temp, ".pigeon", "mcp.json")), "回放不起外部 server");
});

test("临时治理根：宿主已激活的经验照搬，候选按正常格式放在真激活的落点上", () => {
  const host = hostRoot();
  const temp = tempRoot();
  const content = "# 先读后改\n";
  const seeded = seedRerunRoot({
    hostGovernanceRoot: host,
    tempGovernanceRoot: temp,
    candidate: { kind: "skill", name: "read-before-edit", content },
  });
  assert.equal(readFileSync(join(temp, ".pigeon", "memory", "team.md"), "utf8"), "团队约定");
  assert.equal(
    readFileSync(join(temp, ".pigeon", "skills", "old-skill", "ref.md"), "utf8"),
    "附属资源"
  );
  assert.equal(
    readFileSync(join(temp, ".pigeon", "skills", "read-before-edit", "SKILL.md"), "utf8"),
    content,
    "候选落在 Skill Catalog 的标准目录上——与真激活同一条装载路径"
  );
  const candidateEntry = seeded.experiences.find((entry) => entry.candidate);
  assert.equal(candidateEntry?.name, "read-before-edit");
  assert.equal(candidateEntry?.contentHash, sha256Hex(Buffer.from(content, "utf8")));
});

test("临时治理根：基线组与带经验组只差候选这一条，集合哈希随之不同", () => {
  const host = hostRoot();
  const baseline = seedRerunRoot({ hostGovernanceRoot: host, tempGovernanceRoot: tempRoot() });
  const withCandidate = seedRerunRoot({
    hostGovernanceRoot: host,
    tempGovernanceRoot: tempRoot(),
    candidate: { kind: "skill", name: "read-before-edit", content: "# 先读后改\n" },
  });
  assert.notEqual(baseline.experienceSetHash, withCandidate.experienceSetHash);
  const names = (entries: typeof baseline.experiences) => entries.map((entry) => entry.name).sort();
  assert.deepEqual(names(baseline.experiences), ["old-skill", "old-skill/ref.md", "team"]);
  assert.deepEqual(names(withCandidate.experiences), [
    "old-skill",
    "old-skill/ref.md",
    "read-before-edit",
    "team",
  ]);
});

test("临时治理根：候选与宿主同名同种时先剔除旧版本，不让两版同时在场", () => {
  const host = hostRoot();
  const temp = tempRoot();
  const seeded = seedRerunRoot({
    hostGovernanceRoot: host,
    tempGovernanceRoot: temp,
    candidate: { kind: "skill", name: "old-skill", content: "新版本" },
  });
  assert.equal(
    readFileSync(join(temp, ".pigeon", "skills", "old-skill", "SKILL.md"), "utf8"),
    "新版本"
  );
  assert.ok(
    !existsSync(join(temp, ".pigeon", "skills", "old-skill", "ref.md")),
    "旧版本连同附属资源一并剔除"
  );
  assert.equal(seeded.experiences.filter((entry) => entry.name === "old-skill").length, 1);
});

test("临时治理根：宿主的经验目录一个字节都不写", () => {
  const host = hostRoot();
  const before = snapshotHost(host);
  seedRerunRoot({
    hostGovernanceRoot: host,
    tempGovernanceRoot: tempRoot(),
    candidate: { kind: "skill", name: "read-before-edit", content: "正文" },
  });
  seedRerunRoot({
    hostGovernanceRoot: host,
    tempGovernanceRoot: tempRoot(),
    candidate: { kind: "memory", name: "note", content: "正文" },
  });
  assert.equal(snapshotHost(host), before);
});

test("临时治理根：已停止产出的种类不能放进回放材料（决策 094）", () => {
  const host = hostRoot();
  const temp = tempRoot();
  assert.throws(
    () =>
      seedRerunRoot({
        hostGovernanceRoot: host,
        tempGovernanceRoot: temp,
        candidate: { kind: "policy", name: "allow-npm", content: "建议" },
      }),
    (error: unknown) => /已停止产出/.test(String(error))
  );
});
