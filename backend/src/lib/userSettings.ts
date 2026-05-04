import { createServerSupabase } from "./supabase";
import {
    resolveModel,
    DEFAULT_TITLE_MODEL,
    DEFAULT_TABULAR_MODEL,
    type UserApiKeys,
} from "./llm";

export type UserModelSettings = {
    title_model: string;
    tabular_model: string;
    api_keys: UserApiKeys;
};

// Title generation is a lightweight task — always routed to the cheapest model
// of whichever provider the user has keys for: LocalLLM lite if available, 
// otherwise Gemini Flash Lite, otherwise Claude Haiku.
function resolveTitleModel(apiKeys: UserApiKeys): string {
    // Check if LocalLLM is configured server-side
    if (process.env.VLLM_BASE_URL?.trim()) {
        return "localllm-lite";
    }
    if (apiKeys.gemini?.trim()) return DEFAULT_TITLE_MODEL;
    if (apiKeys.claude?.trim()) return "claude-haiku-4-5";
    return DEFAULT_TITLE_MODEL;
}

export async function getUserModelSettings(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserModelSettings> {
    const client = db ?? createServerSupabase();
    const { data } = await client
        .from("user_profiles")
        .select("tabular_model, claude_api_key, gemini_api_key")
        .eq("user_id", userId)
        .single();

    const api_keys: UserApiKeys = {
        claude: data?.claude_api_key ?? null,
        gemini: data?.gemini_api_key ?? null,
        openai: process.env.VLLM_API_KEY ?? null,
    };

    return {
        title_model: resolveTitleModel(api_keys),
        tabular_model: resolveModel(data?.tabular_model, "localllm-main"),
        api_keys,
    };
}

export async function getUserApiKeys(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserApiKeys> {
    const client = db ?? createServerSupabase();
    const { data } = await client
        .from("user_profiles")
        .select("claude_api_key, gemini_api_key")
        .eq("user_id", userId)
        .single();
    return {
        claude: data?.claude_api_key ?? null,
        gemini: data?.gemini_api_key ?? null,
        openai: process.env.VLLM_API_KEY ?? null,
    };
}
