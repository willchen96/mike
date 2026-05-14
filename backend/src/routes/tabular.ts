import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { llmRateLimiter } from "../lib/rateLimiter";
import { createServerSupabase, getUsersByEmails, getUserById } from "../lib/supabase";
import { logger } from "../lib/logger";
import { parseBody } from "../lib/validate";
import { downloadFile } from "../lib/storage";
import { loadActiveVersion } from "../lib/documentVersions";
import { normalizeDocxZipPaths } from "../lib/convert";
import {
    runLLMStream,
    TABULAR_TOOLS,
    type ChatMessage,
    type TabularCellStore,
} from "../lib/chatTools";
import { completeText, streamChatWithTools } from "../lib/llm";
import { getUserApiKeys, getUserModelSettings } from "../lib/userSettings";
import {
    checkProjectAccess,
    ensureReviewAccess,
    listAccessibleProjectIds,
} from "../lib/access";
import { parseLlmJson } from "../lib/chatTools/parseLlmJson";
import {
    TabularCellSchema,
    TabularCellLineSchema,
    TabularCitationsArraySchema,
} from "../lib/chatTools/llm-schemas";

function formatPromptSuffix(format?: string, tags?: string[]): string {
    switch (format) {
        case "bulleted_list":
            return ' The "summary" field in your JSON response must be a markdown bulleted list only — no prose. Format: each item on its own line, prefixed with "* " (asterisk + single space), e.g.\n* First item\n* Second item\n* Third item';
        case "number":
            return ' The "summary" field in your JSON response must be a single number only. No units or explanation.';
        case "percentage":
            return ' The "summary" field in your JSON response must be a single percentage value only (e.g. 42%). No explanation.';
        case "monetary_amount":
            return ' The "summary" field in your JSON response must be the monetary value only, including currency symbol (e.g. $1,234.56). No explanation.';
        case "currency":
            return ' The "summary" field in your JSON response must contain only the currency code(s). Wrap each code in double square brackets, e.g. [[USD]] or [[EUR]]. No other text.';
        case "yes_no":
            return ' The "summary" field in your JSON response must be [[Yes]] or [[No]] only. The "reasoning" field MUST include an inline citation [[page:N||quote:verbatim excerpt ≤25 words]] pointing to the exact language in the document that supports the Yes/No answer.';
        case "date":
            return ' The "summary" field in your JSON response must be the date only in DD Month YYYY format (e.g. 1 January 2024). If a range, give both dates separated by an em dash. The "reasoning" field MUST include an inline citation [[page:N||quote:verbatim excerpt ≤25 words]] pointing to the exact place in the document where the date is found.';
        case "tag":
            return tags?.length
                ? ` The \"summary\" field in your JSON response must contain exactly one tag wrapped in double square brackets. Available tags: ${tags.map((t) => `[[${t}]]`).join(", ")}. No other text. The \"reasoning\" field MUST include an inline citation [[page:N||quote:verbatim excerpt ≤25 words]] pointing to the exact language in the document that supports the chosen tag.`
                : "";
        default:
            return "";
    }
}

/**
 * runBoundedFanOut — bounded concurrency fan-out for tabular generation.
 *
 * Rejects requests where docs × columns > cellCap (default 200) before
 * any processFn is called (ASVS V5 input validation — DoS mitigation T-05-12).
 * Caps concurrent processFn calls at `concurrency` (default 5) via p-limit
 * (T-05-13).
 *
 * p-limit is ESM-only; we load it via dynamic import (mirrors pdfQueue.ts).
 */
export async function runBoundedFanOut<TDoc>(deps: {
    docs: TDoc[];
    columnsCount: number;
    cellCap?: number;
    concurrency?: number;
    processFn: (doc: TDoc) => Promise<void>;
}): Promise<{ ok: true } | { ok: false; code: number; detail: string }> {
    const cap = deps.cellCap ?? 200;
    const conc = deps.concurrency ?? 5;
    const totalCells = deps.docs.length * deps.columnsCount;
    if (totalCells > cap) {
        return {
            ok: false,
            code: 400,
            detail: `Request exceeds maximum of ${cap} cells (${deps.docs.length} docs × ${deps.columnsCount} columns = ${totalCells}). Reduce document count or column count.`,
        };
    }
    // p-limit is ESM-only; use dynamic import (mirrors pdfQueue.ts pattern)
    const { default: pLimit } = await import("p-limit");
    const limit = pLimit(conc);
    await Promise.all(deps.docs.map((doc) => limit(() => deps.processFn(doc))));
    return { ok: true };
}

const CreateReviewSchema = z.object({
    title: z.string().optional(),
    document_ids: z.array(z.string()).min(1),
    columns_config: z.array(
        z.object({
            index: z.number().int(),
            name: z.string(),
            prompt: z.string(),
        }),
    ),
    workflow_id: z.string().uuid().optional(),
    project_id: z.string().uuid().optional(),
});

const RegenerateCellSchema = z.object({
    document_id: z.string().min(1),
    column_index: z.number().int(),
});

const TabularChatSchema = z.object({
    messages: z.array(
        z.object({
            role: z.enum(["user", "assistant"]),
            content: z.string(),
        }),
    ).min(1),
    chat_id: z.string().uuid().optional(),
    review_title: z.string().optional(),
    project_name: z.string().optional(),
});

const PatchReviewSchema = z
    .object({
        title: z.string().optional(),
        columns_config: z.array(z.unknown()).optional(),
        project_id: z.string().uuid().optional().nullable(),
        shared_with: z.array(z.string().email()).optional(),
        document_ids: z.array(z.string()).optional(),
    })
    .partial();

const PromptSchema = z.object({
    title: z.string().trim().min(1, "title is required"),
    format: z
        .enum([
            "text",
            "bulleted_list",
            "number",
            "percentage",
            "monetary_amount",
            "currency",
            "yes_no",
            "date",
            "tag",
        ])
        .optional()
        .default("text"),
    documentName: z.string().trim().optional().default(""),
    tags: z.array(z.string()).optional().default([]),
});

export const tabularRouter = Router();

// GET /tabular-review
tabularRouter.get("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();

    // Optional ?project_id= scopes results to a single project. Project-page
    // callers pass it; the global tabular-reviews page omits it. We still
    // enforce access via listAccessibleProjectIds so a stranger can't request
    // an arbitrary project_id.
    const projectIdFilter =
        typeof req.query.project_id === "string" && req.query.project_id
            ? (req.query.project_id as string)
            : null;

    // Visible reviews = user's own + reviews in any accessible project.
    const projectIds = await listAccessibleProjectIds(userId, userEmail, db);

    if (projectIdFilter && !projectIds.includes(projectIdFilter)) {
        // No access to that project — also covers "project doesn't exist".
        return void res.json([]);
    }

    let ownQuery = db
        .from("tabular_reviews")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
    if (projectIdFilter) ownQuery = ownQuery.eq("project_id", projectIdFilter);

    const sharedProjectIds = projectIdFilter ? [projectIdFilter] : projectIds;
    // Three sources to merge:
    //  - own:           reviews this user created
    //  - sharedProj:    reviews in a project the user has access to
    //  - sharedDirect:  standalone reviews (project_id null) where the
    //                   user's email is in tabular_reviews.shared_with
    const [
        { data: own, error: ownErr },
        { data: shared, error: sharedErr },
        { data: sharedDirect, error: sharedDirectErr },
    ] = await Promise.all([
        ownQuery,
        sharedProjectIds.length > 0
            ? db
                  .from("tabular_reviews")
                  .select("*")
                  .in("project_id", sharedProjectIds)
                  .neq("user_id", userId)
                  .order("created_at", { ascending: false })
            : Promise.resolve({
                  data: [] as Record<string, unknown>[],
                  error: null,
              }),
        // Skip the direct-share lookup when the caller is filtering to a
        // specific project — direct shares are inherently project-id-null.
        userEmail && !projectIdFilter
            ? db
                  .from("tabular_reviews")
                  .select("*")
                  .contains("shared_with", JSON.stringify([userEmail]))
                  .neq("user_id", userId)
                  .order("created_at", { ascending: false })
            : Promise.resolve({
                  data: [] as Record<string, unknown>[],
                  error: null,
              }),
    ]);
    if (ownErr) return void res.status(500).json({ detail: ownErr.message });
    // Don't fail the whole list when an auxiliary share query errors — most
    // commonly the tabular_reviews.shared_with column hasn't been migrated
    // yet. Log and continue so the user still sees their own reviews.
    if (sharedErr)
        logger.warn({ err: sharedErr }, "[tabular] shared-by-project query failed");
    if (sharedDirectErr)
        logger.warn({ err: sharedDirectErr }, "[tabular] shared-by-email query failed");
    const seen = new Set<string>();
    const reviews: Record<string, unknown>[] = [];
    for (const r of [
        ...(own ?? []),
        ...(shared ?? []),
        ...(sharedDirect ?? []),
    ]) {
        const id = (r as { id: string }).id;
        if (seen.has(id)) continue;
        seen.add(id);
        reviews.push(r as Record<string, unknown>);
    }

    // CLEAN-28: aggregation via RPC (single query). EXPLAIN confirms
    // idx_tabular_cells_review (review_id, document_id, column_index) leftmost-prefix
    // index is used — no new index needed.
    const reviewIds = reviews.map((r) => (r as { id: string }).id);
    let docCounts: Record<string, number> = {};
    if (reviewIds.length > 0) {
        const { data: counts, error: cErr } = await db.rpc(
            "select_review_doc_counts",
            { review_ids: reviewIds },
        );
        if (cErr) {
            logger.warn({ err: cErr }, "[tabular] doc-counts rpc failed");
        } else if (counts) {
            for (const row of counts as { review_id: string; doc_count: number }[]) {
                docCounts[row.review_id] = Number(row.doc_count);
            }
        }
    }

    res.json(
        reviews.map((r) => {
            const id = (r as { id: string }).id;
            return { ...r, document_count: docCounts[id] ?? 0 };
        }),
    );
});

// POST /tabular-review
tabularRouter.post("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const body = parseBody(CreateReviewSchema, req, res);
    if (!body) return;
    const { title, document_ids, columns_config, workflow_id, project_id } =
        body as unknown as {
            title?: string;
            document_ids: string[];
            columns_config: { index: number; name: string; prompt: string }[];
            workflow_id?: string;
            project_id?: string;
        };

    const db = createServerSupabase();
    if (project_id) {
        const access = await checkProjectAccess(
            project_id,
            userId,
            userEmail,
            db,
        );
        if (!access.ok)
            return void res.status(404).json({ detail: "Project not found" });
    }
    const { data: review, error } = await db
        .from("tabular_reviews")
        .insert({
            user_id: userId,
            title: title ?? null,
            columns_config,
            project_id: project_id ?? null,
            workflow_id: workflow_id ?? null,
        })
        .select("*")
        .single();
    if (error || !review)
        return void res
            .status(500)
            .json({ detail: error?.message ?? "Failed to create review" });

    const cells = document_ids.flatMap((docId) =>
        columns_config.map((col) => ({
            review_id: review.id,
            document_id: docId,
            column_index: col.index,
            status: "pending",
        })),
    );
    if (cells.length) await db.from("tabular_cells").insert(cells);

    res.status(201).json(review);
});

// POST /tabular-review/prompt (must come before /:reviewId routes)
tabularRouter.post("/prompt", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const body = parseBody(PromptSchema, req, res);
    if (!body) return;
    const { title, format, documentName, tags } = body;

    const formatDescriptions: Record<string, string> = {
        text: "free-form text",
        bulleted_list: "a bulleted list",
        number: "a single number",
        percentage: "a percentage value",
        monetary_amount: "a monetary amount",
        currency: "a currency code",
        yes_no: "Yes or No",
        date: "a date",
        tag: tags.length ? `one of these tags: ${tags.join(", ")}` : "a tag",
    };
    const formatHint = formatDescriptions[format] ?? "free-form text";
    const tagsNote =
        format === "tag" && tags.length
            ? `\nAvailable tags: ${tags.join(", ")}`
            : "";
    const docNote = documentName ? `\nDocument type/name: ${documentName}` : "";

    const userMessage =
        `Column title: ${title}` +
        docNote +
        `\nExpected response format: ${formatHint}` +
        tagsNote +
        `\n\nWrite the best extraction prompt for a legal tabular review column with this title. ` +
        `Do NOT include any instruction about the response format in the prompt — ` +
        `format handling is applied separately and must not be duplicated inside the prompt text.`;

    try {
        const { title_model, api_keys } = await getUserModelSettings(userId, undefined, { route: req.path, requestId: req.id });
        const raw = await completeText({
            model: title_model,
            systemPrompt:
                'You write high-quality column prompts for legal tabular review workflows. Return only valid JSON with a single field: {"prompt": string}. The prompt you write must focus solely on what to extract — never on how to format the response.',
            user: userMessage,
            maxTokens: 512,
            apiKeys: api_keys,
        });
        const rawText = raw
            .replace(/^```(?:json)?\n?/i, "")
            .replace(/\n?```$/, "")
            .trim();
        const promptResult = parseLlmJson(rawText, z.object({ prompt: z.string().min(1) }));
        if (!promptResult.ok) {
            logger.warn({ err: promptResult.error }, "[tabular] /prompt parse failed");
            return void res.status(502).json({ detail: "LLM returned malformed JSON" });
        }
        res.json({ prompt: promptResult.data.prompt.trim(), source: "llm" });
    } catch {
        res.status(502).json({ detail: "Failed to generate prompt from LLM" });
    }
});

// GET /tabular-review/:reviewId
tabularRouter.get("/:reviewId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const db = createServerSupabase();

    const { data: review, error } = await db
        .from("tabular_reviews")
        .select("*")
        .eq("id", reviewId)
        .single();
    if (error || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    const { data: cells } = await db
        .from("tabular_cells")
        .select("*")
        .eq("review_id", reviewId);
    const docIds = [...new Set((cells ?? []).map((c) => c.document_id))];
    const docsResult =
        docIds.length > 0
            ? await db.from("documents").select("*").in("id", docIds)
            : review.project_id
              ? await db
                    .from("documents")
                    .select("*")
                    .eq("project_id", review.project_id)
                    .order("created_at", { ascending: true })
              : { data: [] as Record<string, unknown>[] };

    res.json({
        review: { ...review, is_owner: access.isOwner },
        cells: (cells ?? []).map((cell) => ({
            ...cell,
            content: parseCellContent(cell.content),
        })),
        documents: docsResult.data ?? [],
    });
});

// GET /tabular-review/:reviewId/people
// Owner email + display_name plus member display_names — the analog of
// /projects/:id/people. Used by the standalone TR detail page's People
// modal so the roster can show display_names alongside emails.
tabularRouter.get("/:reviewId/people", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const db = createServerSupabase();

    const { data: review } = await db
        .from("tabular_reviews")
        .select("id, user_id, project_id, shared_with")
        .eq("id", reviewId)
        .single();
    if (!review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    const sharedWith: string[] = (
        Array.isArray(review.shared_with)
            ? (review.shared_with as string[])
            : []
    ).map((e) => (e ?? "").toLowerCase());

    // Resolve shared-with emails to user records via RPC (CLEAN-15).
    // get_auth_user_by_email is SECURITY DEFINER and O(log N) — replaces the
    // listUsers({ perPage: 1000 }) walk that silently truncates above 1000.
    const [userByEmail, ownerRecord] = await Promise.all([
        getUsersByEmails(sharedWith),
        getUserById(review.user_id as string),
    ]);

    const memberUserIds: string[] = [];
    for (const email of sharedWith) {
        const u = userByEmail.get(email);
        if (u) memberUserIds.push(u.id);
    }

    const profileIds = [review.user_id as string, ...memberUserIds].filter(
        (x, i, arr) => arr.indexOf(x) === i,
    );

    const profileByUserId = new Map<string, string | null>();
    if (profileIds.length > 0) {
        const { data: profiles } = await db
            .from("user_profiles")
            .select("user_id, display_name")
            .in("user_id", profileIds);
        for (const p of profiles ?? []) {
            profileByUserId.set(
                p.user_id as string,
                (p.display_name as string | null) ?? null,
            );
        }
    }

    res.json({
        owner: {
            user_id: review.user_id,
            email: ownerRecord?.email ?? null,
            display_name: profileByUserId.get(review.user_id as string) ?? null,
        },
        members: sharedWith
            .filter((email) => userByEmail.has(email))
            .map((email) => {
                const u = userByEmail.get(email)!;
                const display_name = profileByUserId.get(u.id) ?? null;
                return { email, display_name };
            }),
    });
});

// PATCH /tabular-review/:reviewId
tabularRouter.patch("/:reviewId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const patchBody = parseBody(PatchReviewSchema, req, res);
    if (!patchBody) return;
    const updates: Record<string, unknown> = {};
    if (patchBody.title != null) updates.title = patchBody.title;
    if (patchBody.columns_config != null)
        updates.columns_config = patchBody.columns_config;
    if (patchBody.project_id !== undefined)
        updates.project_id = patchBody.project_id;
    // shared_with edits are owner-only — gated below after we know who's
    // making the call. Normalize lowercase + dedupe + drop empties.
    let sharedWithUpdate: string[] | undefined;
    if (Array.isArray(patchBody.shared_with)) {
        const seen = new Set<string>();
        const cleaned: string[] = [];
        for (const raw of patchBody.shared_with) {
            const e = raw.trim().toLowerCase();
            if (!e || seen.has(e)) continue;
            seen.add(e);
            cleaned.push(e);
        }
        sharedWithUpdate = cleaned;
    }
    updates.updated_at = new Date().toISOString();

    const db = createServerSupabase();
    const { data: existingReview, error: reviewError } = await db
        .from("tabular_reviews")
        .select("*")
        .eq("id", reviewId)
        .single();
    if (reviewError || !existingReview)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(
        existingReview,
        userId,
        userEmail,
        db,
    );
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });
    if (sharedWithUpdate !== undefined) {
        if (!access.isOwner)
            return void res
                .status(403)
                .json({ detail: "Only the review owner can change sharing" });
        updates.shared_with = sharedWithUpdate;
    }

    const { data: updatedReview, error: updateError } = await db
        .from("tabular_reviews")
        .update(updates)
        .eq("id", reviewId)
        .select("*")
        .single();
    if (updateError || !updatedReview)
        return void res.status(500).json({
            detail: updateError?.message ?? "Failed to update review",
        });

    if (
        Array.isArray(patchBody.columns_config) ||
        Array.isArray(patchBody.document_ids)
    ) {
        const { data: existingCells } = await db
            .from("tabular_cells")
            .select("document_id,column_index")
            .eq("review_id", reviewId);
        const existingKeys = new Set(
            (existingCells ?? []).map(
                (cell) => `${cell.document_id}:${cell.column_index}`,
            ),
        );

        let documentIds: string[];

        if (Array.isArray(patchBody.document_ids)) {
            // document_ids is the new source of truth — delete removed docs' cells
            const newDocIds = patchBody.document_ids as string[];
            const existingDocIds = (existingCells ?? []).map(
                (cell) => cell.document_id,
            );
            const removedDocIds = existingDocIds.filter(
                (id) => !newDocIds.includes(id),
            );

            if (removedDocIds.length > 0) {
                const { error: deleteError } = await db
                    .from("tabular_cells")
                    .delete()
                    .eq("review_id", reviewId)
                    .in("document_id", removedDocIds);
                if (deleteError)
                    return void res
                        .status(500)
                        .json({ detail: deleteError.message });
            }

            documentIds = newDocIds;
        } else {
            // No document change — derive from existing cells
            documentIds = [
                ...new Set(
                    (existingCells ?? []).map((cell) => cell.document_id),
                ),
            ];
            if (documentIds.length === 0 && existingReview.project_id) {
                const { data: projectDocs } = await db
                    .from("documents")
                    .select("id")
                    .eq("project_id", existingReview.project_id);
                documentIds = (projectDocs ?? []).map((doc) => doc.id);
            }
        }

        const activeColumns = Array.isArray(patchBody.columns_config)
            ? patchBody.columns_config
            : (updatedReview.columns_config ?? []);
        const newCells = documentIds.flatMap((documentId) =>
            activeColumns
                .filter(
                    (column: { index: number }) =>
                        !existingKeys.has(`${documentId}:${column.index}`),
                )
                .map((column: { index: number }) => ({
                    review_id: reviewId,
                    document_id: documentId,
                    column_index: column.index,
                    status: "pending",
                })),
        );

        if (newCells.length > 0) {
            const { error: insertError } = await db
                .from("tabular_cells")
                .insert(newCells);
            if (insertError)
                return void res
                    .status(500)
                    .json({ detail: insertError.message });
        }
    }

    res.json(updatedReview);
});

// DELETE /tabular-review/:reviewId
tabularRouter.delete("/:reviewId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { reviewId } = req.params;
    const db = createServerSupabase();
    const { data, error } = await db
        .from("tabular_reviews")
        .delete()
        .eq("id", reviewId)
        .eq("user_id", userId)
        .select("id");
    if (error) return void res.status(500).json({ detail: error.message });
    if (!data || data.length === 0)
        return void res.status(404).json({ detail: "Review not found" });
    res.status(204).send();
});

// POST /tabular-review/:reviewId/clear-cells
const ClearCellsSchema = z.object({
    document_ids: z.array(z.string()).min(1),
});

// Reset cells to an empty/pending state for the given document_ids. Does not
// delete the rows — it blanks `content` and sets `status` back to "pending".
tabularRouter.post("/:reviewId/clear-cells", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const clearBody = parseBody(ClearCellsSchema, req, res);
    if (!clearBody) return;
    const { document_ids } = clearBody;

    const db = createServerSupabase();
    const { data: review, error: reviewError } = await db
        .from("tabular_reviews")
        .select("id, user_id, project_id")
        .eq("id", reviewId)
        .single();
    if (reviewError || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    const { error } = await db
        .from("tabular_cells")
        .update({ content: null, status: "pending" })
        .eq("review_id", reviewId)
        .in("document_id", document_ids);
    if (error) return void res.status(500).json({ detail: error.message });
    res.status(204).send();
});

// POST /tabular-review/:reviewId/regenerate-cell
tabularRouter.post(
    "/:reviewId/regenerate-cell",
    requireAuth,
    llmRateLimiter,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { reviewId } = req.params;
        const cellBody = parseBody(RegenerateCellSchema, req, res);
        if (!cellBody) return;
        const { document_id, column_index } = cellBody;

        const db = createServerSupabase();
        const { data: review, error: reviewError } = await db
            .from("tabular_reviews")
            .select("*")
            .eq("id", reviewId)
            .single();
        if (reviewError || !review)
            return void res.status(404).json({ detail: "Review not found" });
        const access = await ensureReviewAccess(review, userId, userEmail, db);
        if (!access.ok)
            return void res.status(404).json({ detail: "Review not found" });

        const column = (
            review.columns_config as {
                index: number;
                name: string;
                prompt: string;
                format?: string;
                tags?: string[];
            }[]
        ).find((c) => c.index === column_index);
        if (!column)
            return void res.status(400).json({ detail: "Column not found" });

        const { data: doc } = await db
            .from("documents")
            .select("id, filename, file_type")
            .eq("id", document_id)
            .single();
        if (!doc)
            return void res.status(404).json({ detail: "Document not found" });
        const docActive = await loadActiveVersion(document_id, db);

        await db
            .from("tabular_cells")
            .update({ status: "generating", content: null })
            .eq("review_id", reviewId)
            .eq("document_id", document_id)
            .eq("column_index", column_index);

        let markdown = "";
        if (docActive) {
            const buf = await downloadFile(docActive.storage_path);
            if (buf) {
                try {
                    markdown =
                        (doc.file_type as string) === "pdf"
                            ? await extractPdfMarkdown(buf)
                            : await extractDocxMarkdown(buf);
                } catch (err) {
                    logger.error({ err, documentId: document_id }, "[regenerate-cell] extraction error");
                }
            }
        }

        const { tabular_model, api_keys } = await getUserModelSettings(
            userId,
            db,
            { route: req.path, requestId: req.id },
        );
        const result = await queryGemini(
            tabular_model,
            doc.filename as string,
            markdown,
            column.prompt,
            column.format,
            column.tags,
            api_keys,
        );

        if (!result) {
            await db
                .from("tabular_cells")
                .update({ status: "error" })
                .eq("review_id", reviewId)
                .eq("document_id", document_id)
                .eq("column_index", column_index);
            return void res.status(500).json({ detail: "Generation failed" });
        }

        await db
            .from("tabular_cells")
            .update({ content: JSON.stringify(result), status: "done" })
            .eq("review_id", reviewId)
            .eq("document_id", document_id)
            .eq("column_index", column_index);

        res.json(result);
    },
);

// POST /tabular-review/:reviewId/generate
tabularRouter.post("/:reviewId/generate", requireAuth, llmRateLimiter, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const db = createServerSupabase();

    const { data: review, error: reviewError } = await db
        .from("tabular_reviews")
        .select("*")
        .eq("id", reviewId)
        .single();
    if (reviewError || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    const columns: {
        index: number;
        name: string;
        prompt: string;
        format?: string;
        tags?: string[];
    }[] = review.columns_config ?? [];
    if (columns.length === 0)
        return void res.status(400).json({ detail: "No columns configured" });

    const { data: cells } = await db
        .from("tabular_cells")
        .select("*")
        .eq("review_id", reviewId);
    const cellMap = new Map<string, Record<string, unknown>>();
    for (const cell of cells ?? [])
        cellMap.set(`${cell.document_id}:${cell.column_index}`, cell);

    const docIds = [...new Set((cells ?? []).map((c) => c.document_id))];
    let docs: Record<string, unknown>[] = [];
    if (docIds.length > 0) {
        const { data } = await db
            .from("documents")
            .select("id, filename, file_type, page_count")
            .in("id", docIds);
        docs = data ?? [];
    } else if (review.project_id) {
        const { data } = await db
            .from("documents")
            .select("id, filename, file_type, page_count")
            .eq("project_id", review.project_id)
            .order("created_at", { ascending: true });
        docs = data ?? [];
    }

    const { tabular_model, api_keys } = await getUserModelSettings(userId, db, { route: req.path, requestId: req.id });

    // Cell-count guard: reject before SSE headers are flushed so a JSON 400
    // is still deliverable (T-05-12 — DoS mitigation, ASVS V5 input validation).
    if (docs.length * columns.length > 200) {
        return void res.status(400).json({
            detail: `Request exceeds maximum of 200 cells (${docs.length} docs × ${columns.length} columns = ${docs.length * columns.length}). Reduce document count or column count.`,
        });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const write = (line: string) => res.write(line);

    try {
        await runBoundedFanOut({
            docs,
            columnsCount: columns.length,
            processFn: async (doc) => {
                const docId = doc.id as string;
                const filename = doc.filename as string;
                let markdown = "";

                const active = await loadActiveVersion(docId, db);
                if (active) {
                    const buf = await downloadFile(active.storage_path);
                    if (buf) {
                        try {
                            markdown =
                                (doc.file_type as string) === "pdf"
                                    ? await extractPdfMarkdown(buf)
                                    : await extractDocxMarkdown(buf);
                        } catch (err) {
                            logger.error({ err, docId }, "[tabular/generate] extraction error");
                        }
                    }
                }

                // Filter to only columns that need processing
                const columnsToProcess = columns.filter((col) => {
                    const cell = cellMap.get(`${docId}:${col.index}`);
                    return !(cell?.status === "done" && cell?.content);
                });
                if (columnsToProcess.length === 0) return;

                // Mark all as generating upfront
                for (const col of columnsToProcess) {
                    write(
                        `data: ${JSON.stringify({ type: "cell_update", document_id: docId, column_index: col.index, content: null, status: "generating" })}\n\n`,
                    );
                    const existingCell = cellMap.get(`${docId}:${col.index}`);
                    if (existingCell) {
                        await db
                            .from("tabular_cells")
                            .update({ status: "generating", content: null })
                            .eq("id", existingCell.id);
                    } else {
                        await db.from("tabular_cells").insert({
                            review_id: reviewId,
                            document_id: docId,
                            column_index: col.index,
                            status: "generating",
                        });
                    }
                }

                // Single LLM call for all columns, streaming one JSON line per column
                const receivedColumns = new Set<number>();
                try {
                    await queryGeminiAllColumns(
                        tabular_model,
                        filename,
                        markdown,
                        columnsToProcess,
                        async (columnIndex, result) => {
                            receivedColumns.add(columnIndex);
                            await db
                                .from("tabular_cells")
                                .update({
                                    content: JSON.stringify(result),
                                    status: "done",
                                })
                                .eq("review_id", reviewId)
                                .eq("document_id", docId)
                                .eq("column_index", columnIndex);
                            write(
                                `data: ${JSON.stringify({ type: "cell_update", document_id: docId, column_index: columnIndex, content: result, status: "done" })}\n\n`,
                            );
                        },
                        api_keys,
                        write,
                        docId,
                    );
                } catch (err) {
                    logger.error({ err, docId }, "[tabular/generate] queryGeminiAllColumns error");
                }

                // Mark any columns the LLM didn't return as error
                for (const col of columnsToProcess) {
                    if (!receivedColumns.has(col.index)) {
                        await db
                            .from("tabular_cells")
                            .update({ status: "error" })
                            .eq("review_id", reviewId)
                            .eq("document_id", docId)
                            .eq("column_index", col.index);
                        write(
                            `data: ${JSON.stringify({ type: "cell_update", document_id: docId, column_index: col.index, content: null, status: "error" })}\n\n`,
                        );
                    }
                }
            },
        });

        write("data: [DONE]\n\n");
    } catch (err) {
        logger.error({ err }, "[tabular/generate] stream error");
        try {
            write(
                `data: ${JSON.stringify({ type: "error", message: String(err) })}\n\ndata: [DONE]\n\n`,
            );
        } catch {
            /* ignore */
        }
    } finally {
        res.end();
    }
});

// GET /tabular-review/:reviewId/chats — list chats (metadata only, no messages)
tabularRouter.get("/:reviewId/chats", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const db = createServerSupabase();

    // Verify access (owner or shared-project member).
    const { data: review, error } = await db
        .from("tabular_reviews")
        .select("id, user_id, project_id")
        .eq("id", reviewId)
        .single();
    if (error || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    // Show every member's chats for the review (collaborative), not just
    // the requester's. Per-chat access is gated above by review access.
    const { data: chats } = await db
        .from("tabular_review_chats")
        .select("id, title, created_at, updated_at, user_id")
        .eq("review_id", reviewId)
        .order("updated_at", { ascending: false });

    res.json(chats ?? []);
});

// DELETE /tabular-review/:reviewId/chats/:chatId — delete a single chat
tabularRouter.delete(
    "/:reviewId/chats/:chatId",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const { chatId } = req.params;
        const db = createServerSupabase();
        // Owner-only delete — sibling collaborators shouldn't be able to wipe
        // each other's threads.
        const { error } = await db
            .from("tabular_review_chats")
            .delete()
            .eq("id", chatId)
            .eq("user_id", userId);
        if (error) return void res.status(500).json({ detail: error.message });
        res.status(204).send();
    },
);

// GET /tabular-review/:reviewId/chats/:chatId/messages — messages for a single chat
tabularRouter.get(
    "/:reviewId/chats/:chatId/messages",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { reviewId, chatId } = req.params;
        const db = createServerSupabase();

        const { data: review } = await db
            .from("tabular_reviews")
            .select("id, user_id, project_id")
            .eq("id", reviewId)
            .single();
        if (!review)
            return void res.status(404).json({ detail: "Review not found" });
        const access = await ensureReviewAccess(review, userId, userEmail, db);
        if (!access.ok)
            return void res.status(404).json({ detail: "Review not found" });

        const { data: chat, error: chatError } = await db
            .from("tabular_review_chats")
            .select("id, review_id")
            .eq("id", chatId)
            .single();
        if (chatError || !chat || chat.review_id !== reviewId)
            return void res.status(404).json({ detail: "Chat not found" });

        const { data: messages } = await db
            .from("tabular_review_chat_messages")
            .select("id, role, content, annotations, created_at")
            .eq("chat_id", chatId)
            .order("created_at", { ascending: true });

        res.json(messages ?? []);
    },
);

// ---------------------------------------------------------------------------
// Tabular citation parsing
// ---------------------------------------------------------------------------

type TabularParsedCitation = {
    ref: number;
    col_index: number;
    row_index: number;
    quote: string;
};

const TABULAR_CITATIONS_BLOCK_RE = /<CITATIONS>\s*([\s\S]*?)\s*<\/CITATIONS>/;

function parseTabularCitations(
    text: string,
    write?: (s: string) => void,
): TabularParsedCitation[] {
    const match = text.match(TABULAR_CITATIONS_BLOCK_RE);
    if (!match) return [];
    const citationsResult = parseLlmJson(match[1], TabularCitationsArraySchema);
    if (!citationsResult.ok) {
        if (write) {
            write(
                `data: ${JSON.stringify({ type: "citations_parse_error", error: citationsResult.error })}\n\n`,
            );
        }
        logger.warn({ err: citationsResult.error }, "[tabular] citations parse failed");
        return [];
    }
    return citationsResult.data as TabularParsedCitation[];
}

function extractTabularAnnotations(
    fullText: string,
    tabularStore: TabularCellStore,
    write?: (s: string) => void,
) {
    return parseTabularCitations(fullText, write).map((c) => ({
        type: "tabular_citation" as const,
        ref: c.ref,
        col_index: c.col_index,
        row_index: c.row_index,
        col_name:
            tabularStore.columns[c.col_index]?.name ?? `Col ${c.col_index}`,
        doc_name:
            tabularStore.documents[c.row_index]?.filename ??
            `Row ${c.row_index}`,
        quote: c.quote,
    }));
}

// ---------------------------------------------------------------------------
// Build messages for tabular chat
// ---------------------------------------------------------------------------

function buildTabularMessages(
    messages: ChatMessage[],
    tabularStore: TabularCellStore,
    reviewTitle: string,
): unknown[] {
    const docList = tabularStore.documents
        .map((d, i) => `- ROW:${i} "${d.filename}"`)
        .join("\n");
    const colList = tabularStore.columns
        .map((c, i) => `- COL:${i} "${c.name}"`)
        .join("\n");

    const systemContent = `You are Mike, an AI legal assistant. You are helping with the tabular review titled "${reviewTitle}".

The review extracts specific fields from multiple legal documents into a structured table.
You do NOT have the cell content yet — call read_table_cells to fetch the cells you need before answering.

DOCUMENTS (rows):
${docList || "- (none)"}

COLUMNS (fields):
${colList || "- (none)"}

TABULAR CITATION INSTRUCTIONS:
When you reference specific cell content, place a numbered marker [1], [2], etc. inline in your prose at the point of reference.

After your complete response, append a <CITATIONS> block containing a JSON array with one entry per marker:

<CITATIONS>
[
  {"ref": 1, "col_index": 0, "row_index": 2, "quote": "verbatim text from the cell"},
  {"ref": 2, "col_index": 1, "row_index": 0, "quote": "another excerpt"}
]
</CITATIONS>

Rules:
- col_index and row_index are 0-based (matching the COL/ROW numbers listed above)
- Only cite cells you have read via read_table_cells
- quote should be verbatim text from the cell's summary
- Omit <CITATIONS> if you make no citations
- Do not fabricate cell content
- Answer in clear, concise prose. You may use markdown formatting.`;

    const formatted: unknown[] = [{ role: "system", content: systemContent }];
    for (const msg of messages) {
        formatted.push({ role: msg.role, content: msg.content ?? "" });
    }
    return formatted;
}

// ---------------------------------------------------------------------------
// POST /tabular-review/:reviewId/chat — agentic streaming
// ---------------------------------------------------------------------------

// POST /tabular-review/:reviewId/chat
tabularRouter.post("/:reviewId/chat", requireAuth, llmRateLimiter, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const chatBody = parseBody(TabularChatSchema, req, res);
    if (!chatBody) return;
    const {
        messages,
        chat_id: existingChatId,
        review_title: clientReviewTitle,
        project_name: clientProjectName,
    } = chatBody as unknown as {
        messages: ChatMessage[];
        chat_id?: string;
        review_title?: string;
        project_name?: string;
    };

    const lastUser = [...(messages ?? [])]
        .reverse()
        .find((m) => m.role === "user");
    if (!lastUser?.content?.trim()) {
        return void res
            .status(400)
            .json({ detail: "messages must include a user message" });
    }

    const db = createServerSupabase();
    const { data: review, error } = await db
        .from("tabular_reviews")
        .select("*")
        .eq("id", reviewId)
        .single();
    if (error || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const reviewAccess = await ensureReviewAccess(
        review,
        userId,
        userEmail,
        db,
    );
    if (!reviewAccess.ok)
        return void res.status(404).json({ detail: "Review not found" });

    // Fetch all cells and documents for this review
    const { data: cells } = await db
        .from("tabular_cells")
        .select("*")
        .eq("review_id", reviewId);

    const docIds = [
        ...new Set((cells ?? []).map((c: any) => c.document_id as string)),
    ];
    let docs: { id: string; filename: string }[] = [];
    if (docIds.length > 0) {
        const { data } = await db
            .from("documents")
            .select("id, filename")
            .in("id", docIds)
            .order("created_at", { ascending: true });
        docs = (data ?? []) as { id: string; filename: string }[];
    }

    const sortedColumns = (
        (review.columns_config ?? []) as { index: number; name: string }[]
    ).sort((a, b) => a.index - b.index);

    const tabularStore: TabularCellStore = {
        columns: sortedColumns,
        documents: docs,
        cells: new Map(
            (cells ?? []).map((c: any) => [
                `${c.column_index}:${c.document_id}`,
                parseCellContent(c.content),
            ]),
        ),
    };

    // Create or verify chat record
    let chatId = existingChatId ?? null;
    let chatTitle: string | null = null;
    const isFirstExchange =
        messages.filter((m) => m.role === "user").length === 1;

    if (chatId) {
        // Either chat owner OR any project member of the parent review can
        // continue the chat. We've already verified review access above.
        const { data: existing } = await db
            .from("tabular_review_chats")
            .select("id, title, review_id, user_id")
            .eq("id", chatId)
            .single();
        const canUse =
            !!existing &&
            (existing.review_id === reviewId || existing.user_id === userId);
        if (!canUse || !existing) chatId = null;
        else chatTitle = existing.title;
    }

    if (!chatId) {
        const { data: newChat } = await db
            .from("tabular_review_chats")
            .insert({ review_id: reviewId, user_id: userId })
            .select("id, title")
            .single();
        chatId = newChat?.id ?? null;
        chatTitle = newChat?.title ?? null;
    }

    // Persist user message
    if (chatId) {
        await db.from("tabular_review_chat_messages").insert({
            chat_id: chatId,
            role: "user",
            content: lastUser.content,
        });
    }

    const apiMessages = buildTabularMessages(
        messages,
        tabularStore,
        review.title || "Untitled Review",
    );

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const write = (line: string) => res.write(line);

    if (chatId) {
        write(`data: ${JSON.stringify({ type: "chat_id", chatId })}\n\n`);
    }

    const apiKeys = await getUserApiKeys(userId, db, { route: req.path, requestId: req.id });

    try {
        const { fullText, events } = await runLLMStream({
            apiMessages,
            docStore: new Map(),
            docIndex: {},
            userId,
            db,
            write,
            extraTools: TABULAR_TOOLS,
            tabularStore,
            buildCitations: (text) =>
                extractTabularAnnotations(text, tabularStore, write),
            apiKeys,
        });

        const annotations = extractTabularAnnotations(fullText, tabularStore);

        if (chatId) {
            await db.from("tabular_review_chat_messages").insert({
                chat_id: chatId,
                role: "assistant",
                content: events.length ? events : null,
                annotations: annotations.length ? annotations : null,
            });
            await db
                .from("tabular_review_chats")
                .update({ updated_at: new Date().toISOString() })
                .eq("id", chatId);
        }

        // Generate title on first exchange
        if (chatId && isFirstExchange && !chatTitle && lastUser.content) {
            const { title_model } = await getUserModelSettings(userId, db, { route: req.path, requestId: req.id });
            const title = await generateChatTitle(
                title_model,
                lastUser.content,
                {
                    reviewTitle: clientReviewTitle ?? review.title ?? null,
                    projectName: clientProjectName ?? null,
                },
                apiKeys,
            );
            if (title) {
                await db
                    .from("tabular_review_chats")
                    .update({ title })
                    .eq("id", chatId);
                write(
                    `data: ${JSON.stringify({ type: "chat_title", chatId, title })}\n\n`,
                );
            }
        }
    } catch (err) {
        logger.error({ err }, "[tabular/chat] error");
        try {
            write(
                `data: ${JSON.stringify({ type: "error", message: String(err) })}\n\n`,
            );
            write("data: [DONE]\n\n");
        } catch {
            /* ignore */
        }
    } finally {
        res.end();
    }
});

function parseCellContent(
    raw: unknown,
    write?: (s: string) => void,
    colIndex?: number,
    docId?: string,
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
        const rawCellJson = raw;
        const cellResult = parseLlmJson(rawCellJson, TabularCellSchema);
        if (!cellResult.ok) {
            logger.warn(
                { err: cellResult.error, colIndex, docId },
                "[tabular] per-cell parse failed",
            );
            if (write) {
                write(
                    `data: ${JSON.stringify({ type: "tabular_cell_parse_error", col_index: colIndex ?? -1, doc_id: docId ?? "", error: cellResult.error })}\n\n`,
                );
            }
            // Preserve LLM output verbatim as summary so the user still sees something
            return { summary: rawCellJson.slice(0, 2000), flag: "grey", reasoning: "" };
        }
        return {
            summary: String(cellResult.data.summary ?? cellResult.data.value ?? "").trim(),
            flag: cellResult.data.flag,
            reasoning: typeof cellResult.data.reasoning === "string" ? cellResult.data.reasoning : "",
        };
    }
    return null;
}

async function queryGemini(
    model: string,
    filename: string,
    documentText: string,
    columnPrompt: string,
    format?: string,
    tags?: string[],
    apiKeys?: import("../lib/llm").UserApiKeys,
    write?: (s: string) => void,
    colIndex?: number,
    docId?: string,
) {
    const suffix = formatPromptSuffix(format as never, tags);
    const fullPrompt = `${columnPrompt}${suffix} If not found, state "Not Found". Leave all reasoning and explanation in the "reasoning" field only.`;

    const EXTRACTION_SYSTEM = `You are a legal document analyst. Return ONLY valid JSON:
{"summary": string, "flag": "green"|"grey"|"yellow"|"red", "reasoning": string}

The "summary" and "reasoning" field values may use markdown formatting (bullets, bold, italics, etc.) — the values are still plain JSON strings (escape newlines as \\n), but the text inside will be rendered as markdown in the UI.

The "summary" field must contain only the extracted value with inline citations — no explanation or reasoning. Every factual claim in "summary" must be followed immediately by a citation in the format [[page:N||quote:exact quoted text]], where N is the page number and the quote is a short verbatim excerpt (≤ 25 words). The quote must be narrowly scoped to the specific claim it supports — extract only the exact words that support that statement, not the surrounding sentence or paragraph. Do not have multiple claims share the same long quote; if two different statements need different evidence, give each its own short, narrowly-scoped quote. All reasoning and explanation belongs in "reasoning" only, which may also contain citations.`;

    let raw: string;
    try {
        raw = await completeText({
            model,
            systemPrompt: EXTRACTION_SYSTEM,
            user: `Document: ${filename}\n\n${documentText.slice(0, 120_000)}\n\n---\nInstruction: ${fullPrompt}`,
            maxTokens: 2048,
            apiKeys,
        });
    } catch (err) {
        logger.error({ err }, "[queryGemini] completion failed");
        return null;
    }
    const rawCellJson = raw
        .replace(/^```(?:json)?\n?/i, "")
        .replace(/\n?```$/, "")
        .trim();
    const cellResult = parseLlmJson(rawCellJson, TabularCellSchema);
    if (!cellResult.ok) {
        logger.warn(
            { err: cellResult.error, colIndex, docId },
            "[tabular] queryGemini per-cell parse failed",
        );
        if (write) {
            write(
                `data: ${JSON.stringify({ type: "tabular_cell_parse_error", col_index: colIndex ?? -1, doc_id: docId ?? "", error: cellResult.error })}\n\n`,
            );
        }
        // Persist raw text as summary so the user still sees the LLM output verbatim
        return rawCellJson
            ? {
                  summary: rawCellJson.slice(0, 2000),
                  flag: "grey" as const,
                  reasoning: "",
              }
            : null;
    }
    return {
        summary:
            String(cellResult.data.summary ?? cellResult.data.value ?? "").trim() ||
            "Not addressed",
        flag: cellResult.data.flag ?? "grey",
        reasoning: String(cellResult.data.reasoning ?? ""),
    };
}

async function generateChatTitle(
    model: string,
    firstUserMessage: string,
    context?: { reviewTitle?: string | null; projectName?: string | null },
    apiKeys?: import("../lib/llm").UserApiKeys,
): Promise<string | null> {
    try {
        const contextLines: string[] = [];
        if (context?.projectName)
            contextLines.push(`Project: ${context.projectName}`);
        if (context?.reviewTitle)
            contextLines.push(`Tabular review: ${context.reviewTitle}`);
        const contextBlock = contextLines.length
            ? `This chat is in the context of a tabular review.\n${contextLines.join("\n")}\n\n`
            : "";

        const raw = await completeText({
            model,
            user: `${contextBlock}Generate a short title (4-6 words) for a chat that starts with the message below. The title should reflect the user's specific question, not the review or project name. Return only the title, no punctuation, no quotes:\n\n${firstUserMessage}`,
            maxTokens: 64,
            apiKeys,
        });
        return raw.trim().slice(0, 80) || null;
    } catch {
        return null;
    }
}

function buildTabularContext(
    columns: any[],
    docs: any[],
    cells: any[],
): string {
    const lines: string[] = [
        "# Tabular Review Context\n",
        "Columns (0-based index):",
    ];
    columns.forEach((col: any, i: number) =>
        lines.push(`- COL:${i} → "${col.name}"`),
    );
    lines.push("", "Documents (0-based row index):");
    docs.forEach((doc: any, i: number) =>
        lines.push(`- ROW:${i} → "${doc.filename}"`),
    );
    lines.push("", "## Table Data\n");
    lines.push(`| Document | ${columns.map((c: any) => c.name).join(" | ")} |`);
    lines.push(`|---|${columns.map(() => "---").join("|")}|`);
    docs.forEach((doc: any, rowIdx: number) => {
        const rowCells = columns.map((col: any, colPos: number) => {
            const cell = cells.find(
                (c: any) =>
                    c.document_id === doc.id && c.column_index === col.index,
            ) as any;
            if (
                !cell ||
                cell.status === "pending" ||
                cell.status === "generating"
            ) {
                return `(pending) [[COL:${colPos}||ROW:${rowIdx}]]`;
            }
            if (cell.status === "error") {
                return `(error) [[COL:${colPos}||ROW:${rowIdx}]]`;
            }
            const content = parseCellContent(cell.content);
            const summary = content?.summary?.trim() || "(not yet generated)";
            const truncated =
                summary.length > 400 ? summary.slice(0, 400) + "…" : summary;
            return `${truncated} [[COL:${colPos}||ROW:${rowIdx}]]`;
        });
        lines.push(
            `| ROW:${rowIdx} ${doc.filename} | ${rowCells.join(" | ")} |`,
        );
    });
    return lines.join("\n");
}

type CellResult = {
    summary: string;
    flag: "green" | "grey" | "yellow" | "red";
    reasoning: string;
};
type Column = {
    index: number;
    name: string;
    prompt: string;
    format?: string;
    tags?: string[];
};

async function queryGeminiAllColumns(
    model: string,
    filename: string,
    documentText: string,
    columns: Column[],
    onResult: (columnIndex: number, result: CellResult) => Promise<void>,
    apiKeys?: import("../lib/llm").UserApiKeys,
    write?: (s: string) => void,
    docId?: string,
): Promise<void> {
    const columnsDesc = columns
        .map((col) => {
            const suffix = formatPromptSuffix(col.format as never, col.tags);
            const fullPrompt = `${col.prompt}${suffix} If not found, state "Not Found".`;
            return `Column ${col.index} — "${col.name}": ${fullPrompt}`;
        })
        .join("\n");

    const SYSTEM = `You are a legal document analyst. Extract information for each column listed below.

For each column, output exactly one minified JSON object on its own line (no line breaks inside the JSON), then a newline. Process columns in order and output each result as soon as you finish it.

Line format:
{"column_index": <N>, "summary": <string>, "flag": <"green"|"grey"|"yellow"|"red">, "reasoning": <string>}

Rules:
- "summary": the extracted value with inline citations [[page:N||quote:verbatim excerpt ≤25 words]] after every factual claim. No explanation or reasoning here. Quotes must be narrowly scoped to the specific claim — extract only the exact supporting words, not the full surrounding sentence. Do not reuse one long quote across multiple statements; give each claim its own short, precise quote.
- "flag": green = standard/favorable, yellow = needs attention, red = problematic/unfavorable, grey = neutral/not found
- "reasoning": brief explanation of the extraction
- The "summary" and "reasoning" string VALUES may use markdown (bullets, bold, italics, etc.) — escape newlines as \\n inside the JSON string. This markdown is rendered in the UI.
- Output ONLY the JSON lines themselves. Do NOT wrap the response in markdown code fences (e.g. \`\`\`json), and do not add any preamble or summary.`;

    const USER = `Document: ${filename}\n\n${documentText.slice(0, 120_000)}\n\n---\nColumns to extract:\n${columnsDesc}`;

    let contentBuffer = "";
    const pending: Promise<unknown>[] = [];

    const processLine = async (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const lineResult = parseLlmJson(trimmed, TabularCellLineSchema);
        if (!lineResult.ok) {
            // col_index unknown at this point (couldn't parse the line)
            logger.warn(
                { err: lineResult.error, docId },
                "[tabular] queryGeminiAllColumns line parse failed",
            );
            if (write) {
                write(
                    `data: ${JSON.stringify({ type: "tabular_cell_parse_error", col_index: -1, doc_id: docId ?? "", error: lineResult.error })}\n\n`,
                );
            }
            return;
        }
        const { column_index } = lineResult.data;
        const col = columns.find((c) => c.index === column_index);
        if (!col) return;
        await onResult(column_index, {
            summary: String(lineResult.data.summary ?? lineResult.data.value ?? "").trim() || "Not addressed",
            flag: lineResult.data.flag ?? "grey",
            reasoning: String(lineResult.data.reasoning ?? ""),
        });
    };

    try {
        await streamChatWithTools({
            model,
            systemPrompt: SYSTEM,
            messages: [{ role: "user", content: USER }],
            tools: [],
            apiKeys,
            callbacks: {
                onContentDelta: (delta) => {
                    contentBuffer += delta;
                    let newlineIdx: number;
                    while ((newlineIdx = contentBuffer.indexOf("\n")) !== -1) {
                        const completedLine = contentBuffer.slice(
                            0,
                            newlineIdx,
                        );
                        contentBuffer = contentBuffer.slice(newlineIdx + 1);
                        pending.push(processLine(completedLine));
                    }
                },
            },
        });
    } catch (err) {
        logger.error({ err }, "[queryGeminiAllColumns] stream failed");
    }

    if (contentBuffer.trim()) pending.push(processLine(contentBuffer));
    await Promise.all(pending);
}

async function extractPdfMarkdown(buf: ArrayBuffer): Promise<string> {
    try {
        const pdfjsLib = await import(
            "pdfjs-dist/legacy/build/pdf.mjs" as string
        );
        const pdf = await (
            pdfjsLib as unknown as {
                getDocument: (opts: unknown) => {
                    promise: Promise<{
                        numPages: number;
                        getPage: (n: number) => Promise<{
                            getTextContent: () => Promise<{
                                items: { str?: string; hasEOL?: boolean }[];
                            }>;
                        }>;
                    }>;
                };
            }
        ).getDocument({ data: new Uint8Array(buf) }).promise;
        const pages: string[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const tc = await page.getTextContent();
            const text = tc.items
                .filter((it): it is { str: string } => "str" in it)
                .map((it) => it.str)
                .join(" ")
                .trim();
            if (text) pages.push(`## Page ${i}\n\n${text}`);
        }
        return pages.join("\n\n");
    } catch {
        return "";
    }
}

async function extractDocxMarkdown(buf: ArrayBuffer): Promise<string> {
    try {
        const mammoth = await import("mammoth");
        const normalized = await normalizeDocxZipPaths(Buffer.from(buf));
        const { value: html } = await mammoth.convertToHtml({
            buffer: normalized,
        });
        return html
            .replace(
                /<h([1-6])[^>]*>(.*?)<\/h\1>/gi,
                (_, l, t) => "#".repeat(Number(l)) + " " + t + "\n\n",
            )
            .replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**")
            .replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n")
            .replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n\n")
            .replace(/<[^>]+>/g, "")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    } catch {
        return "";
    }
}
