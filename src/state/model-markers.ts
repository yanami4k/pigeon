// 给模型看、又被程序认回来的固定文字（决策 428）：写的地方用英文；认的地方连同 428 之前的中文一起认——旧会话记录里是中文。
// 只放跨层共用的；只在一个模块里写、在同模块或上层认的，就近定义并在旁边留中文旧说法

// run_command 结果正文里文件变化一段的开头（tools/run-command.ts 写，pi-runtime/context-prune.ts 截取）
export const FILE_CHANGES_HEAD = "File changes:";
export const LEGACY_FILE_CHANGES_HEAD = "文件变化：";

// 正文里最后一段文件变化的起点（含前面的换行）；新旧说法都认，没有为 -1
export function lastFileChangesAt(text: string): number {
  return Math.max(
    text.lastIndexOf(`\n${FILE_CHANGES_HEAD}`),
    text.lastIndexOf(`\n${LEGACY_FILE_CHANGES_HEAD}`)
  );
}
