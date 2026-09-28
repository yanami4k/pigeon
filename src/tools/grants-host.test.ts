// 按网站放权的匹配（决策 290）：带 host 的放权只命中网址主机名一模一样的调用（不区分大小写）；换主机不命中；
// 调用没有网址或网址不合法不命中；固化规则与会话放权同一判定。
import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import { newGrantId, newSessionId } from "../state/ids.ts";
import { matchConfigGrants, scopeMatches } from "./grants.ts";
import { hostOfUrl, hostOfUrlArg, WEB_FETCH_TOOL } from "./host-scope.ts";

test("主机名提取：http(s) 网址取小写主机名；其他协议、无主机与畸形网址取不到", () => {
  assert.equal(hostOfUrl("HTTPS://Docs.Example.COM:8443/a?b=c"), "docs.example.com");
  assert.equal(hostOfUrl("http://[2001:db8::1]/"), "2001:db8::1");
  assert.equal(hostOfUrl("ftp://docs.example.com/"), undefined);
  assert.equal(hostOfUrl("nope"), undefined);
  assert.equal(hostOfUrlArg({ url: "https://a.example/x" }), "a.example");
  assert.equal(hostOfUrlArg({ path: "a" }), undefined);
  assert.equal(hostOfUrlArg({ url: "" }), undefined);
  assert.equal(hostOfUrlArg(null), undefined);
});

test("scopeMatches：host 与调用网址的主机名一致才命中；大小写无关；换主机、无网址、工具名不同都不命中", () => {
  const match = (args: unknown, host: string, tool = WEB_FETCH_TOOL) =>
    scopeMatches(
      undefined,
      WEB_FETCH_TOOL,
      undefined,
      tool,
      args,
      undefined,
      undefined,
      undefined,
      host
    );
  assert.equal(match({ url: "https://docs.example/a" }, "docs.example"), true);
  assert.equal(match({ url: "https://DOCS.example/b?x=1" }, "Docs.Example"), true);
  assert.equal(match({ url: "https://api.docs.example/" }, "docs.example"), false, "不做子域");
  assert.equal(match({ url: "https://other.example/" }, "docs.example"), false);
  assert.equal(match({ prompt: "x" }, "docs.example"), false);
  assert.equal(match({ url: "not a url" }, "docs.example"), false);
  assert.equal(match({ url: "https://docs.example/" }, "docs.example", "web_search"), false);
  // 不带 host 的工具级放权照旧命中任何主机
  assert.equal(
    scopeMatches(undefined, WEB_FETCH_TOOL, undefined, WEB_FETCH_TOOL, {
      url: "https://x.example/",
    }),
    true
  );
});

test("固化规则与会话放权：带 host 的规则命中回指稳定身份；换主机继续下行不命中", () => {
  const grantId = newGrantId();
  const rules = [
    {
      tool: WEB_FETCH_TOOL,
      host: "docs.example",
      promotedFrom: {
        grantId,
        sessionId: newSessionId(),
        firstCall: { toolCallId: "toolu_01", args: { url: "https://docs.example/a" } },
        promotedAt: 1,
      },
    },
  ];
  assert.deepEqual(
    matchConfigGrants(rules, undefined, WEB_FETCH_TOOL, { url: "https://docs.example/b" }),
    { source: "config-rule", refId: grantId }
  );
  assert.equal(
    matchConfigGrants(rules, undefined, WEB_FETCH_TOOL, { url: "https://x.example/" }),
    null
  );

  const store = new SessionGrantStore({ workspaceRoot: "/nonexistent" });
  const grant = store.create({
    tool: WEB_FETCH_TOOL,
    host: "docs.example",
    firstCall: { toolCallId: "toolu_02", args: { url: "https://docs.example/a" } },
  });
  assert.equal(grant.host, "docs.example");
  assert.deepEqual(store.match(WEB_FETCH_TOOL, { url: "https://docs.example/c" }), {
    source: "session-grant",
    refId: grant.grantId,
  });
  assert.equal(store.match(WEB_FETCH_TOOL, { url: "https://x.example/c" }), null);
  // 冷恢复种子带 host
  const { hitCount: _hitCount, ...active } = grant;
  const restored = new SessionGrantStore({ workspaceRoot: "/nonexistent", restored: [active] });
  assert.equal(restored.list()[0]?.host, "docs.example");
  assert.notEqual(restored.match(WEB_FETCH_TOOL, { url: "https://docs.example/z" }), null);
});
