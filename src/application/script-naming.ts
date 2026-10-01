// 脚本编排的点名与额度（决策 309、314）：
// - 缺省须人点名才可用：人本次输入里带关键词，或用斜杠命令发起（命令交给模型的文字带着关键词）。点名由程序判断，只认人亲手
//   输入的文字——判断只挂在"人的输入交给运行面"这一个入口上（终端界面的提交与排队输入、pigeon run 的任务描述）；模型读到的
//   网页、文件、worker 回报与完成通知都不经这个入口，里面出现关键词不算。
// - 点名只管到下一条人手输入：下一条没带关键词即收回。pigeon run 的任务描述算点名，整次运行（含回炉各轮）都算。
// - 项目配置打开"由模型判断"后，工具常驻，不看点名。
// - 额度：点名时可写"额度 ¥5"（人民币）、"额度 $2"（美元）或"额度 300k"（token，k 为千、m 为百万、万为一万）；
//   项目配置可设缺省值；都不设即不限。
export const SCRIPT_KEYWORD = "脚本编排";
export const SCRIPT_COMMAND = "orchestrate";

export interface ScriptBudget {
  unit: "cny" | "usd" | "tokens";
  amount: number;
}

const BUDGET_PATTERN = /额度\s*[:：]?\s*([¥￥$])?\s*(\d+(?:\.\d+)?)\s*([kKmM万])?/;

// 从一段文字里取额度写法；没有即 undefined
export function parseScriptBudget(text: string): ScriptBudget | undefined {
  const match = BUDGET_PATTERN.exec(text);
  if (match === null) return undefined;
  const [, currency, digits = "0", suffix] = match;
  const amount = Number(digits);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  if (currency === "$") return { unit: "usd", amount };
  if (currency === "¥" || currency === "￥") return { unit: "cny", amount };
  const scale =
    suffix === "k" || suffix === "K"
      ? 1_000
      : suffix === "m" || suffix === "M"
        ? 1_000_000
        : suffix === "万"
          ? 10_000
          : 1;
  return { unit: "tokens", amount: Math.round(amount * scale) };
}

// 配置里的额度写法（"¥20"、"$5"、"2m"）
export function parseBudgetSetting(text: string): ScriptBudget {
  const budget = parseScriptBudget(`额度 ${text}`);
  if (budget === undefined) {
    throw new Error(`脚本编排的缺省额度写法不对：${text}（写成 ¥20、$5 或 2m）`);
  }
  return budget;
}

export function budgetText(budget: ScriptBudget | undefined): string | undefined {
  if (budget === undefined) return undefined;
  switch (budget.unit) {
    case "cny":
      return `¥${budget.amount}`;
    case "usd":
      return `$${budget.amount}`;
    default:
      return `${budget.amount} token`;
  }
}

export interface ScriptGateSettings {
  // 项目配置：由模型判断何时用（工具常驻）
  modelDecides: boolean;
  // 项目配置的缺省额度
  defaultBudget?: ScriptBudget;
}

// 项目配置（设置的 orchestration 一节的 script 段）→ 点名的设定；缺省额度写法不对即响亮失败
export function scriptGateSettingsOf(settings: {
  scriptModelDecides: boolean;
  scriptBudget?: string;
}): ScriptGateSettings {
  return {
    modelDecides: settings.scriptModelDecides,
    ...(settings.scriptBudget !== undefined
      ? { defaultBudget: parseBudgetSetting(settings.scriptBudget) }
      : {}),
  };
}

// 本次人手输入的点名状态
export class ScriptGate {
  readonly settings: ScriptGateSettings;
  #named: { budget?: ScriptBudget } | undefined;
  // pigeon run：任务描述点了名即整次运行都算
  #sticky = false;

  constructor(settings: ScriptGateSettings) {
    this.settings = settings;
  }

  // 人的一条输入交给运行面之前调用（只在这一个入口调用）：带关键词即点名，否则收回
  humanInput(text: string): void {
    if (this.#sticky) return;
    this.#named = text.includes(SCRIPT_KEYWORD) ? this.#namedFrom(text) : undefined;
  }

  // pigeon run 的任务描述：算作点名，整次运行都算
  runTask(text: string): void {
    this.#named = this.#namedFrom(text);
    this.#sticky = true;
  }

  #namedFrom(text: string): { budget?: ScriptBudget } {
    const budget = parseScriptBudget(text);
    return budget !== undefined ? { budget } : {};
  }

  // 模型现在能不能提交脚本
  allowed(): boolean {
    return this.settings.modelDecides || this.#named !== undefined;
  }

  // 本次点名给的额度，没给取配置的缺省
  budget(): ScriptBudget | undefined {
    return this.#named?.budget ?? this.settings.defaultBudget;
  }

  // 本次点名是否写了额度（续跑时写了才换额度）
  namedBudget(): ScriptBudget | undefined {
    return this.#named?.budget;
  }
}
