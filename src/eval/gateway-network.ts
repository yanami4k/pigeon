// 跑批的"只通网关"网络档（实验设施，只给外部 agent 条件）：每次跑批建一张 docker 内部网络（--internal，不通外网，
// 名字带跑批前缀），跑批进程内置的模型网关再听这张网络在宿主一侧的地址（网桥的网关地址）；外部 agent 条件的作业容器接这张
// 网络，经网关地址只能连到模型网关。Pigeon 进程内条件与最简 agent 的作业容器照旧 --network none（WORKSPACE_NETWORK_ARGS），
// 不接这张网络。网桥关掉容器之间的互连（enable_icc=false）：外部 agent 条件的作业容器彼此连不通，各自只能连到宿主一侧。
// 跑批结束与开跑前的残留清理都删它：先强制移除仍接在网络上的容器（都是本跑批的作业容器），再删网络。
import { dockerOnce } from "../execution/container-host.ts";

export interface GatewayNetwork {
  name: string;
  // 宿主一侧的地址（网关在这里监听）
  hostAddress: string;
}

export function gatewayNetworkName(prefix: string): string {
  return `${prefix}-gateway-net`;
}

// 作业容器接这张网络的参数（代替 --network none）
export function gatewayNetworkArgs(network: GatewayNetwork): string[] {
  return ["--network", network.name];
}

// 建网络（同名残留先删掉），取宿主一侧的地址
export async function createGatewayNetwork(
  prefix: string,
  docker: readonly string[] = ["docker"]
): Promise<GatewayNetwork> {
  const name = gatewayNetworkName(prefix);
  await removeGatewayNetwork(name, docker);
  const created = await dockerOnce(
    docker,
    [
      "network",
      "create",
      "--internal",
      "-o",
      "com.docker.network.bridge.enable_icc=false",
      "--label",
      `pigeon.stream=${prefix}`,
      name,
    ],
    60_000
  );
  if (created.exitCode !== 0) {
    throw new Error(`建跑批内部网络 ${name} 失败：${created.stderr.trim()}`);
  }
  const inspected = await dockerOnce(
    docker,
    ["network", "inspect", "--format", "{{range .IPAM.Config}}{{.Gateway}} {{end}}", name],
    60_000
  );
  const hostAddress = inspected.stdout
    .toString("utf8")
    .trim()
    .split(/\s+/)
    .find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  if (inspected.exitCode !== 0 || hostAddress === undefined) {
    await removeGatewayNetwork(name, docker).catch(() => {});
    throw new Error(
      `取不到跑批内部网络 ${name} 在宿主一侧的地址：${(inspected.stderr || inspected.stdout.toString("utf8")).trim()}`
    );
  }
  return { name, hostAddress };
}

// 删网络：先强制移除仍接在上面的容器，再删；网络本就不存在视为已删
export async function removeGatewayNetwork(
  name: string,
  docker: readonly string[] = ["docker"]
): Promise<void> {
  const attached = await dockerOnce(
    docker,
    ["network", "inspect", "--format", "{{range .Containers}}{{.Name}} {{end}}", name],
    60_000
  );
  if (attached.exitCode !== 0) {
    if (/not found|No such network/i.test(attached.stderr)) return;
    throw new Error(`查看跑批内部网络 ${name} 失败：${attached.stderr.trim()}`);
  }
  for (const container of attached.stdout.toString("utf8").trim().split(/\s+/).filter(Boolean)) {
    await dockerOnce(docker, ["rm", "-f", container], 120_000);
  }
  const removed = await dockerOnce(docker, ["network", "rm", name], 60_000);
  if (removed.exitCode !== 0 && !/not found|No such network/i.test(removed.stderr)) {
    throw new Error(`删跑批内部网络 ${name} 失败：${removed.stderr.trim()}`);
  }
}

// 网络是否还在（测试与审计用）
export async function gatewayNetworkExists(
  name: string,
  docker: readonly string[] = ["docker"]
): Promise<boolean> {
  const r = await dockerOnce(docker, ["network", "inspect", "--format", "{{.Name}}", name], 60_000);
  return r.exitCode === 0;
}
