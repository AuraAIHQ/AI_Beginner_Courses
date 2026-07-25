import type { ModelSelection, ProviderId } from "../types";
export type { ModelSelection, ProviderId } from "../types";

export interface ProviderDescriptor {
  id: ProviderId;
  label: string;
  available: boolean;
  models: string[];
  error?: string;
}

export interface ProviderDefaults {
  defaultProvider?: string;
  claudeModel?: string;
  lmStudioModel?: string;
}

export function providerDefaultsFromEnv(): ProviderDefaults {
  return {
    defaultProvider: process.env.FDE_DEFAULT_PROVIDER,
    claudeModel: process.env.CLAUDE_MODEL,
    lmStudioModel: process.env.LMSTUDIO_MODEL,
  };
}

export function lmStudioBaseUrl(): string {
  return (process.env.LMSTUDIO_BASE_URL || "http://127.0.0.1:1234/v1").replace(/\/$/, "");
}

export function resolveProviderSelection(
  projectSelection?: ModelSelection,
  defaults: ProviderDefaults = providerDefaultsFromEnv(),
): ModelSelection {
  const configured = defaults.defaultProvider === "lmstudio" ? "lmstudio" : "claude";
  const provider = projectSelection?.provider ?? configured;
  const model = projectSelection?.model
    ?? (provider === "lmstudio" ? defaults.lmStudioModel : defaults.claudeModel);
  return { provider, ...(model ? { model } : {}) };
}

export function availableDefaultSelection(
  providers: ProviderDescriptor[],
  desired: ModelSelection,
): ModelSelection {
  const provider = providers.find((candidate) => candidate.id === desired.provider && candidate.available)
    ?? providers.find((candidate) => candidate.available);
  if (!provider) return { provider: "claude" };
  if (provider.id === "lmstudio") {
    const model = desired.provider === "lmstudio" && desired.model && provider.models.includes(desired.model)
      ? desired.model
      : provider.models[0];
    return { provider: "lmstudio", ...(model ? { model } : {}) };
  }
  return { provider: provider.id, ...(desired.provider === provider.id && desired.model ? { model: desired.model } : {}) };
}

interface LmStudioModel {
  type?: string;
  key?: string;
  capabilities?: { trained_for_tool_use?: boolean };
}

export function selectToolModels(models: LmStudioModel[]): string[] {
  return models
    .filter((model) => model.type === "llm" && model.capabilities?.trained_for_tool_use === true)
    .map((model) => model.key)
    .filter((key): key is string => Boolean(key));
}

async function fetchModels(baseUrl: string): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const headers: Record<string, string> = {};
    if (process.env.LMSTUDIO_API_KEY) headers.authorization = `Bearer ${process.env.LMSTUDIO_API_KEY}`;
    const serverRoot = baseUrl.replace(/\/v1$/, "");
    const response = await fetch(`${serverRoot}/api/v1/models`, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = (await response.json()) as { models?: LmStudioModel[] };
    return selectToolModels(json.models ?? []);
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverProviders(options?: {
  baseUrl?: string;
  requestModels?: () => Promise<string[]>;
}): Promise<ProviderDescriptor[]> {
  const providers: ProviderDescriptor[] = [
    { id: "claude", label: "Claude", available: true, models: [] },
  ];
  try {
    const models = options?.requestModels
      ? await options.requestModels()
      : await fetchModels(options?.baseUrl ?? lmStudioBaseUrl());
    providers.push(models.length > 0
      ? { id: "lmstudio", label: "LM Studio", available: true, models }
      : {
          id: "lmstudio",
          label: "LM Studio",
          available: false,
          models: [],
          error: "未发现支持工具调用的 LLM",
        });
  } catch (error) {
    providers.push({
      id: "lmstudio",
      label: "LM Studio",
      available: false,
      models: [],
      error: (error as Error).message,
    });
  }
  return providers;
}
