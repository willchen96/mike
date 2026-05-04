import { MODELS, type ModelOption } from "../components/assistant/ModelToggle";

export type ModelProvider = "claude" | "gemini" | "openai";

export function getModelProvider(modelId: string): ModelProvider | null {
    const model = MODELS.find((m) => m.id === modelId);
    if (!model) return null;
    if (model.group === "LocalLLM") return "openai";
    return model.group === "Anthropic" ? "claude" : "gemini";
}

export function isModelAvailable(
    modelId: string,
    apiKeys: { claudeApiKey: string | null; geminiApiKey: string | null; openaiApiKey: string | null },
): boolean {
    const provider = getModelProvider(modelId);
    if (!provider) return false;
    // LocalLLM is server-configured, always available
    if (provider === "openai") return true;
    return provider === "claude"
        ? !!apiKeys.claudeApiKey?.trim()
        : !!apiKeys.geminiApiKey?.trim();
}

export function isProviderAvailable(
    provider: ModelProvider,
    apiKeys: { claudeApiKey: string | null; geminiApiKey: string | null; openaiApiKey: string | null },
): boolean {
    if (provider === "openai") return true; // LocalLLM is server-configured
    return provider === "claude"
        ? !!apiKeys.claudeApiKey?.trim()
        : !!apiKeys.geminiApiKey?.trim();
}

export function providerLabel(provider: ModelProvider): string {
    if (provider === "openai") return "LocalLLM (OpenAI Compatible)";
    return provider === "claude" ? "Anthropic (Claude)" : "Google (Gemini)";
}

export function modelGroupToProvider(
    group: ModelOption["group"],
): ModelProvider {
    if (group === "LocalLLM") return "openai";
    return group === "Anthropic" ? "claude" : "gemini";
}
