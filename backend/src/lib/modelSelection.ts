import { gatewayConfig, isGatewayModelAvailable } from "./llm/gateway";
import {
    CLAUDE_LOW_MODELS,
    GEMINI_LOW_MODELS,
    OPENAI_LOW_MODELS,
    providerForModel,
    normalizeReasoningLevelForModel,
    resolveModel,
    type UserApiKeys,
    REASONING_LEVELS,
    type ReasoningLevel,
} from "./llm";
import {
    isRouterModelSelected,
    type RouterModelSelections,
} from "./routerModels";
import { resolveRequestedModel } from "./routerModels";
import { createServerSupabase } from "./supabase";
import { UserFacingError } from "./userFacingError";

export const MODEL_REQUIRED_DETAIL =
    "Select a model before sending a message.";

export const TABULAR_MODEL_REQUIRED_DETAIL =
    "Select a model for this tabular review before running it.";

export const DEFAULT_REASONING_LEVEL: ReasoningLevel = "high";

export function normalizeReasoningLevel(
    value: unknown,
): ReasoningLevel | null {
    // `minimal` was previously persisted; treat it as Low while migrations
    // and older clients converge on the current reasoning-level union.
    if (value === "minimal") return "low";
    return typeof value === "string" &&
        (REASONING_LEVELS as readonly string[]).includes(value)
        ? (value as ReasoningLevel)
        : null;
}

/** Resolve request → chat → profile, defaulting a never-selected user to High. */
export function resolveEffectiveReasoningLevel(args: {
    model: string;
    requested?: unknown;
    chatReasoningLevel?: unknown;
    lastSelectedReasoningLevel?: unknown;
}): ReasoningLevel {
    const selected =
        normalizeReasoningLevel(args.requested) ??
        normalizeReasoningLevel(args.chatReasoningLevel) ??
        normalizeReasoningLevel(args.lastSelectedReasoningLevel) ??
        DEFAULT_REASONING_LEVEL;

    return (
        normalizeReasoningLevelForModel(args.model, selected) ??
        DEFAULT_REASONING_LEVEL
    );
}

/**
 * Normalize a stored optional preference without inventing a fallback.
 * Router preferences are valid only while they remain in the user's saved
 * router-model allowlist.
 */
export function normalizeOptionalModelPreference(
    value: string | null | undefined,
    routerModels: RouterModelSelections,
): string | null {
    const resolved = resolveModel(value, "");
    if (!resolved || !isRouterModelSelected(resolved, routerModels)) return null;
    return resolved;
}

/** Whether a resolved model can actually run with the user's current keys. */
export function hasApiKeyForModel(
    model: string,
    apiKeys: UserApiKeys,
): boolean {
    const provider = providerForModel(model);
    if (provider === "gateway") return isGatewayModelAvailable(model);
    return provider === "ollama" || !!apiKeys[provider]?.trim();
}

type EffectiveChatModelResult =
    | {
          ok: true;
          model: string;
          source: "request" | "chat" | "last_selected" | "gateway";
      }
    | {
          ok: false;
          status: 400 | 422;
          code: "model_required" | "model_unavailable" | "missing_api_key";
          detail: string;
      };

/**
 * Resolve a chat turn, using a configured deployment gateway as the final fallback. An explicit
 * request is authoritative. Otherwise the chat's saved model wins, with the
 * one profile-level last-selected model before the deployment fallback.
 */
export async function resolveEffectiveChatModel(args: {
    requested?: string | null;
    chatModel?: string | null;
    lastSelectedModel?: string | null;
    apiKeys: UserApiKeys;
    userId: string;
    db: ReturnType<typeof createServerSupabase>;
}): Promise<EffectiveChatModelResult> {
    const requestedText = args.requested?.trim() ?? "";
    if (requestedText) {
        const requested = resolveModel(requestedText, "");
        if (!requested) {
            return {
                ok: false,
                status: 400,
                code: "model_unavailable",
                detail: requestedText.startsWith("gateway/")
                    ? `${gatewayConfig()?.label ?? "Gateway"} model is not available. Select a configured model.`
                    : `Model "${requestedText}" is not available. Select another model.`,
            };
        }
        try {
            const model = await resolveRequestedModel(
                requested,
                "",
                args.userId,
                args.db,
                "throw",
            );
            if (!hasApiKeyForModel(model, args.apiKeys)) {
                return {
                    ok: false,
                    status: 422,
                    code: "missing_api_key",
                    detail: `An API key is required to use ${model}. Add the key or select another model.`,
                };
            }
            return { ok: true, model, source: "request" };
        } catch (error) {
            if (error instanceof UserFacingError) {
                return {
                    ok: false,
                    status: 400,
                    code: "model_unavailable",
                    detail: error.message,
                };
            }
            throw error;
        }
    }

    const storedCandidates = [
        { value: args.chatModel, source: "chat" as const },
        { value: args.lastSelectedModel, source: "last_selected" as const },
    ];
    for (const candidate of storedCandidates) {
        const resolved = resolveModel(candidate.value, "");
        if (!resolved) continue;
        const selected = await resolveRequestedModel(
            resolved,
            "",
            args.userId,
            args.db,
            "fallback",
        );
        if (selected && hasApiKeyForModel(selected, args.apiKeys)) {
            return { ok: true, model: selected, source: candidate.source };
        }
    }

    const gateway = gatewayConfig();
    if (gateway) return { ok: true, model: gateway.defaultModel, source: "gateway" };

    return {
        ok: false,
        status: 400,
        code: "model_required",
        detail: MODEL_REQUIRED_DETAIL,
    };
}

/**
 * Pick the model used for automatic title generation.
 *
 * A saved title preference is an explicit override. Otherwise first-party
 * chat models map to that provider's cheapest title-tier model. Routers and
 * local models reuse the exact chat model; deployment gateways use their configured
 * default. Mike cannot safely infer a
 * cheaper equivalent within an external/dynamic catalog.
 */
export function titleModelForChat(
    chatModel: string,
    titleOverride?: string | null,
): string {
    const override = resolveModel(titleOverride, "");
    if (override) return override;

    const resolvedChatModel = resolveModel(chatModel, "");
    if (!resolvedChatModel) {
        throw new Error("A supported chat model is required for title generation");
    }

    switch (providerForModel(resolvedChatModel)) {
        case "claude":
            return CLAUDE_LOW_MODELS[0];
        case "gemini":
            return GEMINI_LOW_MODELS[0];
        case "openai":
            return OPENAI_LOW_MODELS[0];
        case "gateway":
            return gatewayConfig()!.defaultModel;
        case "openrouter":
        case "vercel":
        case "opencode-go":
        case "ollama":
            return resolvedChatModel;
    }
}

/** Only configured deployments introduce a fallback for absent/unusable preferences. */
export function gatewayAwarePreference(
    model: string | null,
    usable: (model: string) => boolean,
): string | null {
    const gateway = gatewayConfig();
    if (!gateway || (model && usable(model))) return model;
    return gateway.defaultModel;
}
