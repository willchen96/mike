// Shared types + helpers used across the tabular extraction files.
//
// These are module-internal: they are exported here so sibling files
// (tabular.prompt.ts, tabular.extract.ts, …) and routes/tabular.ts can
// import them.

import { gatewayConfig } from "../llm/gateway";
import { createServerSupabase } from "../supabase";
import {
    providerForModel,
    resolveModel,
    type Provider,
    type UserApiKeys,
} from "../llm";
import { getUserModelSettings } from "../userSettings";
import { resolveRequestedModel } from "../routerModels";
import {
    gatewayAwarePreference,
    hasApiKeyForModel,
    TABULAR_MODEL_REQUIRED_DETAIL,
} from "../modelSelection";
import { UserFacingError } from "../userFacingError";

export type Db = ReturnType<typeof createServerSupabase>;

// Structural logging slice — service functions only ever .error().
export type Log = Pick<Console, "error">;

// ---------------------------------------------------------------------------
// Model helpers
// ---------------------------------------------------------------------------

function providerLabel(provider: Provider): string {
    if (provider === "gateway") return gatewayConfig()?.label ?? "Gateway";
    if (provider === "claude") return "Anthropic";
    if (provider === "openai") return "OpenAI";
    if (provider === "openrouter") return "OpenRouter";
    if (provider === "vercel") return "Vercel AI Gateway";
    if (provider === "opencode-go") return "OpenCode Go";
    if (provider === "ollama") return "Local (Ollama)";
    return "Gemini";
}

export type MissingApiKey = {
    provider: Provider;
    model: string;
    detail: string;
};

export function missingModelApiKey(
    model: string,
    apiKeys: UserApiKeys,
): MissingApiKey | null {
    const provider = providerForModel(model);
    if (provider === "ollama" || provider === "gateway") return null; // deployment-managed
    if (apiKeys[provider]?.trim()) return null;
    return {
        provider,
        model,
        detail: `${providerLabel(provider)} API key is required to use ${model}. Add an API key or select a different tabular review model.`,
    };
}

export type ValidatedModel = {
    ok: true;
    model: string;
    apiKeys: UserApiKeys;
};

export type ModelValidationFailure = {
    ok: false;
    status: 400 | 409 | 422;
    body: Record<string, unknown>;
};

/**
 * Resolve + authorize the model a tabular review run should use.
 *
 * Lives here rather than in routes/tabular.ts because BOTH the synchronous SSE
 * generate endpoint and the async (queued) one must apply the same policy: the
 * model is a property of the review, it has to still be an available model, the
 * router alias has to resolve for this user, and the user has to hold a key for
 * the provider it lands on.
 */
export async function validateSelectedModel(
    model: unknown,
    userId: string,
    db: Db,
    stored = false,
): Promise<ValidatedModel | ModelValidationFailure> {
    let settings: Awaited<ReturnType<typeof getUserModelSettings>> | undefined;
    const text = typeof model === "string" ? model.trim() : "";
    if (gatewayConfig() && (stored || !text)) {
        settings = await getUserModelSettings(userId, db);
        const candidate = stored
            ? await resolveRequestedModel(text, "", userId, db, "fallback")
            : settings.tabular_model;
        model = gatewayAwarePreference(
            candidate || null,
            (candidateModel) => hasApiKeyForModel(candidateModel, settings!.api_keys),
        );
    }
    const requested = resolveModel(
        typeof model === "string" ? model.trim() : "",
        "",
    );
    if (!requested) {
        return {
            ok: false,
            status: typeof model === "string" && model.trim() ? 400 : 409,
            body: {
                code:
                    typeof model === "string" && model.trim()
                        ? "model_unavailable"
                        : "model_required",
                detail:
                    typeof model === "string" && model.trim()
                        ? `Model "${model}" is not available. Select another model.`
                        : TABULAR_MODEL_REQUIRED_DETAIL,
            },
        };
    }

    let selected: string;
    try {
        selected = await resolveRequestedModel(
            requested,
            "",
            userId,
            db,
            "throw",
        );
    } catch (error) {
        if (error instanceof UserFacingError) {
            return {
                ok: false,
                status: 400,
                body: { code: "model_unavailable", detail: error.message },
            };
        }
        throw error;
    }

    const { api_keys: apiKeys } = settings ?? await getUserModelSettings(userId, db);
    const missingKey = missingModelApiKey(selected, apiKeys);
    if (missingKey) {
        return {
            ok: false,
            status: 422,
            body: { code: "missing_api_key", ...missingKey },
        };
    }
    return { ok: true, model: selected, apiKeys };
}

// ---------------------------------------------------------------------------
// Cell content parsing
// ---------------------------------------------------------------------------

export function parseCellContent(
    raw: unknown,
): { summary: string; flag?: string; reasoning?: string } | null {
    if (!raw) return null;
    if (typeof raw === "object" && raw !== null && "summary" in raw) {
        const c = raw as {
            summary?: unknown;
            flag?: unknown;
            reasoning?: unknown;
        };
        return {
            summary: String(c.summary ?? ""),
            flag: (["green", "grey", "yellow", "red"] as const).includes(
                c.flag as "green",
            )
                ? (c.flag as string)
                : undefined,
            reasoning: typeof c.reasoning === "string" ? c.reasoning : "",
        };
    }
    if (typeof raw === "string") {
        try {
            const p = JSON.parse(raw) as {
                summary?: unknown;
                value?: unknown;
                flag?: unknown;
                reasoning?: unknown;
            };
            return {
                summary: String(p.summary ?? p.value ?? "").trim(),
                flag: (["green", "grey", "yellow", "red"] as const).includes(
                    p.flag as "green",
                )
                    ? (p.flag as string)
                    : undefined,
                reasoning: typeof p.reasoning === "string" ? p.reasoning : "",
            };
        } catch {
            return { summary: raw, flag: "grey", reasoning: "" };
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Extraction result / column shapes
// ---------------------------------------------------------------------------

export type CellResult = {
    summary: string;
    flag: "green" | "grey" | "yellow" | "red";
    reasoning: string;
};
export type Column = {
    index: number;
    name: string;
    prompt: string;
    format?: string;
    tags?: string[];
};

// ---------------------------------------------------------------------------
// Generation lease
// ---------------------------------------------------------------------------
//
// A tabular review may only have ONE generation running at a time. The lease is
// a row-level claim on `tabular_reviews` taken by
// `begin_tabular_review_generation` and released by
// `finish_tabular_review_generation`; it also expires on its own so a holder
// that dies never wedges the review forever. Every cell write made during a run
// is stamped with (and guarded by) that run's `generation_id`, so a superseded
// run can never overwrite the winner's results.
//
// In the SYNCHRONOUS path the HTTP request holds the lease for its whole life
// and renews it on a heartbeat (see routes/tabular.ts). In the ASYNC path the
// request only *claims* the lease and then hands it to the queue: the workers
// renew it while they process, and whichever worker observes that no cell still
// carries the generation id releases it. These constants are shared by both so
// the two paths agree on the timings.

/** Lease duration requested on begin/renew. */
export const TABULAR_GENERATION_LEASE_SECONDS = 300;
/** How often a holder renews its lease — comfortably inside the lease window. */
export const TABULAR_GENERATION_HEARTBEAT_MS = 60_000;

/**
 * Renew the lease. Returns false when this generation no longer owns it (it
 * expired and someone else claimed the review), which callers treat as "stop".
 */
export async function renewGeneration(
    db: Db,
    reviewId: string,
    generationId: string,
): Promise<boolean> {
    const { data, error } = await db.rpc("renew_tabular_review_generation", {
        target_review_id: reviewId,
        target_generation_id: generationId,
        lease_seconds: TABULAR_GENERATION_LEASE_SECONDS,
    });
    return !error && data === true;
}

/** Release the lease. Best-effort: a failure only delays it to its expiry. */
export async function finishGeneration(
    db: Db,
    reviewId: string,
    generationId: string,
    log: Log,
    context = "[tabular/generation]",
): Promise<void> {
    try {
        const { error } = await db.rpc("finish_tabular_review_generation", {
            target_review_id: reviewId,
            target_generation_id: generationId,
        });
        if (error) throw error;
    } catch (error) {
        log.error(`${context} failed to release generation lease`, error);
    }
}

/**
 * Release the lease once no cell is still claimed by this generation.
 *
 * The async path stamps every targeted cell with the generation id before
 * enqueuing, and each terminal write clears it, so "no cell carries this id"
 * means every enqueued row has reached a terminal state — including rows still
 * sitting in the queue, whose cells stay stamped until a worker finishes them.
 * That makes this a safe "last one out turns off the lights" check for whichever
 * worker happens to finish last. If every worker dies before reaching it, the
 * lease still expires on its own.
 */
export async function finishGenerationIfIdle(
    db: Db,
    reviewId: string,
    generationId: string,
    log: Log,
    context = "[tabular/generation]",
): Promise<void> {
    const { data, error } = await db
        .from("tabular_cells")
        .select("id")
        .eq("review_id", reviewId)
        .eq("generation_id", generationId)
        .limit(1);
    if (error) {
        log.error(`${context} failed to check generation idleness`, error);
        return;
    }
    if ((data ?? []).length > 0) return;
    await finishGeneration(db, reviewId, generationId, log, context);
}
