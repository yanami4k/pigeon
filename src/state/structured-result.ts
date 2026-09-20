// 模型输出里的结构化结果（M6，决策 064）：从末条 assistant 正文里抠出一个 JSON 对象。
// 零依赖零 IO 的纯文本解析；提炼器与审阅器共用同一口径，解析不了即视为没有结构化结果
// （由消费方判定"结果不可解析"），本函数不抛。
//
// 认的四种形态，按这个顺序：
//   1. ```json 围栏（M7 起允许围栏前后有文字）——模型常先写分析文字再给围栏，取最后一个能解析成对象的围栏块；
//   2. 整段正文就是一个 JSON 对象；
//   3. 正文里第一个 { 到最后一个 } 之间的那一段；
// 以 ``` 开头却没有任何可解析围栏的，直接判为没有结果——不去正文里瞎找，
// 那通常意味着模型给的是别的语言的代码块。数组不算结构化结果：约定的产物都是对象。

function asObject(body: string): unknown {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

export function structuredResultOf(text: string): unknown {
  const trimmed = text.trim();
  const fenced = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/g)]
    .map((match) => asObject(match[1] ?? ""))
    .filter((value) => value !== undefined);
  if (fenced.length > 0) {
    return fenced.at(-1);
  }
  if (trimmed.startsWith("```")) {
    return undefined;
  }
  const whole = asObject(trimmed);
  if (whole !== undefined) {
    return whole;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? asObject(trimmed.slice(start, end + 1)) : undefined;
}
