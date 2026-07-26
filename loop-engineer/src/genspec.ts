/**
 * CC-69 · 共享 spec-gen —— 两个独立前端(fde-copilot / hack5)调**同一个** loop 端点生成 loop-ready 规格。
 *
 * 背景:原始对话 ≠ 规格。前端只有零散对话时,把它交给这里 → 产出结构化 SPEC.md(对齐 MediaBot docs 标准:
 * 产品定义/数据模型/业务流程/错误处理/测试策略/工程约定 + 待确认缺口)+ readiness 就绪度。
 * **无状态**:前端把 {对话/输入 + 当前 SPEC + 客户/交付物上下文} 传进来,loop 跑一次 chat 返回更新后的 SPEC,
 * 由前端存盘/展示(右侧面板)。loop-ready(readiness.loop_ready)后前端再把该 SPEC 内联进 /plan 建 job。
 * 这样两前端交给 loop 的是同一套标准,spec-gen 逻辑只有一份(在 loop),标准永不漂移。
 */
import { resolveProvider } from "./config.js";
import { runChat, extractJson } from "./providers.js";
import type { Config } from "./types.js";
import { ZERO, add } from "./usage.js";
import type { Usage } from "./usage.js";

export interface GenSpecInput {
  /** 客户本轮新输入 / 一句话需求(必填)。 */
  input: string;
  /** 当前 SPEC.md 全文(增量修订用;首轮为空则写精简初稿)。 */
  currentSpec?: string;
  /** 客户背景("客户:X\n<背景>")。 */
  clientContext?: string;
  /** 交付物("交付物:X(类型:Y)")。 */
  deliverableContext?: string;
  /** 最近对话文本(供增量上下文)。 */
  history?: string;
  /** 面向用户文字的语言:zh/en/th(结构化字段/键名不变)。 */
  lang?: string;
}

export interface GenSpecOutput {
  reply: string;
  openQuestions: Array<{ id: string; question: string; why: string }>;
  readiness: { score: number; loop_ready: boolean; missing: string[] };
  spec_markdown: string;
  usage: Usage;
}

function langDirective(lang?: string): string {
  const l = (lang ?? "zh").toLowerCase();
  if (l.startsWith("en"))
    return "⚠️ OUTPUT LANGUAGE = English. Write ALL user-facing text (reply, open_questions, readiness.missing, and the human-readable prose in SPEC.md) in English. Keep JSON keys / markdown heading markers / slugs unchanged.";
  if (l.startsWith("th"))
    return "⚠️ ภาษาผลลัพธ์ = ไทย เขียนข้อความที่ผู้ใช้เห็นทั้งหมด (reply, open_questions, readiness.missing และเนื้อหาใน SPEC.md) เป็นภาษาไทย คงคีย์ JSON / เครื่องหมายหัวข้อ / slug ไว้เหมือนเดิม";
  return "【输出语言=中文】面向用户的所有文字(reply、open_questions、readiness.missing、SPEC.md 中给人读的散文)用中文;JSON 键名/markdown 标题标记/slug 不变。";
}

/** 系统提示:把对话增量并进结构化 SPEC.md(对齐 MediaBot docs 的分节标准)。 */
function systemPrompt(lang?: string): string {
  return `${langDirective(lang)}

你是需求 intake Copilot。把客户零散口语化的诉求,一点点并进一份**结构化、可增量、loop-ready** 的规格 SPEC.md,
让下游一个「接触不到客户本人」的自动编码 loop 仅凭它就能建出可跑的 MVP。这是交互式对话,回答要快、准、克制。

**SPEC.md 结构(单文档承载全部,分节写清;没内容的节写「(待补)」不要删节):**
## 一句话定位
## 目标用户与核心场景
## 核心功能(每个功能一行 + 一句可验收标准;编号)
## 数据模型 / 关键实体(有存储/状态时;字段 + 关系)
## 业务流程 / 状态机(关键流程逐步 + 分支/异常)
## 错误处理与边界(失败模式、幂等、限额)
## 技术方向(架构/依赖/部署取向;AI 推断的标「【假设·待确认】」)
## 验收标准(用户视角"怎么算好用")
## 范围(范围内 / 明确范围外)
## 待确认缺口(必须客户回答的问题、技术假设、已知风险)

**本轮**:在「当前 SPEC.md」基础上把客户新输入做**增量修订**(改相关小节,不整篇重写;当前为空则写精简但**结构完整**的初稿,
每节都在、缺内容标「(待补)」)。不做联网调研,凭知识给合理技术方向并标「【假设·待确认】」。
评估 readiness(0-100;loop_ready=够建一个可跑 MVP,不追求面面俱到,但**核心功能/验收/范围**三节必须实)。

**只输出一个 JSON 对象**(第一个字符就是 {,不要任何解释或 markdown 代码围栏),字段:
- reply: string —— 给客户看的简短回复(一句话说本轮并进了什么 + 抛最关键的一个问题)
- open_questions: array —— [{id:string, question:string, why:string}],必须客户回答的问题
- readiness: object —— {score:int(0-100), loop_ready:bool, missing:string[]}
- spec_markdown: string —— 更新后的**完整** SPEC.md 全文(含上面所有分节)`;
}

/**
 * chat provider 级联链(复用 planner 的:主选 + LOOP_PLANNER_FALLBACK)。
 * **逐个防御式解析**:缺 key / 非 openai-chat 的档跳过(不抛),与 planSpec 一致 —— 否则主选 workers-ai
 * 在容器缺 CLOUDFLARE_API_TOKEN 时 resolveProvider 直接抛,整条链废掉。降级到 deepseek/hilinkup。
 */
function chatChain(config: Config) {
  const names = [
    config.providers.planner,
    ...(process.env.LOOP_PLANNER_FALLBACK ?? "deepseek-chat,hilinkup:glm-5.2").split(",").map((s) => s.trim()),
  ].filter(Boolean);
  const seen = new Set<string>();
  const resolved = [];
  for (const n of names) {
    if (seen.has(n)) continue;
    seen.add(n);
    try {
      const p = resolveProvider(n);
      if (p.kind === "openai-chat") resolved.push(p);
    } catch {
      /* 缺 key / 不可用 → 跳过,降级下一个 */
    }
  }
  if (resolved.length === 0) throw new Error("无可用 chat provider（planner 链全部缺 key / 非 chat）");
  return resolved;
}

interface ParsedTurn {
  reply?: string;
  open_questions?: Array<{ id: string; question: string; why: string }>;
  readiness?: { score: number; loop_ready: boolean; missing: string[] };
  spec_markdown?: string;
}

/**
 * 无状态生成/增量更新 SPEC.md。失败(provider 挂或连续不吐可解析 JSON)抛错,由调用方兜 500。
 * 快模型偶发不吐 JSON → runChat 级联 + 一次严格重试。
 */
export async function genSpec(input: GenSpecInput, config: Config): Promise<GenSpecOutput> {
  if (!input.input || !input.input.trim()) throw new Error("input 为空(需要客户输入/一句话需求)");
  const chain = chatChain(config);
  const system = systemPrompt(input.lang);
  const user =
    `## 客户背景\n${input.clientContext?.trim() || "(无客户背景)"}\n\n` +
    `## ${input.deliverableContext?.trim() || "交付物:(未指定)"}\n\n` +
    `## 最近对话\n${input.history?.trim() || "(无)"}\n\n` +
    `## 当前 SPEC.md 全文\n${input.currentSpec?.trim() || "(尚为空,请写结构完整的精简初稿)"}\n\n` +
    `## 客户本轮新输入\n${input.input.trim()}`;

  const STRICT =
    "\n\n(上一轮没有严格只输出一个 JSON 对象。请只输出一个 JSON 对象,第一个字符就是 {,含 reply、open_questions、readiness、spec_markdown 四个字段,不要任何解释或 markdown 围栏。)";

  let usage: Usage = { ...ZERO };
  let parsed: ParsedTurn | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await runChat(system, attempt === 1 ? user : user + STRICT, {
      provider: chain[0],
      fallbacks: chain.slice(1),
      maxTokens: 8000,
      timeoutMs: Number(process.env.GENSPEC_TIMEOUT_MS ?? 90_000),
    });
    usage = add(usage, res.usage);
    const p = extractJson<ParsedTurn>(res.text);
    if (p && typeof p.spec_markdown === "string" && p.spec_markdown.trim() && typeof p.reply === "string") {
      parsed = p;
      break;
    }
  }
  if (!parsed) {
    throw new Error("spec-gen 未返回可解析的结构化结果(reply + spec_markdown)");
  }

  // usage.costUsd 已由 runChat 每次调用算好并经 add() 累计,无需再估。
  const specMd = parsed.spec_markdown!.endsWith("\n") ? parsed.spec_markdown! : parsed.spec_markdown! + "\n";
  return {
    reply: parsed.reply!,
    openQuestions: Array.isArray(parsed.open_questions) ? parsed.open_questions : [],
    readiness: parsed.readiness ?? { score: 0, loop_ready: false, missing: ["未返回 readiness"] },
    spec_markdown: specMd,
    usage,
  };
}
