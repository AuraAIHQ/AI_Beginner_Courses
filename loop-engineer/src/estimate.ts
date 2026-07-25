/**
 * CC-62 / CC-61 — /estimate 事前积分预估。
 *
 * 把「客户 idea / spec」估成积分区间,供 hack5 在建 job 前做余额预检:够则放行、不够提示充值。
 * 设计取舍:**纯启发式,不真跑 planner** —— 预估必须秒级返回且零 token 成本(预估本身不该烧积分)。
 * 用复杂度信号(功能点数 + 各能力信号加权 + 篇幅)映射到档位,档位→积分区间来自实测校准的种子表。
 *
 * 换算(与 CC-54 / hack5 同源):积分 = ceil(成本USD × 100)。1 积分 = $0.01 成本 = $0.02 客户价(2× 加价)。
 * 种子表按 coder=DeepSeek v4-pro 正常路径估;若降级兜底 HiLinkup,同档约 ×3-4(见 note)。
 *
 * CC-61 校准(2026-07-25):真实样本 cheap-flight-go(极短 idea,含外部API+定时+邮件)$0.476→48 积分,
 * 而旧版对同类极短 idea 估 5-15(欠估 3-9×)。根因:一句话 idea 无 bullet → 只数 1 个功能点。
 * 修法:①按 、/+/逗号 也切分列举式 idea ②识别多个独立能力信号各自加权(外部API 权重最高:沙盒难做)
 * ③极短 idea + 多能力信号时按经验抬档,避免乐观欠估。
 */

export type Tier = "XS" | "S" | "M" | "L";

export interface EstimateInput {
  idea?: string;
  spec?: string;
}

export interface EstimateSignals {
  featureCount: number;
  hasBackend: boolean;
  multiPage: boolean;
  chars: number;
  /** CC-61:命中的独立能力信号(externalApi/db/auth/scheduling/email/realtime/multiPage/backend)。 */
  matched: string[];
}

export interface EstimateResult {
  tier: Tier;
  creditsLow: number;
  creditsHigh: number;
  note: string;
  /** CC-61:预估置信度。short idea-only → low(区间更宽、按经验抬档);spec/多信号 → high。 */
  confidence: "low" | "medium" | "high";
  signals: EstimateSignals;
}

// 档位→积分区间(种子表 · coder=DeepSeek v4-pro 正常路径 · 随真实 job 回填校准)。
const TIER_CREDITS: Record<Tier, [number, number]> = {
  XS: [3, 8], // 单文件微改 / 极简静态页
  S: [5, 15], // 1-2 文件小功能
  M: [15, 50], // 多文件骨架 + 数个 feature(如 cheap-flight $0.476→48 落此档顶)
  L: [50, 200], // 全新 app 多任务 + 返工 + 多外部集成
};

// 独立能力信号:每个≈一块要独立实现的工作(→ 更可能是多任务全栈 app),故各自加权。
// externalApi 权重最高:沙盒无外网/无 key,接第三方 API 是最难做、最烧返工的一步(cheap-flight 实证)。
const SIGNALS: { key: string; re: RegExp; w: number }[] = [
  { key: "externalApi", re: /外部\s*api|第三方|三方接口|行情|股价|股票|天气|航班|机票|地图|汇率|快递|物流|aviationstack|openweather|stripe|支付接口|openai|爬虫|抓取|scrape/i, w: 2 },
  { key: "scheduling", re: /定时|cron|轮询|scheduled|每天|每小时|周期|监控|watch/i, w: 1 },
  { key: "email", re: /邮件|email|resend|smtp|发信|通知提醒|短信|sms|push\b|推送通知/i, w: 1 },
  { key: "auth", re: /登录|注册|鉴权|auth\b|账户|账号|token|会话|session|权限/i, w: 1 },
  { key: "db", re: /数据库|db\b|sql|postgres|mysql|sqlite|mongo|redis|持久化|存储/i, w: 1 },
  { key: "realtime", re: /实时|websocket|长连接|直播|在线协作/i, w: 1 },
  { key: "backend", re: /后端|服务端|api\b|接口|server|订单|队列/i, w: 1 },
  { key: "multiPage", re: /多页|路由|route|导航|dashboard|后台|管理端|列表页|详情页/i, w: 1 },
];

/** 数功能点:spec 的 bullet/编号行优先;列举式 idea 按 、/+/逗号/句末 切分;都无则 1。 */
function countFeatures(text: string): number {
  const bullets = (text.match(/^\s*(?:[-*+]|\d+[.)、])\s+/gm) ?? []).length;
  if (bullets > 0) return bullets;
  // CC-61:idea 常用 、+ ，, ；; 及句末标点列举需求 → 都当分隔切子句
  const clauses = text
    .split(/[。.!?！？\n、+＋，,；;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
  return Math.max(1, clauses.length);
}

/** 估一个 idea/spec 的积分区间 + 档位 + 信号。纯函数,确定性,便于测试与 hack5 对齐。 */
export function estimateJob(input: EstimateInput): EstimateResult {
  const text = (input.spec ?? input.idea ?? "").trim();
  const chars = text.length;
  const ideaOnly = !input.spec && !!input.idea;
  const featureCount = countFeatures(text);

  const matched: string[] = [];
  let signalWeight = 0;
  for (const s of SIGNALS) {
    if (s.re.test(text)) {
      matched.push(s.key);
      signalWeight += s.w;
    }
  }
  const hasBackend = matched.includes("backend") || matched.includes("externalApi") || matched.includes("db");
  const multiPage = matched.includes("multiPage");

  // 打分:功能点 + 各能力信号加权 + 长篇。能力信号是主要复杂度来源(每个≈一块独立工作)。
  let score = featureCount + signalWeight;
  if (chars > 1200) score += 1;

  // CC-61 抬档:极短 idea 常把「外部API+定时+邮件」压成一句话 → featureCount 只 1,靠信号权重补。
  // 若 ≥3 个独立能力信号 → 至少 M(经验:这类必是多任务全栈 app,cheap-flight 即 48 积分)。
  const integrationSignals = matched.filter((k) => k !== "multiPage" && k !== "backend").length;

  let tier: Tier;
  if (score <= 2) tier = "XS";
  else if (score <= 5) tier = "S";
  else if (score <= 11) tier = "M";
  else tier = "L";
  if (integrationSignals >= 3 && (tier === "XS" || tier === "S")) tier = "M";
  if (integrationSignals >= 4 && tier === "M") tier = "L";

  const [creditsLow, creditsHigh] = TIER_CREDITS[tier];

  // 置信度:spec 或信号丰富 → high;极短 idea-only → low(欠估风险,预检建议按 creditsHigh 从紧)。
  const confidence: EstimateResult["confidence"] =
    !ideaOnly || featureCount >= 4 ? "high" : chars < 60 && integrationSignals >= 2 ? "low" : "medium";

  const empty = chars === 0;
  const note = empty
    ? "无输入文本,按最小档估;请传 idea 或 spec 以获得准确预估。"
    : `档位 ${tier}(功能点≈${featureCount}${matched.length ? " · 信号:" + matched.join("/") : ""})。` +
      `积分=ceil(成本×100),按正常走 DeepSeek 估;若 DeepSeek 不可用兜底 HiLinkup,同档约 ×3-4。` +
      (confidence === "low" ? "极短 idea 预估置信低、可能偏低,预检建议按 creditsHigh 从紧。" : "建议按 creditsHigh 预检余额。");

  return { tier, creditsLow, creditsHigh, note, confidence, signals: { featureCount, hasBackend, multiPage, chars, matched } };
}
