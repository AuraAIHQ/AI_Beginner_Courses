import { promises as fs } from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./config.js";

/** 用量：token + 计算量(墙钟) + 成本估算 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** 成本估算（USD）：claude 用 SDK 报告值；远程 OpenAI-compatible 用价表估 */
  costUsd: number;
  /** 计算量代理：模型墙钟毫秒（"计算秒" = computeMs/1000） */
  computeMs: number;
  /** 调用次数 */
  calls: number;
}

export const ZERO: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  costUsd: 0,
  computeMs: 0,
  calls: 0,
};

export function add(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    costUsd: a.costUsd + b.costUsd,
    computeMs: a.computeMs + b.computeMs,
    calls: a.calls + b.calls,
  };
}

// —— 成本估算价表（USD / 1M token，[输入, 输出]）——
// 粗估，可按实际账单调整；claude 直接用 SDK 的 total_cost_usd 不走这里。
// —— 价表 = hack5 积分计费的权威 model-prices.csv(CC-54)。[输入, 输出] USD / 1M token。——
// 计费必须与 hack5 同源(1 积分 = $0.02 = 成本×2)。含 hack5 表的正式 key + WorkBench 实际
// 用的短名别名(如 DEEPSEEK_MODEL=deepseek-v4-pro 映射到 hack5 的 deepseek-v4-pro-202606 费率)。
const PRICE: Record<string, [number, number]> = {
  // MiniMax
  "MiniMax-M2": [0.31, 1.24],
  "MiniMax-M2.1": [0.31, 1.24],
  "MiniMax-M2.1-highspeed": [0.62, 2.47],
  "MiniMax-M2.5": [0.31, 1.24],
  "MiniMax-M2.5-highspeed": [0.62, 2.47],
  "MiniMax-M2.7": [0.31, 1.24],
  "MiniMax-M2.7-highspeed": [0.62, 2.47],
  "minimax-m3": [0.3, 1.2],
  // DeepSeek（hack5 正式 key + WorkBench 短名别名）
  "deepseek-v4-flash-202605": [0.15, 0.29],
  "deepseek-v4-pro-202606": [0.44, 0.88],
  "deepseek-v4-flash": [0.15, 0.29],
  "deepseek-v4-pro": [0.44, 0.88],
  // ByteDance
  "doubao-seed-2-1-pro-260628": [0.88, 4.41],
  "doubao-seed-2-1-turbo-260628": [0.44, 2.21],
  "doubao-seed-evolving": [0.88, 4.41],
  // Zhipu GLM
  "glm-4.7": [0.59, 2.35],
  "glm-5": [0.88, 3.24],
  "glm-5-turbo": [0.74, 3.24],
  "glm-5.1": [1.18, 4.11],
  "glm-5.2": [1.18, 4.11],
  // Moonshot Kimi
  "kimi-k2.5": [0.59, 3.09],
  "kimi-k2.6": [0.96, 3.97],
  "kimi-k2.7-code": [0.96, 3.97],
  "kimi-k2.7-code-highspeed": [1.9, 7.94],
  "kimi-k3": [2.79, 13.97],
  // Alibaba Qwen
  "qwen3.7-max": [1.76, 5.29],
  "qwen3.7-plus": [1.76, 5.29],
};

export function estimateCost(model: string | undefined, inTok: number, outTok: number): number {
  if (!model) return 0;
  const p = PRICE[model];
  if (!p) return 0;
  return (inTok * p[0] + outTok * p[1]) / 1_000_000;
}

// —— 账本（持久化在项目 .loop/usage.json，gitignored）——
export interface Ledger {
  total: Usage;
  byProvider: Record<string, Usage>;
  updatedAt: string;
}

const LEDGER_PATH = path.join(PROJECT_ROOT, ".loop", "usage.json");

export async function loadLedger(): Promise<Ledger> {
  try {
    return JSON.parse(await fs.readFile(LEDGER_PATH, "utf8")) as Ledger;
  } catch {
    return { total: ZERO, byProvider: {}, updatedAt: new Date().toISOString() };
  }
}

/** 记一笔用量（provider 名 → 累加进 total 与 byProvider），带时间戳 */
export async function recordUsage(providerName: string, u: Usage, now: string): Promise<void> {
  const l = await loadLedger();
  l.total = add(l.total, u);
  l.byProvider[providerName] = add(l.byProvider[providerName] ?? ZERO, u);
  l.updatedAt = now;
  await fs.mkdir(path.dirname(LEDGER_PATH), { recursive: true });
  await fs.writeFile(LEDGER_PATH, JSON.stringify(l, null, 2), "utf8");
}

// —— 展示格式化 ——
export const fmtTokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`;
export const fmtCost = (u: number) => (u >= 0.01 ? `$${u.toFixed(2)}` : `$${u.toFixed(4)}`);
export const fmtSecs = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
};
