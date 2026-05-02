import { MODELS, type ModelOption } from "../components/assistant/ModelToggle";

export type ModelProvider = "claude" | "gemini" | "openai";

export type ApiKeys = {
    claudeApiKey: string | null;
    geminiApiKey: string | null;
    openaiApiKey: string | null;
};

export function getModelProvider(modelId: string): ModelProvider | null {
    const model = MODELS.find((m) => m.id === modelId);
    if (!model) return null;
    if (model.group === "Anthropic") return "claude";
    if (model.group === "OpenAI") return "openai";
    return "gemini";
}

export function isModelAvailable(
    modelId: string,
    apiKeys: ApiKeys,
): boolean {
    const provider = getModelProvider(modelId);
    if (!provider) return false;
    if (provider === "claude") return !!apiKeys.claudeApiKey?.trim();
    if (provider === "openai") return !!apiKeys.openaiApiKey?.trim();
    return !!apiKeys.geminiApiKey?.trim();
}

export function isProviderAvailable(
    provider: ModelProvider,
    apiKeys: ApiKeys,
): boolean {
    if (provider === "claude") return !!apiKeys.claudeApiKey?.trim();
    if (provider === "openai") return !!apiKeys.openaiApiKey?.trim();
    return !!apiKeys.geminiApiKey?.trim();
}

export function providerLabel(provider: ModelProvider): string {
    if (provider === "claude") return "Anthropic (Claude)";
    if (provider === "openai") return "OpenAI (GPT)";
    return "Google (Gemini)";
}

export function modelGroupToProvider(
    group: ModelOption["group"],
): ModelProvider {
    if (group === "Anthropic") return "claude";
    if (group === "OpenAI") return "openai";
    return "gemini";
}
