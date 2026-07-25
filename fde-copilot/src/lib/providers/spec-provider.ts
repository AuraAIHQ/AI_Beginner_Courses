import type { TurnResult, Usage } from "../types";
import { runClaudeSpecAgent } from "./claude";
import { runLmStudioSpecAgent } from "./lmstudio";
import { lmStudioBaseUrl, type ModelSelection } from "./registry";

export interface SpecAgentContext {
  root: string;
  system: string;
  user: string;
  model?: string;
  maxTurns: number;
}

export interface SpecAgentOutput {
  result: TurnResult;
  usedFallback: boolean;
  rawText: string;
  usage: Usage;
}

export interface SpecAgentProvider {
  run(context: SpecAgentContext): Promise<SpecAgentOutput>;
}

const providers: Record<ModelSelection["provider"], SpecAgentProvider> = {
  claude: { run: runClaudeSpecAgent },
  lmstudio: {
    run: async (context) => {
      if (!context.model) throw new Error("LM Studio Provider 未选择模型（设置 LMSTUDIO_MODEL 或在项目中选择）");
      return runLmStudioSpecAgent({
        root: context.root,
        baseUrl: lmStudioBaseUrl(),
        apiKey: process.env.LMSTUDIO_API_KEY,
        model: context.model,
        system: context.system,
        user: context.user,
        maxTurns: context.maxTurns,
      });
    },
  },
};

export function specAgentProvider(selection: ModelSelection): SpecAgentProvider {
  return providers[selection.provider];
}
