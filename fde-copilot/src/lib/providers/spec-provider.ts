import type { TurnResult, Usage } from "../types";
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

/**
 * 只登记**真正经由本抽象层执行**的 provider。
 *
 * 曾经这里还挂着 `claude: { run: runClaudeSpecAgent }`，但 agent.ts 的 claude 路径从不走
 * specAgentProvider —— 它直接用 agent-sdk 的 query 循环。那份 providers/claude.ts 是并支后
 * 留下的死代码，且相对 live 路径少了若干加固，一旦有人「顺手接上」就是静默降级。已删除。
 * claude 要迁到本抽象层，应当把 live 实现搬过来，而不是复活那份旧的。
 */
const providers: Partial<Record<ModelSelection["provider"], SpecAgentProvider>> = {
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
  const provider = providers[selection.provider];
  if (!provider) {
    throw new Error(`provider「${selection.provider}」不经由 spec-provider 抽象层执行`);
  }
  return provider;
}
