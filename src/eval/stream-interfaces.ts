// 题面接口说明的数据文件（374）：分析包在开跑前按规则算出并入库（eval/analysis/data/task-interfaces.json），
// 按清单摘要与步号给出每题的接口说明。跑批器给了 --task-interfaces 才读：清单摘要与本次清单不符即拒绝开跑，
// 文件内容的摘要进身份头
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { TaskInterfaceModule } from "./stream-manifest.ts";

export interface TaskInterfaces {
  // 数据文件的摘要（内容逐字的 sha256 取前 16 位，同清单摘要的算法）
  digest: string;
  // 步号（清单里的 seq）→ 该题的接口说明；没有内容的题不在其中
  bySeq: ReadonlyMap<number, readonly TaskInterfaceModule[]>;
}

interface TaskInterfacesFile {
  manifestDigest?: unknown;
  tasks?: unknown;
}

export function readTaskInterfaces(file: string, manifestDigest: string): TaskInterfaces {
  const raw = readFileSync(file);
  const data = JSON.parse(raw.toString("utf8")) as TaskInterfacesFile;
  if (data.manifestDigest !== manifestDigest) {
    throw new Error(
      `接口数据文件 ${file} 的清单摘要（${String(data.manifestDigest)}）与本次清单的（${manifestDigest}）不符，拒绝开跑：用本次清单重新生成接口数据`
    );
  }
  if (!Array.isArray(data.tasks)) throw new Error(`接口数据文件 ${file} 没有 tasks 列表`);
  const bySeq = new Map<number, readonly TaskInterfaceModule[]>();
  for (const t of data.tasks as { seq?: unknown; interfaces?: unknown }[]) {
    if (typeof t.seq !== "number" || !Array.isArray(t.interfaces)) {
      throw new Error(`接口数据文件 ${file} 的题缺 seq 或 interfaces`);
    }
    if (t.interfaces.length > 0) bySeq.set(t.seq, t.interfaces as TaskInterfaceModule[]);
  }
  return { digest: createHash("sha256").update(raw).digest("hex").slice(0, 16), bySeq };
}
