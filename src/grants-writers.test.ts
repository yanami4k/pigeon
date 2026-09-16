// grants.json 写入方守护（ROADMAP §M4 完成证据、§8：不允许任何后台流程写 grants.json）：
// 固化规则的两个写入函数只许由 application/grants.ts 调用——命令层是唯一入口，审批与治理路径
// 不得自行改写配置文件。本测试扫描生产代码（不含测试文件与定义文件本身）核对引用方集合。
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const WRITERS = ["appendGrantConfigRule", "removeGrantConfigRule"];
// 定义处（persistence 层实现）与唯一调用方（application 命令层）
const DEFINITION = "persistence/grants-config.ts";
const ALLOWED_CALLERS = ["application/grants.ts"];

function productionFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        found.push(path);
      }
    }
  };
  walk(dir);
  return found;
}

test("grants.json 写入方守护：固化规则的写入函数只被 application/grants.ts 引用", () => {
  const srcDir = fileURLToPath(new URL(".", import.meta.url));
  const referencing = new Set<string>();
  for (const file of productionFiles(srcDir)) {
    const text = readFileSync(file, "utf8");
    if (WRITERS.some((name) => text.includes(name))) {
      referencing.add(relative(srcDir, file).split("\\").join("/"));
    }
  }
  referencing.delete(DEFINITION);
  assert.deepEqual(
    [...referencing].sort(),
    ALLOWED_CALLERS,
    "固化规则写入函数的生产引用方必须只有 application/grants.ts（新增引用方需先裁决）"
  );
});
