// 行级 diff：最长公共子序列（LCS）求出把一侧变成另一侧的最短增删脚本。
// 纯算法、零依赖零 IO；与 tools/hashline.ts 的 buildEditDiff 不是一回事——那边渲染的是
// 已知坐标的编辑（改了哪几行是输入，不需要推断），这边要从两段文本自己推出改动。
//
// 输出是逐行前缀记号：空格 = 未变、- = 删、+ = 加。不带 hunk 头也不带上下文裁剪，
// 排版与文案由调用方决定。
export function lineDiff(oldLines: readonly string[], newLines: readonly string[]): string[] {
  const rows = oldLines.length;
  const columns = newLines.length;
  // lcs[i][j] = oldLines[i..] 与 newLines[j..] 的最长公共子序列长度
  const lcs: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(columns + 1).fill(0)
  );
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = columns - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      const next = lcs[i + 1] as number[];
      row[j] =
        oldLines[i] === newLines[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  // 回溯：两边相同就并进，否则按哪一侧的剩余 LCS 更长决定先删还是先加
  while (i < rows && j < columns) {
    if (oldLines[i] === newLines[j]) {
      out.push(` ${oldLines[i]}`);
      i++;
      j++;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      out.push(`-${oldLines[i]}`);
      i++;
    } else {
      out.push(`+${newLines[j]}`);
      j++;
    }
  }
  for (; i < rows; i++) {
    out.push(`-${oldLines[i]}`);
  }
  for (; j < columns; j++) {
    out.push(`+${newLines[j]}`);
  }
  return out;
}
