// .pigeon/web.json 读取（决策 288、289）：缺失即未配置；合法即原样交回；不是 JSON 或不合 schema 响亮失败，报错不回显字段的值。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadWebConfig, WebConfigError, webConfigPath } from "./web-config.ts";

function withRoot(body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pigeon-web-config-"));
  try {
    mkdirSync(join(root, ".pigeon"), { recursive: true });
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("文件缺失 = 未配置；合法配置原样交回", () => {
  withRoot((root) => {
    assert.equal(loadWebConfig(root), undefined);
    const config = {
      version: 1,
      search: { backend: "zai", maxResults: 8, zai: { apiKey: "sk-secret" } },
      fetch: { timeoutMs: 1000, maxBytes: 2048 },
    };
    writeFileSync(webConfigPath(root), JSON.stringify(config));
    assert.deepEqual(loadWebConfig(root), config);
  });
});

test("不是 JSON、schema 不符（未知后端、版本不对、条数越界）都响亮失败；报错不回显 key 的值", () => {
  withRoot((root) => {
    writeFileSync(webConfigPath(root), "{ nope");
    assert.throws(() => loadWebConfig(root), WebConfigError);
    for (const bad of [
      { version: 1, search: { backend: "bing" } },
      { version: 2 },
      { version: 1, search: { maxResults: 50 } },
      {
        version: 1,
        search: { tavily: { apiKey: "sk-secret-value-here" } },
        fetch: { maxBytes: 0 },
      },
    ]) {
      writeFileSync(webConfigPath(root), JSON.stringify(bad));
      assert.throws(
        () => loadWebConfig(root),
        (error: unknown) => {
          assert.ok(error instanceof WebConfigError);
          assert.ok(!error.message.includes("sk-secret-value-here"), error.message);
          return true;
        }
      );
    }
  });
});
