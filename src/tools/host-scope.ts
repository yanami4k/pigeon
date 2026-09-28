// 按网站放权的作用域（决策 290）：网络档工具（web_fetch）的放权以网址的主机名限定——第一次访问某网站时问人，
// 选"以后都允许"即放行该网站；换一个网站仍要问。主机名取自调用参数 args.url（WHATWG 解析后的 hostname，小写），
// 与 pathPrefix 取 args.path、command 取 args.command 同一约定：无 url 参数或解析失败 = 定位不到主机，
// 带 host 的放权不命中（fail-closed 到人工审批）。
// 治理层经 inspectHost 能力（结构检查，与 exec 档的 inspectCommand 同做法）问工具这次调用要访问哪个主机，
// 交给审批面板显示与建放权。

export const WEB_SEARCH_TOOL = "web_search";
export const WEB_FETCH_TOOL = "web_fetch";

// 声明了按网站审批能力的工具：只读检查，返回这次调用将访问的主机名；定位不到返回 undefined
export interface HostScopedTool {
  inspectHost(params: unknown): string | undefined;
}

// 主机名的规范形：小写，去掉 IPv6 字面量的方括号
export function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
}

// 取网址的主机名；不是合法的 http(s) 网址返回 undefined
export function hostOfUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") {
    return undefined;
  }
  return normalizeHost(url.hostname);
}

// 取调用参数里的网址主机名：只认 args.url 字符串
export function hostOfUrlArg(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || !("url" in args)) {
    return undefined;
  }
  const url = (args as { url: unknown }).url;
  return typeof url === "string" && url.length > 0 ? hostOfUrl(url) : undefined;
}
