// Handlers for the DB queue. Every handler runs with at-least-once
// semantics: it must be idempotent, and it signals "retry me" by throwing.
//
// Registered kinds:
//   audit.chat_turn  — fan out one chat turn's audit rows (durable audit)
//   account.delete   — full account data erasure (survives restarts)
//   storage.cleanup  — delete storage objects/prefixes (no more swallowed
//                      fire-and-forget deletes leaking files)
//   export.build     — build a user data export and park it in storage
//   mcp.refresh_token        — renew an MCP OAuth access token before it
//                      expires, instead of on the request that needs it
//   document.precompute_text — extract a legacy Office file's text once, so
//                      read_document stops paying for LibreOffice per call

import {
    chatTurnAuditEvents,
    insertAuditEvent,
    recordAudit,
    type ChatTurnAuditBase,
} from "../audit";
import {
    deleteUserAccountData,
    listOrgsBlockingAccountDeletion,
} from "../userDataCleanup";
import {
    buildUserAccountExport,
    buildUserChatsExport,
    buildUserTabularReviewsExport,
    userExportFilename,
} from "../userDataExport";
import {
    AUDIT_CSV_FILENAME,
    buildAuditCsv,
    type AuditQuery,
} from "../auditExport";
import { ensureDocAccess } from "../access";
import {
    downloadFilenameForVersion,
    loadActiveVersion,
} from "../documentVersions";
import {
    deleteFile,
    downloadFile,
    extractedTextKey,
    listFiles,
    uploadFile,
} from "../storage";
import {
    McpOAuthRequiredError,
    loadOAuthToken,
    refreshOAuthAccessToken,
} from "../mcp/oauth";
import { requiresLibreOfficeTextExtraction } from "../documentTypes";
import { extractLegacyOfficeText } from "../chat/tools/documentOps";
import {
    runConversionJob,
    setDocumentTerminalStatus,
} from "../../workers/conversionWorker";
import {
    runExtractionJob,
    markExtractionFailed,
} from "../../workers/extractionWorker";
import { publishCellUpdate } from "../queue/runProgress";
import type { ConversionJobData } from "../queue/conversionQueue";
import type { ExtractionJobData } from "../queue/extractionQueue";
import { DB_JOB_FAILURE_HOOKS, NonRetryableJobError } from "./runner";
import type { Db, DbJob, DbJobHandlers } from "./types";

/** The export types a client may request; anything else is a 400 upstream. */
export const EXPORT_TYPES = [
    "account",
    "chats",
    "tabular-reviews",
    "audit-csv",
    "documents-zip",
] as const;
export type ExportType = (typeof EXPORT_TYPES)[number];

/** The whole-account JSON exports: one artifact per (user, type). */
const JSON_EXPORT_TYPES = ["account", "chats", "tabular-reviews"] as const;
type JsonExportType = (typeof JSON_EXPORT_TYPES)[number];

/**
 * Upper bound on a documents-zip selection. The zip is assembled in memory,
 * so an unbounded selection is an OOM waiting to happen; the route rejects
 * oversized requests with a 400 and the handler treats one that slipped
 * through as malformed rather than retrying it forever.
 */
export const MAX_ZIP_EXPORT_DOCUMENTS = 500;

export async function handleChatTurnAudit(db: Db, job: DbJob): Promise<void> {
    const base = job.payload.base as ChatTurnAuditBase | undefined;
    if (!base?.userId) return; // malformed payload — nothing to retry into
    const events = (job.payload.events as unknown[] | undefined) ?? [];
    // Throwing inserts: a transient DB error retries the job. A retry after
    // a partial fan-out can duplicate a row (at-least-once) — for an audit
    // trail a rare duplicate beats a silent gap.
    for (const event of chatTurnAuditEvents(base, events)) {
        await insertAuditEvent(db, event);
    }
}

export async function handleAccountDelete(db: Db, job: DbJob): Promise<void> {
    const userId = job.payload.userId as string | undefined;
    if (!userId) return;
    const userEmail = (job.payload.userEmail as string | undefined) ?? null;

    // REFUSAL BEFORE DESTRUCTION. The route already answered 409 for an
    // account that is the sole admin of an organization with members or
    // content, but the org can change between the request and this job, and
    // this handler is also reachable by requeueing an old row. Ask first,
    // while nothing has been touched.
    //
    // Non-retryable on purpose: an organization does not acquire a second
    // admin because we asked twenty more times over the next few hours. The
    // row lands in `failed` with the reason legible on the first attempt.
    const blockers = await listOrgsBlockingAccountDeletion(db, userId);
    if (blockers.length > 0) {
        throw new NonRetryableJobError(
            `Account is the only admin of ${blockers.length} organization(s) that still hold members or content: ${blockers
                .map((b) => `${b.org_id} (${b.reason})`)
                .join(", ")}`,
        );
    }

    // The whole cascade is deletes — idempotent by nature, so a crash midway
    // simply re-runs. The user's sessions were revoked by the route, so no new
    // data can appear underneath us.
    await deleteUserAccountData(db, userId, userEmail);

    // Erase the user's leftovers in the queue itself: export artifacts hold a
    // full copy of their data, and queued audit payloads hold titles/prompts.
    //
    // FILE BEFORE POINTER, and loudly. result.storage_path on these rows is
    // the only record of where the artifacts live, and the row purge below
    // destroys it. A swallowed storage failure here would let the purge
    // proceed and orphan a full copy of the user's data with nothing left
    // anywhere to retry the delete — so lookup and delete failures throw
    // instead: the job stays retryable (the route enqueues it with
    // maxAttempts 20) and the rows survive until their files are actually
    // gone. deleteUserAccountData already purged the exports/<userId>/
    // prefix with the same throwing semantics; this per-row pass covers
    // listings a storage backend serves stale.
    const { data: exportJobs, error: exportJobsError } = await db
        .from("db_jobs")
        .select("id, result")
        .eq("kind", "export.build")
        .filter("payload->>userId", "eq", userId);
    if (exportJobsError) {
        throw new Error(
            `Failed to load export jobs: ${exportJobsError.message}`,
        );
    }
    const exportRows = (exportJobs ?? []) as Pick<DbJob, "id" | "result">[];
    let artifactFailures = 0;
    for (const row of exportRows) {
        const path = row.result?.storage_path;
        if (typeof path === "string" && path.length > 0) {
            try {
                await deleteFile(path);
            } catch {
                artifactFailures += 1;
            }
        }
    }
    if (artifactFailures > 0) {
        throw new Error(
            `${artifactFailures}/${exportRows.length} export artifact deletes failed`,
        );
    }
    const purges = [
        await db
            .from("db_jobs")
            .delete()
            .filter("payload->>userId", "eq", userId)
            .neq("id", job.id),
        await db
            .from("db_jobs")
            .delete()
            .filter("payload->base->>userId", "eq", userId)
            .neq("id", job.id),
    ];
    for (const purge of purges) {
        if (purge.error) {
            throw new Error(
                `Failed to purge queue rows: ${purge.error.message}`,
            );
        }
    }

    // The auth user goes LAST, and only once every row above is gone.
    //
    // documents.user_id references auth.users ON DELETE SET NULL (an
    // organization's documents outlive the account that uploaded them), so
    // deleting the auth user first does not destroy this account's rows — it
    // ANONYMISES them. Every personal document would be left with a null
    // user_id and no org: matched by none of the `eq("user_id", userId)`
    // deletes above, listed nowhere, and still pointing at
    // `generated/<userId>/…` and `extracted-text/<versionId>.txt` objects
    // that nothing would ever sweep. Erasure that leaves the rows and the
    // files behind is not erasure — so the data goes first, by user_id, while
    // the user_id is still on it.
    //
    // Deleting it here also makes the job's retry budget mean something: while
    // this step is outstanding the account still exists, so a permanently
    // failed cascade leaves a recoverable account rather than a nameless pile
    // of rows. The user cannot use it in the meantime — the route revoked
    // their sessions before this job was ever picked up.
    const { error } = await db.auth.admin.deleteUser(userId);
    // "not found" is success: a previous attempt got this far before dying.
    if (error && !/not\s*found/i.test(error.message))
        throw new Error(`Failed to delete auth user: ${error.message}`);
}

export async function handleStorageCleanup(db: Db, job: DbJob): Promise<void> {
    const keys = (job.payload.keys as string[] | undefined) ?? [];
    const prefixes = (job.payload.prefixes as string[] | undefined) ?? [];

    const targets = new Set(keys.filter((k) => typeof k === "string" && k));
    for (const prefix of prefixes) {
        if (typeof prefix !== "string" || !prefix) continue;
        for (const key of await listFiles(prefix)) targets.add(key);
    }

    // Delete everything we can this attempt; throw at the end if anything
    // failed so the retry re-runs the (idempotent) remainder.
    let failures = 0;
    for (const key of targets) {
        try {
            await deleteFile(key);
        } catch {
            failures++;
        }
    }
    if (failures > 0) {
        throw new Error(
            `[storage.cleanup] ${failures}/${targets.size} deletes failed`,
        );
    }
}

/** One finished artifact, ready to park in storage. */
type ExportArtifact = {
    body: Buffer;
    filename: string;
    /** Stored on the object and replayed as the download's Content-Type. */
    contentType: string;
};

const JSON_EXPORT_AUDIT_ACTIONS: Record<JsonExportType, string> = {
    account: "export.account",
    chats: "export.chats",
    "tabular-reviews": "export.tabular",
};

async function buildJsonExport(
    db: Db,
    userId: string,
    userEmail: string | null,
    type: JsonExportType,
): Promise<ExportArtifact> {
    const data =
        type === "account"
            ? await buildUserAccountExport(db, userId, userEmail)
            : type === "chats"
              ? await buildUserChatsExport(db, userId, userEmail)
              : await buildUserTabularReviewsExport(db, userId, userEmail);
    return {
        body: Buffer.from(JSON.stringify(data, null, 2), "utf8"),
        filename: userExportFilename(type, userId),
        contentType: "application/json",
    };
}

async function buildAuditCsvExport(
    db: Db,
    job: DbJob,
    userId: string,
    userEmail: string | null,
): Promise<ExportArtifact> {
    // The route validated these params through parseQuery before enqueuing,
    // so a job without them is malformed rather than retryable.
    const query = job.payload.query as AuditQuery | undefined;
    if (!query || typeof query !== "object") {
        throw new Error(`[export.build] malformed payload on job ${job.id}`);
    }
    const csv = await buildAuditCsv(db, userId, userEmail ?? undefined, query);
    return {
        body: Buffer.from(csv, "utf8"),
        filename: AUDIT_CSV_FILENAME,
        contentType: "text/csv; charset=utf-8",
    };
}

async function buildDocumentsZipExport(
    db: Db,
    job: DbJob,
    userId: string,
    userEmail: string | null,
): Promise<ExportArtifact> {
    const documentIds = job.payload.document_ids as unknown;
    if (
        !Array.isArray(documentIds) ||
        documentIds.length === 0 ||
        documentIds.length > MAX_ZIP_EXPORT_DOCUMENTS ||
        documentIds.some((id) => typeof id !== "string" || !id)
    ) {
        throw new Error(`[export.build] malformed payload on job ${job.id}`);
    }

    // org_id and workflow_id are part of the verdict, not decoration:
    // ensureDocAccess resolves a workflow asset through its workflow and an
    // org document through its org. Selecting only project_id/user_id made
    // both branches unreachable, so an org colleague's document and every
    // detached document were silently dropped from the zip. The sync route
    // (documents.ts) already selects the full set.
    const { data: rawDocs, error } = await db
        .from("documents")
        .select("id, current_version_id, user_id, project_id, org_id, workflow_id")
        .in("id", documentIds as string[]);
    if (error) throw new Error(`[export.build] ${error.message}`);

    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    let added = 0;
    for (const doc of (rawDocs ?? []) as {
        id: string;
        user_id: string;
        project_id: string | null;
        org_id?: string | null;
        workflow_id?: string | null;
    }[]) {
        // Access is re-checked HERE, not at enqueue time: the payload's ids
        // are stale by definition (a share can be revoked while the job
        // waits), so a doc the user can no longer read is skipped.
        const access = await ensureDocAccess(doc, userId, userEmail, db);
        if (!access.ok) continue;
        const active = await loadActiveVersion(doc.id, db);
        if (!active) continue;
        const raw = await downloadFile(active.storage_path);
        if (!raw) continue;
        // Sequential, unlike the sync route's Promise.all: this path exists
        // for selections large enough that fetching every file at once is
        // what would blow the memory ceiling.
        zip.file(
            downloadFilenameForVersion(
                active.filename,
                active.version_number,
                active.source === "assistant_edit",
            ),
            Buffer.from(raw),
        );
        added++;
    }
    if (added === 0) {
        throw new Error(
            `[export.build] no accessible documents for job ${job.id}`,
        );
    }

    return {
        body: await zip.generateAsync({
            type: "nodebuffer",
            compression: "DEFLATE",
        }),
        filename: "documents.zip",
        contentType: "application/zip",
    };
}

export async function handleExportBuild(
    db: Db,
    job: DbJob,
): Promise<Record<string, unknown>> {
    const userId = job.payload.userId as string | undefined;
    const type = job.payload.type as ExportType | undefined;
    if (!userId || !type || !EXPORT_TYPES.includes(type)) {
        throw new Error(`[export.build] malformed payload on job ${job.id}`);
    }
    const userEmail = (job.payload.userEmail as string | undefined) ?? null;

    const artifact =
        type === "audit-csv"
            ? await buildAuditCsvExport(db, job, userId, userEmail)
            : type === "documents-zip"
              ? await buildDocumentsZipExport(db, job, userId, userEmail)
              : await buildJsonExport(db, userId, userEmail, type);

    // Path is namespaced under the user (account erasure purges the prefix)
    // and keyed by job id (a re-run overwrites its own artifact — idempotent).
    const storagePath = `exports/${userId}/${job.id}-${artifact.filename}`;
    const body = artifact.body;
    await uploadFile(
        storagePath,
        body.buffer.slice(
            body.byteOffset,
            body.byteOffset + body.byteLength,
        ) as ArrayBuffer,
        artifact.contentType,
    );

    // The completion audit row replaces the one the old sync route wrote.
    // The filtered exports have no such row: neither of their sync routes
    // recorded one, and inventing it here would change the history feed.
    if (type !== "audit-csv" && type !== "documents-zip") {
        await recordAudit(db, {
            userId,
            userEmail,
            action: JSON_EXPORT_AUDIT_ACTIONS[type],
            surface: "account",
        });
    }

    // No signed /download token here: that route only serves paths backed by
    // a live document_versions row, which an export artifact is not. The
    // client downloads through GET /user/exports/:id/download instead, which
    // re-checks ownership on every request and replays content_type.
    return {
        storage_path: storagePath,
        filename: artifact.filename,
        content_type: artifact.contentType,
    };
}

/**
 * Refresh an MCP OAuth access token that is about to expire.
 *
 * The lazy refresh in oauthBearerToken stays the last line of defense; this
 * job just moves the cost (and the failure) off the request that would
 * otherwise discover the expiry mid-tool-call.
 */
export const MCP_TOKEN_REFRESH_WINDOW_MS = 15 * 60 * 1000;

export async function handleMcpRefreshToken(
    db: Db,
    job: DbJob,
): Promise<void> {
    const connectorId = job.payload.connectorId as string | undefined;
    if (!connectorId) return; // malformed payload — nothing to retry into

    const token = await loadOAuthToken(connectorId, db);
    // The connector was disconnected (rows cascade-delete) or never held an
    // OAuth grant between the sweep and this run: nothing to refresh, and a
    // retry cannot bring the row back.
    if (!token?.encrypted_access_token || !token.encrypted_refresh_token) {
        return;
    }

    // Idempotency, and the whole point of re-checking here: a concurrent
    // request may already have taken the lazy-refresh path, or an earlier
    // attempt of this very job may have succeeded and then failed to report
    // it. A token that is no longer near expiry needs nothing.
    const expiresAt = token.expires_at ? Date.parse(token.expires_at) : null;
    if (!expiresAt || expiresAt > Date.now() + MCP_TOKEN_REFRESH_WINDOW_MS) {
        return;
    }

    try {
        // refreshOAuthAccessToken owns its own persistence (it upserts the
        // new token through storeOAuthToken), so there is nothing to write
        // here — reusing it is what keeps the two refresh paths identical.
        await refreshOAuthAccessToken(token, db);
    } catch (err) {
        // A dead grant (invalid_grant and friends) cannot be retried into
        // life: only the user reconnecting fixes it. Burning the attempt
        // budget replaying it would just spam the authorization server, so
        // swallow it and let the lazy path surface "reconnect" in the UI the
        // next time the user actually touches this connector.
        if (err instanceof McpOAuthRequiredError && err.permanent) {
            console.warn(
                "[mcp.refresh_token] permanent refresh failure; user must reconnect",
                { connectorId, oauthErrorCode: err.oauthErrorCode },
            );
            return;
        }
        // Everything else — transport errors, 5xx/429 from the authorization
        // server — is worth another attempt.
        throw err;
    }
}

/**
 * Precompute a legacy Office version's plain text into the read_document
 * cache.
 *
 * WHY: .doc and .ppt have no in-process reader, so read_document shells out
 * to LibreOffice on EVERY call — inside the chat tool call the user is
 * waiting on. Doing it once here, off the request path, turns that into a
 * single storage GET.
 *
 * Idempotent: the key is derived from the immutable version id, so a retry
 * overwrites its own object with identical bytes.
 */
export async function handleDocumentPrecomputeText(
    _db: Db,
    job: DbJob,
): Promise<void> {
    const versionId = job.payload.versionId as string | undefined;
    const storagePath = job.payload.storagePath as string | undefined;
    const fileType = job.payload.fileType as string | undefined;
    // Gate on the file type as well as the ids: this handler is the only
    // thing that would run LibreOffice off a queue payload, and a job for a
    // type that already has an in-process reader is a mistake, not work.
    if (
        !versionId ||
        !storagePath ||
        !requiresLibreOfficeTextExtraction(fileType)
    ) {
        return;
    }

    const raw = await downloadFile(storagePath);
    if (!raw) {
        // Storage may simply be lagging; a genuinely deleted source runs the
        // attempt budget out and then stops, which is the right end state.
        throw new Error(
            `[document.precompute_text] source unavailable: ${storagePath}`,
        );
    }
    const text = await extractLegacyOfficeText(raw);
    const body = Buffer.from(text, "utf8");
    await uploadFile(
        extractedTextKey(versionId),
        body.buffer.slice(
            body.byteOffset,
            body.byteOffset + body.byteLength,
        ) as ArrayBuffer,
        "text/plain; charset=utf-8",
    );
}

// Postgres-driver fallback for the two BullMQ-native workloads: the SAME
// job bodies (runConversionJob / runExtractionJob) run off db_jobs rows when
// no Redis is configured. Their retry budget and dedupe identity match the
// BullMQ path (set at enqueue time in lib/queue/*Queue.ts), and their
// domain-level permanent-failure semantics are reproduced by the failure
// hooks below — the generic state machine only knows about db_jobs rows.

export async function handleConversionConvert(
    db: Db,
    job: DbJob,
): Promise<void> {
    await runConversionJob(job.payload as unknown as ConversionJobData, db);
}

export async function handleExtractionExtract(
    db: Db,
    job: DbJob,
): Promise<void> {
    // publishCellUpdate no-ops without Redis; the SSE views' DB-poll
    // backstops carry progress in this mode.
    await runExtractionJob(job.payload as unknown as ExtractionJobData, {
        db,
        publish: publishCellUpdate,
    });
}

DB_JOB_FAILURE_HOOKS["conversion.convert"] = async (db, job) => {
    const data = job.payload as unknown as ConversionJobData;
    // Mirrors the BullMQ worker's permanent-failure handler: only the
    // initial-upload flow (finalize) has a document parked "processing" with
    // no path forward; version flows keep a healthy document untouched.
    if (data.finalizeDocumentStatus === false) return;
    await setDocumentTerminalStatus(db, data.documentId, "error");
};

DB_JOB_FAILURE_HOOKS["extraction.extract"] = async (db, job) => {
    await markExtractionFailed(job.payload as unknown as ExtractionJobData, {
        db,
        publish: publishCellUpdate,
    });
};

export const DB_JOB_HANDLERS: DbJobHandlers = {
    "audit.chat_turn": handleChatTurnAudit,
    "account.delete": handleAccountDelete,
    "storage.cleanup": handleStorageCleanup,
    "export.build": handleExportBuild,
    "conversion.convert": handleConversionConvert,
    "extraction.extract": handleExtractionExtract,
    "mcp.refresh_token": handleMcpRefreshToken,
    "document.precompute_text": handleDocumentPrecomputeText,
};
