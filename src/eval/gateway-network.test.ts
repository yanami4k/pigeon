// 只通网关的网络档（真容器，实验设施）：跑批内部网络建好后，网关再听它在宿主一侧的地址；接这张网络的容器能连到网关
// （假上游），连不上公网（任选一个公网 IP 的 443 端口）、解析不了公网域名；探测容器能连到宿主在这张网络上的哪些端口
// （PIGEON_GATEWAY_NET_SCAN=1 时扫全部端口，否则扫常见端口与网关端口），结果打在测试的诊断输出里；删网络后网络不在。
// 需要真 docker 与实验镜像（服务器上都有），本机缺一即跳过。
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { promisify } from "node:util";
import { removeWorkspaceContainer, startWorkspaceContainer } from "../execution/container-host.ts";
import {
  createGatewayNetwork,
  gatewayNetworkExists,
  gatewayNetworkName,
  removeGatewayNetwork,
} from "./gateway-network.ts";
import { startModelGateway } from "./model-gateway.ts";
import { LimitController } from "./model-limits.ts";
import { REAL_IMAGE, realDockerSkip } from "./real-docker-fixtures.ts";

const execFileAsync = promisify(execFile);

// 在容器里用镜像自带的 node 跑一段探测脚本，取最后一行 JSON。须异步执行：网关就在本进程里，同步等子进程会卡住事件循环，
// 容器发来的请求无人应答
async function probeInContainer(
  container: string,
  script: string
): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync("docker", ["exec", container, "node", "-e", script], {
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
}

const probeScript = (args: readonly string[]) => `
const ARGS = ${JSON.stringify(args)};
const net = require("node:net");
const dns = require("node:dns").promises;
const tcp = (host, port, ms) => new Promise((resolve) => {
  const s = net.connect({ host, port });
  const done = (r) => { s.destroy(); resolve(r); };
  s.setTimeout(ms, () => done("timeout"));
  s.on("connect", () => done("open"));
  s.on("error", (e) => done(e.code || "error"));
});
(async () => {
  const [base, publicIp, hostAddr, portsSpec] = ARGS;
  const out = {};
  try {
    const r = await fetch(base + "/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": "placeholder" }, body: "{\\"stream\\":true}" });
    out.gateway = r.status; await r.text();
  } catch (e) { out.gateway = "error: " + e.message; }
  out.publicTcp = await tcp(publicIp, 443, 3000);
  try { const a = await dns.lookup("example.com"); out.dns = "resolved " + a.address; } catch (e) { out.dns = e.code || "error"; }
  const ports = portsSpec === "all" ? Array.from({ length: 65535 }, (_, i) => i + 1) : portsSpec.split(",").map(Number);
  const open = [];
  let i = 0;
  const worker = async () => { while (i < ports.length) { const p = ports[i++]; if ((await tcp(hostAddr, p, 300)) === "open") open.push(p); } };
  await Promise.all(Array.from({ length: 400 }, worker));
  out.openHostPorts = open.sort((a, b) => a - b);
  out.scanned = ports.length;
  console.log(JSON.stringify(out));
})();
`;

test("只通网关的网络（真容器）：容器能连到网关、连不上公网与公网 DNS；宿主在这张网络上能连的端口如实列出；跑批结束删网络", {
  skip: realDockerSkip(),
  timeout: 900_000,
}, async (t) => {
  const prefix = `pigeon-gwnet-test-${process.pid}`;
  const container = `${prefix}-job`;
  const seen: string[] = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.url ?? "");
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"usage":{"input_tokens":1,"output_tokens":1}}');
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const limits = new LimitController({
    probe: async () => true,
    slots: 2,
    sleep: () => new Promise(() => {}),
    warn: () => {},
  });
  const gateway = await startModelGateway({
    upstreamBaseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    accounts: [{ key: "key-one", concurrency: 2 }],
    limits,
    probeRequest: { path: "/v1/messages", body: { max_tokens: 1 } },
    warn: () => {},
  });
  let networkName: string | undefined;
  try {
    const network = await createGatewayNetwork(prefix);
    networkName = network.name;
    assert.equal(network.name, gatewayNetworkName(prefix));
    assert.match(network.hostAddress, /^\d+\.\d+\.\d+\.\d+$/);
    const internalBase = await gateway.listenInternal(network.hostAddress);
    const gatewayPort = Number(new URL(internalBase).port);
    await startWorkspaceContainer({
      image: REAL_IMAGE,
      name: container,
      runArgs: ["--network", network.name, "--label", `pigeon.stream=${prefix}`],
    });
    const ports =
      process.env.PIGEON_GATEWAY_NET_SCAN === "1"
        ? "all"
        : [22, 53, 80, 111, 443, 2375, 2376, 3000, 5000, 8080, gatewayPort].join(",");
    const result = await probeInContainer(
      container,
      probeScript([
        gateway.jobBaseUrl("s|ext-x|1", { on: "internal" }),
        "1.1.1.1",
        network.hostAddress,
        ports,
      ])
    );
    t.diagnostic(
      `宿主一侧地址上能连的端口：${JSON.stringify(result.openHostPorts)}（扫了 ${result.scanned} 个；网关端口 ${gatewayPort}）`
    );
    t.diagnostic(`公网 TCP：${result.publicTcp}；公网 DNS：${result.dns}`);
    assert.equal(result.gateway, 200, "经网关的作业地址连得通");
    assert.equal(seen.length, 1, "请求到了假上游");
    assert.notEqual(result.publicTcp, "open", "连不上公网 IP 的 443 端口");
    assert.ok(!String(result.dns).startsWith("resolved"), `解析不了公网域名：${result.dns}`);
    assert.ok((result.openHostPorts as number[]).includes(gatewayPort), "网关端口在能连的端口里");
  } finally {
    await removeWorkspaceContainer(container).catch(() => {});
    if (networkName !== undefined) {
      await removeGatewayNetwork(networkName);
      assert.equal(await gatewayNetworkExists(networkName), false, "网络已删除");
    }
    await gateway.close();
    limits.close();
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

test("删网络：接在上面的残留容器一并移除；网络本就不存在视为已删", {
  skip: realDockerSkip(),
  timeout: 300_000,
}, async () => {
  const prefix = `pigeon-gwnet-residue-${process.pid}`;
  const network = await createGatewayNetwork(prefix);
  const container = `${prefix}-left`;
  try {
    await startWorkspaceContainer({
      image: REAL_IMAGE,
      name: container,
      runArgs: ["--network", network.name],
    });
    // 同名网络再建一次（开跑前的残留清理）：旧网络连同接在上面的容器一并清掉
    const again = await createGatewayNetwork(prefix);
    assert.equal(again.name, network.name);
    const left = execFileSync("docker", ["ps", "-aq", "--filter", `name=^${container}$`], {
      encoding: "utf8",
    }).trim();
    assert.equal(left, "", "残留容器已移除");
  } finally {
    await removeWorkspaceContainer(container).catch(() => {});
    await removeGatewayNetwork(network.name);
    await removeGatewayNetwork(network.name);
    assert.equal(await gatewayNetworkExists(network.name), false);
  }
});
