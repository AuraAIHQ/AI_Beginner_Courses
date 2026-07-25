import { promises as fs } from "node:fs";
import path from "node:path";
import { projectDir, readConversation, readClient, readProjectState } from "./clients";
import type { ConversationEntry, TurnResult, Usage } from "./types";
import { z } from "zod";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { ZERO_USAGE } from "./types";
import { resolveProviderSelection } from "./providers/registry";
import { specAgentProvider } from "./providers/spec-provider";

/**
 * 执行模式（CC-58，与 loop-engineer 对齐）：`api`（默认，云 key）| `local`（显式 opt-in，
 * 允许本机 `claude login` 订阅）。默认云化，摆脱"某台 Mac Mini 醒着 + 交互式订阅态"的硬依赖。
 */
function executionMode(): "api" | "local" {
  return process.env.EXECUTION_MODE === "local" ? "local" : "api";
}

/**
 * full agent-sdk 路径给子进程的认证 env。容器/无人值守里绝不静默回落本机订阅：
 *  - `local`（opt-in）：继承 process.env，允许本机订阅或环境已有认证。
 *  - `api`（默认）：强制云端 Anthropic 兼容端点。优先已配好的 ANTHROPIC_*，否则复用 DeepSeek
 *    云端点（与 loop-engineer 同一套 DEEPSEEK_* 云 key，非 Anthropic 官方；HiLinkup 无 Anthropic
 *    端点驱动不了 agentic，故 agentic 侧用 DeepSeek），否则 fail-closed 报错。
 */
function resolveAgentEnv(): Record<string, string | undefined> {
  const base: Record<string, string | undefined> = { ...process.env };
  if (executionMode() === "local") return base;

  if (base.ANTHROPIC_BASE_URL && (base.ANTHROPIC_AUTH_TOKEN || base.ANTHROPIC_API_KEY)) {
    return base; // 已显式配好 Anthropic 兼容端点
  }
  const key = base.DEEPSEEK_API_KEY;
  const url = base.DEEPSEEK_BASE_URL;
  const model = base.DEEPSEEK_MODEL;
  if (key && url) {
    const env: Record<string, string | undefined> = {
      ...base,
      ANTHROPIC_BASE_URL: url,
      ANTHROPIC_AUTH_TOKEN: key,
    };
    if (model) {
      // 覆盖所有模型 slot，避免 claude 内部选 opus/sonnet/haiku 时回落官方 Anthropic
      env.ANTHROPIC_MODEL = model;
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
      env.ANTHROPIC_SMALL_FAST_MODEL = model;
    }
    return env;
  }
  if (base.ANTHROPIC_API_KEY) return base; // 官方 key 兜底（非默认，显式给了就用）

  throw new Error(
    "fde-copilot 云模式(EXECUTION_MODE=api,默认)需 Anthropic 兼容云端点：配 " +
      "DEEPSEEK_API_KEY+DEEPSEEK_BASE_URL(推荐,复用 loop-engineer 云 key)或 ANTHROPIC_* 之一。" +
      "要用本机 claude login 订阅请设 EXECUTION_MODE=local。",
  );
}

/**
 * 权限闸（对抗 prompt injection）：客户输入原样进 prompt，故必须硬性约束工具。
 * 文件读写/搜索路径必须落在该客户目录内；只放行检索与 submit_turn；其余（Bash/WebFetch 等）一律拒绝。
 */
function makeCanUseTool(root: string): CanUseTool {
  const base = path.resolve(root);
  const inside = (p: unknown): boolean => {
    if (typeof p !== "string" || p.length === 0) return false;
    const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(base, p);
    return abs === base || abs.startsWith(base + path.sep);
  };
  const PATH_KEY: Record<string, string> = {
    Read: "file_path",
    Write: "file_path",
    Edit: "file_path",
    MultiEdit: "file_path",
    NotebookEdit: "notebook_path",
  };
  // A 方案「快 chat」：默认关掉 WebSearch —— 每轮联网调研是最大耗时/耗轮次来源，
  // 会把单轮拖到分钟级（hack5 的 CF Worker 同步 fetch 扛不住）。追问式对话本就该秒回，
  // 深度调研留到后面 loop 阶段。设 CHAT_WEBSEARCH=true 可恢复。
  const webSearchEnabled = process.env.CHAT_WEBSEARCH === "true";
  return async (toolName, input) => {
    if (process.env.CANUSE_DEBUG) console.error(`[canUseTool] ${toolName}`);
    if (toolName.startsWith("mcp__workbench__")) return { behavior: "allow", updatedInput: input };
    if (toolName === "WebSearch") {
      return webSearchEnabled
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: "快 chat 模式已关闭 WebSearch（设 CHAT_WEBSEARCH=true 恢复）" };
    }
    if (toolName === "TodoWrite") {
      return { behavior: "allow", updatedInput: input };
    }
    if (toolName in PATH_KEY) {
      const p = (input as Record<string, unknown>)[PATH_KEY[toolName]];
      if (!inside(p)) return { behavior: "deny", message: `拒绝越界路径：${String(p)}（仅允许客户目录内）` };
      return { behavior: "allow", updatedInput: input };
    }
    if (toolName === "Glob" || toolName === "Grep") {
      const p = (input as Record<string, unknown>).path;
      if (p !== undefined && !inside(p)) {
        return { behavior: "deny", message: `拒绝越界搜索路径：${String(p)}` };
      }
      return { behavior: "allow", updatedInput: input };
    }
    return { behavior: "deny", message: `工具 ${toolName} 未被安全策略允许` };
  };
}

async function loadSystemPrompt(): Promise<string> {
  // A 方案「快 chat」：默认用轻量 intake 提示（每轮只小改 SPEC.md + GAPS.md、不联网、不写 6 文档），
  // 把单轮压到秒级以适配 hack5 的 Cloudflare Worker 同步 fetch（45s 超时）。
  // 设 CHAT_FULL_SPEC=true 可切回完整 6 文档规格生成模式（分钟级，仅适合本地/异步场景）。
  const file = process.env.CHAT_FULL_SPEC === "true" ? "system.md" : "system-fast.md";
  return fs.readFile(path.join(process.cwd(), "prompts", file), "utf8");
}

// —— submit_turn：agent 每轮结束必须调用一次，把结构化结果交回网页 ——
function buildSubmitTool(sink: { value: TurnResult | null }) {
  return tool(
    "submit_turn",
    "把本轮的结构化结果交回网页 UI。每一轮结束时恰好调用一次，这是你本轮的最后一个动作。",
    {
      reply: z.string().describe("给客户看的中文回复：先小结本轮做了什么，再抛最关键的问题"),
      open_questions: z
        .array(
          z.object({
            id: z.string(),
            question: z.string(),
            why: z.string().describe("为什么需要问：哪块规格卡在这里"),
          }),
        )
        .describe("必须由客户回答的问题（只有客户知道的信息）"),
      research_notes: z
        .array(
          z.object({
            claim: z.string(),
            source: z.string().optional(),
            needs_confirmation: z.boolean().describe("true=AI 调研假设需客户确认"),
          }),
        )
        .describe("本轮你自主调研得到的结论"),
      readiness: z.object({
        score: z.number().min(0).max(100).describe("规格离下游 loop 可独立开工的成熟度"),
        loop_ready: z.boolean(),
        missing: z.array(z.string()).describe("还差哪些才 loop-ready"),
      }),
      updated_docs: z.array(z.string()).describe("本轮更新过的文档文件名"),
      // 快 chat（单次调用）模式：模型不碰文件工具，把更新后的完整 SPEC.md 内容放这里，server 负责保存。
      spec_markdown: z
        .string()
        .optional()
        .describe("更新后的完整 SPEC.md 全文（快 chat 模式必填；server 会写盘）"),
    },
    async (args) => {
      sink.value = args as TurnResult;
      return { content: [{ type: "text", text: "已记录，本轮结束。" }] };
    },
  );
}

function recentContext(history: ConversationEntry[], take = 6): string {
  const slice = history.slice(-take);
  if (slice.length === 0) return "（这是客户第一次输入，尚无历史。）";
  return slice
    .map((e) => `${e.role === "customer" ? "客户" : "你(Copilot)"}：${e.text}`)
    .join("\n");
}

/** 内部沟通语言（CC-53）：AI 面向用户的文字用此语言。缺省 zh = 现状，向后兼容。 */
export type ChatLang = "zh" | "en" | "th";

export function normLang(v: unknown): ChatLang {
  return v === "en" || v === "th" ? v : "zh";
}

function langName(lang: ChatLang): string {
  return lang === "en" ? "English" : lang === "th" ? "ภาษาไทย (Thai)" : "中文";
}

/**
 * 输出语言指令（CC-53）：只约束**面向用户的文字**（reply / open_questions / readiness.missing /
 * SPEC.md 里给人读的散文）用指定语言；**结构化字段不变**（JSON 键名、slug、章节标记、readiness 数值）。
 * zh 时与现状一致。措辞刻意强硬 + 要求「无视输入/上下文语言」，因为快模型易被满屏中文带偏。
 */
function langDirective(lang: ChatLang): string {
  if (lang === "zh") {
    return "【输出语言=中文】面向用户的所有文字（reply、open_questions 的问题、readiness.missing、SPEC.md 中给人读的定位/功能描述等）全程用中文。";
  }
  const name = langName(lang);
  const native = lang === "en" ? "in English" : "เป็นภาษาไทย"; // 用目标语言自身再钉一遍
  return `⚠️ CRITICAL — OUTPUT LANGUAGE = ${name}. You MUST write ALL user-facing text ${native}: the "reply" string, every open_questions question and why, all readiness.missing items, and the human-readable prose inside SPEC.md (positioning, feature descriptions, notes). This is MANDATORY and OVERRIDES everything else — write ${native} EVEN THOUGH the user's message, the existing SPEC.md, and these very instructions are in Chinese. Do NOT reply in Chinese. ONLY the machine/structured parts stay unchanged: JSON field NAMES (keys), slugs, markdown "##" heading markers, and numeric readiness values. Never translate JSON keys.`;
}

export interface RunTurnInput {
  clientSlug: string;
  projectSlug: string;
  customerInput: string;
  attachments?: string[];
  /** 内部沟通语言（CC-53）：zh | en | th，缺省 zh。 */
  lang?: ChatLang;
}

export interface RunTurnOutput {
  result: TurnResult;
  /** 若 agent 未调用 submit_turn，用于兜底提示 */
  usedFallback: boolean;
  rawText: string;
  /** 本轮用量（token / 计算量 / 成本） */
  usage: Usage;
}

/**
 * CC-54：chat 直连模型价表($/1M token,[输入, 输出]),与 hack5 权威 model-prices.csv +
 * loop-engineer usage.ts 同源。用于算每轮 chat 的实际成本回传给 hack5 积分扣费。
 */
const CHAT_PRICE: Record<string, [number, number]> = {
  "MiniMax-M2": [0.31, 1.24],
  "MiniMax-M2.1": [0.31, 1.24],
  "MiniMax-M2.1-highspeed": [0.62, 2.47],
  "MiniMax-M2.5": [0.31, 1.24],
  "MiniMax-M2.5-highspeed": [0.62, 2.47],
  "MiniMax-M2.7": [0.31, 1.24],
  "MiniMax-M2.7-highspeed": [0.62, 2.47],
  "minimax-m3": [0.3, 1.2],
};
function estimateChatCost(model: string, inTok: number, outTok: number): number {
  const p = CHAT_PRICE[model];
  return p ? (inTok * p[0] + outTok * p[1]) / 1_000_000 : 0;
}

/** 从模型输出里稳健抽第一个 JSON 对象（容忍 ```json 包裹与前后废话）。 */
function extractJsonObject<T>(text: string): T | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/**
 * 快 chat「直连」路径：不走 claude-agent-sdk（省掉每次起子进程的固定开销 ~40s），
 * 直接调 OpenAI 兼容快模型（HiLinkup，如 MiniMax-M2.1-highspeed），一次请求出结构化 JSON，
 * server 写 SPEC.md。实测 ~11s（vs sdk 单次调用 ~53s），延迟更低更稳。
 * 触发：fastMode 且配了 HILINKUP_API_KEY 且 CHAT_DIRECT!=="false"。
 */
async function runTurnDirect(
  input: RunTurnInput,
  ctx: { dir: string; history: ConversationEntry[]; client: Awaited<ReturnType<typeof readClient>>; project: Awaited<ReturnType<typeof readProjectState>> },
): Promise<RunTurnOutput> {
  const { dir, history, client, project } = ctx;
  const baseUrl = (process.env.HILINKUP_BASE_URL || "https://hilinkup.com/v1").replace(/\/$/, "");
  const apiKey = process.env.HILINKUP_API_KEY!;
  const model = process.env.CHAT_DIRECT_MODEL || "MiniMax-M2.1-highspeed";

  const specContent = await fs.readFile(path.join(dir, "SPEC.md"), "utf8").catch(() => "");
  const clientContext = client
    ? `客户：${client.name}\n${client.background || "（客户未填背景）"}`
    : "（无客户背景）";
  const deliverableContext = project
    ? `交付物：${project.deliverable.name}（类型：${project.deliverable.type}）`
    : "（无交付物信息）";

  const lang = normLang(input.lang);
  const system = `${langDirective(lang)}

你是快速需求 intake Copilot。把客户零散口语化的诉求，一点点并进一份精简、可增量的规格 SPEC.md，让下游一个「接触不到客户本人」的自动编码 loop 仅凭它就能建出 MVP。这是交互式对话,客户在等你的下一个问题,回答要快、准、克制。

SPEC.md 结构(一个文档承载全部)：## 一句话定位 / ## 目标用户 / ## 核心功能(每个一行+一句验收标准) / ## 范围(范围内、范围外) / ## 技术方向(可选,AI 假设标注「【假设·待确认】」) / ## 待确认 缺口(必须客户回答的问题、技术假设、已知风险)。

本轮:在「当前 SPEC.md」基础上把客户新输入做增量修订(改相关小节,不整篇重写;空则写精简初稿)。不做联网调研,凭知识给合理技术方向并标「【假设·待确认】」。评估 readiness(0-100,loop_ready=够建一个可跑 MVP;不追求面面俱到)。

**只输出一个 JSON 对象**(第一个字符就是 {,不要任何解释文字或 markdown 代码围栏),字段:
- reply: string —— 给客户看的简短回复(一句话说本轮并进了什么 + 抛最关键的一个问题)
- open_questions: array —— [{id:string, question:string, why:string}],必须客户回答的问题
- readiness: object —— {score:int(0-100), loop_ready:bool, missing:string[]}
- spec_markdown: string —— 更新后的完整 SPEC.md 全文`;

  const langReminder = lang === "zh" ? "" : `\n\n${langDirective(lang)}`;
  const user = `## 客户背景\n${clientContext}\n\n## ${deliverableContext}\n\n## 最近对话\n${recentContext(history)}\n\n## 当前 SPEC.md 全文\n${specContent || "（尚为空，请写精简初稿）"}\n\n## 客户本轮新输入\n${input.customerInput}${langReminder}`;

  const timeoutMs = Number(process.env.CHAT_DIRECT_TIMEOUT_MS ?? 60_000);
  // 快模型偶发不吐可解析 JSON（hack5 生产实测 ~2 次挂 1 次）→ 解析失败自动重试，
  // 重试时追加「严格只输出 JSON」指令。仍失败才落兜底。
  const maxAttempts = Number(process.env.CHAT_DIRECT_RETRIES ?? 2) + 1;
  const usage: Usage = { ...ZERO_USAGE, turns: 0 };
  let rawText = "";
  let parsed: Partial<TurnResult> | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let j: {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            {
              role: "user",
              content:
                attempt === 1
                  ? user
                  : `${user}\n\n（上一轮没有严格只输出一个 JSON 对象。请只输出一个 JSON 对象，第一个字符就是 {，含 reply、open_questions、readiness、spec_markdown 四个字段，不要任何解释或 markdown 围栏。）`,
            },
          ],
          max_tokens: Number(process.env.CHAT_DIRECT_MAX_TOKENS ?? 3000),
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`直连 chat ${model} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      j = (await res.json()) as typeof j;
    } finally {
      clearTimeout(timer);
    }
    rawText = j.choices?.[0]?.message?.content ?? "";
    usage.turns += 1;
    usage.inputTokens += j.usage?.prompt_tokens ?? 0;
    usage.outputTokens += j.usage?.completion_tokens ?? 0;
    parsed = extractJsonObject<Partial<TurnResult>>(rawText);
    if (parsed && typeof parsed.spec_markdown === "string" && parsed.reply) break;
    parsed = null;
  }

  // CC-54：按价表算本轮 chat 实际成本(含重试的累计 token),回传供 hack5 积分扣费
  usage.costUsd = estimateChatCost(model, usage.inputTokens, usage.outputTokens);

  if (!parsed || typeof parsed.spec_markdown !== "string" || !parsed.reply) {
    // 解析不出结构化结果：兜底，不写盘（避免把废话覆盖掉现有 SPEC.md）
    const fallback: TurnResult = {
      reply: parsed?.reply || "（本轮 Copilot 未返回结构化结果，请重试或补充信息。）",
      open_questions: parsed?.open_questions ?? [],
      research_notes: [],
      readiness: parsed?.readiness ?? { score: 0, loop_ready: false, missing: ["直连 chat 未返回可解析结果"] },
      updated_docs: [],
    };
    return { result: fallback, usedFallback: true, rawText, usage };
  }

  const body = parsed.spec_markdown.endsWith("\n") ? parsed.spec_markdown : parsed.spec_markdown + "\n";
  await fs.writeFile(path.join(dir, "SPEC.md"), body, "utf8");

  const result: TurnResult = {
    reply: parsed.reply,
    open_questions: parsed.open_questions ?? [],
    research_notes: parsed.research_notes ?? [],
    readiness: parsed.readiness ?? { score: 0, loop_ready: false, missing: [] },
    updated_docs: ["SPEC.md"],
    spec_markdown: parsed.spec_markdown,
  };
  return { result, usedFallback: false, rawText, usage };
}

/**
 * 跑一轮：给定客户新输入，让 agent 读现状→更新文档→调研→抛问题→submit_turn。
 * cwd 锁定为该客户目录，agent 直接就地读写 spec 文档。
 */
export async function runTurn(input: RunTurnInput): Promise<RunTurnOutput> {
  const dir = projectDir(input.clientSlug, input.projectSlug);
  const history = await readConversation(input.clientSlug, input.projectSlug);
  const client = await readClient(input.clientSlug);
  const project = await readProjectState(input.clientSlug, input.projectSlug);

  // 多provider 选择（OURS）：项目可选 claude / lmstudio。
  const selection = resolveProviderSelection(project?.model);

  // 快 chat「直连」快模型(CC-61,默认;仅 claude provider):绕开 agent-sdk 子进程,~11s。
  // 项目显式选 LM Studio 时尊重选择,走下面的 provider 抽象层,不劫持到 HiLinkup 直连。
  if (
    selection.provider === "claude" &&
    process.env.CHAT_FULL_SPEC !== "true" &&
    process.env.HILINKUP_API_KEY &&
    process.env.CHAT_DIRECT !== "false"
  ) {
    return runTurnDirect(input, { dir, history, client, project });
  }

  // CC-53：把输出语言指令并进 system（缺省 zh 与原提示一致）。
  const system = (await loadSystemPrompt()) + `\n\n${langDirective(normLang(input.lang))}`;

  const sink: { value: TurnResult | null } = { value: null };
  const submitServer = createSdkMcpServer({
    name: "workbench",
    version: "1.0.0",
    tools: [buildSubmitTool(sink)],
  });
  // 附件名客户可控：只取 basename，杜绝借文件名做路径穿越/误导 Read 越界
  const safeAttachments = (input.attachments ?? []).map((a) => path.basename(a)).filter(Boolean);
  const attachNote = safeAttachments.length
    ? `\n\n客户本轮附带了文件（已存到当前目录，可用 Read 读取）：${safeAttachments.join(", ")}`
    : "";

  const clientContext = client
    ? `## 客户背景（该客户下所有项目共享，务必据此定制）\n客户：${client.name}\n${client.background || "（客户未填背景）"}`
    : "";
  const deliverableContext = project
    ? `## 本项目的交付物（右栏以此为中心，所有规格都服务于产出它）\n名称：${project.deliverable.name}\n类型：${project.deliverable.type}`
    : "";

  // A 方案「快 chat」（默认）：单次调用——不给文件工具，把当前 SPEC.md 塞进 prompt，
  // 模型一次性产出「更新后的完整 SPEC.md + 回复」经 submit_turn 交回，server 写盘。
  // 这样只有 1 个模型往返，延迟可预测（避免 agentic 循环自主多轮读写导致的耗时抖动）。
  const fastMode = process.env.CHAT_FULL_SPEC !== "true";
  let specContent = "";
  if (fastMode) {
    specContent = await fs.readFile(path.join(dir, "SPEC.md"), "utf8").catch(() => "");
  }

  const taskBlock = fastMode
    ? `## 当前 SPEC.md 全文（就是下面这段，你要在此基础上更新；不要用任何文件工具，全靠这段做增量）
${specContent ? "```markdown\n" + specContent + "\n```" : "（SPEC.md 尚为空，请写一份精简初稿）"}

## 你的任务（快 chat 单次调用）
结合**客户背景**、**交付物目标**、**最近对话**，把客户本轮新输入并进 SPEC.md。**你没有文件读写工具**——把更新后的**完整 SPEC.md 全文**放进 \`mcp__workbench__submit_turn\` 的 \`spec_markdown\` 字段（server 会替你写盘），同时给出简短 reply、最关键的问题、readiness。**只调用 submit_turn 恰好一次，这是你唯一的动作。**`
    : `## 你的任务
按 system prompt 的流程处理这轮输入：结合上面的**客户背景**与**交付物目标**，读现状 → 融合更新当前目录下的 spec 文档 → 检缺口 → 能查的自己查、只有客户知道的抛问题 → 评估 readiness → 最后调用 mcp__workbench__submit_turn 恰好一次。`;

  const prompt = `${clientContext}

${deliverableContext}

## 最近对话
${recentContext(history)}

## 客户本轮新输入
${input.customerInput}${attachNote}

${taskBlock}`;

  // LM Studio（OURS 多provider）：走 provider 抽象层（本地 OpenAI 兼容 agentic 生成 spec）。
  if (selection.provider === "lmstudio") {
    const lmMaxTurns = Number(process.env.AGENT_MAX_TURNS ?? (fastMode ? 4 : 40));
    return specAgentProvider(selection).run({
      root: dir,
      system,
      user: prompt,
      model: selection.model,
      maxTurns: lmMaxTurns,
    });
  }

  // claude（默认）：CC-58 云化 agent-sdk 执行路径（resolveAgentEnv 强制云 auth + query 循环）。
  // 快 chat 只需模型 1 次调 submit_turn（给一点余量应对思考轮）；完整模式沿用大 maxTurns。
  const maxTurns = Number(process.env.AGENT_MAX_TURNS ?? (fastMode ? 4 : 40));
  const model = process.env.CLAUDE_MODEL || undefined;

  let rawText = "";
  const usage: Usage = { ...ZERO_USAGE, turns: 1 };
  for await (const msg of query({
    prompt,
    options: {
      // CC-58：默认云化 auth——full 路径不静默吃本机订阅；env 完全替换子进程环境（已 spread process.env）
      env: resolveAgentEnv(),
      cwd: dir,
      systemPrompt: system,
      model,
      mcpServers: { workbench: submitServer },
      // 关键：文件/搜索工具「不」放进 allowedTools——放进去会被免问放行、绕过 canUseTool。
      // 只免问放行自有 MCP 工具；Read/Write/Edit/Glob/Grep 一律落到 canUseTool 逐次校验路径。
      // WebSearch 仅在 CHAT_WEBSEARCH=true 时放行（默认关，见 makeCanUseTool 的「快 chat」注释）。
      // WebFetch 既不放行也会被 canUseTool 默认拒绝（SSRF）。
      allowedTools:
        process.env.CHAT_WEBSEARCH === "true"
          ? ["WebSearch", "mcp__workbench__submit_turn"]
          : ["mcp__workbench__submit_turn"],
      // 快 chat：硬禁所有文件/搜索/命令工具，逼模型只用 submit_turn（单次调用、延迟可预测）。
      // 完整模式不禁，让 agent 就地读写 6 文档。
      ...(fastMode
        ? {
            disallowedTools: [
              "Read",
              "Write",
              "Edit",
              "MultiEdit",
              "NotebookEdit",
              "Glob",
              "Grep",
              "Bash",
              "WebSearch",
              "WebFetch",
              "TodoWrite",
            ],
          }
        : {}),
      // 不加载大 repo 的 CLAUDE.md / 项目设置，保持每个客户会话隔离
      settingSources: [],
      // 不再 bypass；default + canUseTool 硬性约束路径，防越界写/读与 SSRF
      permissionMode: "default",
      canUseTool: makeCanUseTool(dir),
      maxTurns,
    },
  })) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text") rawText += block.text;
      }
    } else if (msg.type === "result") {
      // 结果消息携带 usage / 成本 / 墙钟——累进本轮用量
      if ("usage" in msg && msg.usage) {
        usage.inputTokens += msg.usage.input_tokens ?? 0;
        usage.outputTokens += msg.usage.output_tokens ?? 0;
        usage.cacheReadTokens += msg.usage.cache_read_input_tokens ?? 0;
      }
      if ("total_cost_usd" in msg && typeof msg.total_cost_usd === "number") {
        usage.costUsd += msg.total_cost_usd;
      }
      if ("duration_ms" in msg && typeof msg.duration_ms === "number") {
        usage.computeMs += msg.duration_ms;
      }
      if ("result" in msg && typeof msg.result === "string" && !rawText) rawText = msg.result;
    }
  }

  if (sink.value) {
    // 快 chat：模型不碰文件工具，由 server 把 spec_markdown 写进 SPEC.md。
    if (fastMode && typeof sink.value.spec_markdown === "string" && sink.value.spec_markdown.trim()) {
      const body = sink.value.spec_markdown.endsWith("\n")
        ? sink.value.spec_markdown
        : sink.value.spec_markdown + "\n";
      await fs.writeFile(path.join(dir, "SPEC.md"), body, "utf8");
      if (!sink.value.updated_docs?.includes("SPEC.md")) {
        sink.value.updated_docs = [...(sink.value.updated_docs ?? []), "SPEC.md"];
      }
    }
    return { result: sink.value, usedFallback: false, rawText, usage };
  }

  // 兜底：agent 没调 submit_turn，用其最终文本当回复
  const fallback: TurnResult = {
    reply: rawText || "（本轮 Copilot 未返回结构化结果，请重试或补充信息。）",
    open_questions: [],
    research_notes: [],
    readiness: { score: 0, loop_ready: false, missing: ["agent 未提交结构化结果"] },
    updated_docs: [],
  };
  return { result: fallback, usedFallback: true, rawText, usage };
}
