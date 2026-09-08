import { requireGatewayModel } from "./llm/gateway";
import { createServerSupabase } from "./supabase";
import { UserFacingError } from "./userFacingError";
import { resolveModel } from "./llm/models";

type Db = ReturnType<typeof createServerSupabase>;

export type RouterSlug = "openrouter" | "vercel" | "opencode-go";

/**
 * Every router, in the order the settings UI lists them. A router's slug is
 * also its model-id prefix and its API-key provider name — keeping those one
 * string is what lets the selection, gating and key lookups stay generic.
 */
export const ROUTER_SLUGS: readonly RouterSlug[] = [
    "openrouter",
    "vercel",
    "opencode-go",
];

/** One saved model selection per router. */
export type RouterModelSelections = Record<RouterSlug, string[]>;

/** The router a namespaced app-level model id routes through, if any. */
export function routerForModelId(model: string): RouterSlug | null {
    return ROUTER_SLUGS.find((slug) => model.startsWith(`${slug}/`)) ?? null;
}

/**
 * True when a router-prefixed model id is in the user's saved selection for
 * that router (selections store the raw catalog id, without the slug prefix).
 * Non-router models are always allowed here — their gating happens elsewhere.
 */
export function isRouterModelSelected(
    model: string,
    selections: RouterModelSelections,
): boolean {
    const router = routerForModelId(model);
    if (!router) return true;
    return selections[router].includes(model.slice(router.length + 1));
}

/** Router labels as the settings UI names them, for user-facing messages. */
const ROUTER_LABELS: Record<RouterSlug, string> = {
    openrouter: "OpenRouter",
    vercel: "Vercel AI Gateway",
    "opencode-go": "OpenCode Go",
};

/**
 * Request-time model resolution for chat-style requests. Router-prefixed ids
 * are accepted by SHAPE in resolveModel, so on their own they would let any
 * authenticated user hand-craft a request that runs an arbitrary, arbitrarily
 * expensive gateway model on the operator's env key. This choke point
 * additionally requires a router model to be in the requesting user's saved
 * selection.
 *
 * `onOutsideSelection` picks what "not in the selection" means to the caller:
 * - "throw" (the request path): the user named this model in THIS request, so
 *   quietly answering with a different one is a lie about which model wrote
 *   the response. Fail loudly with an actionable message instead.
 * - "fallback" (the default, for stored preferences): a preference the user
 *   set long ago must not brick every request; degrade to the caller's
 *   default exactly like an invalid model id, with a warning for operators.
 */
export async function resolveRequestedModel(
    requested: string | null | undefined,
    fallback: string,
    userId: string,
    db: Db = createServerSupabase(),
    onOutsideSelection: "throw" | "fallback" = "fallback",
): Promise<string> {
    if (requested?.startsWith("gateway/")) {
        try {
            requireGatewayModel(requested);
            return requested;
        } catch (error) {
            if (onOutsideSelection === "throw" || !(error instanceof UserFacingError)) {
                throw error;
            }
            return fallback;
        }
    }
    const resolved = resolveModel(requested, fallback);
    const router = routerForModelId(resolved);
    if (!router) return resolved;
    const selection = await getUserRouterModels(userId, router, db);
    if (selection.includes(resolved.slice(router.length + 1))) {
        return resolved;
    }
    if (onOutsideSelection === "throw") {
        throw new UserFacingError(
            `Model ${resolved} is not in your saved ${ROUTER_LABELS[router]} models — add it in Settings → Bring Your Own Keys → Routers.`,
        );
    }
    console.warn(
        `[router-models] user ${userId} requested ${router} model "${resolved}" outside their saved selection; using ${fallback}`,
    );
    return fallback;
}

// Deploy-before-migrate tolerance: on a database that predates the
// user_router_models migration, reads report "no selections" instead of
// exploding every profile/chat/title/tabular request into a 500. Postgres
// raises undefined_table (42P01); PostgREST reports a relation missing from
// its schema cache as PGRST205 (the analog of the 42703 missing-column shape
// selectProfile already tolerates).
//
// BOTH arms require the message to name user_router_models. Neither code
// means "THIS table is missing" on its own — a policy, view or trigger that
// references some other dropped relation raises 42P01 from this query too,
// and answering that with an empty selection would turn a schema fault into
// a silent "you have no router models".
function isMissingRouterModelsTable(error: unknown): boolean {
    const record =
        error && typeof error === "object"
            ? (error as { code?: unknown; message?: unknown })
            : {};
    const code = typeof record.code === "string" ? record.code : "";
    const message = typeof record.message === "string" ? record.message : "";
    return (
        (code === "42P01" || code === "PGRST205") &&
        message.includes("user_router_models")
    );
}

let warnedMissingTable = false;

/** Every router's saved selection for a user, in one round of queries. */
export async function getAllUserRouterModels(
    userId: string,
    db: Db = createServerSupabase(),
): Promise<RouterModelSelections> {
    const selections = await Promise.all(
        ROUTER_SLUGS.map((slug) => getUserRouterModels(userId, slug, db)),
    );
    return Object.fromEntries(
        ROUTER_SLUGS.map((slug, index) => [slug, selections[index]]),
    ) as RouterModelSelections;
}

export async function getUserRouterModels(
    userId: string,
    router: string,
    db: Db = createServerSupabase(),
): Promise<string[]> {
    const { data, error } = await db
        .from("user_router_models")
        .select("model_id")
        .eq("user_id", userId)
        .eq("router", router)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true });
    if (error) {
        if (isMissingRouterModelsTable(error)) {
            if (!warnedMissingTable) {
                warnedMissingTable = true;
                console.warn(
                    "[router-models] user_router_models table is missing; " +
                        "treating router selections as empty until the " +
                        "20260818_01 migration is applied",
                );
            }
            return [];
        }
        throw error;
    }

    return (data ?? []).flatMap((row) =>
        typeof row.model_id === "string" && row.model_id.trim()
            ? [row.model_id.trim()]
            : [],
    );
}

export async function replaceUserRouterModels(
    userId: string,
    router: string,
    modelIds: string[],
    db: Db = createServerSupabase(),
): Promise<void> {
    const { error } = await db.rpc("replace_user_router_models", {
        target_user_id: userId,
        target_router: router,
        target_model_ids: modelIds,
    });
    if (error) throw error;
}
