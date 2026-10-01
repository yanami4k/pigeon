// 路径收口的边界用例（决策 325）：Pigeon 自己的目录与文件位置全部经 src/state/paths.ts 给出——除该模块外，非测试源码
// （测试与 *-fixtures.ts 夹具除外）的字符串字面量与模板字面量里不得出现目录名 .pigeon。
// 只看字面量（注释照常可写 .pigeon）；按路径段匹配（.pigeon 前后是路径分隔符、引号、空白、括号或串的两端），
// 不误伤 options.pigeon、"$cfg.pigeon"、".pigeon-start" 这类不是目录名的写法。
// 断言一：检测器能抓住违规、不误伤上述写法（防"规则还在但已经不执行任务了"）；断言二：src/ 下 0 违规且确实扫了文件。
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const PATHS_MODULE = path.join("state", "paths.ts");

const SEGMENT = /(^|[/\\"'`\s(（：:])\.pigeon(?=$|[/\\"'`\s)）。，、；])/;

// 源码里含目录名 .pigeon 的字面量（行号从 1 起）：按语法树取字符串与模板的各段
export function pigeonLiterals(source: string): Array<{ line: number; text: string }> {
  const file = ts.createSourceFile("probe.ts", source, ts.ScriptTarget.Latest, true);
  const found: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      if (SEGMENT.test(node.text)) {
        found.push({
          line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
          text: node.text,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!entry.name.endsWith(".ts")) return [];
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith("-fixtures.ts")) return [];
    return [full];
  });
}

test("检测器：字面量里的目录名 .pigeon 被抓住，注释与非目录名的写法不误伤", () => {
  const hits = pigeonLiterals(
    [
      'const a = join(root, ".pigeon", "sessions");',
      // 模板字面量（源码文本里的 $ 与花括号分开写，免得被当成本文件自己的模板）
      `const b = \`说明 $${"{"}x} 在 .pigeon/grants.json 里\`;`,
      `const c = \`$${"{"}root}/.pigeon\`;`,
      "// 注释里的 .pigeon/settings.json 不算",
      'const d = options.pigeon; const e = "$cfg.pigeon"; const f = "$idx.pigeon-start";',
      'const g = "metadata.pigeon";',
    ].join("\n")
  );
  assert.deepEqual(
    hits.map((hit) => hit.line),
    [1, 2, 3]
  );
});

test("非测试源码只有路径模块含字面量 .pigeon", () => {
  const files = sourceFiles(SRC);
  assert.ok(files.length > 100, `应扫到 src/ 下的源码，实际 ${files.length} 个——疑似空转`);
  const violations = files
    .filter((file) => path.relative(SRC, file) !== PATHS_MODULE)
    .flatMap((file) =>
      pigeonLiterals(readFileSync(file, "utf8")).map(
        (hit) => `${path.relative(SRC, file)}:${hit.line}：${hit.text}`
      )
    );
  assert.deepEqual(violations, [], "请改走 src/state/paths.ts");
  // 路径模块自身确实含有（检测器在真实文件上有效）
  assert.ok(pigeonLiterals(readFileSync(path.join(SRC, PATHS_MODULE), "utf8")).length > 0);
});
