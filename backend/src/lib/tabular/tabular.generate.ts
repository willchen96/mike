// Non-streaming prepare steps for the tabular-review generate stream.
//
// STREAMING: the SSE endpoint (POST /:reviewId/generate) keeps its streaming
// loop, lease handling, abort handling, and per-cell persistence in the route.
// Only the NON-streaming work lives here, split into the two phases the
// generation lease imposes:
//
//   1. prepareTabularGenerate  — PRE-lease guards: does the review exist, may
//      this user touch it, does it have columns, does the user have a key for
//      the tabular model. None of these read cell state.
//   2. loadTabularGenerateWork — POST-lease snapshot: the rows (filtered to
//      those whose every source document the requester may read) and the
//      current cells.
//
// Phase 2 must not run before the lease is claimed. Otherwise a request can
// snapshot pending cells while another run is finishing, acquire the newly
// released lease, and regenerate results that were completed after its stale
// snapshot.

import { type UserApiKeys } from "../llm";
import { ensureReviewAccess, filterAccessibleDocumentIds } from "../access";
import { loadReviewRows, type ReviewRow } from "./tabular.rows";
import {
    validateSelectedModel,
    type Column,
    type Db,
    type ModelValidationFailure,
} from "./tabular.shared";

// ---------------------------------------------------------------------------
// Phase 1 — pre-lease guards
// ---------------------------------------------------------------------------

export type PreparedGenerate = {
    /** The review row as stored (carries `updated_at` for the lease claim). */
    review: Record<string, unknown>;
    columns: Column[];
    tabular_model: string;
    api_keys: UserApiKeys;
};

export async function prepareTabularGenerate(
    db: Db,
    args: { reviewId: string; userId: string; userEmail: string | undefined },
): Promise<
    | { ok: true; data: PreparedGenerate }
    | { ok: false; kind: "not_found" }
    | { ok: false; kind: "no_columns" }
    | ({ ok: false; kind: "model" } & Omit<ModelValidationFailure, "ok">)
> {
    const { reviewId, userId, userEmail } = args;

    const { data: review, error: reviewError } = await db
        .from("tabular_reviews")
        .select("*")
        .eq("id", reviewId)
        .single();
    if (reviewError || !review) return { ok: false, kind: "not_found" };
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok) return { ok: false, kind: "not_found" };

    const columns: Column[] = review.columns_config ?? [];
    if (columns.length === 0) return { ok: false, kind: "no_columns" };

    // The model is a property of the REVIEW (main's model-selection policy), not
    // of the user's global defaults, and it must still resolve + be keyed for
    // this user. Failures are carried out verbatim so both the sync and the
    // async endpoint answer with the same status/body.
    const selected = await validateSelectedModel(review.model, userId, db, true);
    if (!selected.ok)
        return {
            ok: false,
            kind: "model",
            status: selected.status,
            body: selected.body,
        };

    return {
        ok: true,
        data: {
            review,
            columns,
            tabular_model: selected.model,
            api_keys: selected.apiKeys,
        },
    };
}

// ---------------------------------------------------------------------------
// Phase 2 — post-lease work snapshot
// ---------------------------------------------------------------------------

export type TabularGenerateWork = {
    /** The review's rows, restricted to rows whose sources are all accessible. */
    rows: ReviewRow[];
    /** Existing cells keyed `${row_id}:${column_index}`. */
    cellMap: Map<string, Record<string, unknown>>;
};

export async function loadTabularGenerateWork(
    db: Db,
    args: { reviewId: string; userId: string; userEmail: string | undefined },
): Promise<
    | { ok: true; data: TabularGenerateWork }
    | { ok: false; kind: "cells_error"; error: unknown }
> {
    const { reviewId, userId, userEmail } = args;

    let rows = await loadReviewRows(db, reviewId);

    const { data: cells, error: cellsError } = await db
        .from("tabular_cells")
        .select("*")
        .eq("review_id", reviewId);
    if (cellsError)
        return { ok: false, kind: "cells_error", error: cellsError };
    const cellMap = new Map<string, Record<string, unknown>>();
    for (const cell of cells ?? [])
        cellMap.set(`${cell.row_id}:${cell.column_index}`, cell);

    // A row is only extractable if the requester can access every source
    // document feeding it; drop rows containing anything they cannot see.
    const sourceIds = [
        ...new Set(rows.flatMap((row) => row.source_document_ids ?? [])),
    ];
    const allowedSourceIds = new Set(
        await filterAccessibleDocumentIds(sourceIds, userId, userEmail, db),
    );
    rows = rows.filter((row) =>
        (row.source_document_ids ?? []).every((id) => allowedSourceIds.has(id)),
    );

    return { ok: true, data: { rows, cellMap } };
}
