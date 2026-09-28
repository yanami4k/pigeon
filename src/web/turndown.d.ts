// turndown 7.2.0（MIT）没有自带类型声明；这里只声明本仓库用到的一小部分接口，不引入 @types/turndown。
declare module "turndown" {
  interface TurndownNode {
    nodeName: string;
    getAttribute(name: string): string | null;
  }
  interface TurndownOptions {
    headingStyle?: "setext" | "atx";
    codeBlockStyle?: "indented" | "fenced";
    bulletListMarker?: "-" | "+" | "*";
    emDelimiter?: "_" | "*";
    strongDelimiter?: "__" | "**";
  }
  interface TurndownRule {
    filter: string | string[] | ((node: TurndownNode) => boolean);
    replacement: (content: string, node: TurndownNode) => string;
  }
  class TurndownService {
    constructor(options?: TurndownOptions);
    turndown(html: string): string;
    remove(filter: string | string[]): this;
    addRule(key: string, rule: TurndownRule): this;
  }
  export default TurndownService;
}
