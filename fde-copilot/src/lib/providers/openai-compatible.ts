export interface FunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools: FunctionTool[];
  tool_choice: "auto";
  max_tokens: number;
  temperature: number;
}

export interface ChatCompletionResponse {
  choices?: Array<{
    message?: { role: "assistant"; content?: string | null; tool_calls?: ToolCall[] };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface ToolLoopResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  turns: number;
  /**
   * true = 用满 maxTurns 仍未收到「不带 tool_calls 的收尾回复」。
   * 此时**不抛错**：模型很可能已经通过 submit_turn 交出了有效结果，只是没再多说一句收尾的话；
   * 抛错会把它连同已写盘的文档一起丢掉，违反本文件既有的「provider 失败要优雅降级，不要抛」约定。
   * 由调用方决定这算不算失败（lmstudio.ts：submit_turn 收到了就照常返回，没收到才算 fallback）。
   */
  exhausted: boolean;
}

export interface RunToolLoopOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  system: string;
  user: string;
  tools: FunctionTool[];
  executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
  maxTurns?: number;
  maxTokens?: number;
  timeoutMs?: number;
  request?: (request: ChatCompletionRequest) => Promise<ChatCompletionResponse>;
}

async function requestCompletion(
  opts: Pick<RunToolLoopOptions, "baseUrl" | "apiKey" | "timeoutMs">,
  body: ChatCompletionRequest,
): Promise<ChatCompletionResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 180_000);
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
    const response = await fetch(`${opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`OpenAI-compatible HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
    }
    return (await response.json()) as ChatCompletionResponse;
  } finally {
    clearTimeout(timer);
  }
}

export async function runToolLoop(opts: RunToolLoopOptions): Promise<ToolLoopResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];
  const usage = { inputTokens: 0, outputTokens: 0 };
  const maxTurns = opts.maxTurns ?? 24;

  for (let turn = 1; turn <= maxTurns; turn++) {
    const body: ChatCompletionRequest = {
      model: opts.model,
      messages: messages.map((message) => ({ ...message })),
      tools: opts.tools,
      tool_choice: "auto",
      max_tokens: opts.maxTokens ?? 4096,
      temperature: 0,
    };
    const response = opts.request
      ? await opts.request(body)
      : await requestCompletion(opts, body);
    usage.inputTokens += response.usage?.prompt_tokens ?? 0;
    usage.outputTokens += response.usage?.completion_tokens ?? 0;

    const message = response.choices?.[0]?.message;
    if (!message) throw new Error("OpenAI-compatible provider 未返回 choices[0].message");
    const calls = message.tool_calls ?? [];
    messages.push({
      role: "assistant",
      content: message.content ?? "",
      ...(calls.length ? { tool_calls: calls } : {}),
    });

    if (!calls.length) {
      return { text: message.content ?? "", usage, turns: turn, exhausted: false };
    }

    for (const call of calls) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.function.arguments) as Record<string, unknown>;
      } catch {
        args = {};
      }
      let content: string;
      try {
        content = await opts.executeTool(call.function.name, args);
      } catch (error) {
        content = `工具执行失败：${(error as Error).message}`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }

  // 用满回合数 → 如实上报，但不抛：见 ToolLoopResult.exhausted。
  // 最后一条 assistant 文本（可能为空）照常带回，调用方能据此给用户一个有内容的回复。
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  return {
    text: typeof last?.content === "string" ? last.content : "",
    usage,
    turns: maxTurns,
    exhausted: true,
  };
}
