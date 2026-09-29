// 编排脚本里 agent 的输出格式（决策 310、313）：按一份 JSON Schema 校验 worker 交回的数据。零依赖零 IO 的纯函数，
// 支持常用的关键字——type（可为数组）、enum、const、properties、required、additionalProperties（false 或子格式）、items、
// minItems、maxItems、minLength、maxLength、minimum、maximum、anyOf；其余关键字不校验。返回不合之处（空即合格式），
// 每条写明位置（$ 为根）。
export type JsonSchema = Record<string, unknown>;

const MAX_PROBLEMS = 20;

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function typeMatches(expected: string, value: unknown): boolean {
  const actual = typeOf(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  return expected === actual;
}

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function check(schema: JsonSchema, value: unknown, at: string, problems: string[]): void {
  if (problems.length >= MAX_PROBLEMS) return;
  const type = schema.type;
  if (type !== undefined) {
    const types = Array.isArray(type) ? type.map(String) : [String(type)];
    if (!types.some((expected) => typeMatches(expected, value))) {
      problems.push(`${at}：应为 ${types.join(" 或 ")}，实际为 ${typeOf(value)}`);
      return;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => sameJson(item, value))) {
    problems.push(`${at}：应为 ${schema.enum.map((item) => JSON.stringify(item)).join("、")} 之一`);
  }
  if ("const" in schema && !sameJson(schema.const, value)) {
    problems.push(`${at}：应为 ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.anyOf)) {
    const matched = schema.anyOf.some((option) => {
      if (!isSchema(option)) return false;
      const inner: string[] = [];
      check(option, value, at, inner);
      return inner.length === 0;
    });
    if (!matched) problems.push(`${at}：不合 anyOf 里的任何一种`);
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && [...value].length < schema.minLength) {
      problems.push(`${at}：至少 ${schema.minLength} 个字符`);
    }
    if (typeof schema.maxLength === "number" && [...value].length > schema.maxLength) {
      problems.push(`${at}：至多 ${schema.maxLength} 个字符`);
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      problems.push(`${at}：不能小于 ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      problems.push(`${at}：不能大于 ${schema.maximum}`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      problems.push(`${at}：至少 ${schema.minItems} 项`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      problems.push(`${at}：至多 ${schema.maxItems} 项`);
    }
    if (isSchema(schema.items)) {
      const items = schema.items;
      value.forEach((item, index) => {
        check(items, item, `${at}[${index}]`, problems);
      });
    }
  }
  if (typeOf(value) === "object") {
    const record = value as Record<string, unknown>;
    const properties = isSchema(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !(key in record)) {
          problems.push(`${at}：缺少必填项 ${key}`);
        }
      }
    }
    for (const [key, item] of Object.entries(record)) {
      const sub = properties[key];
      if (isSchema(sub)) {
        check(sub, item, `${at}.${key}`, problems);
      } else if (schema.additionalProperties === false) {
        problems.push(`${at}：不允许多出的项 ${key}`);
      } else if (isSchema(schema.additionalProperties)) {
        check(schema.additionalProperties, item, `${at}.${key}`, problems);
      }
    }
  }
}

// 校验：返回不合之处；schema 本身不是对象即一条说明
export function checkJsonSchema(schema: unknown, value: unknown): string[] {
  if (!isSchema(schema)) {
    return ["输出格式须为一个 JSON Schema 对象"];
  }
  const problems: string[] = [];
  check(schema, value, "$", problems);
  return problems;
}

// 规范化：键按字母序，用于指纹（同一格式不因键序不同而算两份）
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
