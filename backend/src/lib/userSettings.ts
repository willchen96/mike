import { createServerSupabase } from "./supabase";
import {
    resolveModel,
    DEFAULT_TITLE_MODEL,
    DEFAULT_TABULAR_MODEL,
    type UserApiKeys,
} from "./llm";
import { decryptApiKey } from "./crypto";
import { logger } from "./logger";

export type UserModelSettings = {
    title_model: string;
    tabular_model: string;
    api_keys: UserApiKeys;
};

// Title generation is a lightweight task — always routed to the cheapest model
// of whichever provider the user has keys for: Gemini Flash Lite if Gemini is
// available, otherwise Claude Haiku. With no user keys set, defaults to Gemini
// (the dev-mode env fallback).
function resolveTitleModel(apiKeys: UserApiKeys): string {
    if (apiKeys.gemini?.trim()) return DEFAULT_TITLE_MODEL;
    if (apiKeys.claude?.trim()) return "claude-haiku-4-5";
    return DEFAULT_TITLE_MODEL;
}

/**
 * Decodes three base64 bytea columns from PostgREST into Buffers and decrypts
 * the AES-GCM ciphertext. Returns null when:
 *   - any column value is missing (user hasn't set a key)
 *   - decryption fails (tampered ciphertext / wrong master key)
 *
 * Callers that need to distinguish "no key" from "decrypt failure" must check
 * whether ciphertextB64 was non-null before calling.
 */
function decryptColumn(
    ciphertextB64: string | null | undefined,
    ivB64: string | null | undefined,
    authTagB64: string | null | undefined,
): string | null {
    if (!ciphertextB64 || !ivB64 || !authTagB64) return null;
    return decryptApiKey({
        ciphertext: decodeBytea(ciphertextB64),
        iv: decodeBytea(ivB64),
        authTag: decodeBytea(authTagB64),
    });
}

function decodeBytea(value: string): Buffer {
    return value.startsWith("\\x")
        ? Buffer.from(value.slice(2), "hex")
        : Buffer.from(value, "base64");
}

type EncryptedKeyRow = {
    tabular_model?: string | null;
    claude_api_key_ciphertext?: string | null;
    claude_api_key_iv?: string | null;
    claude_api_key_auth_tag?: string | null;
    gemini_api_key_ciphertext?: string | null;
    gemini_api_key_iv?: string | null;
    gemini_api_key_auth_tag?: string | null;
};

export async function getUserModelSettings(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
    ctx?: { route?: string; requestId?: string | number | object },
): Promise<UserModelSettings> {
    const client = db ?? createServerSupabase();
    const { data: rawData } = await client
        .from("user_profiles")
        .select(
            "tabular_model, " +
            "claude_api_key_ciphertext, claude_api_key_iv, claude_api_key_auth_tag, " +
            "gemini_api_key_ciphertext, gemini_api_key_iv, gemini_api_key_auth_tag",
        )
        .eq("user_id", userId)
        .single();
    const data = rawData as unknown as EncryptedKeyRow | null;

    const claude = data?.claude_api_key_ciphertext
        ? decryptColumn(
            data.claude_api_key_ciphertext,
            data.claude_api_key_iv,
            data.claude_api_key_auth_tag,
          )
        : null;

    if (data?.claude_api_key_ciphertext && claude === null) {
        logger.error(
            { user_id: userId, provider: "claude" },
            "[userSettings] decrypt failed — possible master key mismatch",
        );
    }

    const gemini = data?.gemini_api_key_ciphertext
        ? decryptColumn(
            data.gemini_api_key_ciphertext,
            data.gemini_api_key_iv,
            data.gemini_api_key_auth_tag,
          )
        : null;

    if (data?.gemini_api_key_ciphertext && gemini === null) {
        logger.error(
            { user_id: userId, provider: "gemini" },
            "[userSettings] decrypt failed — possible master key mismatch",
        );
    }

    if (claude) {
        logger.info({
            event: "api_key_read",
            user_id: userId,
            provider: "claude",
            route: ctx?.route ?? "unknown",
            request_id: ctx?.requestId,
        }, "[userSettings] api_key_read");
    }
    if (gemini) {
        logger.info({
            event: "api_key_read",
            user_id: userId,
            provider: "gemini",
            route: ctx?.route ?? "unknown",
            request_id: ctx?.requestId,
        }, "[userSettings] api_key_read");
    }

    const api_keys: UserApiKeys = { claude, gemini };

    return {
        title_model: resolveTitleModel(api_keys),
        tabular_model: resolveModel(data?.tabular_model ?? null, DEFAULT_TABULAR_MODEL),
        api_keys,
    };
}

export async function getUserApiKeys(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
    ctx?: { route?: string; requestId?: string | number | object },
): Promise<UserApiKeys> {
    const client = db ?? createServerSupabase();
    const { data: rawData } = await client
        .from("user_profiles")
        .select(
            "claude_api_key_ciphertext, claude_api_key_iv, claude_api_key_auth_tag, " +
            "gemini_api_key_ciphertext, gemini_api_key_iv, gemini_api_key_auth_tag",
        )
        .eq("user_id", userId)
        .single();
    const data = rawData as unknown as EncryptedKeyRow | null;

    const claude = data?.claude_api_key_ciphertext
        ? decryptColumn(
            data.claude_api_key_ciphertext,
            data.claude_api_key_iv,
            data.claude_api_key_auth_tag,
          )
        : null;

    if (data?.claude_api_key_ciphertext && claude === null) {
        logger.error(
            { user_id: userId, provider: "claude" },
            "[userSettings] decrypt failed — possible master key mismatch",
        );
    }

    const gemini = data?.gemini_api_key_ciphertext
        ? decryptColumn(
            data.gemini_api_key_ciphertext,
            data.gemini_api_key_iv,
            data.gemini_api_key_auth_tag,
          )
        : null;

    if (data?.gemini_api_key_ciphertext && gemini === null) {
        logger.error(
            { user_id: userId, provider: "gemini" },
            "[userSettings] decrypt failed — possible master key mismatch",
        );
    }

    if (claude) {
        logger.info({
            event: "api_key_read",
            user_id: userId,
            provider: "claude",
            route: ctx?.route ?? "unknown",
            request_id: ctx?.requestId,
        }, "[userSettings] api_key_read");
    }
    if (gemini) {
        logger.info({
            event: "api_key_read",
            user_id: userId,
            provider: "gemini",
            route: ctx?.route ?? "unknown",
            request_id: ctx?.requestId,
        }, "[userSettings] api_key_read");
    }

    return { claude, gemini };
}
