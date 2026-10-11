// 结果里怎么回显命令（决策 421）：模型自己发出的命令已在它的工具调用参数里、随历史每轮重发（上下文裁剪只换工具结果的正文，
// 不碰调用参数），结果里再整段回显就是第二份——用 heredoc 写文件时整份内容会出现两次。结果里只回显开头：首行、至多
// COMMAND_ECHO_CHARS 字，省略了的注明共几行（单行时共几字）、完整命令在哪。作业列表与通知里用更短的标识。
// 用了短名时模型发出的只是短名，展开后的完整命令照旧整段给出，由调用方判断，不经这里。纯函数。
export const COMMAND_ECHO_CHARS = 200;
export const COMMAND_LABEL_CHARS = 80;

interface Shape {
  first: string;
  lines: number;
  chars: number;
}

// 末尾的空白不算一行
function shapeOf(command: string): Shape {
  const body = command.replace(/\s+$/, "");
  const lines = body.split(/\r?\n/);
  return { first: lines[0] ?? "", lines: lines.length, chars: body.length };
}

function clipped(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// run_command 结果与报错里的回显；where 说明完整命令在哪
export function commandEcho(command: string, where = "本次调用"): string {
  const shape = shapeOf(command);
  if (shape.lines === 1 && shape.first.length <= COMMAND_ECHO_CHARS) return command;
  const total = shape.lines > 1 ? `共 ${shape.lines} 行` : `共 ${shape.chars} 字`;
  return `${clipped(shape.first, COMMAND_ECHO_CHARS)}（${total}，其余已省略，完整命令见${where}）`;
}

// 后台作业在作业列表、作业输出与通知里的简短标识
export function commandLabel(command: string): string {
  const shape = shapeOf(command);
  if (shape.lines === 1 && shape.first.length <= COMMAND_LABEL_CHARS) return command;
  const head = clipped(shape.first, COMMAND_LABEL_CHARS);
  return shape.lines > 1
    ? `${head.endsWith("…") ? head : `${head}…`}（共 ${shape.lines} 行）`
    : head;
}
