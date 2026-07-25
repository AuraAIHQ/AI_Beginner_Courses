import { promises as fs } from "node:fs";
import { z } from "zod";
import { SPEC_DOCS, type TurnResult, type Usage, ZERO_USAGE } from "../types";
import {
  runToolLoop,
  type ChatCompletionResponse,
  type ChatCompletionRequest,
  type FunctionTool,
} from "./openai-compatible";
import { safeProjectPath } from "./path-policy";

const TurnResultSchema = z.object({
  reply: z.string(),
  open_questions: z.array(z.object({ id: z.string(), question: z.string(), why: z.string() })),
  research_notes: z.array(z.object({
    claim: z.string(),
    source: z.string().optional(),
    needs_confirmation: z.boolean(),
  })),
  readiness: z.object({
    score: z.number().min(0).max(100),
    loop_ready: z.boolean(),
    missing: z.array(z.string()),
  }),
  updated_docs: z.array(z.string()),
});

const fileEnum = [...SPEC_DOCS];
const tools: FunctionTool[] = [
  {
    type: "function",
    function: {
      name: "list_specs",
      description: "列出当前项目允许访问的规格文档。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "read_spec",
      description: "读取一份当前项目的规格文档。",
      parameters: {
        type: "object",
        properties: { file: { type: "string", enum: fileEnum } },
        required: ["file"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_spec",
      description: "完整覆盖一份规格文档。先 read_spec，再写回融合后的完整 Markdown。",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string", enum: fileEnum },
          content: { type: "string" },
        },
        required: ["file", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_turn",
      description: "提交本轮面向客户的结构化结果。完成所有文档更新后必须恰好调用一次。",
      parameters: {
        type: "object",
        properties: {
          reply: { type: "string" },
          open_questions: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "string" }, question: { type: "string" }, why: { type: "string" } },
              required: ["id", "question", "why"],
            },
          },
          research_notes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                claim: { type: "string" },
                source: { type: "string" },
                needs_confirmation: { type: "boolean" },
              },
              required: ["claim", "needs_confirmation"],
            },
          },
          readiness: {
            type: "object",
            properties: {
              score: { type: "number", minimum: 0, maximum: 100 },
              loop_ready: { type: "boolean" },
              missing: { type: "array", items: { type: "string" } },
            },
            required: ["score", "loop_ready", "missing"],
          },
          updated_docs: { type: "array", items: { type: "string", enum: fileEnum } },
        },
        required: ["reply", "open_questions", "research_notes", "readiness", "updated_docs"],
        additionalProperties: false,
      },
    },
  },
];

async function safeSpec(root: string, file: unknown): Promise<string> {
  if (typeof file !== "string" || !SPEC_DOCS.includes(file as (typeof SPEC_DOCS)[number])) {
    throw new Error(`不允许访问规格文件：${String(file)}`);
  }
  return safeProjectPath(root, file);
}

export interface RunLmStudioSpecAgentOptions {
  root: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  system: string;
  user: string;
  maxTurns?: number;
  request?: (request: ChatCompletionRequest) => Promise<ChatCompletionResponse>;
}

export interface LmStudioSpecAgentResult {
  result: TurnResult;
  usedFallback: boolean;
  rawText: string;
  usage: Usage;
}

export async function runLmStudioSpecAgent(
  opts: RunLmStudioSpecAgentOptions,
): Promise<LmStudioSpecAgentResult> {
  let submitted: TurnResult | null = null;
  const started = Date.now();
  const loop = await runToolLoop({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    system: `${opts.system}\n\n你运行在本地 OpenAI-compatible Agent 中。只能通过提供的工具访问规格文件；完成后必须调用 submit_turn。你没有网页搜索能力，不得声称已联网调研。`,
    user: opts.user,
    tools,
    maxTurns: opts.maxTurns,
    request: opts.request,
    executeTool: async (name, input) => {
      if (name === "list_specs") return JSON.stringify(SPEC_DOCS);
      if (name === "read_spec") return fs.readFile(await safeSpec(opts.root, input.file), "utf8");
      if (name === "write_spec") {
        if (typeof input.content !== "string") throw new Error("write_spec.content 必须是字符串");
        await fs.writeFile(await safeSpec(opts.root, input.file), input.content, "utf8");
        return `已更新 ${String(input.file)}`;
      }
      if (name === "submit_turn") {
        submitted = TurnResultSchema.parse(input);
        return "已记录结构化结果";
      }
      throw new Error(`未知工具：${name}`);
    },
  });

  const usage: Usage = {
    ...ZERO_USAGE,
    inputTokens: loop.usage.inputTokens,
    outputTokens: loop.usage.outputTokens,
    computeMs: Date.now() - started,
    turns: 1,
  };
  if (submitted) return { result: submitted, usedFallback: false, rawText: loop.text, usage };

  return {
    result: {
      reply: loop.text || "本地模型未提交结构化结果，请重试。",
      open_questions: [],
      research_notes: [],
      readiness: { score: 0, loop_ready: false, missing: ["本地模型未调用 submit_turn"] },
      updated_docs: [],
    },
    usedFallback: true,
    rawText: loop.text,
    usage,
  };
}
