import type { Provider } from "./types";

// ---------------------------------------------------------------------------
// Canonical model IDs
// ---------------------------------------------------------------------------
// Main-chat tier (top-end) — user picks one of these per message.
export const CLAUDE_MAIN_MODELS = ["claude-opus-4-7", "claude-sonnet-4-6"] as const;
export const GEMINI_MAIN_MODELS = [
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
] as const;
export const LOCAL_LLM_MAIN_MODELS = ["localllm-main"] as const;

// Mid-tier (used for tabular review) — user picks one in account settings.
export const CLAUDE_MID_MODELS = ["claude-sonnet-4-6"] as const;
export const GEMINI_MID_MODELS = ["gemini-3-flash-preview"] as const;
export const LOCAL_LLM_MID_MODELS = ["localllm-main"] as const;

// Low-tier (used for title generation, lightweight extractions) — user picks
// one in account settings.
export const CLAUDE_LOW_MODELS = ["claude-haiku-4-5"] as const;
export const GEMINI_LOW_MODELS = ["gemini-3.1-flash-lite-preview"] as const;
export const LOCAL_LLM_LOW_MODELS = ["localllm-lite"] as const;

export const DEFAULT_MAIN_MODEL = "localllm-main";
export const DEFAULT_TITLE_MODEL = "localllm-lite";
export const DEFAULT_TABULAR_MODEL = "localllm-main";

const ALL_MODELS = new Set<string>([
    ...CLAUDE_MAIN_MODELS,
    ...GEMINI_MAIN_MODELS,
    ...LOCAL_LLM_MAIN_MODELS,
    ...CLAUDE_MID_MODELS,
    ...GEMINI_MID_MODELS,
    ...LOCAL_LLM_MID_MODELS,
    ...CLAUDE_LOW_MODELS,
    ...GEMINI_LOW_MODELS,
    ...LOCAL_LLM_LOW_MODELS,
]);

// ---------------------------------------------------------------------------
// Provider inference
// ---------------------------------------------------------------------------

export function providerForModel(model: string): Provider {
    if (model.startsWith("localllm")) return "openai";
    if (model.startsWith("claude")) return "claude";
    if (model.startsWith("gemini")) return "gemini";
    throw new Error(`Unknown model id: ${model}`);
}

export function resolveModel(id: string | null | undefined, fallback: string): string {
    if (id && ALL_MODELS.has(id)) return id;
    return fallback;
}
