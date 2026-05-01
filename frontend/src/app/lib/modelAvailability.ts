import { MODELS, type ModelOption } from "../components/assistant/ModelToggle";

export type ModelProvider = "claude" | "gemini" | "openrouter";

export function getModelProvider(modelId: string): ModelProvider | null {
    const model = MODELS.find((m) => m.id === modelId);
    if (!model) return null;
    if (model.group === "Anthropic") return "claude";
    if (model.group === "Google") return "gemini";
    if (model.group === "OpenRouter") return "openrouter";
    return null;
}

export function isModelAvailable(
    modelId: string,
    apiKeys: { claudeApiKey: string | null; geminiApiKey: string | null; openrouterApiKey?: string | null },
): boolean {
    const provider = getModelProvider(modelId);
    if (!provider) return false;
    if (provider === "claude") return !!apiKeys.claudeApiKey?.trim();
    if (provider === "gemini") return !!apiKeys.geminiApiKey?.trim();
    if (provider === "openrouter") return !!apiKeys.openrouterApiKey?.trim();
    return false;
}

export function isProviderAvailable(
    provider: ModelProvider,
    apiKeys: { claudeApiKey: string | null; geminiApiKey: string | null; openrouterApiKey?: string | null },
): boolean {
    if (provider === "claude") return !!apiKeys.claudeApiKey?.trim();
    if (provider === "gemini") return !!apiKeys.geminiApiKey?.trim();
    if (provider === "openrouter") return !!apiKeys.openrouterApiKey?.trim();
    return false;
}

export function providerLabel(provider: ModelProvider): string {
    if (provider === "claude") return "Anthropic (Claude)";
    if (provider === "gemini") return "Google (Gemini)";
    if (provider === "openrouter") return "OpenRouter";
    return "";
}

export function modelGroupToProvider(
    group: ModelOption["group"],
): ModelProvider {
    if (group === "Anthropic") return "claude";
    if (group === "Google") return "gemini";
    return "openrouter";
}
