import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attributeFailure,
  createdByDiff,
  extractMissing,
  type MissingRefs,
} from "./stream-attribution.ts";

test("缺失提取（node）：模块找不到与导出名不存在，绝对路径化为相对工作区根", () => {
  const output = [
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/testbed/src/state/candidate.ts' imported from /testbed/src/state/candidate.test.ts",
    "SyntaxError: The requested module '../state/ids.ts' does not provide an export named 'asGrantId'",
    "Error: Cannot find module '/testbed/src/state/candidate.ts' imported from elsewhere",
  ].join("\n");
  assert.deepEqual(extractMissing(output, "/testbed"), {
    paths: ["src/state/candidate.ts"],
    names: ["asGrantId"],
  });
});

test("缺失提取（python）：模块找不到与导入名不存在，模块名换成路径片段", () => {
  const output = [
    "E   ModuleNotFoundError: No module named 'strands.agent.local_agent'",
    "E   ImportError: cannot import name 'LocalAgent' from 'strands.agent' (/testbed/strands-py/src/strands/agent/__init__.py)",
  ].join("\n");
  assert.deepEqual(extractMissing(output, "/testbed"), {
    paths: ["strands/agent/local_agent"],
    names: ["LocalAgent"],
  });
});

test("人新建的文件与名字：取新增文件与新增行里的导出定义（TS 与 Python）", () => {
  const created = createdByDiff({
    addedFiles: ["src/state/candidate.ts", "strands-py/src/strands/agent/local_agent.py"],
    addedLines: [
      "export function asGrantId(raw: string): GrantId {",
      "export const GRANT_KINDS = [",
      "export interface Grant {",
      "export type GrantKind = string;",
      "export class GrantStore {",
      "export async function loadGrants() {",
      "class LocalAgent(Protocol):",
      "def make_agent(config):",
      "async def run_agent():",
      "    def _private(self):",
      "const internal = 1;",
    ],
  });
  assert.deepEqual(created.files, [
    "src/state/candidate.ts",
    "strands-py/src/strands/agent/local_agent.py",
  ]);
  assert.deepEqual(
    [...created.names].sort(),
    [
      "GRANT_KINDS",
      "Grant",
      "GrantKind",
      "GrantStore",
      "LocalAgent",
      "asGrantId",
      "loadGrants",
      "make_agent",
      "run_agent",
    ].sort()
  );
});

const none: MissingRefs = { paths: [], names: [] };

test("归因：通过不归因；缺前置优先于维护步接口不同，二者优先于回归，其余为没做出来", () => {
  const reverted = [
    createdByDiff({ addedFiles: ["src/a.ts"], addedLines: ["export function fa() {"] }),
  ];
  const maintenance = [
    createdByDiff({ addedFiles: ["src/m.ts"], addedLines: ["export function fm() {"] }),
  ];
  const base = { revertedCreated: reverted, maintenanceCreated: maintenance, regressions: 0 };
  assert.equal(attributeFailure({ ...base, passed: true, missing: none }), null);
  assert.equal(
    attributeFailure({ ...base, passed: false, missing: { paths: ["src/a.ts"], names: [] } }),
    "missing-prerequisite"
  );
  assert.equal(
    attributeFailure({ ...base, passed: false, missing: { paths: [], names: ["fa"] } }),
    "missing-prerequisite"
  );
  assert.equal(
    attributeFailure({ ...base, passed: false, missing: { paths: [], names: ["fm"] } }),
    "maintenance-interface"
  );
  assert.equal(
    attributeFailure({
      ...base,
      passed: false,
      missing: { paths: ["src/a.ts"], names: ["fm"] },
    }),
    "missing-prerequisite"
  );
  assert.equal(
    attributeFailure({
      ...base,
      regressions: 2,
      passed: false,
      missing: { paths: [], names: ["zz"] },
    }),
    "regression"
  );
  assert.equal(attributeFailure({ ...base, passed: false, missing: none }), "not-done");
});

test("归因：Python 模块路径片段与新建文件按去扩展名的后缀对上", () => {
  const reverted = [
    createdByDiff({ addedFiles: ["strands-py/src/strands/agent/local_agent.py"], addedLines: [] }),
  ];
  assert.equal(
    attributeFailure({
      passed: false,
      missing: { paths: ["strands/agent/local_agent"], names: [] },
      revertedCreated: reverted,
      maintenanceCreated: [],
      regressions: 0,
    }),
    "missing-prerequisite"
  );
  // 包目录：模块名对应 __init__.py
  const pkg = [
    createdByDiff({ addedFiles: ["strands-py/src/strands/routing/__init__.py"], addedLines: [] }),
  ];
  assert.equal(
    attributeFailure({
      passed: false,
      missing: { paths: ["strands/routing"], names: [] },
      revertedCreated: pkg,
      maintenanceCreated: [],
      regressions: 0,
    }),
    "missing-prerequisite"
  );
});
