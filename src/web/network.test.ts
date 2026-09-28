// 内网防护与安全抓取（决策 289）：非公网地址一律拒绝（含域名解析到内网）；跨主机跳转不跟随；同主机跳转逐跳重校验；
// 正文按上限截断。传输层与 DNS 解析都注入，不真的连外网。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isPublicIp,
  readBodyCapped,
  resolvePublicHttpUrl,
  safeFetch,
  type Transport,
  UnsafeUrlError,
  WebFetchError,
} from "./network.ts";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 as const }];

test("内网防护：回环、内网、链路本地、云元数据、保留段、IPv6 本地与内嵌 IPv4 的字面量、localhost、带凭据与非 http 网址一律拒绝", async () => {
  const rejected = [
    "http://127.0.0.1/private",
    "http://0.0.0.0/private",
    "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.1/private",
    "http://172.16.5.5/private",
    "http://192.168.1.1/private",
    "http://100.64.0.1/cgnat",
    "http://192.0.2.1/documentation",
    "http://198.51.100.1/documentation",
    "http://203.0.113.1/documentation",
    "http://[::1]/private",
    "http://[::ffff:127.0.0.1]/mapped",
    "http://[::ffff:c0a8:101]/mapped-hex",
    "http://[64:ff9b::7f00:1]/nat64",
    "http://[fe80::1]/link-local",
    "http://[fc00::1]/unique-local",
    "http://localhost/",
    "http://api.localhost/",
    "ftp://example.com/file",
    "http://user:secret@example.com/",
    "not a url",
  ];
  for (const url of rejected) {
    await assert.rejects(resolvePublicHttpUrl(url, { lookup: publicLookup }), UnsafeUrlError, url);
  }
  const ok = await resolvePublicHttpUrl("https://example.com/page?q=1", { lookup: publicLookup });
  assert.equal(ok.url.href, "https://example.com/page?q=1");
  assert.deepEqual(ok.addresses, [{ address: "93.184.216.34", family: 4 }]);
});

test("内网防护：域名解析到内网地址也拒绝（任一地址非公网即拒，报错点名该地址）；解析不出拒绝", async () => {
  const mixed = async () => [
    { address: "93.184.216.34", family: 4 as const },
    { address: "10.0.0.5", family: 4 as const },
  ];
  await assert.rejects(
    resolvePublicHttpUrl("https://intranet.example/", { lookup: mixed }),
    (error) => {
      assert.ok(error instanceof UnsafeUrlError);
      assert.match(error.message, /intranet\.example/);
      assert.match(error.message, /10\.0\.0\.5/);
      return true;
    }
  );
  await assert.rejects(
    resolvePublicHttpUrl("https://nowhere.example/", { lookup: async () => [] }),
    /无法解析/
  );
  await assert.rejects(
    resolvePublicHttpUrl("https://boom.example/", {
      lookup: async () => {
        throw new Error("dns down");
      },
    }),
    /无法解析/
  );
});

test("公网地址判定表：公网 IPv4 / IPv6 放行，其余拒绝", () => {
  for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700::1111", "2001:4860:4860::8888"]) {
    assert.equal(isPublicIp(address), true, address);
  }
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "192.168.0.1",
    "169.254.1.1",
    "224.0.0.1",
    "::1",
    "fe80::1",
    "fd00::1",
    "2001:db8::1",
    "::ffff:10.0.0.1",
    "64:ff9b::a00:1",
    "not-an-ip",
  ]) {
    assert.equal(isPublicIp(address), false, address);
  }
});

function redirectTo(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

test("跨主机跳转不跟随：交回跳转目标，不再发第二次请求", async () => {
  const calls: string[] = [];
  const transport: Transport = async (url) => {
    calls.push(url.href);
    return redirectTo("https://other.example/landing?x=1");
  };
  const outcome = await safeFetch(
    "https://start.example/go",
    {},
    { lookup: publicLookup, transport }
  );
  assert.equal(outcome.kind, "cross-host-redirect");
  if (outcome.kind === "cross-host-redirect") {
    assert.equal(outcome.from.href, "https://start.example/go");
    assert.equal(outcome.to.href, "https://other.example/landing?x=1");
  }
  assert.deepEqual(calls, ["https://start.example/go"]);
});

test("同主机跳转跟随并逐跳重校验：第二跳的解析落到内网即拒绝（防 DNS 重绑定），不发第二次请求", async () => {
  let lookups = 0;
  const rebinding = async () => {
    lookups += 1;
    return lookups === 1
      ? [{ address: "93.184.216.34", family: 4 as const }]
      : [{ address: "127.0.0.1", family: 4 as const }];
  };
  const calls: string[] = [];
  const transport: Transport = async (url) => {
    calls.push(url.href);
    return redirectTo("/next");
  };
  await assert.rejects(
    safeFetch("https://same.example/first", {}, { lookup: rebinding, transport }),
    UnsafeUrlError
  );
  assert.deepEqual(calls, ["https://same.example/first"]);
  assert.equal(lookups, 2);
});

test("同主机跳转跟随：相对地址与协议升级都按同一主机处理；超过上限报错", async () => {
  const calls: string[] = [];
  const transport: Transport = async (url) => {
    calls.push(url.href);
    if (url.pathname === "/first") {
      return redirectTo("/second", 301);
    }
    if (url.pathname === "/second") {
      return redirectTo("https://same.example/third");
    }
    return new Response("done", { status: 200 });
  };
  const outcome = await safeFetch(
    "http://same.example/first",
    {},
    { lookup: publicLookup, transport }
  );
  assert.equal(outcome.kind, "response");
  if (outcome.kind === "response") {
    assert.equal(outcome.url.href, "https://same.example/third");
    assert.equal(await outcome.response.text(), "done");
  }
  assert.deepEqual(calls, [
    "http://same.example/first",
    "http://same.example/second",
    "https://same.example/third",
  ]);

  const loop: Transport = async () => redirectTo("/again");
  await assert.rejects(
    safeFetch(
      "https://loop.example/a",
      {},
      { lookup: publicLookup, transport: loop, maxRedirects: 2 }
    ),
    (error) => error instanceof WebFetchError && /超过 2 次/.test(error.message)
  );
});

test("正文按上限截断：超过上限只留前 N 字节并标记；恰好读完或未超不标记", async () => {
  const body = "abcdefghij";
  const over = await readBodyCapped(new Response(body), 4);
  assert.equal(new TextDecoder().decode(over.bytes), "abcd");
  assert.equal(over.truncated, true);
  const exact = await readBodyCapped(new Response(body), 10);
  assert.equal(new TextDecoder().decode(exact.bytes), body);
  assert.equal(exact.truncated, false);
  const under = await readBodyCapped(new Response(body), 100);
  assert.equal(under.truncated, false);
  const empty = await readBodyCapped(new Response(null, { status: 204 }), 100);
  assert.equal(empty.bytes.byteLength, 0);
});
