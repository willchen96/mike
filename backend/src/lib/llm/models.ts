import { isGatewayModelAvailable } from "./gateway";
import { REASONING_LEVELS, type Provider, type ReasoningLevel } from "./types";

// ---------------------------------------------------------------------------
// Canonical model IDs
// ---------------------------------------------------------------------------
// Main-chat tier (top-end) — user picks one of these per message.
export const CLAUDE_MAIN_MODELS = [
    "claude-fable-5",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
] as const;
export const GEMINI_MAIN_MODELS = [
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
] as const;
export const OPENAI_MAIN_MODELS = [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
] as const;
// Ollama models are detected dynamically (see GET /models/ollama). Any id of
// the form "ollama/<tag>" is valid — see providerForModel / resolveModel.

// Mid-tier (used for tabular review) — user picks one in account settings.
export const CLAUDE_MID_MODELS = [
    "claude-sonnet-5",
    "claude-sonnet-4-6",
] as const;
export const GEMINI_MID_MODELS = [
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3-flash-preview",
] as const;
export const OPENAI_MID_MODELS = ["gpt-5.6-terra", "gpt-5.4"] as const;

// Low-tier (used for title generation, lightweight extractions) — user picks
// one in account settings.
export const CLAUDE_LOW_MODELS = ["claude-haiku-4-5"] as const;
export const GEMINI_LOW_MODELS = [
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
] as const;
export const OPENAI_LOW_MODELS = ["gpt-5.6-luna", "gpt-5.4-mini"] as const;

export const DEFAULT_MAIN_MODEL = "gemini-3-flash-preview";
export const DEFAULT_TITLE_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_TABULAR_MODEL = "gemini-3-flash-preview";

const STANDARD_REASONING_LEVELS: readonly ReasoningLevel[] =
    REASONING_LEVELS.filter((level) => level !== "max");
const GPT_56_REASONING_LEVELS: readonly ReasoningLevel[] = REASONING_LEVELS;

/** Explicit AI SDK reasoning levels supported by the selected model family. */
export function reasoningLevelsForModel(
    model: string,
): readonly ReasoningLevel[] {
    const catalogId = model.replace(/^(?:openrouter|vercel)\//, "");
    if (/(?:^|\/)gpt-5\.6(?:-|$)/.test(catalogId)) {
        return GPT_56_REASONING_LEVELS;
    }
    return STANDARD_REASONING_LEVELS;
}

/** Move a stale saved level to the nearest level supported by the model. */
export function normalizeReasoningLevelForModel(
    model: string,
    reasoning: ReasoningLevel | undefined,
): ReasoningLevel | undefined {
    if (!reasoning) return undefined;
    const supported = reasoningLevelsForModel(model);
    if (supported.includes(reasoning)) return reasoning;
    const requestedIndex = REASONING_LEVELS.indexOf(reasoning);
    return supported.reduce((nearest, candidate) => {
        const nearestDistance = Math.abs(
            REASONING_LEVELS.indexOf(nearest) - requestedIndex,
        );
        const candidateDistance = Math.abs(
            REASONING_LEVELS.indexOf(candidate) - requestedIndex,
        );
        return candidateDistance <= nearestDistance ? candidate : nearest;
    }, supported[0] ?? "high");
}

// OpenCode Go publishes one catalog across three incompatible wire protocols:
// OpenAI Responses, Anthropic Messages, and OpenAI Chat Completions. The live
// /models payload does not identify a model's protocol, so keep these lists
// fail-closed and in sync with https://opencode.ai/docs/go/#endpoints. A new
// catalog entry is not offered until Mike can actually speak its protocol.
export const OPENCODE_GO_CHAT_COMPLETIONS_MODEL_IDS: ReadonlySet<string> =
    new Set([
        "glm-5",
        "glm-5.1",
        "glm-5.2",
        "glm-5.3",
        "kimi-k2.6",
        "kimi-k2.7-code",
        "kimi-k3",
        "deepseek-v4-pro",
        "deepseek-v4-flash",
        "mimo-v2.5",
        "mimo-v2.5-pro",
        "hy3",
    ]);

export const OPENCODE_GO_MESSAGES_MODEL_IDS: ReadonlySet<string> = new Set([
    "minimax-m3",
    "minimax-m2.7",
    "minimax-m2.5",
    "qwen3.8-max",
    "qwen3.7-max",
    "qwen3.7-plus",
    "qwen3.6-plus",
]);

const ALL_MODELS = new Set<string>([
    ...CLAUDE_MAIN_MODELS,
    ...GEMINI_MAIN_MODELS,
    ...OPENAI_MAIN_MODELS,
    ...CLAUDE_MID_MODELS,
    ...GEMINI_MID_MODELS,
    ...OPENAI_MID_MODELS,
    ...CLAUDE_LOW_MODELS,
    ...GEMINI_LOW_MODELS,
    ...OPENAI_LOW_MODELS,
]);

// ---------------------------------------------------------------------------
// Provider inference
// ---------------------------------------------------------------------------

export function providerForModel(model: string): Provider {
    if (model.startsWith("gateway/")) return "gateway";
    if (model.startsWith("ollama")) return "ollama";
    if (model.startsWith("openrouter/")) return "openrouter";
    if (model.startsWith("vercel/")) return "vercel";
    if (model.startsWith("opencode-go/")) return "opencode-go";
    if (model.startsWith("claude")) return "claude";
    if (model.startsWith("gemini")) return "gemini";
    if (model.startsWith("gpt-")) return "openai";
    throw new Error(`Unknown model id: ${model}`);
}

// Renamed/retired static ids → their current equivalents. Stored preferences
// and localStorage selections outlive catalog renames; mapping here keeps an
// old saved value working instead of silently kicking it to the fallback.
export const LEGACY_MODEL_IDS: Record<string, string> = {
    "gemini-3.1-flash-lite-preview": "gemini-3.5-flash-lite",
    "gpt-5.4-lite": "gpt-5.4-mini",
};

export function resolveModel(
    id: string | null | undefined,
    fallback: string,
): string {
    const canonical = id ? (LEGACY_MODEL_IDS[id] ?? id) : id;
    if (
        canonical &&
        (ALL_MODELS.has(canonical) ||
            isGatewayModelAvailable(canonical) ||
            canonical.startsWith("ollama/") ||
            /^(?:openrouter|vercel)\/[^\s/]+\/[^\s]+$/.test(canonical) ||
            // OpenCode Go's catalog ids are single-segment ("glm-5"), not the
            // vendor/model pairs OpenRouter and Vercel publish.
            /^opencode-go\/[^\s]+$/.test(canonical))
    )
        return canonical;
    return fallback;
}

export function openRouterModelId(model: string): string {
    return model.replace(/^openrouter\//, "");
}

export function vercelModelId(model: string): string {
    return model.replace(/^vercel\//, "");
}

export function openCodeGoModelId(model: string): string {
    return model.replace(/^opencode-go\//, "");
}

export function isOpenCodeGoChatCompletionsModel(model: string): boolean {
    return OPENCODE_GO_CHAT_COMPLETIONS_MODEL_IDS.has(
        openCodeGoModelId(model),
    );
}

export function isOpenCodeGoMessagesModel(model: string): boolean {
    return OPENCODE_GO_MESSAGES_MODEL_IDS.has(openCodeGoModelId(model));
}

export function isSupportedOpenCodeGoModel(model: string): boolean {
    return (
        isOpenCodeGoChatCompletionsModel(model) ||
        isOpenCodeGoMessagesModel(model)
    );
}
