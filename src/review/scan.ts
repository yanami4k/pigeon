// 候选的确定性扫描（M6 S3，决策 065 子裁决 ④）：规则可复查、结果可复现，扫描器版本随结果落盘。
// 命中只把候选标为"扫描拒收"——正文照常暂存（复查与改进规则的素材），永不参与激活、缺省不出现在列表里。
// 模型筛查只作建议标注，不参与判决（§3.8）。
export const SCANNER_VERSION = "1";

export type ScanRule = "invisible-char" | "injection" | "exfiltration" | "executable";

export interface ScanHit {
  rule: ScanRule;
  // 人读的命中说明（文件、字符码位或匹配片段）
  detail: string;
}

export interface ScanResult {
  scannerVersion: string;
  hits: ScanHit[];
}

// 不可见字符：Unicode Tags、零宽、双向控制、变体选择符
const INVISIBLE_RANGES: ReadonlyArray<{ label: string; from: number; to: number }> = [
  { label: "Unicode Tags", from: 0xe0000, to: 0xe007f },
  { label: "零宽字符", from: 0x200b, to: 0x200d },
  { label: "零宽字符", from: 0x2060, to: 0x2060 },
  { label: "零宽字符", from: 0xfeff, to: 0xfeff },
  { label: "双向控制", from: 0x200e, to: 0x200f },
  { label: "双向控制", from: 0x202a, to: 0x202e },
  { label: "双向控制", from: 0x2066, to: 0x2069 },
  { label: "变体选择符", from: 0xfe00, to: 0xfe0f },
  { label: "变体选择符", from: 0xe0100, to: 0xe01ef },
];

// 注入短语：要求模型无视既有指令或切换身份的说法
const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+instructions/i,
  /disregard\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier|your)\s+(?:instructions|rules)/i,
  /you\s+are\s+now\s+(?:in\s+)?(?:developer|dan|jailbreak)/i,
  /(?:reveal|print|show)\s+(?:your\s+)?system\s+prompt/i,
  /忽略(?:之前|以上|前面|上面|先前)(?:的)?(?:所有|全部)?(?:指令|说明|要求|规则)/,
  /无视(?:之前|以上|前面|上面)?(?:的)?(?:所有|全部)?(?:指令|规则|限制)/,
];

// 外泄模式：下载执行、密钥形态、可疑 URL（IP 直连、隧道与回传服务、查询串带凭据）
const EXFILTRATION_PATTERNS: readonly RegExp[] = [
  /\b(?:curl|wget)\b/i,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /https?:\/\/(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\/|\b)/i,
  /https?:\/\/[^\s/]*(?:ngrok|pastebin|webhook\.site|requestbin|pipedream)[^\s]*/i,
  /https?:\/\/\S*[?&](?:token|key|secret|password|api_key)=/i,
];

// 可执行脚本目录与可执行扩展名
const EXECUTABLE_PATH = /(?:^|\/)(?:scripts|bin)\/|\.(?:sh|bash|ps1|bat|cmd|exe|com)$/i;

function snippet(text: string, index: number): string {
  return text.slice(Math.max(0, index - 10), index + 30).replaceAll("\n", " ");
}

export function scanCandidateFiles(files: Readonly<Record<string, string>>): ScanResult {
  const hits: ScanHit[] = [];
  for (const [relativePath, content] of Object.entries(files)) {
    const normalizedPath = relativePath.replaceAll("\\", "/");
    if (EXECUTABLE_PATH.test(normalizedPath)) {
      hits.push({ rule: "executable", detail: `${normalizedPath}：可执行脚本目录或扩展名` });
    }
    const seen = new Set<string>();
    for (const char of content) {
      const codePoint = char.codePointAt(0) ?? 0;
      const range = INVISIBLE_RANGES.find((item) => codePoint >= item.from && codePoint <= item.to);
      if (range !== undefined) {
        const key = `${range.label}:${codePoint}`;
        if (!seen.has(key)) {
          seen.add(key);
          hits.push({
            rule: "invisible-char",
            detail: `${normalizedPath}：${range.label} U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`,
          });
        }
      }
    }
    for (const pattern of INJECTION_PATTERNS) {
      const match = pattern.exec(content);
      if (match !== null) {
        hits.push({
          rule: "injection",
          detail: `${normalizedPath}：「${snippet(content, match.index)}」`,
        });
      }
    }
    for (const pattern of EXFILTRATION_PATTERNS) {
      const match = pattern.exec(content);
      if (match !== null) {
        hits.push({
          rule: "exfiltration",
          detail: `${normalizedPath}：「${snippet(content, match.index)}」`,
        });
      }
    }
  }
  return { scannerVersion: SCANNER_VERSION, hits };
}
