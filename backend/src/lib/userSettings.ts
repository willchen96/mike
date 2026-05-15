import { createServerDb } from "./db";
import {
    resolveModel,
    DEFAULT_TITLE_MODEL,
    DEFAULT_TABULAR_MODEL,
    OLLAMA_LOW_MODELS,
    OPENAI_LOW_MODELS,
    type UserApiKeys,
} from "./llm";
import { isOllamaConfigured } from "./llm/ollama";
import { getUserApiKeys as getStoredUserApiKeys } from "./userApiKeys";

export type UserModelSettings = {
    title_model: string;
    tabular_model: string;
    api_keys: UserApiKeys;
};

// Title generation is a lightweight task — always routed to the cheapest model
// of whichever provider the user has keys for: Gemini Flash Lite if Gemini is
// available, otherwise OpenAI nano, otherwise Claude Haiku. With no user keys
// set, defaults to Gemini (the dev-mode env fallback).
function resolveTitleModel(apiKeys: UserApiKeys): string {
    if (isOllamaConfigured()) return OLLAMA_LOW_MODELS[0];
    if (apiKeys.gemini?.trim()) return DEFAULT_TITLE_MODEL;
    if (apiKeys.openai?.trim()) return OPENAI_LOW_MODELS[0];
    if (apiKeys.claude?.trim()) return "claude-haiku-4-5";
    return DEFAULT_TITLE_MODEL;
}

export async function getUserModelSettings(
    userId: string,
    db?: ReturnType<typeof createServerDb>,
): Promise<UserModelSettings> {
    const client = db ?? createServerDb();
    const { data } = await client
        .selectFrom("userProfiles")
        .select(["tabularModel"])
        .where("userId", "=", userId)
        .single();
    const api_keys = await getStoredUserApiKeys(userId, client);

    return {
        title_model: resolveTitleModel(api_keys),
        tabular_model: resolveModel(data?.tabular_model, DEFAULT_TABULAR_MODEL),
        api_keys,
    };
}

export async function getUserApiKeys(
    userId: string,
    db?: ReturnType<typeof createServerDb>,
): Promise<UserApiKeys> {
    const client = db ?? createServerDb();
    return getStoredUserApiKeys(userId, client);
}
