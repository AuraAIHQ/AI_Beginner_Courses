import { spawn } from "node:child_process";
import type { ResolvedProvider } from "./config.js";
import { runLocalCodingAgent } from "./local-agent.js";
import { ZERO, estimateCost, recordUsage } from "./usage.js";
import type { Usage } from "./usage.js";

export interface RunAgentOpts {
  cwd: string;
  provider: ResolvedProvider;
  /** 限制工具（如 reviewer 只读）。不传则用默认全量 + skip-permissions */
  allowedTools?: string[];
  /** 硬禁工具（deny 优先级高于 skip-permissions，用于把 reviewer 收成只读） */
  disallowedTools?: string[];
  maxTurns?: number;
  timeoutMs?: number;
  /** 外部取消信号（job 级超时用）：abort 时 kill 子进程并 reject */
  signal?: AbortSignal;
  /** provider.isMock 时用它替代真实调用 */
  mockHandler?: (prompt: string, cwd: string) => Promise<string>;
}

export interface RunAgentResult {
  text: string;
  provider: string;
  usage: Usage;
}

/**
 * W2 / B2 硬约束：coder/reviewer 在 worktree 里执行「模型自动生成的代码」。跑不可信代码的
 * 沙箱应用**白名单**（而非黑名单）——从最小 env 起，只放行明确需要的键，杜绝 host 上其它
 * 机密（云凭证 AWS_*、其它 *_API_KEY/*_SECRET、SSH agent socket 等）被生成代码读到外泄。
 *
 * 模型端点认证（provider.env 的 ANTHROPIC_*）由调用方随后并入 —— 模型必需、非 git 凭证。
 */
const SANDBOX_ALLOW_KEYS = new Set([
  "PATH",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

/**
 * 构造沙箱环境（白名单）：从最小 allowlist 起，只放行必要的系统/locale 变量，
 * 再并入 provider.env（模型端点认证）。运维可用 LOOP_SANDBOX_PASSTHROUGH（逗号分隔）
 * 追加确需透传的键（如某些 CI 环境的代理设置）。
 */
export function sandboxEnv(
  base: NodeJS.ProcessEnv,
  providerEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  const extra = (process.env.LOOP_SANDBOX_PASSTHROUGH ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allow = new Set([...SANDBOX_ALLOW_KEYS, ...extra]);
  const env: NodeJS.ProcessEnv = {};
  for (const k of Object.keys(base)) {
    if (allow.has(k)) env[k] = base[k];
  }
  return { ...env, ...providerEnv };
}

/**
 * 统一原语：把一个 prompt 交给某供应商执行。
 * 真实供应商 = spawn `claude -p`，用 provider.env 覆盖端点/模型（订阅/GLM/Kimi 同一机制）。
 * mock = 本地模拟，用于无 key 跑通编排。
 */
export async function runAgent(prompt: string, opts: RunAgentOpts): Promise<RunAgentResult> {
  const { provider } = opts;

  if (opts.signal?.aborted) throw new Error(`供应商 ${provider.name} 已取消（超时）`);

  if (provider.isMock) {
    const text = opts.mockHandler
      ? await opts.mockHandler(prompt, opts.cwd)
      : "[mock] no handler";
    return { text, provider: "mock", usage: { ...ZERO, calls: 1 } };
  }

  if (provider.kind === "openai-compatible") {
    if (!provider.capabilities.agenticCoder || !provider.baseUrl || !provider.model) {
      throw new Error(`供应商 ${provider.name} 不支持 agentic coder`);
    }
    const local = await runLocalCodingAgent({
      cwd: opts.cwd,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model,
      prompt,
      maxTurns: opts.maxTurns,
      timeoutMs: opts.timeoutMs,
    });
    const usage: Usage = {
      inputTokens: local.inputTokens,
      outputTokens: local.outputTokens,
      cacheReadTokens: 0,
      costUsd: 0,
      computeMs: local.computeMs,
      calls: 1,
    };
    await recordUsage(provider.name, usage, new Date().toISOString());
    return { text: local.text, provider: provider.name, usage };
  }

  const maxTurns = opts.maxTurns ?? 60;
  const timeoutMs = opts.timeoutMs ?? 600_000;

  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--dangerously-skip-permissions",
    "--max-turns",
    String(maxTurns),
  ];
  if (opts.disallowedTools && opts.disallowedTools.length) {
    // deny 优先于 skip-permissions，确保 reviewer 即便 skip 也无法写/跑命令
    args.push("--disallowedTools", ...opts.disallowedTools);
  }
  if (opts.allowedTools && opts.allowedTools.length) {
    args.push("--allowedTools", ...opts.allowedTools);
  }

  // B2：剥离 push token/PAT/编排密钥，绝不让沙箱代码读到 git 凭证
  const env = sandboxEnv(process.env, provider.env);
  // CC-58 容器回归修复：CF Container 内以 root 运行，claude CLI 默认拒绝
  // `--dangerously-skip-permissions`（root/sudo 安全拦截）。IS_SANDBOX=1 是 Anthropic
  // 官方的一次性沙箱逃生阀——本 CF Container 本就是每 job 短生命周期的隔离沙箱，符合语义。
  // 本地(非 root)跑不受影响。
  env.IS_SANDBOX = "1";

  const result = await new Promise<RunAgentResult>((resolve, reject) => {
    const child = spawn("claude", args, { cwd: opts.cwd, env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`供应商 ${provider.name} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    // 外部取消（job 级超时）：kill 子进程并 reject
    const onAbort = () => {
      child.kill("SIGKILL");
      reject(new Error(`供应商 ${provider.name} 被取消（job 超时）`));
    };
    if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    };

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      cleanup();
      reject(new Error(`spawn claude 失败：${e.message}`));
    });
    child.on("close", (code) => {
      cleanup();
      if (code !== 0) {
        reject(new Error(`供应商 ${provider.name} 退出码 ${code}：${stderr.slice(0, 500)}`));
        return;
      }
      resolve({ text: extractResult(stdout), provider: provider.name, usage: extractUsage(stdout, provider) });
    });
  });
  await recordUsage(result.provider, result.usage, new Date().toISOString());
  return result;
}

/** 从 `claude -p --output-format json` 的输出里取 usage/成本/墙钟 */
function extractUsage(stdout: string, provider: ResolvedProvider): Usage {
  try {
    const obj = JSON.parse(stdout.trim()) as {
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
      total_cost_usd?: number;
      duration_ms?: number;
    };
    const inTok = obj.usage?.input_tokens ?? 0;
    const outTok = obj.usage?.output_tokens ?? 0;
    // 只有真正的 Anthropic(claude 订阅)才信 total_cost_usd；GLM/Kimi/DeepSeek 直连时
    // claude -p 按 Anthropic 价折算会大幅高估，改用本地价表按其自身 token 估。
    const costUsd =
      provider.name === "claude"
        ? obj.total_cost_usd ?? 0
        : estimateCost(provider.model, inTok, outTok);
    return {
      inputTokens: inTok,
      outputTokens: outTok,
      cacheReadTokens: obj.usage?.cache_read_input_tokens ?? 0,
      costUsd,
      computeMs: obj.duration_ms ?? 0,
      calls: 1,
    };
  } catch {
    return { ...ZERO, calls: 1 };
  }
}

/**
 * OpenAI 兼容单发调用（HiLinkup 等网关）。无 agentic 工具——上下文（diff/规格）
 * 由调用方拼进 messages。用于 reviewer/planner/回流 这类"喂上下文→出 JSON"的角色。
 */
export async function runChat(
  system: string,
  user: string,
  opts: {
    provider: ResolvedProvider;
    fallbacks?: ResolvedProvider[];
    maxTokens?: number;
    timeoutMs?: number;
  },
): Promise<RunAgentResult> {
  // CC-58（jason 12:13）：按 key 价值级联，用尽即切下一个。主 provider（如 Workers AI 配额
  // 用尽/限流）内部退避重试仍失败 → 依次 failover 到 fallbacks（DeepSeek → HiLinkup）。
  // 老调用不传 fallbacks，行为与之前完全一致。
  const chain = [opts.provider, ...(opts.fallbacks ?? []).filter((p) => p.name !== opts.provider.name)];
  let lastErr: Error | null = null;
  for (let i = 0; i < chain.length; i++) {
    try {
      return await attemptChat(system, user, chain[i], opts);
    } catch (e) {
      lastErr = e as Error;
      if (i < chain.length - 1) {
        console.error(
          `[runChat] ${chain[i].name} 失败(${lastErr.message.slice(0, 100)}) → 级联下一档 ${chain[i + 1].name}`,
        );
      }
    }
  }
  throw lastErr ?? new Error("runChat 级联全部失败");
}

async function attemptChat(
  system: string,
  user: string,
  provider: ResolvedProvider,
  opts: { maxTokens?: number; timeoutMs?: number },
): Promise<RunAgentResult> {
  // Union(LM Studio + CC-58): 云 chat provider 需 apiKey，但本地 LM Studio 无 key。
  // 只强制 baseUrl/model；apiKey 缺失时 fetch 自动省略 authorization 头（见下）。
  if (!provider.baseUrl || !provider.model) {
    throw new Error(`runChat 需要 OpenAI-compatible 供应商（有 baseUrl/model）：${provider.name}`);
  }
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const startedMs = Date.now();
  // 瞬时错误（429/503/网络）退避重试，避免一次限流就打死整个任务
  const backoffMs = [2000, 5000, 12000];
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: provider.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          max_tokens: opts.maxTokens ?? 4000,
          // 不设 temperature：部分模型（如 kimi-k2.7-code）只接受默认值
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      // 瞬时错误：限流 429 与各类 5xx（含 Cloudflare 524 origin timeout）都退避重试
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`${provider.name} HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
        if (attempt < backoffMs.length) {
          await new Promise((r) => setTimeout(r, backoffMs[attempt] + Math.floor(Math.random() * 500)));
          continue; // 退避后重试
        }
        throw lastErr;
      }
      if (!res.ok) {
        throw new Error(`${provider.name} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const j = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const inTok = j.usage?.prompt_tokens ?? 0;
      const outTok = j.usage?.completion_tokens ?? 0;
      const usage: Usage = {
        inputTokens: inTok,
        outputTokens: outTok,
        cacheReadTokens: 0,
        costUsd: estimateCost(provider.model, inTok, outTok),
        computeMs: Date.now() - startedMs,
        calls: 1,
      };
      await recordUsage(provider.name, usage, new Date().toISOString());
      return { text: j.choices?.[0]?.message?.content ?? "", provider: provider.name, usage };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e as Error;
      // 网络/中断类瞬时错误也退避重试
      const transient = /aborted|ECONNRESET|ETIMEDOUT|fetch failed|network/i.test(lastErr.message);
      if (transient && attempt < backoffMs.length) {
        await new Promise((r) => setTimeout(r, backoffMs[attempt] + Math.floor(Math.random() * 500)));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new Error(`${provider.name} 调用失败`);
}

/** 从 `claude -p --output-format json` 的输出里取最终文本 */
function extractResult(stdout: string): string {
  const trimmed = stdout.trim();
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj.result === "string") return obj.result;
  } catch {
    /* 非 JSON，回退原文 */
  }
  return trimmed;
}

/** 从模型输出里稳健地抽第一个 JSON 对象（容忍 ```json 包裹与前后废话） */
export function extractJson<T>(text: string): T | null {
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
