// 测试夹具：真 docker 与实验镜像的门控（服务器上都有，本机或 CI 缺一即跳过）。只供测试使用。
import { execFileSync } from "node:child_process";

export const REAL_IMAGE = process.env.PIGEON_STREAM_TEST_IMAGE ?? "pigeon-stream-pigeon:v4";

export function realDockerSkip(image: string = REAL_IMAGE): string | false {
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" });
    return false;
  } catch {
    return `没有 docker 或镜像 ${image}`;
  }
}
