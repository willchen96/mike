import { gatewayConfig } from "../lib/llm/gateway";
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { recordAudit } from "../lib/audit";
import { sendInternalError } from "../lib/httpError";
import { attachActiveVersionPaths } from "../lib/documentVersions";
import {
    AssistantStreamError,
    ASSISTANT_ERROR_MESSAGE,
    buildCancelledAssistantMessage,
    isAbortError,
    runLLMStream,
    stripTransientAssistantEvents,
    TABULAR_TOOLS,
    type ChatMessage,
    type TabularCellStore,
    parseOptionalModel,
    parseOptionalReasoning,
} from "../lib/chat";
import { completeText } from "../lib/llm";
import {
    generateChatTitle,
    queryTabularCell,
} from "../lib/tabular/tabular.extract";
import {
    parseCellContent,
    TABULAR_GENERATION_HEARTBEAT_MS,
    TABULAR_GENERATION_LEASE_SECONDS,
    validateSelectedModel,
    type Column,
} from "../lib/tabular/tabular.shared";
import {
    extractRowColumns,
    finalizeCell,
} from "../lib/tabular/tabular.extractRow";
import {
    loadTabularGenerateWork,
    prepareTabularGenerate,
} from "../lib/tabular/tabular.generate";
import {
    awaitCellTerminal,
    claimCellsForGeneration,
    streamTabularGenerateAsync,
    streamTabularRunView,
} from "../lib/tabular/tabular.generateStream";
import {
    enqueueExtraction,
    removeQueuedExtractionJobs,
} from "../lib/queue/extractionQueue";
import {
    fetchSourceDocuments,
    loadReviewRows,
    loadRowDocumentText,
    type ReviewRow,
    type SourceDocument,
} from "../lib/tabular/tabular.rows";
import {
    getUserModelSettings,
    persistLastSelectedChatModel,
    persistLastSelectedReasoningLevel,
} from "../lib/userSettings";
import {
    TABULAR_MODEL_REQUIRED_DETAIL,
    resolveEffectiveChatModel,
    resolveEffectiveReasoningLevel,
    titleModelForChat,
} from "../lib/modelSelection";
import {
    checkProjectAccess,
    creatorScopedAllowed,
    ensureReviewAccess,
    filterAccessibleDocumentIds,
    normalizeEmail,
    resolveContentOrgId,
} from "../lib/access";
import { can } from "../lib/permissions";
import { loadProfileUsersByEmail } from "../lib/userLookup";
import {
    deleteContentGrant,
    listContentGrants,
    upsertContentGrant,
} from "../lib/contentAccess";
import { listContentPeople } from "../lib/resourcePeople";
import {
    buildTabularReviewIdsOverviewRpcArgs,
    buildTabularReviewsOverviewRpcArgs,
    parseTabularReviewScope,
} from "../lib/tabularReviewsOverview";
import { parsePaginationQuery } from "../lib/pagination";
import { normalizeSearchTerm } from "../lib/search";
import { parseTabularReviewSort } from "../lib/sort";

export const tabularRouter = Router();
const TABULAR_GENERATION_CONCURRENCY = 3;
// The lease timings live in lib/tabular/tabular.shared.ts because the queue
// workers hold the same lease on the async path and must agree on them.

type DocumentGrouping = "document" | "folder";
type SupabaseDb = ReturnType<typeof createServerSupabase>;

function isReviewGenerationRunning(review: Record<string, unknown>): boolean {
    if (!review.active_generation_id || !review.generation_lease_expires_at) {
        return false;
    }
    const leaseExpiresAt = Date.parse(
        String(review.generation_lease_expires_at),
    );
    return Number.isFinite(leaseExpiresAt) && leaseExpiresAt > Date.now();
}

function normalizeGrouping(value: unknown): DocumentGrouping {
    return value === "folder" ? "folder" : "document";
}

function buildFolderPathMap(
    folders: {
        id: string;
        name: string;
        parent_folder_id: string | null;
    }[],
): Map<string, string> {
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const paths = new Map<string, string>();
    const resolve = (id: string): string => {
        const existing = paths.get(id);
        if (existing) return existing;
        const folder = byId.get(id);
        if (!folder) return "Unknown folder";
        const path = folder.parent_folder_id
            ? `${resolve(folder.parent_folder_id)} / ${folder.name}`
            : folder.name;
        paths.set(id, path);
        return path;
    };
    for (const folder of folders) resolve(folder.id);
    return paths;
}

async function getFolderPathMaps(
    db: SupabaseDb,
    userId: string,
    docs: SourceDocument[],
): Promise<{
    project: Map<string, string>;
    library: Map<string, string>;
}> {
    const projectIds = [
        ...new Set(
            docs
                .map((doc) => doc.project_id)
                .filter((id): id is string => !!id),
        ),
    ];
    const [projectResult, libraryResult] = await Promise.all([
        projectIds.length
            ? db
                  .from("project_subfolders")
                  .select("id, name, parent_folder_id")
                  .in("project_id", projectIds)
            : Promise.resolve({ data: [] }),
        db
            .from("library_folders")
            .select("id, name, parent_folder_id")
            .eq("user_id", userId),
    ]);
    return {
        project: buildFolderPathMap(projectResult.data ?? []),
        library: buildFolderPathMap(libraryResult.data ?? []),
    };
}

async function createRowsForReview(
    db: SupabaseDb,
    reviewId: string,
    userId: string,
    documentIds: string[],
    columns: Column[],
    grouping: DocumentGrouping,
): Promise<void> {
    const docs = await fetchSourceDocuments(db, documentIds);
    const folderPaths = await getFolderPathMaps(db, userId, docs);
    const inputs: {
        label: string;
        row_type: "document" | "folder";
        folder_id: string | null;
        library_folder_id: string | null;
        document_id: string | null;
        sourceIds: string[];
    }[] = [];

    if (grouping === "folder") {
        const byFolder = new Map<
            string,
            {
                folder_id: string | null;
                library_folder_id: string | null;
                docs: SourceDocument[];
            }
        >();
        for (const doc of docs) {
            const folderKey = doc.folder_id
                ? `project:${doc.folder_id}`
                : doc.library_folder_id
                  ? `library:${doc.library_folder_id}`
                  : null;
            if (!folderKey) {
                inputs.push({
                    label: doc.filename,
                    row_type: "document",
                    folder_id: null,
                    library_folder_id: null,
                    document_id: doc.id,
                    sourceIds: [doc.id],
                });
                continue;
            }
            const existing = byFolder.get(folderKey);
            if (existing) {
                existing.docs.push(doc);
            } else {
                byFolder.set(folderKey, {
                    folder_id: doc.folder_id ?? null,
                    library_folder_id: doc.library_folder_id ?? null,
                    docs: [doc],
                });
            }
        }
        for (const folder of byFolder.values()) {
            const label = folder.folder_id
                ? folderPaths.project.get(folder.folder_id)
                : folder.library_folder_id
                  ? folderPaths.library.get(folder.library_folder_id)
                  : null;
            inputs.push({
                label: label ?? "Unknown folder",
                row_type: "folder",
                folder_id: folder.folder_id,
                library_folder_id: folder.library_folder_id,
                document_id: null,
                sourceIds: folder.docs.map((doc) => doc.id),
            });
        }
    } else {
        for (const doc of docs) {
            inputs.push({
                label: doc.filename,
                row_type: "document",
                folder_id: null,
                library_folder_id: null,
                document_id: doc.id,
                sourceIds: [doc.id],
            });
        }
    }

    inputs.sort((a, b) => a.label.localeCompare(b.label));
    if (inputs.length === 0) return;

    const { data, error } = await db
        .from("tabular_review_rows")
        .insert(
            inputs.map((input, sort_index) => ({
                review_id: reviewId,
                label: input.label,
                row_type: input.row_type,
                folder_id: input.folder_id,
                library_folder_id: input.library_folder_id,
                document_id: input.document_id,
                sort_index,
            })),
        )
        .select("*");
    if (error) throw new Error(error.message);
    const rows = ((data ?? []) as ReviewRow[]).sort(
        (a, b) => a.sort_index - b.sort_index,
    );
    const sources = rows.flatMap((row) =>
        (inputs[row.sort_index]?.sourceIds ?? []).map(
            (document_id, sort_index) => ({
                row_id: row.id,
                document_id,
                sort_index,
            }),
        ),
    );
    if (sources.length) {
        const { error: sourceError } = await db
            .from("tabular_review_row_sources")
            .insert(sources);
        if (sourceError) throw new Error(sourceError.message);
    }
    const cells = rows.flatMap((row) =>
        columns.map((column) => ({
            review_id: reviewId,
            row_id: row.id,
            document_id: row.document_id,
            column_index: column.index,
            status: "pending",
        })),
    );
    if (cells.length) {
        const { error: cellError } = await db
            .from("tabular_cells")
            .insert(cells);
        if (cellError) throw new Error(cellError.message);
    }
}

async function rebuildRowsForReview(
    db: SupabaseDb,
    reviewId: string,
    userId: string,
    documentIds: string[],
    columns: Column[],
    grouping: DocumentGrouping,
): Promise<void> {
    const { error } = await db
        .from("tabular_review_rows")
        .delete()
        .eq("review_id", reviewId);
    if (error) throw new Error(error.message);
    await createRowsForReview(
        db,
        reviewId,
        userId,
        documentIds,
        columns,
        grouping,
    );
}

async function syncCellsForReviewRows(
    db: SupabaseDb,
    reviewId: string,
    columns: Column[],
): Promise<void> {
    const { data: rows, error: rowsError } = await db
        .from("tabular_review_rows")
        .select("id,document_id")
        .eq("review_id", reviewId);
    if (rowsError) throw new Error(rowsError.message);
    const { data: cells, error: cellsError } = await db
        .from("tabular_cells")
        .select("id,row_id,column_index")
        .eq("review_id", reviewId);
    if (cellsError) throw new Error(cellsError.message);

    const activeColumnIndexes = new Set(columns.map((column) => column.index));
    const staleCellIds = (cells ?? [])
        .filter((cell) => !activeColumnIndexes.has(cell.column_index))
        .map((cell) => cell.id);
    if (staleCellIds.length) {
        const { error } = await db
            .from("tabular_cells")
            .delete()
            .in("id", staleCellIds);
        if (error) throw new Error(error.message);
    }

    const existingKeys = new Set(
        (cells ?? [])
            .filter((cell) => activeColumnIndexes.has(cell.column_index))
            .map((cell) => `${cell.row_id}:${cell.column_index}`),
    );
    const missingCells = (rows ?? []).flatMap((row) =>
        columns
            .filter((column) => !existingKeys.has(`${row.id}:${column.index}`))
            .map((column) => ({
                review_id: reviewId,
                row_id: row.id,
                document_id: row.document_id,
                column_index: column.index,
                status: "pending",
            })),
    );
    if (missingCells.length) {
        const { error } = await db.from("tabular_cells").insert(missingCells);
        if (error) throw new Error(error.message);
    }
}


// GET /tabular-review
tabularRouter.get("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();

    const projectIdFilter =
        typeof req.query.project_id === "string" && req.query.project_id
            ? (req.query.project_id as string)
            : null;

    const rpcArgs = buildTabularReviewsOverviewRpcArgs({
        userId,
        userEmail,
        projectIdFilter,
        scope: parseTabularReviewScope(req.query.scope),
        pagination: parsePaginationQuery(req.query as Record<string, unknown>),
        searchTerm: normalizeSearchTerm(req.query.search),
        sort: parseTabularReviewSort(req.query as Record<string, unknown>),
    });

    const { data, error } = await db.rpc(
        "get_tabular_reviews_overview",
        rpcArgs,
    );
    if (error) return void sendInternalError(res, error);

    res.json(data ?? []);
});

// GET /tabular-review/ids (must come before /:reviewId routes)
// Lightweight id + owner list for every review matching the current
// filters — backs "select all matching" bulk actions so the client doesn't
// have to page through full review payloads just to collect checkboxes.
//
// PostgREST enforces its own row cap on every RPC response (db-max-rows),
// independent of anything this route asks for, and truncates silently
// (206 + a shorter array, no error) rather than failing. So this pages
// through the RPC itself — server-side, same-datacenter round trips — until
// a page comes back empty, rather than trusting one call to return
// everything.
const TABULAR_REVIEW_IDS_PAGE_SIZE = 1000;
const TABULAR_REVIEW_IDS_MAX_PAGES = 200; // guards a runaway loop, not a product limit

tabularRouter.get("/ids", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();

    const projectIdFilter =
        typeof req.query.project_id === "string" && req.query.project_id
            ? (req.query.project_id as string)
            : null;
    const searchTerm = normalizeSearchTerm(req.query.search);
    const scope = parseTabularReviewScope(req.query.scope);

    const ids: { id: string; user_id: string }[] = [];
    let offset = 0;
    for (let page = 0; page < TABULAR_REVIEW_IDS_MAX_PAGES; page++) {
        const rpcArgs = buildTabularReviewIdsOverviewRpcArgs({
            userId,
            userEmail,
            projectIdFilter,
            scope,
            searchTerm,
            pagination: { limit: TABULAR_REVIEW_IDS_PAGE_SIZE, offset },
        });
        const { data, error } = await db.rpc(
            "get_tabular_review_ids_overview",
            rpcArgs,
        );
        if (error) return void sendInternalError(res, error);

        const rows = (data ?? []) as { id: string; user_id: string }[];
        if (rows.length === 0) break;
        ids.push(...rows);
        offset += rows.length;
    }

    res.json(ids);
});

// POST /tabular-review
tabularRouter.post("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const {
        title,
        document_ids,
        columns_config,
        workflow_id,
        project_id,
        org_id,
        document_grouping,
        model,
    } = req.body as {
        title?: string;
        document_ids: string[];
        columns_config: { index: number; name: string; prompt: string }[];
        workflow_id?: string;
        project_id?: string;
        org_id?: unknown;
        document_grouping?: DocumentGrouping;
        model?: string;
    };

    if ((typeof model !== "string" || !model.trim()) && !gatewayConfig()) {
        return void res.status(400).json({
            code: "model_required",
            detail: TABULAR_MODEL_REQUIRED_DETAIL,
        });
    }

    const db = createServerSupabase();
    const selectedModel = await validateSelectedModel(model, userId, db);
    if (!selectedModel.ok) {
        return void res.status(selectedModel.status).json(selectedModel.body);
    }
    if (project_id) {
        // Creating a review inside a project contributes content to it.
        const access = await checkProjectAccess(
            project_id,
            userId,
            userEmail,
            db,
        );
        if (!access.ok || !can(access.projectRole, "content.edit"))
            return void res.status(404).json({ detail: "Project not found" });
    }
    const allowedDocumentIds = Array.isArray(document_ids)
        ? await filterAccessibleDocumentIds(document_ids, userId, userEmail, db)
        : [];
    const grouping = normalizeGrouping(document_grouping);
    // Project reviews inherit their project's organization as tenant
    // provenance. Standalone reviews are always direct-scoped.
    const resolvedOrg = await resolveContentOrgId(db, {
        projectId: project_id ?? null,
    });
    if (!resolvedOrg.ok)
        return void sendInternalError(res, resolvedOrg.detail);
    if (org_id != null) {
        return void res.status(400).json({
            detail:
                "Tabular reviews cannot be organization-scoped. Create the review inside an organization project instead.",
        });
    }
    const { data: review, error } = await db
        .from("tabular_reviews")
        .insert({
            user_id: userId,
            title: title ?? null,
            model: selectedModel.model,
            columns_config,
            document_ids: allowedDocumentIds,
            project_id: project_id ?? null,
            workflow_id: workflow_id ?? null,
            document_grouping: grouping,
            org_id: resolvedOrg.orgId,
        })
        .select("*")
        .single();
    if (error || !review)
        return void sendInternalError(
            res,
            error ?? new Error("Review create returned no data"),
        );

    try {
        await createRowsForReview(
            db,
            review.id,
            userId,
            allowedDocumentIds,
            columns_config,
            grouping,
        );
    } catch (error) {
        await db.from("tabular_reviews").delete().eq("id", review.id);
        return void res.status(500).json({
            detail:
                error instanceof Error
                    ? error.message
                    : "Failed to create review rows",
        });
    }

    void recordAudit(db, {
        userId,
        userEmail,
        action: "tabular.created",
        title: (review as { title?: string | null }).title ?? null,
        surface: "tabular",
        projectId: project_id ?? null,
        reviewId: (review as { id: string }).id,
        model: selectedModel.model,
    });
    res.status(201).json({
        ...review,
        is_owner: true,
        access_role: "owner",
    });
});

// POST /tabular-review/prompt (must come before /:reviewId routes)
tabularRouter.post("/prompt", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const title =
        typeof req.body.title === "string" ? req.body.title.trim() : "";
    if (!title)
        return void res.status(400).json({ detail: "title is required" });

    const format: string =
        typeof req.body.format === "string" ? req.body.format : "text";
    const documentName: string =
        typeof req.body.documentName === "string"
            ? req.body.documentName.trim()
            : "";
    const tags: string[] = Array.isArray(req.body.tags)
        ? req.body.tags.filter((t: unknown) => typeof t === "string")
        : [];

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
        const { tabular_model: promptModel, api_keys } =
            await getUserModelSettings(userId);
        if (!promptModel) {
            return void res.status(409).json({
                code: "model_required",
                detail: "Select a default tabular review model in Settings → Model Preferences before generating a column prompt.",
            });
        }
        const raw = await completeText({
            model: promptModel,
            systemPrompt:
                'You write high-quality column prompts for legal tabular review workflows. Return only valid JSON with a single field: {"prompt": string}. The prompt you write must focus solely on what to extract — never on how to format the response.',
            user: userMessage,
            maxTokens: 512,
            apiKeys: api_keys,
        });
        const parsed = JSON.parse(
            raw
                .replace(/^```(?:json)?\n?/i, "")
                .replace(/\n?```$/, "")
                .trim(),
        ) as { prompt?: unknown };
        if (typeof parsed.prompt === "string" && parsed.prompt.trim()) {
            res.json({ prompt: parsed.prompt.trim(), source: "llm" });
        } else {
            res.status(502).json({ detail: "LLM returned an empty prompt" });
        }
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

    const { data: cells, error: cellsError } = await db
        .from("tabular_cells")
        .select("*")
        .eq("review_id", reviewId);
    if (cellsError) return void sendInternalError(res, cellsError);
    const rows = await loadReviewRows(db, reviewId);
    const rowDocIds = rows.flatMap((row) => row.source_document_ids ?? []);
    const docIds = Array.isArray(review.document_ids)
        ? (review.document_ids as string[])
        : rowDocIds;
    const docsResult =
        docIds.length > 0
            ? await db.from("documents").select("*").in("id", docIds)
            : { data: [] as Record<string, unknown>[] };
    const docs = (docsResult.data ?? []) as unknown as {
        id: string;
        current_version_id?: string | null;
    }[];
    await attachActiveVersionPaths(db, docs);
    const clientReview = { ...review };
    delete clientReview.active_generation_id;
    delete clientReview.generation_lease_expires_at;

    res.json({
        review: {
            ...clientReview,
            is_owner: access.isCreator,
            access_role: access.projectRole,
            is_running: isReviewGenerationRunning(review),
        },
        cells: (cells ?? []).map((cell) => ({
            ...cell,
            content: parseCellContent(cell.content),
        })),
        rows,
        documents: docs,
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
        .select("id, user_id, project_id, org_id")
        .eq("id", reviewId)
        .single();
    if (!review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    const people = await listContentPeople(
        db,
        "tabular_review",
        review as {
            id: string;
            user_id: string | null;
            project_id: string | null;
            org_id?: string | null;
        },
    );
    if (!people.ok) return void sendInternalError(res, people.detail);
    res.json(people);
});

// GET /tabular-review/:reviewId/access — role-aware direct grants, admin-only.
tabularRouter.get("/:reviewId/access", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const db = createServerSupabase();
    const { data: review } = await db
        .from("tabular_reviews")
        .select("id, user_id, project_id, org_id")
        .eq("id", reviewId)
        .maybeSingle();
    if (!review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });
    if (!can(access.projectRole, "access.manage"))
        return void res.status(403).json({
            detail: "Only a review owner can change who has access.",
        });
    if (review.project_id)
        return void res.json({
            scope: "project",
            inherited_from_project_id: review.project_id,
            org_id: review.org_id ?? null,
            access_role: access.projectRole,
            grants: [],
        });
    const listed = await listContentGrants(db, "tabular_review", reviewId);
    if (!listed.ok) return void sendInternalError(res, listed.detail);
    res.json({
        scope: "direct",
        org_id: null,
        access_role: access.projectRole,
        grants: listed.grants,
    });
});

// POST /tabular-review/:reviewId/access — grant or re-role one recipient.
tabularRouter.post("/:reviewId/access", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const db = createServerSupabase();
    const { data: review } = await db
        .from("tabular_reviews")
        .select("id, user_id, project_id, org_id")
        .eq("id", reviewId)
        .maybeSingle();
    if (!review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });
    if (!can(access.projectRole, "access.manage"))
        return void res.status(403).json({
            detail: "Only a review owner can change who has access.",
        });
    if (review.project_id)
        return void res.status(409).json({
            code: "access_inherited",
            detail: "Project-owned reviews inherit access from their project.",
        });
    const email = normalizeEmail(
        typeof req.body?.email === "string" ? req.body.email : null,
    );
    if (email && normalizeEmail(userEmail) === email)
        return void res.status(400).json({
            detail: "You cannot share a tabular review with yourself.",
        });
    if (req.body?.role === "deny")
        return void res.status(400).json({
            detail: "Deny is only available for organization members",
        });
    const { userById } = await loadProfileUsersByEmail(db);
    const result = await upsertContentGrant(db, {
        kind: "tabular_review",
        resourceId: reviewId,
        email: req.body?.email,
        role: req.body?.role,
        createdBy: userId,
        creatorEmail: review.user_id
            ? userById.get(review.user_id as string)?.email
            : null,
    });
    if (!result.ok) {
        if (result.kind === "validation")
            return void res.status(400).json({ detail: result.detail });
        return void sendInternalError(res, result.detail);
    }
    res.status(201).json(result.grant);
});

// DELETE /tabular-review/:reviewId/access/:email — revoke one recipient.
tabularRouter.delete(
    "/:reviewId/access/:email",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { reviewId } = req.params;
        const db = createServerSupabase();
        const { data: review } = await db
            .from("tabular_reviews")
            .select("id, user_id, project_id, org_id")
            .eq("id", reviewId)
            .maybeSingle();
        if (!review)
            return void res.status(404).json({ detail: "Review not found" });
        const access = await ensureReviewAccess(review, userId, userEmail, db);
        if (!access.ok)
            return void res.status(404).json({ detail: "Review not found" });
        if (!can(access.projectRole, "access.manage"))
            return void res.status(403).json({
                detail: "Only a review owner can change who has access.",
            });
        if (review.project_id)
            return void res.status(409).json({
                code: "access_inherited",
                detail: "Project-owned reviews inherit access from their project.",
            });
        const result = await deleteContentGrant(db, {
            kind: "tabular_review",
            resourceId: reviewId,
            email: decodeURIComponent(req.params.email),
        });
        if (!result.ok) return void sendInternalError(res, result.detail);
        if (!result.removed)
            return void res
                .status(404)
                .json({ detail: "Access grant not found" });
        res.status(204).send();
    },
);

// PATCH /tabular-review/:reviewId
tabularRouter.patch("/:reviewId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    if (
        req.body &&
        typeof req.body === "object" &&
        "shared_with" in req.body
    )
        return void res.status(400).json({
            detail:
                "shared_with is no longer supported; use the tabular review access endpoints.",
        });
    const updates: Record<string, unknown> = {};
    if (req.body.title != null) updates.title = req.body.title;
    const modelUpdateProvided = req.body.model !== undefined;
    const projectIdUpdateProvided = req.body.project_id !== undefined;
    const projectIdUpdate =
        req.body.project_id === null
            ? null
            : typeof req.body.project_id === "string" &&
                req.body.project_id.trim()
              ? req.body.project_id.trim()
              : undefined;
    if (projectIdUpdateProvided && projectIdUpdate === undefined) {
        return void res.status(400).json({
            detail: "project_id must be a non-empty string or null",
        });
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
    // Per-field gates, generalising #175's owner-only "settings" rule to
    // the role ladder. Title, document set and column set are content work
    // (member+): reshaping the grid destroys cells when narrowed, but so does
    // any other edit a member may already make. Sharing is admin-only — it
    // changes WHO can reach the review, which is a different kind of power.
    // Moving the review between projects stays with its creator.
    if (
        (req.body.title != null ||
            Array.isArray(req.body.document_ids) ||
            req.body.document_grouping != null ||
            modelUpdateProvided) &&
        !can(access.projectRole, "content.edit")
    ) {
        return void res.status(403).json({
            detail: "Only a review editor can change review settings",
        });
    }
    if (modelUpdateProvided) {
        const selectedModel = await validateSelectedModel(
            req.body.model,
            userId,
            db,
        );
        if (!selectedModel.ok) {
            return void res
                .status(selectedModel.status)
                .json(selectedModel.body);
        }
        updates.model = selectedModel.model;
    }
    if (req.body.columns_config != null) {
        if (!can(access.projectRole, "content.edit")) {
            return void res.status(403).json({
                detail: "Only a review editor can change columns",
            });
        }
        updates.columns_config = req.body.columns_config;
    }
    if (req.body.document_grouping != null) {
        if (
            req.body.document_grouping !== "document" &&
            req.body.document_grouping !== "folder"
        ) {
            return void res.status(400).json({
                detail: "document_grouping must be document or folder",
            });
        }
        updates.document_grouping = req.body.document_grouping;
    }
    if (Array.isArray(req.body.document_ids)) {
        updates.document_ids = await filterAccessibleDocumentIds(
            req.body.document_ids,
            userId,
            userEmail,
            db,
        );
    }
    if (projectIdUpdateProvided) {
        if (!creatorScopedAllowed(access, existingReview.user_id)) {
            return void res.status(403).json({
                detail: "Only the review's creator can move a review",
            });
        }
        if (projectIdUpdate) {
            const projectAccess = await checkProjectAccess(
                projectIdUpdate,
                userId,
                userEmail,
                db,
            );
            if (!projectAccess.ok) {
                return void res
                    .status(404)
                    .json({ detail: "Target project not found" });
            }
        }
        updates.project_id = projectIdUpdate;
        // `tabular_reviews.org_id` is a DENORMALIZED copy of the project's
        // tenant, stamped at creation and read directly by the SQL visibility
        // predicates (`tr.org_id is not null and exists (select 1 from
        // org_members …)`). Moving the review to another project changes
        // which tenant owns it, so the copy has to be restamped from the
        // destination — otherwise a review moved out of an org project into a
        // personal one keeps answering yes to that org arm and stays visible
        // to every member of an organization it no longer belongs to. Same
        // helper and argument shape as the create path.
        const movedOrg = await resolveContentOrgId(db, {
            projectId: projectIdUpdate ?? null,
        });
        if (!movedOrg.ok)
            return void sendInternalError(res, movedOrg.detail);
        updates.org_id = movedOrg.orgId;
    }

    const { data: updatedReview, error: updateError } = await db
        .from("tabular_reviews")
        .update(updates)
        .eq("id", reviewId)
        .select("*")
        .single();
    if (updateError || !updatedReview)
        return void sendInternalError(
            res,
            updateError ?? new Error("Review update returned no data"),
        );

    const rowShapeChanged =
        Array.isArray(req.body.document_ids) ||
        req.body.document_grouping != null ||
        projectIdUpdateProvided;
    try {
        const activeColumns = (updatedReview.columns_config ?? []) as Column[];
        if (rowShapeChanged) {
            await rebuildRowsForReview(
                db,
                reviewId,
                userId,
                (updatedReview.document_ids ?? []) as string[],
                activeColumns,
                normalizeGrouping(updatedReview.document_grouping),
            );
        } else if (Array.isArray(req.body.columns_config)) {
            await syncCellsForReviewRows(db, reviewId, activeColumns);
        }
    } catch (error) {
        return void res.status(500).json({
            detail:
                error instanceof Error
                    ? error.message
                    : "Failed to synchronize review rows",
        });
    }

    res.json(updatedReview);
});

// DELETE /tabular-review/:reviewId
tabularRouter.delete("/:reviewId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const db = createServerSupabase();
    // container.delete keeps review deletion at the top of the ladder: the
    // review's own creator, or an admin of the project it lives in (who could
    // already delete the whole project, review included). The old
    // `.eq("user_id", userId)` filter made that project admin's DELETE a
    // silent 204 no-op — the row survived and the UI showed it again on the
    // next load. Resolving the role first also lets members and viewers learn
    // they were refused (403) instead of guessing at a 404.
    const { data: review, error: reviewError } = await db
        .from("tabular_reviews")
        .select("id, user_id, project_id, org_id")
        .eq("id", reviewId)
        .single();
    if (reviewError || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });
    if (!can(access.projectRole, "container.delete"))
        return void res.status(403).json({
            detail: "You do not have permission to delete this review",
        });

    const { error } = await db
        .from("tabular_reviews")
        .delete()
        .eq("id", reviewId);
    if (error) return void sendInternalError(res, error);
    res.status(204).send();
});

// POST /tabular-review/:reviewId/clear-cells
// Reset cells to an empty/pending state for the given row_ids. Does not
// delete the rows — it blanks `content` and sets `status` back to "pending".
tabularRouter.post("/:reviewId/clear-cells", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const { row_ids } = req.body as { row_ids?: string[] };

    if (!Array.isArray(row_ids) || row_ids.length === 0)
        return void res.status(400).json({ detail: "row_ids is required" });

    const db = createServerSupabase();
    const { data: review, error: reviewError } = await db
        .from("tabular_reviews")
        .select(
            "id, user_id, project_id, org_id, columns_config, updated_at, active_generation_id, generation_lease_expires_at",
        )
        .eq("id", reviewId)
        .single();
    if (reviewError || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });
    // Blanking extracted cells is destructive but it is still editing the
    // review's contents, so it sits with the rest of content.edit. Viewers,
    // being read-only, are refused.
    if (!can(access.projectRole, "content.edit"))
        return void res.status(403).json({
            detail: "Only a review editor can clear cells",
        });
    if (isReviewGenerationRunning(review)) {
        return void res.status(409).json({
            code: "review_running",
            detail: "This tabular review is currently running.",
        });
    }

    const mutationId = randomUUID();
    const { data: startResult, error: startError } = await db.rpc(
        "begin_tabular_review_generation",
        {
            target_review_id: reviewId,
            expected_updated_at: review.updated_at,
            target_generation_id: mutationId,
            lease_seconds: TABULAR_GENERATION_LEASE_SECONDS,
        },
    );
    if (startError) return void sendInternalError(res, startError);
    if (startResult === "running") {
        return void res.status(409).json({
            code: "review_running",
            detail: "This tabular review is currently running.",
        });
    }
    if (startResult === "stale") {
        return void res.status(409).json({
            code: "review_stale",
            detail: "A newer version of this tabular review is available.",
        });
    }
    if (startResult !== "started") {
        return void res.status(startResult === "not_found" ? 404 : 500).json({
            detail:
                startResult === "not_found"
                    ? "Review not found"
                    : "Failed to clear tabular review cells",
        });
    }

    try {
        // Async mode: reap leftover queued extraction for these rows BEFORE
        // blanking the cells. Holding the lease means no generation is live
        // (begin_ returned "started", not "running") — but a lease that LAPSED
        // can leave orphans behind: jobs still waiting in Redis that would
        // start seconds from now and re-fill the freshly cleared row, and
        // zombie jobs still running past their expired lease. Waiting/delayed
        // jobs are removed outright; a running one gets a persisted `canceled`
        // marker its next attempt no-ops on (and its terminal writes are
        // already dropped by the generation_id guards, since we clear the
        // stamp below). Best-effort — clearing must succeed even if Redis is
        // unreachable. Flag-gated so synchronous deployments never dial Redis.
        if (process.env.ASYNC_TABULAR_EXTRACTION === "true") {
            try {
                const columnIndexes = (
                    (review.columns_config as { index: number }[] | null) ?? []
                ).map((c) => c.index);
                await removeQueuedExtractionJobs(
                    reviewId,
                    row_ids,
                    columnIndexes,
                );
            } catch (err) {
                console.error(
                    "[tabular/clear-cells] queue cancellation failed",
                    err,
                );
            }
        }

        const { error } = await db
            .from("tabular_cells")
            .update({
                content: null,
                status: "pending",
                generation_id: null,
            })
            .eq("review_id", reviewId)
            .in("row_id", row_ids);
        if (error) return void sendInternalError(res, error);
        res.status(204).send();
    } finally {
        const { error } = await db.rpc("finish_tabular_review_generation", {
            target_review_id: reviewId,
            target_generation_id: mutationId,
        });
        if (error) {
            console.error(
                "[tabular/clear-cells] failed to release generation lease",
                error,
            );
        }
    }
});

// POST /tabular-review/:reviewId/regenerate-cell
tabularRouter.post(
    "/:reviewId/regenerate-cell",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { reviewId } = req.params;
        const { row_id, column_index } = req.body as {
            row_id?: string;
            column_index: number;
        };

        if (!row_id || column_index == null)
            return void res
                .status(400)
                .json({ detail: "row_id and column_index are required" });

        const db = createServerSupabase();
        const { data: review, error: reviewError } = await db
            .from("tabular_reviews")
            .select("*")
            .eq("id", reviewId)
            .single();
        if (reviewError || !review)
            return void res.status(404).json({ detail: "Review not found" });
        const access = await ensureReviewAccess(review, userId, userEmail, db);
        if (!access.ok || !can(access.projectRole, "content.edit"))
            return void res.status(404).json({ detail: "Review not found" });
        if (isReviewGenerationRunning(review)) {
            return void res.status(409).json({
                code: "review_running",
                detail: "This tabular review is currently running.",
            });
        }

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

        const rows = await loadReviewRows(db, reviewId);
        const row = rows.find((candidate) => candidate.id === row_id);
        if (!row)
            return void res
                .status(404)
                .json({ detail: "Review row not found" });
        const sourceIds = row.source_document_ids ?? [];
        const allowedSourceIds = await filterAccessibleDocumentIds(
            sourceIds,
            userId,
            userEmail,
            db,
        );
        if (allowedSourceIds.length !== sourceIds.length)
            return void res
                .status(404)
                .json({ detail: "Review row not found" });

        const selectedModel = await validateSelectedModel(
            review.model,
            userId,
            db,
            true,
        );
        if (!selectedModel.ok) {
            return void res
                .status(selectedModel.status)
                .json(selectedModel.body);
        }
        const tabular_model = selectedModel.model;
        const api_keys = selectedModel.apiKeys;

        const generationId = randomUUID();
        const { data: startResult, error: startError } = await db.rpc(
            "begin_tabular_review_generation",
            {
                target_review_id: reviewId,
                expected_updated_at: review.updated_at,
                target_generation_id: generationId,
                lease_seconds: TABULAR_GENERATION_LEASE_SECONDS,
            },
        );
        if (startError) return void sendInternalError(res, startError);
        if (startResult === "running") {
            return void res.status(409).json({
                code: "review_running",
                detail: "This tabular review is currently running.",
            });
        }
        if (startResult === "stale") {
            return void res.status(409).json({
                code: "review_stale",
                detail: "A newer version of this tabular review is available.",
            });
        }
        if (startResult !== "started") {
            return void res
                .status(startResult === "not_found" ? 404 : 500)
                .json({
                    detail:
                        startResult === "not_found"
                            ? "Review not found"
                            : "Failed to regenerate tabular review cell",
                });
        }

        let renewingLease = false;
        const leaseHeartbeat = setInterval(() => {
            if (renewingLease) return;
            renewingLease = true;
            void (async () => {
                try {
                    const { data, error } = await db.rpc(
                        "renew_tabular_review_generation",
                        {
                            target_review_id: reviewId,
                            target_generation_id: generationId,
                            lease_seconds: TABULAR_GENERATION_LEASE_SECONDS,
                        },
                    );
                    if (error || data !== true) {
                        console.error(
                            "[tabular/regenerate-cell] failed to renew generation lease",
                            error ?? "Lease is no longer active",
                        );
                    }
                } catch (error) {
                    console.error(
                        "[tabular/regenerate-cell] failed to renew generation lease",
                        error,
                    );
                } finally {
                    renewingLease = false;
                }
            })();
        }, TABULAR_GENERATION_HEARTBEAT_MS);

        // Async path only: once the job is enqueued the queue owns the lease —
        // the worker renews it while it extracts and releases it through
        // `finishGenerationIfIdle` when the cell reaches a terminal state. This
        // request must then not release it on its way out, because on the 202
        // branch the job is still running.
        let leaseHandedOff = false;

        try {
            // Stamp the cell with this generation BEFORE any enqueue: the stamp
            // is what makes the worker's writes guardable and what keeps the
            // lease held until the cell is terminal.
            const { error: generatingError } = await db
                .from("tabular_cells")
                .update({
                    status: "generating",
                    content: null,
                    generation_id: generationId,
                })
                .eq("review_id", reviewId)
                .eq("row_id", row.id)
                .eq("column_index", column_index);
            if (generatingError) {
                return void sendInternalError(res, generatingError);
            }

            // Async path: enqueue a single-cell job (deduped on
            // extract:<review>:<row>:<col>, so it never collides with a
            // full-row job) and wait for the cell to reach a terminal state, so
            // the response keeps its synchronous JSON shape. The work itself is
            // durable: if this request drops or times out the worker still
            // finishes and the client catches up via the DB or the GET
            // generate/stream view.
            if (process.env.ASYNC_TABULAR_EXTRACTION === "true") {
                // The worker renews the lease from here on — two renewers would
                // only race each other.
                clearInterval(leaseHeartbeat);
                try {
                    await enqueueExtraction({
                        reviewId,
                        userId,
                        rowId: row.id,
                        columnIndex: column_index,
                        generationId,
                    });
                    leaseHandedOff = true;
                } catch (err) {
                    // Nothing will ever run this cell, so we still own both the
                    // cell's terminal state and the lease (released in finally).
                    console.error(
                        "[tabular/regenerate-cell] enqueue failed",
                        err,
                    );
                    await finalizeCell(db, {
                        reviewId,
                        rowId: row.id,
                        columnIndex: column_index,
                        status: "error",
                        generationId,
                    });
                    return void res
                        .status(500)
                        .json({ detail: "Generation failed" });
                }

                const terminal = await awaitCellTerminal({
                    db,
                    reviewId,
                    rowId: row.id,
                    columnIndex: column_index,
                    log: console,
                });
                if (terminal === null)
                    // Still running after the wait budget — the job survives
                    // this response and still holds the lease; the client keeps
                    // the cell "generating" and picks the result up from the
                    // resume stream or a reload.
                    return void res.status(202).json({
                        status: "generating",
                        detail: "Extraction still running",
                    });
                if (terminal.status === "error")
                    return void res
                        .status(500)
                        .json({ detail: "Generation failed" });
                return void res.json(terminal.content);
            }

            const markdown = await loadRowDocumentText(db, row);
            const result = await queryTabularCell(
                tabular_model,
                row.label,
                markdown,
                column.prompt,
                column.format,
                column.tags,
                api_keys,
            );

            if (!result) {
                await db
                    .from("tabular_cells")
                    .update({ status: "error", generation_id: null })
                    .eq("review_id", reviewId)
                    .eq("row_id", row.id)
                    .eq("column_index", column_index)
                    .eq("generation_id", generationId);
                return void res
                    .status(500)
                    .json({ detail: "Generation failed" });
            }

            const { error: completedError } = await db
                .from("tabular_cells")
                .update({
                    content: JSON.stringify(result),
                    status: "done",
                    generation_id: null,
                })
                .eq("review_id", reviewId)
                .eq("row_id", row.id)
                .eq("column_index", column_index)
                .eq("generation_id", generationId);
            if (completedError) {
                return void sendInternalError(res, completedError);
            }

            res.json(result);
        } catch (error) {
            await db
                .from("tabular_cells")
                .update({ status: "error", generation_id: null })
                .eq("review_id", reviewId)
                .eq("row_id", row.id)
                .eq("column_index", column_index)
                .eq("generation_id", generationId);
            console.error("[tabular/regenerate-cell] generation failed", error);
            if (!res.headersSent) {
                res.status(500).json({ detail: "Generation failed" });
            }
        } finally {
            clearInterval(leaseHeartbeat);
            // On the async path the lease now belongs to the worker running the
            // enqueued job — including on the 202 branch, where the job is
            // still going after this response. It releases it itself once the
            // cell is terminal (`finishGenerationIfIdle`).
            if (!leaseHandedOff) {
                const { error } = await db.rpc(
                    "finish_tabular_review_generation",
                    {
                        target_review_id: reviewId,
                        target_generation_id: generationId,
                    },
                );
                if (error) {
                    console.error(
                        "[tabular/regenerate-cell] failed to release generation lease",
                        error,
                    );
                }
            }
        }
    },
);

// POST /tabular-review/:reviewId/generate
tabularRouter.post("/:reviewId/generate", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const db = createServerSupabase();
    const generationAbort = new AbortController();
    const generationId = randomUUID();
    let leaseHeartbeat: ReturnType<typeof setInterval> | null = null;
    let renewingLease = false;
    req.on("aborted", () => generationAbort.abort());

    // Pre-lease guards only (review, access, columns, model policy). Row and
    // cell state is deliberately NOT read here — see the note at the lease
    // claim.
    const prepared = await prepareTabularGenerate(db, {
        reviewId,
        userId,
        userEmail,
    });
    if (!prepared.ok) {
        if (prepared.kind === "not_found")
            return void res.status(404).json({ detail: "Review not found" });
        if (prepared.kind === "no_columns")
            return void res
                .status(400)
                .json({ detail: "No columns configured" });
        return void res.status(prepared.status).json(prepared.body);
    }
    const { columns, tabular_model, api_keys } = prepared.data;

    const expectedUpdatedAt = req.body?.expected_updated_at;
    if (
        typeof expectedUpdatedAt !== "string" ||
        !Number.isFinite(Date.parse(expectedUpdatedAt))
    ) {
        return void res.status(400).json({
            detail: "expected_updated_at must be a valid timestamp",
        });
    }
    if (generationAbort.signal.aborted || res.destroyed) return;

    const { data: startResult, error: startError } = await db.rpc(
        "begin_tabular_review_generation",
        {
            target_review_id: reviewId,
            expected_updated_at: expectedUpdatedAt,
            target_generation_id: generationId,
            lease_seconds: TABULAR_GENERATION_LEASE_SECONDS,
        },
    );
    if (startError) {
        return void sendInternalError(res, startError);
    }
    if (startResult === "running") {
        return void res.status(409).json({
            code: "review_running",
            detail: "This tabular review is already running elsewhere.",
        });
    }
    if (startResult === "stale") {
        return void res.status(409).json({
            code: "review_stale",
            detail: "A newer version of this tabular review is available.",
        });
    }
    if (startResult === "not_found") {
        return void res.status(404).json({ detail: "Review not found" });
    }
    if (startResult !== "started") {
        return void res.status(500).json({
            detail: "Failed to start tabular review generation",
        });
    }
    // Everything used to decide which cells need work is loaded only after
    // the atomic lease claim. Otherwise, a request can snapshot pending cells
    // while another run is finishing, acquire the newly released lease, and
    // regenerate results that were completed after its stale snapshot.
    let rows: ReviewRow[] = [];
    let cellMap = new Map<string, Record<string, unknown>>();

    // The async path hands the lease to the queue workers (they renew it, and
    // the last one out releases it) because the work outlives this request.
    // While that is true this handler must neither release the lease nor end
    // the response in its `finally`.
    let leaseHandedOff = false;
    let streamFinished = false;
    res.on("close", () => {
        if (!streamFinished) generationAbort.abort();
    });
    const write = (line: string) => {
        if (res.destroyed || res.writableEnded) return false;
        return res.write(line);
    };

    try {
        leaseHeartbeat = setInterval(() => {
            if (renewingLease || generationAbort.signal.aborted) return;
            renewingLease = true;
            void (async () => {
                try {
                    const { data, error } = await db.rpc(
                        "renew_tabular_review_generation",
                        {
                            target_review_id: reviewId,
                            target_generation_id: generationId,
                            lease_seconds: TABULAR_GENERATION_LEASE_SECONDS,
                        },
                    );
                    if (error || data !== true) generationAbort.abort();
                } catch {
                    generationAbort.abort();
                } finally {
                    renewingLease = false;
                }
            })();
        }, TABULAR_GENERATION_HEARTBEAT_MS);

        const work = await loadTabularGenerateWork(db, {
            reviewId,
            userId,
            userEmail,
        });
        if (!work.ok) {
            sendInternalError(res, work.error);
            return;
        }
        rows = work.data.rows;
        cellMap = work.data.cellMap;

        if (generationAbort.signal.aborted || res.destroyed) return;

        // Async path: hand extraction to the durable BullMQ queue and turn this
        // request into a reconnectable view that tails progress. The work
        // survives a disconnect and retries on failure. Falls through to the
        // historical inline path when the flag is off (no Redis required).
        if (process.env.ASYNC_TABULAR_EXTRACTION === "true") {
            // The workers renew the lease from here on, so stop our heartbeat
            // before handing over — two renewers would just race each other.
            if (leaseHeartbeat) {
                clearInterval(leaseHeartbeat);
                leaseHeartbeat = null;
            }
            leaseHandedOff = await streamTabularGenerateAsync({
                res,
                db,
                reviewId,
                userId,
                generationId,
                columns,
                rows,
                cellMap,
                log: console,
            });
            void recordAudit(db, {
                userId,
                userEmail,
                action: "tabular.generated",
                surface: "tabular",
                reviewId,
            });
            return;
        }

        // Synchronous path: claim the cells this run intends to fill by
        // stamping them with the generation id — the same call the async path
        // makes before enqueuing. Every write extractRowColumns then performs
        // is guarded on that stamp, so a run that loses the lease mid-flight
        // (a wedged process, a renew that failed) can no longer blank or
        // overwrite the cells its successor has already filled. Doing it here,
        // right after the atomic lease claim, is the only window in which no
        // other generation can be running.
        try {
            await claimCellsForGeneration({
                db,
                reviewId,
                generationId,
                columns,
                rows,
                cellMap,
            });
        } catch (claimErr) {
            sendInternalError(res, claimErr);
            return;
        }

        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        let nextRowIndex = 0;
        const cellFrame = (
            rowId: string,
            columnIndex: number,
            content: unknown,
            status: "generating" | "done" | "error" | "pending",
        ): void => {
            write(
                `data: ${JSON.stringify({ type: "cell_update", row_id: rowId, column_index: columnIndex, content, status })}\n\n`,
            );
        };

        const processRow = async (row: ReviewRow) => {
            const existingByColumn = new Map<number, Record<string, unknown>>();
            for (const col of columns) {
                const cell = cellMap.get(`${row.id}:${col.index}`);
                if (cell) existingByColumn.set(col.index, cell);
            }

            // Shared extraction core — the async worker runs this same
            // function. It owns the generating/done DB writes (stamped with and
            // guarded by this run's generation id) and announces each
            // transition through the sink, which here writes SSE frames. It
            // never decides the terminal state of a column the model skipped;
            // it reports those in `missing`.
            const { missing } = await extractRowColumns({
                db,
                reviewId,
                row,
                columns,
                existingByColumn,
                model: tabular_model,
                apiKeys: api_keys,
                generationId,
                abortSignal: generationAbort.signal,
                sink: {
                    generating: (rowId, columnIndex) =>
                        cellFrame(rowId, columnIndex, null, "generating"),
                    done: (rowId, columnIndex, result) =>
                        cellFrame(rowId, columnIndex, result, "done"),
                },
            });

            // Stopped cells return to pending; genuine missing model output is
            // still an error. Completed cells remain untouched.
            const incompleteStatus = generationAbort.signal.aborted
                ? "pending"
                : "error";
            for (const columnIndex of missing) {
                await finalizeCell(db, {
                    reviewId,
                    rowId: row.id,
                    columnIndex,
                    status: incompleteStatus,
                    generationId,
                });
                cellFrame(row.id, columnIndex, null, incompleteStatus);
            }
        };

        const runWorker = async () => {
            while (!generationAbort.signal.aborted) {
                const rowIndex = nextRowIndex++;
                if (rowIndex >= rows.length) return;
                await processRow(rows[rowIndex]);
            }
        };
        await Promise.all(
            Array.from(
                {
                    length: Math.min(
                        TABULAR_GENERATION_CONCURRENCY,
                        rows.length,
                    ),
                },
                () => runWorker(),
            ),
        );

        if (!generationAbort.signal.aborted) {
            void recordAudit(db, {
                userId,
                userEmail,
                action: "tabular.generated",
                surface: "tabular",
                reviewId,
                model: tabular_model,
            });
            write("data: [DONE]\n\n");
        }
    } catch (err) {
        if (!generationAbort.signal.aborted) {
            console.error("[tabular/generate] stream error", err);
            if (res.headersSent) {
                try {
                    write(
                        `data: ${JSON.stringify({ type: "error", message: ASSISTANT_ERROR_MESSAGE })}\n\ndata: [DONE]\n\n`,
                    );
                } catch {
                    /* ignore */
                }
            } else if (!res.destroyed && !res.writableEnded) {
                res.status(500).json({
                    detail: "Failed to prepare tabular review generation",
                });
            }
        }
    } finally {
        streamFinished = true;
        if (leaseHeartbeat) clearInterval(leaseHeartbeat);
        // On the async path the lease now belongs to the workers and the SSE
        // view is still tailing them, so neither is ours to close.
        if (!leaseHandedOff) {
            try {
                const { error } = await db.rpc(
                    "finish_tabular_review_generation",
                    {
                        target_review_id: reviewId,
                        target_generation_id: generationId,
                    },
                );
                if (error) throw error;
            } catch (error) {
                console.error(
                    "[tabular/generate] failed to release generation lease",
                    error,
                );
            }
            if (!res.writableEnded) res.end();
        }
    }
});

// GET /tabular-review/:reviewId/generate/stream — reconnect to an in-flight (or
// just-finished) generate run without re-triggering work. A client whose POST
// /generate stream dropped can resume here and catch up on the remaining cells.
// Pure observer: it never enqueues and takes NO generation lease, so watching a
// run can never block it or make a legitimate POST 409. (Registered before the
// /:reviewId/chats group; no path collision since the segments differ.)
tabularRouter.get(
    "/:reviewId/generate/stream",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { reviewId } = req.params;
        const db = createServerSupabase();

        const prepared = await prepareTabularGenerate(db, {
            reviewId,
            userId,
            userEmail,
        });
        if (!prepared.ok) {
            if (prepared.kind === "not_found")
                return void res
                    .status(404)
                    .json({ detail: "Review not found" });
            if (prepared.kind === "no_columns")
                return void res
                    .status(400)
                    .json({ detail: "No columns configured" });
            return void res.status(prepared.status).json(prepared.body);
        }

        const work = await loadTabularGenerateWork(db, {
            reviewId,
            userId,
            userEmail,
        });
        if (!work.ok) return void sendInternalError(res, work.error);

        await streamTabularRunView({
            res,
            db,
            reviewId,
            columns: prepared.data.columns,
            rows: work.data.rows,
            cellMap: work.data.cellMap,
            log: console,
        });
    },
);

// GET /tabular-review/:reviewId/chats — list chats (metadata only, no messages)
tabularRouter.get("/:reviewId/chats", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const db = createServerSupabase();

    // Verify access (creator, direct grant, project access, or org).
    const { data: review, error } = await db
        .from("tabular_reviews")
        .select("id, user_id, project_id, org_id")
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
        .select(
            "id, title, model, reasoning_level, created_at, updated_at, user_id",
        )
        .eq("review_id", reviewId)
        .order("updated_at", { ascending: false });

    res.json(chats ?? []);
});

// Review-chat writes share one preamble: the caller must be able to access
// the review named in the URL, and the chat must actually belong to it —
// previously these two writes checked neither, so any chat id could be hit
// through any (or a nonexistent) review path.
async function ensureReviewChatWriteAccess(
    reviewId: string,
    chatId: string,
    userId: string,
    userEmail: string | null | undefined,
    db: ReturnType<typeof createServerSupabase>,
): Promise<{ ok: true } | { ok: false; status: number; detail: string }> {
    const { data: review } = await db
        .from("tabular_reviews")
        .select("id, user_id, project_id, org_id")
        .eq("id", reviewId)
        .single();
    if (!review) return { ok: false, status: 404, detail: "Review not found" };
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return { ok: false, status: 404, detail: "Review not found" };
    const { data: chat } = await db
        .from("tabular_review_chats")
        .select("id, review_id, user_id")
        .eq("id", chatId)
        .single();
    if (!chat || chat.review_id !== reviewId)
        return { ok: false, status: 404, detail: "Chat not found" };
    // Review chats are creator-write: collaborators read each other's
    // threads but cannot rename or delete them. Refusing here, not via the
    // write's user_id filter alone, keeps a non-creator from getting a
    // success-shaped 204 for an update that silently matched zero rows.
    //
    // `creatorScopedAllowed` rather than a bare `chat.user_id !== userId`,
    // because `tabular_review_chats.user_id` is ON DELETE SET NULL since
    // 20260902_01: once the author's account is deleted the column is NULL
    // and "only the creator may act" means NOBODY may act — the thread is
    // stranded inside a review the organization still owns, which is the
    // opposite of what detaching the row was for. When the creator is gone
    // the container's admins inherit the operation; while a creator exists
    // nothing changes, and an admin still may not touch a colleague's live
    // thread.
    if (
        !creatorScopedAllowed(
            {
                // "isCreator" is about THIS chat. `access` was derived for
                // the REVIEW, and the review's creator is not thereby the
                // creator of every chat inside it — passing `access` whole
                // would hand them everyone's threads.
                isCreator: !!chat.user_id && chat.user_id === userId,
                projectRole: access.projectRole,
            },
            chat.user_id,
        )
    )
        return {
            ok: false,
            status: 403,
            detail: "Only the chat's creator can modify it",
        };
    return { ok: true };
}

// DELETE /tabular-review/:reviewId/chats/:chatId — delete a single chat
tabularRouter.delete(
    "/:reviewId/chats/:chatId",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { reviewId, chatId } = req.params;
        const db = createServerSupabase();
        const gate = await ensureReviewChatWriteAccess(
            reviewId,
            chatId,
            userId,
            userEmail,
            db,
        );
        if (!gate.ok)
            return void res.status(gate.status).json({ detail: gate.detail });
        // Scoped by the binding the gate just proved (this chat, in this
        // review) and nothing more. A `user_id` filter here would be a
        // second, weaker copy of the authorization rule: it would silently
        // match zero rows for the case the gate now allows — an admin
        // clearing up after a departed colleague — and answer 204 while
        // deleting nothing.
        const { error } = await db
            .from("tabular_review_chats")
            .delete()
            .eq("id", chatId)
            .eq("review_id", reviewId);
        if (error) return void sendInternalError(res, error);
        res.status(204).send();
    },
);

// PATCH /tabular-review/:reviewId/chats/:chatId — update chat settings
tabularRouter.patch(
    "/:reviewId/chats/:chatId",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { reviewId, chatId } = req.params;
        const body =
            req.body && typeof req.body === "object" && !Array.isArray(req.body)
                ? (req.body as Record<string, unknown>)
                : {};
        const invalidField = Object.keys(body).find(
            (field) =>
                field !== "title" &&
                field !== "model" &&
                field !== "reasoningLevel",
        );
        if (invalidField) {
            return void res.status(400).json({
                detail: `Unsupported chat field: ${invalidField}`,
            });
        }
        const hasTitle = Object.hasOwn(body, "title");
        const hasModel = Object.hasOwn(body, "model");
        const hasReasoning = Object.hasOwn(body, "reasoningLevel");
        if (!hasTitle && !hasModel && !hasReasoning) {
            return void res.status(400).json({
                detail: "title, model, or reasoningLevel is required",
            });
        }

        const title = typeof body.title === "string" ? body.title.trim() : "";
        if (hasTitle && !title) {
            return void res.status(400).json({ detail: "title is required" });
        }
        const parsedModel = parseOptionalModel(body.model);
        if (hasModel && !parsedModel.ok) {
            return void res.status(400).json({ detail: parsedModel.detail });
        }
        const parsedReasoning = parseOptionalReasoning(body.reasoningLevel);
        if (hasReasoning && !parsedReasoning.ok) {
            return void res
                .status(400)
                .json({ detail: parsedReasoning.detail });
        }

        const db = createServerSupabase();
        const gate = await ensureReviewChatWriteAccess(
            reviewId,
            chatId,
            userId,
            userEmail,
            db,
        );
        if (!gate.ok)
            return void res.status(gate.status).json({ detail: gate.detail });
        // Scoped by chat + review only — mirrors the delete above.
        const { data: chat, error: chatError } = await db
            .from("tabular_review_chats")
            .select("id, model")
            .eq("id", chatId)
            .eq("review_id", reviewId)
            .single();
        if (chatError || !chat) {
            return void res.status(404).json({ detail: "Chat not found" });
        }

        let selectedModel: string | undefined;
        if (hasModel) {
            const settings = await getUserModelSettings(userId, db);
            const resolution = await resolveEffectiveChatModel({
                requested: parsedModel.ok ? parsedModel.value : undefined,
                chatModel: chat.model,
                lastSelectedModel: settings.last_selected_chat_model,
                apiKeys: settings.api_keys,
                userId,
                db,
            });
            if (!resolution.ok) {
                return void res.status(resolution.status).json({
                    code: resolution.code,
                    detail: resolution.detail,
                });
            }
            selectedModel = resolution.model;
        }
        const selectedReasoningLevel =
            hasReasoning && parsedReasoning.ok
                ? parsedReasoning.value
                : undefined;
        const update = {
            ...(hasTitle ? { title: title.slice(0, 200) } : {}),
            ...(selectedModel ? { model: selectedModel } : {}),
            ...(selectedReasoningLevel
                ? { reasoning_level: selectedReasoningLevel }
                : {}),
            updated_at: new Date().toISOString(),
        };
        const { data, error } = await db
            .from("tabular_review_chats")
            .update(update)
            .eq("id", chatId)
            .eq("review_id", reviewId)
            .select("id, title, model, reasoning_level")
            .single();
        if (error || !data) {
            return void res.status(404).json({ detail: "Chat not found" });
        }

        if (selectedModel) {
            const profileError = await persistLastSelectedChatModel(
                userId,
                selectedModel,
                db,
            );
            if (profileError) return void sendInternalError(res, profileError);
        }
        if (selectedReasoningLevel) {
            const profileError = await persistLastSelectedReasoningLevel(
                userId,
                selectedReasoningLevel,
                db,
            );
            if (profileError) return void sendInternalError(res, profileError);
        }
        res.json(data);
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
            .select("id, user_id, project_id, org_id")
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

function parseTabularCitations(text: string): TabularParsedCitation[] {
    const match = text.match(TABULAR_CITATIONS_BLOCK_RE);
    if (!match) return [];
    try {
        return JSON.parse(match[1]) as TabularParsedCitation[];
    } catch {
        return [];
    }
}

function extractTabularAnnotations(
    fullText: string,
    tabularStore: TabularCellStore,
) {
    return parseTabularCitations(fullText).map((c) => ({
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
tabularRouter.post("/:reviewId/chat", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const {
        messages,
        chat_id: existingChatId,
        review_title: clientReviewTitle,
        project_name: clientProjectName,
        model: rawModel,
        reasoning: rawReasoning,
    } = req.body as {
        messages: ChatMessage[];
        chat_id?: string;
        review_title?: string;
        project_name?: string;
        model?: unknown;
        reasoning?: unknown;
    };

    const parsedModel = parseOptionalModel(rawModel);
    if (!parsedModel.ok) {
        return void res.status(400).json({ detail: parsedModel.detail });
    }
    const parsedReasoning = parseOptionalReasoning(rawReasoning);
    if (!parsedReasoning.ok) {
        return void res.status(400).json({ detail: parsedReasoning.detail });
    }

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
    if (!reviewAccess.ok || !can(reviewAccess.projectRole, "content.edit"))
        return void res.status(404).json({ detail: "Review not found" });

    // Fetch all cells and logical review rows for this review.
    const { data: cells } = await db
        .from("tabular_cells")
        .select("*")
        .eq("review_id", reviewId);
    const rows = await loadReviewRows(db, reviewId);

    const sortedColumns = (
        (review.columns_config ?? []) as { index: number; name: string }[]
    ).sort((a, b) => a.index - b.index);

    const tabularStore: TabularCellStore = {
        columns: sortedColumns,
        documents: rows.map((row) => ({
            id: row.id,
            filename: row.label,
        })),
        cells: new Map(
            (cells ?? []).map((c: any) => [
                `${c.column_index}:${c.row_id}`,
                parseCellContent(c.content),
            ]),
        ),
    };

    // Create or verify chat record
    let chatId = existingChatId ?? null;
    let chatTitle: string | null = null;
    let chatModel: string | null = null;
    let chatReasoningLevel: string | null = null;
    const isFirstExchange =
        messages.filter((m) => m.role === "user").length === 1;

    if (chatId) {
        // The chat must belong to this exact review and to the requester.
        // Review access alone is not enough: otherwise a user could reuse one
        // of their chats from a different review in this route.
        const { data: existing } = await db
            .from("tabular_review_chats")
            .select("id, title, model, reasoning_level, review_id, user_id")
            .eq("id", chatId)
            .single();
        const canUse =
            !!existing &&
            existing.review_id === reviewId &&
            existing.user_id === userId;
        if (!canUse || !existing) chatId = null;
        else {
            chatTitle = existing.title;
            chatModel = existing.model;
            chatReasoningLevel = existing.reasoning_level;
        }
    }

    const modelSettings = await getUserModelSettings(userId, db);
    const modelResolution = await resolveEffectiveChatModel({
        requested: parsedModel.value,
        chatModel,
        lastSelectedModel: modelSettings.last_selected_chat_model,
        apiKeys: modelSettings.api_keys,
        userId,
        db,
    });
    if (!modelResolution.ok) {
        return void res.status(modelResolution.status).json({
            code: modelResolution.code,
            detail: modelResolution.detail,
        });
    }
    const selectedChatModel = modelResolution.model;
    const selectedReasoningLevel = resolveEffectiveReasoningLevel({
        model: selectedChatModel,
        requested: parsedReasoning.value,
        chatReasoningLevel,
        lastSelectedReasoningLevel: modelSettings.last_selected_reasoning_level,
    });
    const api_keys = modelSettings.api_keys;

    if (
        chatId &&
        (chatModel !== selectedChatModel ||
            chatReasoningLevel !== selectedReasoningLevel)
    ) {
        const { error: updateError } = await db
            .from("tabular_review_chats")
            .update({
                model: selectedChatModel,
                reasoning_level: selectedReasoningLevel,
                updated_at: new Date().toISOString(),
            })
            .eq("id", chatId)
            .eq("review_id", reviewId)
            .eq("user_id", userId);
        if (updateError) return void sendInternalError(res, updateError);
    }

    if (!chatId) {
        const { data: newChat, error: newChatError } = await db
            .from("tabular_review_chats")
            .insert({
                review_id: reviewId,
                user_id: userId,
                model: selectedChatModel,
                reasoning_level: selectedReasoningLevel,
            })
            .select("id, title")
            .single();
        if (newChatError || !newChat) {
            return void res
                .status(500)
                .json({ detail: "Failed to create chat" });
        }
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
    const streamAbort = new AbortController();
    let streamFinished = false;
    res.on("close", () => {
        if (!streamFinished) streamAbort.abort();
    });

    if (chatId) {
        write(`data: ${JSON.stringify({ type: "chat_id", chatId })}\n\n`);
    }

    try {
        const { fullText, events } = await runLLMStream({
            apiMessages,
            docStore: new Map(),
            docIndex: {},
            userId,
            db,
            write,
            extraTools: TABULAR_TOOLS,
            includeResearchTools: false,
            tabularStore,
            buildCitations: (text) =>
                extractTabularAnnotations(text, tabularStore),
            model: selectedChatModel,
            reasoning: selectedReasoningLevel,
            apiKeys: api_keys,
            signal: streamAbort.signal,
        });

        const persistedEvents = stripTransientAssistantEvents(events);
        const annotations = extractTabularAnnotations(fullText, tabularStore);

        if (chatId) {
            await db.from("tabular_review_chat_messages").insert({
                chat_id: chatId,
                role: "assistant",
                content: persistedEvents.length ? persistedEvents : null,
                annotations: annotations.length ? annotations : null,
            });
            await db
                .from("tabular_review_chats")
                .update({ updated_at: new Date().toISOString() })
                .eq("id", chatId);
        }

        // Generate title on first exchange
        if (chatId && isFirstExchange && !chatTitle && lastUser.content) {
            const title = await generateChatTitle(
                titleModelForChat(selectedChatModel, modelSettings.title_model),
                lastUser.content,
                {
                    reviewTitle: clientReviewTitle ?? review.title ?? null,
                    projectName: clientProjectName ?? null,
                },
                api_keys,
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
        if (isAbortError(err)) {
            console.log("[tabular/chat] client aborted stream", { chatId });
            if (chatId && err instanceof AssistantStreamError) {
                const partial = buildCancelledAssistantMessage({
                    fullText: err.fullText,
                    events: err.events,
                    buildCitations: (fullText) =>
                        extractTabularAnnotations(fullText, tabularStore),
                });
                const annotations = partial.citations;
                const { error: saveError } = await db
                    .from("tabular_review_chat_messages")
                    .insert({
                        chat_id: chatId,
                        role: "assistant",
                        content: partial.events.length ? partial.events : null,
                        annotations: annotations.length ? annotations : null,
                    });
                if (saveError) {
                    console.error(
                        "[tabular/chat] failed to save aborted stream",
                        saveError,
                    );
                }
                await db
                    .from("tabular_review_chats")
                    .update({ updated_at: new Date().toISOString() })
                    .eq("id", chatId);
            }
            return;
        }
        console.error("[tabular/chat] error", err);
        const message = ASSISTANT_ERROR_MESSAGE;
        const errorEvents =
            err instanceof AssistantStreamError
                ? stripTransientAssistantEvents(err.events)
                : [{ type: "error" as const, message }];
        const errorFullText =
            err instanceof AssistantStreamError ? err.fullText : "";
        if (chatId) {
            try {
                const annotations = extractTabularAnnotations(
                    errorFullText,
                    tabularStore,
                );
                const { error: saveError } = await db
                    .from("tabular_review_chat_messages")
                    .insert({
                        chat_id: chatId,
                        role: "assistant",
                        content: errorEvents.length ? errorEvents : null,
                        annotations: annotations.length ? annotations : null,
                    });
                if (saveError)
                    console.error(
                        "[tabular/chat] failed to save error",
                        saveError,
                    );
            } catch (saveErr) {
                console.error("[tabular/chat] failed to save error", saveErr);
            }
        }
        try {
            write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
            write("data: [DONE]\n\n");
        } catch {
            /* ignore */
        }
    } finally {
        streamFinished = true;
        res.end();
    }
});
