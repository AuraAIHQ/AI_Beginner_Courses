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
      return { text: message.content ?? "", usage, turns: turn };
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

  throw new Error(`OpenAI-compatible agent 超过最大工具回合数 ${maxTurns}`);
}
