export type ModelProvider = "claude" | "gemini";

export function getModelProvider(modelId: string): ModelProvider | null {
    if (modelId.startsWith("claude")) return "claude";
    if (modelId.startsWith("gemini")) return "gemini";
    return null;
}

export type ApiKeyPresence = {
    hasClaudeKey: boolean;
    hasGeminiKey: boolean;
};

export function isModelAvailable(
    modelId: string,
    apiKeys: ApiKeyPresence,
): boolean {
    const provider = getModelProvider(modelId);
    if (!provider) return false;
    return provider === "claude" ? apiKeys.hasClaudeKey : apiKeys.hasGeminiKey;
}

export function isProviderAvailable(
    provider: ModelProvider,
    apiKeys: ApiKeyPresence,
): boolean {
    return provider === "claude" ? apiKeys.hasClaudeKey : apiKeys.hasGeminiKey;
}

export function providerLabel(provider: ModelProvider): string {
    return provider === "claude" ? "Anthropic (Claude)" : "Google (Gemini)";
}

/**
 * Map a model's group string to its provider.
 * Groups from the /models catalog use provider names ("Anthropic", "Google");
 * fall back to ID-prefix detection for unknown groups.
 */
export function modelGroupToProvider(group: string): ModelProvider {
    if (group === "Anthropic") return "claude";
    if (group === "Google") return "gemini";
    // fallback: shouldn't normally reach here
    return "claude";
}
