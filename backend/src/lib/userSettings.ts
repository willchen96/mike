import { createServerSupabase } from "./supabase";
import { type UserApiKeys } from "./llm";
import { type ReasoningLevel } from "./llm";
import { getUserApiKeys as getStoredUserApiKeys } from "./userApiKeys";
import {
    getAllUserRouterModels,
} from "./routerModels";
import {
    normalizeOptionalModelPreference,
    gatewayAwarePreference,
    hasApiKeyForModel,
    normalizeReasoningLevel,
} from "./modelSelection";

export type UserModelSettings = {
    /** Explicit override; null means derive the title model from the chat. */
    title_model: string | null;
    /** Default for new reviews only; each review stores its own model. */
    tabular_model: string | null;
    /** Cross-surface fallback used only when a chat has no usable model. */
    last_selected_chat_model: string | null;
    /** Cross-surface fallback used only when a chat has no saved level. */
    last_selected_reasoning_level: ReasoningLevel | null;
    legal_research_us: boolean;
    api_keys: UserApiKeys;
    personalisation?: {
        displayName: string | null;
        organisation: string | null;
        jurisdiction: string | null;
        practiceSetting: string | null;
        professionalTitle: string | null;
        practiceAreas: string[];
    };
};

export async function getUserModelSettings(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserModelSettings> {
    const client = db ?? createServerSupabase();
    const [profileResult, api_keys, routerModels] = await Promise.all([
        client
            .from("user_profiles")
            .select(
                "title_model, tabular_model, last_selected_chat_model, last_selected_reasoning_level, legal_research_us, display_name, organisation, jurisdiction, practice_setting, professional_title, practice_areas",
            )
            .eq("user_id", userId)
            .single(),
        getStoredUserApiKeys(userId, client),
        getAllUserRouterModels(userId, client),
    ]);
    let data = profileResult.data;

    // A database that predates the 20260821 onboarding migration rejects the
    // select above outright (unknown column), which would silently fall every
    // caller back to default models and re-enable US legal research for users
    // who turned it off. Retry with the pre-migration column set so saved
    // settings keep working; personalisation simply stays empty.
    if (profileResult.error?.code === "42703") {
        const withoutLastSelected = await client
            .from("user_profiles")
            .select(
                "title_model, tabular_model, last_selected_chat_model, legal_research_us, display_name, organisation, jurisdiction, practice_setting, professional_title, practice_areas",
            )
            .eq("user_id", userId)
            .single();
        if (!withoutLastSelected.error) {
            data = {
                ...withoutLastSelected.data,
                last_selected_reasoning_level: null,
            } as typeof data;
        } else if (withoutLastSelected.error.code === "42703") {
            const legacy = await client
                .from("user_profiles")
                .select("title_model, tabular_model, legal_research_us")
                .eq("user_id", userId)
                .single();
            // A second failure (a database even older than the pre-migration
            // shape) keeps data null and falls through to the defaults below.
            data = legacy.error
                ? null
                : ({
                      ...legacy.data,
                      last_selected_chat_model: null,
                      last_selected_reasoning_level: null,
                  } as typeof data);
        } else {
            data = null;
        }
    }

    const preference = (value: string | null | undefined) => gatewayAwarePreference(
        normalizeOptionalModelPreference(value, routerModels),
        (model) => hasApiKeyForModel(model, api_keys),
    );
    return {
        title_model: preference(data?.title_model),
        tabular_model: preference(data?.tabular_model),
        last_selected_chat_model: preference(data?.last_selected_chat_model),
        last_selected_reasoning_level: normalizeReasoningLevel(
            data?.last_selected_reasoning_level,
        ),
        legal_research_us:
            (data as { legal_research_us?: boolean | null } | null)
                ?.legal_research_us !== false,
        personalisation: {
            displayName:
                typeof data?.display_name === "string"
                    ? data.display_name
                    : null,
            organisation:
                typeof data?.organisation === "string"
                    ? data.organisation
                    : null,
            jurisdiction:
                typeof data?.jurisdiction === "string"
                    ? data.jurisdiction
                    : null,
            practiceSetting:
                typeof data?.practice_setting === "string"
                    ? data.practice_setting
                    : null,
            professionalTitle:
                typeof data?.professional_title === "string"
                    ? data.professional_title
                    : null,
            practiceAreas: Array.isArray(data?.practice_areas)
                ? data.practice_areas.filter(
                      (area): area is string => typeof area === "string",
                  )
                : [],
        },
        api_keys,
    };
}

/** Save a reasoning level when the user explicitly selects it in a picker. */
export async function persistLastSelectedReasoningLevel(
    userId: string,
    reasoningLevel: ReasoningLevel,
    db: ReturnType<typeof createServerSupabase>,
): Promise<unknown | null> {
    const { error } = await db
        .from("user_profiles")
        .update({
            last_selected_reasoning_level: reasoningLevel,
            updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
    return error ?? null;
}

/** Save a model when the user explicitly selects it in a chat picker. */
export async function persistLastSelectedChatModel(
    userId: string,
    model: string,
    db: ReturnType<typeof createServerSupabase>,
): Promise<unknown | null> {
    const { error } = await db
        .from("user_profiles")
        .update({
            last_selected_chat_model: model,
            updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
    return error ?? null;
}

export async function getUserApiKeys(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserApiKeys> {
    const client = db ?? createServerSupabase();
    return getStoredUserApiKeys(userId, client);
}
