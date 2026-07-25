// 系统贯穿的类型定义（客户 Client → 项目 Project 两级）

export interface Readiness {
  score: number;
  loop_ready: boolean;
  missing: string[];
}

export interface OpenQuestion {
  id: string;
  question: string;
  why: string;
}

export interface ResearchNote {
  claim: string;
  source?: string;
  needs_confirmation: boolean;
}

export interface TurnResult {
  reply: string;
  open_questions: OpenQuestion[];
  research_notes: ResearchNote[];
  readiness: Readiness;
  updated_docs: string[];
  /** 快 chat（单次调用）模式：更新后的完整 SPEC.md 全文，由 server 写盘（agent 不碰文件工具）。 */
  spec_markdown?: string;
}

export interface ConversationEntry {
  role: "customer" | "copilot";
  at: string;
  text: string;
  result?: TurnResult;
  attachments?: string[];
}

// —— 用量 ——
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  computeMs: number;
  turns: number;
}
export const ZERO_USAGE: Usage = {
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, computeMs: 0, turns: 0,
};
export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    costUsd: a.costUsd + b.costUsd,
    computeMs: a.computeMs + b.computeMs,
    turns: a.turns + b.turns,
  };
}

// —— 客户（背景自我介绍，被其下所有项目共享）——
export interface Client {
  slug: string;
  name: string;
  /** 客户基本背景 / 自我介绍，注入每个项目的对话上下文 */
  background: string;
  createdAt: string;
  updatedAt: string;
}

// —— 交付物（右栏以此为中心）——
export const DELIVERABLE_TYPES = [
  { id: "video", label: "视频", labelEn: "Video" },
  { id: "video-resume", label: "视频简历", labelEn: "Video Resume" },
  { id: "ppt", label: "PPT / 幻灯片", labelEn: "PPT / Slides" },
  { id: "web", label: "网页 / 小程序", labelEn: "Web / Mini-app" },
  { id: "doc", label: "文档 / 报告", labelEn: "Doc / Report" },
  { id: "other", label: "其他", labelEn: "Other" },
] as const;
export type DeliverableType = (typeof DELIVERABLE_TYPES)[number]["id"];

export interface Deliverable {
  /** 交付物命名，如「我的视频简历」 */
  name: string;
  type: DeliverableType;
}

export type ProviderId = "claude" | "lmstudio";
export interface ModelSelection {
  provider: ProviderId;
  model?: string;
}

// —— 项目（客户下的一个交付目标，独立对话与规格）——
export interface ProjectState {
  slug: string;
  clientSlug: string;
  name: string;
  deliverable: Deliverable;
  createdAt: string;
  updatedAt: string;
  rounds: number;
  status: "intake" | "building" | "testing" | "ready";
  lastReadiness: Readiness | null;
  usage?: Usage;
  /** 项目级模型路由；缺省时使用服务端 FDE_DEFAULT_PROVIDER。 */
  model?: ModelSelection;
}

export const SPEC_DOCS = [
  "SPEC.md", "PRODUCT.md", "FEATURES.md", "TECH_SPEC.md", "INTERACTIONS.md", "GAPS.md", "INTAKE.md",
] as const;
export type SpecDoc = (typeof SPEC_DOCS)[number];
