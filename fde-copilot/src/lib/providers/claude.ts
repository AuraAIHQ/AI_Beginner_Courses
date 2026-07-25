import { z } from "zod";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { TurnResult, Usage } from "../types";
import { ZERO_USAGE } from "../types";
import type { SpecAgentContext, SpecAgentOutput } from "./spec-provider";
import { safeProjectPath } from "./path-policy";

function makeCanUseTool(root: string): CanUseTool {
  const inside = async (p: unknown): Promise<boolean> => {
    if (typeof p !== "string" || p.length === 0) return false;
    try {
      await safeProjectPath(root, p);
      return true;
    } catch {
      return false;
    }
  };
  const pathKey: Record<string, string> = {
    Read: "file_path",
    Write: "file_path",
    Edit: "file_path",
    MultiEdit: "file_path",
    NotebookEdit: "notebook_path",
  };
  return async (toolName, input) => {
    if (process.env.CANUSE_DEBUG) console.error(`[canUseTool] ${toolName}`);
    if (toolName.startsWith("mcp__workbench__")) return { behavior: "allow", updatedInput: input };
    if (toolName === "WebSearch" || toolName === "TodoWrite") {
      return { behavior: "allow", updatedInput: input };
    }
    if (toolName in pathKey) {
      const p = (input as Record<string, unknown>)[pathKey[toolName]];
      if (!(await inside(p))) return { behavior: "deny", message: `拒绝越界路径：${String(p)}（仅允许客户目录内）` };
      return { behavior: "allow", updatedInput: input };
    }
    if (toolName === "Glob" || toolName === "Grep") {
      const p = (input as Record<string, unknown>).path;
      if (p !== undefined && !(await inside(p))) {
        return { behavior: "deny", message: `拒绝越界搜索路径：${String(p)}` };
      }
      return { behavior: "allow", updatedInput: input };
    }
    return { behavior: "deny", message: `工具 ${toolName} 未被安全策略允许` };
  };
}

function buildSubmitTool(sink: { value: TurnResult | null }) {
  return tool(
    "submit_turn",
    "把本轮的结构化结果交回网页 UI。每一轮结束时恰好调用一次，这是你本轮的最后一个动作。",
    {
      reply: z.string(),
      open_questions: z.array(z.object({ id: z.string(), question: z.string(), why: z.string() })),
      research_notes: z.array(z.object({
        claim: z.string(), source: z.string().optional(), needs_confirmation: z.boolean(),
      })),
      readiness: z.object({
        score: z.number().min(0).max(100), loop_ready: z.boolean(), missing: z.array(z.string()),
      }),
      updated_docs: z.array(z.string()),
    },
    async (args) => {
      sink.value = args as TurnResult;
      return { content: [{ type: "text", text: "已记录，本轮结束。" }] };
    },
  );
}

export async function runClaudeSpecAgent(context: SpecAgentContext): Promise<SpecAgentOutput> {
  const sink: { value: TurnResult | null } = { value: null };
  const submitServer = createSdkMcpServer({
    name: "workbench",
    version: "1.0.0",
    tools: [buildSubmitTool(sink)],
  });
  let rawText = "";
  const usage: Usage = { ...ZERO_USAGE, turns: 1 };

  for await (const msg of query({
    prompt: context.user,
    options: {
      cwd: context.root,
      systemPrompt: context.system,
      model: context.model,
      mcpServers: { workbench: submitServer },
      allowedTools: ["WebSearch", "mcp__workbench__submit_turn"],
      settingSources: [],
      permissionMode: "default",
      canUseTool: makeCanUseTool(context.root),
      maxTurns: context.maxTurns,
    },
  })) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content) if (block.type === "text") rawText += block.text;
    } else if (msg.type === "result") {
      if ("usage" in msg && msg.usage) {
        usage.inputTokens += msg.usage.input_tokens ?? 0;
        usage.outputTokens += msg.usage.output_tokens ?? 0;
        usage.cacheReadTokens += msg.usage.cache_read_input_tokens ?? 0;
      }
      if ("total_cost_usd" in msg && typeof msg.total_cost_usd === "number") usage.costUsd += msg.total_cost_usd;
      if ("duration_ms" in msg && typeof msg.duration_ms === "number") usage.computeMs += msg.duration_ms;
      if ("result" in msg && typeof msg.result === "string" && !rawText) rawText = msg.result;
    }
  }

  if (sink.value) return { result: sink.value, usedFallback: false, rawText, usage };
  return {
    result: {
      reply: rawText || "（本轮 Copilot 未返回结构化结果，请重试或补充信息。）",
      open_questions: [],
      research_notes: [],
      readiness: { score: 0, loop_ready: false, missing: ["agent 未提交结构化结果"] },
      updated_docs: [],
    },
    usedFallback: true,
    rawText,
    usage,
  };
}
