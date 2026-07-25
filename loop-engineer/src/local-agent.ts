import { promises as fs } from "node:fs";
import path from "node:path";

interface LocalToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type LocalMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: LocalToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface LocalChatRequest {
  model: string;
  messages: LocalMessage[];
  tools: Array<Record<string, unknown>>;
  tool_choice: "auto";
  temperature: number;
  max_tokens: number;
}

interface LocalChatResponse {
  choices?: Array<{
    message?: { role: "assistant"; content?: string | null; tool_calls?: LocalToolCall[] };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface LocalAgentResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  computeMs: number;
}

export interface RunLocalCodingAgentOptions {
  cwd: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  prompt: string;
  maxTurns?: number;
  maxTokens?: number;
  timeoutMs?: number;
  request?: (body: LocalChatRequest) => Promise<LocalChatResponse>;
}

const tools: Array<Record<string, unknown>> = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 file inside the task worktree.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Completely replace a UTF-8 file inside the task worktree.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files below a directory in the task worktree.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
];

async function safePath(cwd: string, input: unknown): Promise<string> {
  if (typeof input !== "string" || !input) throw new Error("path 必须是非空字符串");
  const root = await fs.realpath(cwd);
  const candidate = path.resolve(root, input);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    throw new Error(`路径越界：${input}`);
  }
  try {
    const real = await fs.realpath(candidate);
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error(`符号链接越界：${input}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = await fs.realpath(path.dirname(candidate));
    if (parent !== root && !parent.startsWith(root + path.sep)) throw new Error(`父目录越界：${input}`);
  }
  return candidate;
}

async function executeTool(
  opts: RunLocalCodingAgentOptions,
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  if (name === "read_file") return fs.readFile(await safePath(opts.cwd, input.path), "utf8");
  if (name === "write_file") {
    if (typeof input.content !== "string") throw new Error("content 必须是字符串");
    await fs.writeFile(await safePath(opts.cwd, input.path), input.content, "utf8");
    return `updated ${String(input.path)}`;
  }
  if (name === "list_files") {
    const dir = await safePath(opts.cwd, typeof input.path === "string" ? input.path : ".");
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.map((entry) => `${entry.isDirectory() ? "d" : "f"} ${entry.name}`).join("\n");
  }
  throw new Error(`未知工具：${name}`);
}

async function requestCompletion(
  opts: RunLocalCodingAgentOptions,
  body: LocalChatRequest,
): Promise<LocalChatResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 600_000);
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
    const response = await fetch(`${opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`LM Studio HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
    return (await response.json()) as LocalChatResponse;
  } finally {
    clearTimeout(timer);
  }
}

export async function runLocalCodingAgent(opts: RunLocalCodingAgentOptions): Promise<LocalAgentResult> {
  const started = Date.now();
  const messages: LocalMessage[] = [
    {
      role: "system",
      content: "You are an autonomous coding agent. Work only inside the provided worktree using the file tools. Inspect files before editing, implement the task, and finish with a concise summary. The loop engine runs configured quality gates after you finish; do not request or invent shell execution. Never invent tool results.",
    },
    { role: "user", content: opts.prompt },
  ];
  let inputTokens = 0;
  let outputTokens = 0;

  for (let turn = 1; turn <= (opts.maxTurns ?? 60); turn++) {
    const body: LocalChatRequest = {
      model: opts.model,
      messages: messages.map((message) => ({ ...message })),
      tools,
      tool_choice: "auto",
      temperature: 0,
      max_tokens: opts.maxTokens ?? 8192,
    };
    const response = opts.request ? await opts.request(body) : await requestCompletion(opts, body);
    inputTokens += response.usage?.prompt_tokens ?? 0;
    outputTokens += response.usage?.completion_tokens ?? 0;
    const message = response.choices?.[0]?.message;
    if (!message) throw new Error("LM Studio 未返回 choices[0].message");
    const calls = message.tool_calls ?? [];
    messages.push({
      role: "assistant",
      content: message.content ?? "",
      ...(calls.length ? { tool_calls: calls } : {}),
    });
    if (!calls.length) {
      return { text: message.content ?? "", inputTokens, outputTokens, computeMs: Date.now() - started };
    }
    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function.arguments) as Record<string, unknown>; } catch { /* tool gets empty args */ }
      let content: string;
      try { content = await executeTool(opts, call.function.name, args); }
      catch (error) { content = `工具执行失败：${(error as Error).message}`; }
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }
  throw new Error(`LM Studio coder 超过最大工具回合数 ${opts.maxTurns ?? 60}`);
}
