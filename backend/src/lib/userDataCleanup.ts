import { createServerSupabase } from "./supabase";
import { deleteFile, extractedTextKey, listFiles } from "./storage";
import { enqueueStorageCleanup } from "./dbq/enqueue";
import { NonRetryableJobError } from "./dbq/runner";
import { removeGrantsForEmail } from "./projectAccess";
import { removeContentGrantsForEmail } from "./contentAccess";
import { ORG_CONTENT_TABLES } from "./orgs";

type Db = ReturnType<typeof createServerSupabase>;

const DELETE_BATCH_SIZE = 500;

function uniqueStrings(values: Array<string | null | undefined>): string[] {
    return [...new Set(values.filter((value): value is string => !!value))];
}

function chunks<T>(values: T[], size = DELETE_BATCH_SIZE): T[][] {
    const result: T[][] = [];
    for (let i = 0; i < values.length; i += size) {
        result.push(values.slice(i, i + size));
    }
    return result;
}

async function throwIfError<T extends { message?: string } | null>(
    error: T,
    context: string,
) {
    if (error) throw new Error(`${context}: ${error.message ?? "unknown error"}`);
}

async function deleteByIds(db: Db, table: string, ids: string[]) {
    for (const batch of chunks(ids)) {
        const { error } = await (db as any).from(table).delete().in("id", batch);
        await throwIfError(error, `Failed to delete ${table}`);
    }
}

async function deleteWhereIn(
    db: Db,
    table: string,
    column: string,
    values: string[],
) {
    for (const batch of chunks(values)) {
        const { error } = await (db as any)
            .from(table)
            .delete()
            .in(column, batch);
        await throwIfError(error, `Failed to delete ${table}`);
    }
}

/**
 * Split the projects a user created into the personal ones (destroyed on
 * account deletion) and the organization ones (kept, and detached).
 */
async function partitionOwnedProjects(
    db: Db,
    userId: string,
): Promise<{ personal: string[]; org: string[] }> {
    const { data, error } = await db
        .from("projects")
        .select("id, org_id")
        .eq("user_id", userId);
    await throwIfError(error, "Failed to load user projects");
    const rows = (data ?? []) as { id: string | null; org_id?: string | null }[];
    return {
        personal: uniqueStrings(
            rows.filter((row) => !row.org_id).map((row) => row.id),
        ),
        org: uniqueStrings(rows.filter((row) => !!row.org_id).map((row) => row.id)),
    };
}

/** The project-tree tables that carry both a `user_id` and a `project_id`. */
const PROJECT_CONTENT_TABLES = [
    "documents",
    "chats",
    "tabular_reviews",
    "project_subfolders",
] as const;

/**
 * Does this organization still directly own anything?
 *
 * The inventory lives in lib/orgs.ts so this and the `deleteOrg` API path
 * answer the identical question. Every org_id foreign key is ON DELETE
 * RESTRICT, so an org that owns content cannot be deleted at all — the probe
 * is how we say so deliberately instead of surfacing a constraint violation.
 */
async function orgOwnsContent(db: Db, orgId: string): Promise<boolean> {
    for (const table of ORG_CONTENT_TABLES) {
        const { data, error } = await (db as any)
            .from(table)
            .select("id")
            .eq("org_id", orgId)
            .limit(1);
        // A transient read error must never read as "this org holds nothing":
        // that is the difference between tidying up and deleting a firm.
        await throwIfError(error, `Failed to load org ${table}`);
        if (((data ?? []) as unknown[]).length > 0) return true;
    }
    return false;
}

/**
 * Every organization-owned project this user left content in — including
 * projects somebody else created.
 *
 * The distinction matters more than it looks. A departing associate's
 * uploads mostly live in matters a partner opened, so scoping retention to
 * "org projects this user created" keeps the container and deletes the
 * contents: the firm is left with an empty matter and no idea what used to
 * be in it. What the organization owns is the project, and therefore
 * everything inside it, whoever happened to put it there.
 */
async function orgProjectIdsHoldingUserContent(
    db: Db,
    userId: string,
): Promise<string[]> {
    const results = await Promise.all(
        PROJECT_CONTENT_TABLES.map((table) =>
            (db as any)
                .from(table)
                .select("project_id")
                .eq("user_id", userId)
                .not("project_id", "is", null),
        ),
    );

    const candidateIds: string[] = [];
    for (const [index, result] of results.entries()) {
        await throwIfError(
            result.error,
            `Failed to load ${PROJECT_CONTENT_TABLES[index]} projects`,
        );
        candidateIds.push(
            ...uniqueStrings(
                ((result.data ?? []) as { project_id: string | null }[]).map(
                    (row) => row.project_id,
                ),
            ),
        );
    }

    const unique = uniqueStrings(candidateIds);
    if (unique.length === 0) return [];

    const orgProjectIds: string[] = [];
    for (const batch of chunks(unique)) {
        const { data, error } = await db
            .from("projects")
            .select("id, org_id")
            .in("id", batch);
        await throwIfError(error, "Failed to classify projects holding content");
        orgProjectIds.push(
            ...uniqueStrings(
                (
                    (data ?? []) as {
                        id: string | null;
                        org_id?: string | null;
                    }[]
                )
                    .filter((row) => !!row.org_id)
                    .map((row) => row.id),
            ),
        );
    }
    return uniqueStrings(orgProjectIds);
}

/**
 * Documents that must go when this account is erased: the ones they uploaded
 * plus everything sitting in a personal project of theirs — MINUS anything
 * the organization owns, which stays behind.
 *
 * A document is the organization's if it lives in an org project or carries
 * an `org_id` of its own (org-tagged documents can sit outside any project).
 */
async function getDocumentIdsForAccountDeletion(
    db: Db,
    userId: string,
    personalProjectIds: string[],
    orgProjectIds: string[],
): Promise<string[]> {
    const [ownedDocs, projectDocs, orgProjectDocs] = await Promise.all([
        db.from("documents").select("id, org_id, workflow_id").eq("user_id", userId),
        personalProjectIds.length > 0
            ? db
                  .from("documents")
                  .select("id, org_id, workflow_id")
                  .in("project_id", personalProjectIds)
            : Promise.resolve({ data: [], error: null }),
        orgProjectIds.length > 0
            ? db
                  .from("documents")
                  .select("id, org_id")
                  .in("project_id", orgProjectIds)
            : Promise.resolve({ data: [], error: null }),
    ]);

    await throwIfError(ownedDocs.error, "Failed to load user documents");
    await throwIfError(projectDocs.error, "Failed to load project documents");
    await throwIfError(
        orgProjectDocs.error,
        "Failed to load organization project documents",
    );

    type DocRow = {
        id: string | null;
        org_id?: string | null;
        workflow_id?: string | null;
    };
    const candidates = [
        ...((ownedDocs.data ?? []) as DocRow[]),
        ...((projectDocs.data ?? []) as DocRow[]),
    ];

    // A workflow asset (documents.workflow_id) belongs to its workflow. When
    // the workflow is organization-owned it survives this deletion, and an
    // asset stripped from a surviving workflow is a workflow that silently
    // stopped working — so those documents are kept (and detached) too.
    const workflowIds = uniqueStrings(
        candidates.map((row) => row.workflow_id ?? null),
    );
    const survivingWorkflowIds = new Set<string>();
    for (const batch of chunks(workflowIds)) {
        const { data: workflowRows, error: workflowError } = await db
            .from("workflows")
            .select("id, org_id")
            .in("id", batch);
        await throwIfError(workflowError, "Failed to classify workflows");
        for (const row of (workflowRows ?? []) as {
            id: string | null;
            org_id?: string | null;
        }[]) {
            if (row.id && row.org_id) survivingWorkflowIds.add(row.id);
        }
    }

    const keep = new Set([
        ...uniqueStrings(
            ((orgProjectDocs.data ?? []) as DocRow[]).map((row) => row.id),
        ),
        ...uniqueStrings(
            candidates.filter((row) => !!row.org_id).map((row) => row.id),
        ),
        ...uniqueStrings(
            candidates
                .filter(
                    (row) =>
                        !!row.workflow_id &&
                        survivingWorkflowIds.has(row.workflow_id),
                )
                .map((row) => row.id),
        ),
    ]);

    return uniqueStrings(candidates.map((row) => row.id)).filter(
        (id) => !keep.has(id),
    );
}

/**
 * Re-anchor the content the departing user left inside organization projects.
 * Their rows survive with `user_id = NULL` — the content belongs to the
 * organization, and its FKs are ON DELETE SET NULL so the auth.users cascade
 * that follows this cleanup will not take them.
 */
async function detachOrgProjectContent(
    db: Db,
    userId: string,
    orgProjectIds: string[],
) {
    if (orgProjectIds.length > 0) {
        for (const table of PROJECT_CONTENT_TABLES) {
            for (const batch of chunks(orgProjectIds)) {
                const { error } = await (db as any)
                    .from(table)
                    .update({ user_id: null })
                    .eq("user_id", userId)
                    .in("project_id", batch);
                await throwIfError(error, `Failed to detach ${table}`);
            }
        }
        // Only the projects this user actually created change hands. The set
        // above deliberately includes colleagues' projects — that is how
        // their content gets kept — and blanking `user_id` there would erase
        // a living colleague's authorship of a project they still own.
        for (const batch of chunks(orgProjectIds)) {
            const { error } = await db
                .from("projects")
                .update({ user_id: null })
                .eq("user_id", userId)
                .in("id", batch);
            await throwIfError(error, "Failed to detach organization projects");
        }
    }

    // Org-tagged content that sits outside any project still belongs to the
    // organization; `org_id` is the whole claim.
    for (const table of ["documents", "tabular_reviews"] as const) {
        const { error } = await (db as any)
            .from(table)
            .update({ user_id: null })
            .eq("user_id", userId)
            .not("org_id", "is", null);
        await throwIfError(error, `Failed to detach organization ${table}`);
    }

    // A firm's shared workflows are not the personal property of whoever
    // first drafted them.
    const { error: workflowError } = await db
        .from("workflows")
        .update({ user_id: null })
        .eq("user_id", userId)
        .not("org_id", "is", null);
    await throwIfError(workflowError, "Failed to detach organization workflows");

    await detachChildrenOfSurvivingContent(db, userId);
}

/**
 * Two kinds of row hang off content that has just been handed to an
 * organization and carry a `user_id` of their own: the chat threads attached
 * to a review, and the asset documents attached to a workflow
 * (documents.workflow_id). Their parent FKs already cascade, so keeping the
 * parent while cascading the child away would leave a review nobody appears
 * to have worked on and a workflow whose assets have silently vanished.
 */
async function detachChildrenOfSurvivingContent(db: Db, userId: string) {
    const pairs = [
        {
            table: "tabular_review_chats",
            fk: "review_id",
            parent: "tabular_reviews",
            label: "review chats",
        },
        {
            // Workflow assets are `documents` rows with a workflow_id since
            // 20260901_03 folded workflow_reference_documents away.
            table: "documents",
            fk: "workflow_id",
            parent: "workflows",
            label: "workflow assets",
        },
    ] as const;

    for (const { table, fk, parent, label } of pairs) {
        const { data, error } = await (db as any)
            .from(table)
            .select(fk)
            .eq("user_id", userId);
        await throwIfError(error, `Failed to load ${label}`);

        const parentIds = uniqueStrings(
            ((data ?? []) as Record<string, string | null>[]).map(
                (row) => row[fk],
            ),
        );
        if (parentIds.length === 0) continue;

        // A parent survives when it is org-owned — either detached moments
        // ago (user_id now null) or created by somebody still present.
        const survivors: string[] = [];
        for (const batch of chunks(parentIds)) {
            const { data: parents, error: parentError } = await (db as any)
                .from(parent)
                .select("id, org_id")
                .in("id", batch);
            await throwIfError(parentError, `Failed to classify ${label}`);
            survivors.push(
                ...uniqueStrings(
                    (
                        (parents ?? []) as {
                            id: string | null;
                            org_id?: string | null;
                        }[]
                    )
                        .filter((row) => !!row.org_id)
                        .map((row) => row.id),
                ),
            );
        }
        if (survivors.length === 0) continue;

        for (const batch of chunks(uniqueStrings(survivors))) {
            const { error: detachError } = await (db as any)
                .from(table)
                .update({ user_id: null })
                .eq("user_id", userId)
                .in(fk, batch);
            await throwIfError(detachError, `Failed to detach ${label}`);
        }
    }
}

// Storage bytes and the rows that point at them must die in a strict
// order: rows first, bytes second. These two halves used to be one
// function that ran BEFORE any row was deleted, which put the whole
// cleanup in the wrong order — none of it is transactional, so a failure
// after the files were gone left a live account (or a live project) full
// of documents whose every version 404s. Failing the other way round is
// recoverable: rows gone, bytes still there, and the bytes are exactly
// what the claim-filtered orphan sweep exists to reclaim.
//
// The paths must still be COLLECTED before the rows go —
// document_versions cascades away with its documents row, taking the
// only record of what to delete with it.
async function collectDocumentVersionPaths(
    db: Db,
    documentIds: string[],
): Promise<string[]> {
    const paths = new Set<string>();

    for (const batch of chunks(documentIds)) {
        const { data, error } = await db
            .from("document_versions")
            .select("id, storage_path, pdf_storage_path")
            .in("document_id", batch);
        await throwIfError(error, "Failed to load document storage paths");

        for (const version of data ?? []) {
            // The extracted-text cache is keyed by version id and lives
            // outside the per-user storage prefixes, so nothing else would
            // ever enumerate it. Deleting an object that was never written is
            // a no-op, so this is unconditional rather than type-gated.
            if (typeof version.id === "string" && version.id.length > 0) {
                paths.add(extractedTextKey(version.id));
            }
            if (
                typeof version.storage_path === "string" &&
                version.storage_path.length > 0
            ) {
                paths.add(version.storage_path);
            }
            if (
                typeof version.pdf_storage_path === "string" &&
                version.pdf_storage_path.length > 0
            ) {
                paths.add(version.pdf_storage_path);
            }
        }
    }

    return [...paths];
}

// Best-effort by design: the rows are already gone by the time this runs,
// so a failed removal must not abort the surrounding cleanup — it would
// strand the caller in a worse state (rows half-deleted, account kept)
// than the orphaned bytes it was trying to avoid.
async function deleteStorageFiles(paths: string[]) {
    await Promise.all(paths.map((path) => deleteFile(path).catch(() => {})));
}

/**
 * Which of these storage keys is still spoken for by a surviving database row.
 *
 * Storage keys are namespaced by the *uploader*, not by the owner:
 * `documents/{uploaderId}/{documentId}/…`. Once an organization keeps a
 * departing user's uploads, "everything under this user's prefix" and
 * "everything this account is losing" stop being the same set of bytes, and
 * the only authority on which is which is the rows themselves.
 */
async function claimedStoragePaths(
    db: Db,
    paths: string[],
): Promise<Set<string>> {
    const claimed = new Set<string>();
    const claim = (value: unknown) => {
        if (typeof value === "string" && paths.includes(value))
            claimed.add(value);
    };

    for (const batch of chunks(paths)) {
        // Workflow-asset files are claimed through document_versions too:
        // 20260901_03 gave every legacy reference file a version row carrying
        // its original workflow-references/ storage path.
        const [versions, pdfVersions] = await Promise.all([
            db
                .from("document_versions")
                .select("storage_path, pdf_storage_path")
                .in("storage_path", batch),
            db
                .from("document_versions")
                .select("storage_path, pdf_storage_path")
                .in("pdf_storage_path", batch),
        ]);
        await throwIfError(versions.error, "Failed to classify stored versions");
        await throwIfError(
            pdfVersions.error,
            "Failed to classify stored version PDFs",
        );

        for (const row of [
            ...((versions.data ?? []) as Record<string, unknown>[]),
            ...((pdfVersions.data ?? []) as Record<string, unknown>[]),
        ]) {
            claim(row.storage_path);
            claim(row.pdf_storage_path);
        }
    }

    return claimed;
}

/**
 * Sweep whatever is left under the departing user's storage prefixes — but
 * only the objects that nothing in the database still points at.
 *
 * This used to delete the prefixes wholesale, which was correct only while
 * "the uploader's account is gone" implied "the uploaded rows are gone". It
 * no longer does: an organization keeps the documents and workflow references
 * its departing member created, and those rows still address bytes filed
 * under that member's id. Deleting the prefix left the firm holding a
 * document row whose every version pointed at a 404.
 *
 * MUST run after the row deletions, so "a row still claims this key" is
 * simply a question the database can answer.
 */
async function deleteOrphanedUserStorage(db: Db, userId: string) {
    try {
        const paths = [
            ...new Set([
                ...(await listFiles(`documents/${userId}/`)),
                ...(await listFiles(`workflow-references/${userId}/`)),
            ]),
        ];
        if (paths.length === 0) return;

        const claimed = await claimedStoragePaths(db, paths);
        await Promise.all(
            paths
                .filter((path) => !claimed.has(path))
                .map((path) => deleteFile(path).catch(() => {})),
        );
    } catch {
        // Version-linked objects are deleted above. Prefix cleanup is best-effort
        // for orphaned files left behind by interrupted uploads.
    }
}

/**
 * Purge the account's export artifacts (`exports/<userId>/…`). Each object
 * here is a complete copy of the account's data, and once account deletion
 * purges the user's db_jobs rows this listing is the last enumeration of
 * those objects anywhere. So unlike the orphan sweep above, failures MUST
 * propagate: the caller is a durable job (or the route's inline fallback,
 * which surfaces a 5xx) and a retry re-runs this with the listing intact.
 * Swallowing here would let erasure report success while a full export of
 * the user's data survives with nothing left pointing at it.
 */
async function deleteUserExportArtifacts(userId: string) {
    let paths: string[];
    try {
        paths = await listFiles(`exports/${userId}/`);
    } catch (err) {
        throw new Error(
            `Failed to list export artifacts: ${
                err instanceof Error ? err.message : "unknown error"
            }`,
        );
    }
    let failures = 0;
    for (const path of paths) {
        try {
            await deleteFile(path);
        } catch {
            failures += 1;
        }
    }
    if (failures > 0) {
        throw new Error(
            `Failed to delete ${failures}/${paths.length} export artifacts`,
        );
    }
}

/** One organization that stands between a user and deleting their account. */
export type AccountDeletionOrgBlocker = {
    org_id: string;
    name: string;
    /**
     * "members" — other people are still in the org and would be left with
     * nobody able to administer it (or, worse, with an arbitrary successor).
     * "content" — nobody else is left, but the org still owns matters, so it
     * cannot be deleted either.
     */
    reason: "members" | "content";
};

/**
 * The organizations that make this account undeletable, and why.
 *
 * PRODUCT DECISION: an account that is the SOLE ADMIN of an organization
 * which still has other members, or still owns content, cannot be deleted.
 * The user must appoint another admin or delete the organization first.
 *
 * Both of the alternatives were implemented here before, and both were wrong:
 *
 *  - Auto-promoting "the earliest remaining member" hands a firm's matters to
 *    whoever happened to join first, with no audit row and no consent. Worse,
 *    the cleanup_org_admin_access_overrides trigger then deletes that
 *    member's `deny` overrides — so a person deliberately walled off from a
 *    matter becomes its owner as a side effect of somebody else closing their
 *    account.
 *  - Leaving the membership row "for the auth.users cascade" produced an
 *    organization with zero members: invisible in every listing, undeletable
 *    (its content FKs are ON DELETE RESTRICT), and holding content nobody can
 *    reach. In practice the cascade did not even get that far — the
 *    org_member_protect_resource_ownership trigger refuses to remove a member
 *    who still owns the org's projects, so the durable account.delete job
 *    failed forever while the user, whose sessions were revoked and who had
 *    been sent to the login page, could simply log back in.
 *
 * Refusing up front is the only outcome that leaves the database, the
 * organization and the user in a state each of them agrees with.
 */
export async function listOrgsBlockingAccountDeletion(
    db: Db,
    userId: string,
): Promise<AccountDeletionOrgBlocker[]> {
    const { data: memberships, error: membershipError } = await db
        .from("org_members")
        .select("id, org_id, role")
        .eq("user_id", userId);
    await throwIfError(membershipError, "Failed to load org memberships");

    const blockers: AccountDeletionOrgBlocker[] = [];
    for (const m of (memberships ?? []) as {
        id: string;
        org_id: string;
        role: string;
    }[]) {
        if (m.role !== "admin") continue;

        const { data: otherAdmins, error: otherAdminsError } = await db
            .from("org_members")
            .select("id")
            .eq("org_id", m.org_id)
            .eq("role", "admin")
            .neq("id", m.id)
            .limit(1);
        await throwIfError(otherAdminsError, "Failed to load org admins");
        // Somebody else can administer it: leaving is unremarkable.
        if (((otherAdmins ?? []) as unknown[]).length > 0) continue;

        const { data: otherMembers, error: otherMembersError } = await db
            .from("org_members")
            .select("id")
            .eq("org_id", m.org_id)
            .neq("id", m.id)
            .limit(1);
        await throwIfError(
            otherMembersError,
            "Failed to load remaining org members",
        );
        const hasOtherMembers = ((otherMembers ?? []) as unknown[]).length > 0;
        if (!hasOtherMembers && !(await orgOwnsContent(db, m.org_id))) {
            // Nobody and nothing left: deleteUserOrganizations deletes the
            // whole org, so this one blocks nothing.
            continue;
        }

        const { data: org, error: orgError } = await db
            .from("organizations")
            .select("id, name")
            .eq("id", m.org_id)
            .maybeSingle();
        await throwIfError(orgError, "Failed to load organization");
        blockers.push({
            org_id: m.org_id,
            name:
                typeof (org as { name?: unknown } | null)?.name === "string"
                    ? ((org as { name: string }).name)
                    : "your organization",
            reason: hasOtherMembers ? "members" : "content",
        });
    }
    return blockers;
}

/**
 * Tear down a user's organization footprint on account deletion.
 *
 * An organization is a durable owner in its own right, not an extension of
 * whoever happened to create it, so this NEVER deletes an org that still has
 * people or content in it:
 *
 *  - The departing user's membership row is removed.
 *  - A sole admin whose org still has members or content is REFUSED — see
 *    listOrgsBlockingAccountDeletion for why neither auto-promotion nor
 *    "leave it to the cascade" is an acceptable alternative. The route
 *    answers 409 long before this runs, and deleteUserAccountData re-asks
 *    the same question as its FIRST act, before a single row is destroyed.
 *    The throw here is the last line of defence for a caller that reached
 *    this function on its own, so by the time it fires the caller's content
 *    is already gone — which is exactly why the check above it exists.
 *  - An org left with no members and no content at all is deleted, which is
 *    what closing a personal workspace should do.
 *  - Any invitations the user sent lose their inviter reference through the
 *    FK's ON DELETE SET NULL; invitations addressed TO them are cancelled.
 */
export async function deleteUserOrganizations(
    db: Db,
    userId: string,
    userEmail?: string | null,
) {
    const { data: memberships, error: membershipError } = await db
        .from("org_members")
        .select("id, org_id, role")
        .eq("user_id", userId);
    await throwIfError(membershipError, "Failed to load org memberships");

    for (const m of (memberships ?? []) as {
        id: string;
        org_id: string;
        role: string;
    }[]) {
        if (m.role === "admin") {
            const { data: otherAdmins, error: otherAdminsError } = await db
                .from("org_members")
                .select("id")
                .eq("org_id", m.org_id)
                .eq("role", "admin")
                .neq("id", m.id)
                .limit(1);
            await throwIfError(otherAdminsError, "Failed to load org admins");
            if (((otherAdmins ?? []) as unknown[]).length === 0) {
                const { data: otherMembers, error: otherMembersError } =
                    await db
                        .from("org_members")
                        .select("id")
                        .eq("org_id", m.org_id)
                        .neq("id", m.id)
                        .limit(1);
                await throwIfError(
                    otherMembersError,
                    "Failed to load remaining org members",
                );
                const hasOtherMembers =
                    ((otherMembers ?? []) as unknown[]).length > 0;

                if (hasOtherMembers || (await orgOwnsContent(db, m.org_id))) {
                    // Unreachable through the API — routes/user.ts refuses
                    // this account with a 409 before enqueueing anything, and
                    // deleteUserAccountData re-checks before it destroys a
                    // single row. Reaching it means the org changed underneath
                    // a request that was already in flight, so stop here
                    // rather than improvise a successor.
                    //
                    // NonRetryableJobError, not Error: an organization does
                    // not acquire a second admin because the queue asked
                    // twenty more times over the next few hours. A plain
                    // Error burned the whole retry budget re-deriving the
                    // same refusal and buried the reason under the repeats.
                    throw new NonRetryableJobError(
                        `Cannot delete this account while it is the only admin of organization ${m.org_id}`,
                    );
                }

                // Nobody and nothing left: the org goes with the account, and
                // the ON DELETE CASCADE from organizations takes the
                // membership row with it.
                await deleteByIds(db, "organizations", [m.org_id]);
                continue;
            }
        }

        const { error: deleteError } = await db
            .from("org_members")
            .delete()
            .eq("id", m.id);
        await throwIfError(deleteError, "Failed to remove org membership");
    }

    const normalizedEmail = userEmail?.trim().toLowerCase();
    if (normalizedEmail) {
        const { error: inviteError } = await db
            .from("org_invitations")
            .update({
                status: "cancelled",
                cancelled_at: new Date().toISOString(),
            })
            .eq("email", normalizedEmail)
            .eq("status", "pending");
        await throwIfError(inviteError, "Failed to cancel org invitations");
    }
}

export async function deleteAllUserChats(db: Db, userId: string) {
    const [assistantChats, tabularChats, wordDocuments] = await Promise.all([
        db.from("chats").delete().eq("user_id", userId),
        db.from("tabular_review_chats").delete().eq("user_id", userId),
        db.from("word_documents").delete().eq("user_id", userId),
    ]);

    await throwIfError(assistantChats.error, "Failed to delete assistant chats");
    await throwIfError(tabularChats.error, "Failed to delete tabular chats");
    await throwIfError(wordDocuments.error, "Failed to delete Word chats");
}

export async function deleteAllUserTabularReviews(db: Db, userId: string) {
    const { data: reviews, error: reviewsError } = await db
        .from("tabular_reviews")
        .select("id")
        .eq("user_id", userId);
    await throwIfError(reviewsError, "Failed to load tabular reviews");

    const reviewIds = uniqueStrings(
        ((reviews ?? []) as { id: string | null }[]).map((row) => row.id),
    );
    if (reviewIds.length === 0) return 0;

    const { data: reviewChats, error: reviewChatsError } = await db
        .from("tabular_review_chats")
        .select("id")
        .in("review_id", reviewIds);
    await throwIfError(reviewChatsError, "Failed to load tabular review chats");

    const reviewChatIds = uniqueStrings(
        ((reviewChats ?? []) as { id: string | null }[]).map((row) => row.id),
    );

    await deleteWhereIn(
        db,
        "tabular_review_chat_messages",
        "chat_id",
        reviewChatIds,
    );
    await deleteWhereIn(db, "tabular_review_chats", "review_id", reviewIds);
    await deleteWhereIn(db, "tabular_cells", "review_id", reviewIds);
    await deleteByIds(db, "tabular_reviews", reviewIds);

    return reviewIds.length;
}

/**
 * Delete projects (and everything inside them) by id, with no ownership
 * filter. Callers must have authorised the delete themselves — routes do that
 * through the `container.delete` capability, and an organization project may
 * have no creator left to scope by anyway.
 */
export async function deleteProjectsByIds(db: Db, projectIds: string[]) {
    const ownedProjectIds = uniqueStrings(projectIds);
    if (ownedProjectIds.length === 0) return 0;

    const [projectDocs, projectChats, projectReviews, projectFolders] =
        await Promise.all([
            db.from("documents").select("id").in("project_id", ownedProjectIds),
            db.from("chats").select("id").in("project_id", ownedProjectIds),
            db
                .from("tabular_reviews")
                .select("id")
                .in("project_id", ownedProjectIds),
            db
                .from("project_subfolders")
                .select("id")
                .in("project_id", ownedProjectIds),
        ]);

    await throwIfError(projectDocs.error, "Failed to load project documents");
    await throwIfError(projectChats.error, "Failed to load project chats");
    await throwIfError(
        projectReviews.error,
        "Failed to load project tabular reviews",
    );
    await throwIfError(projectFolders.error, "Failed to load project folders");

    const documentIds = uniqueStrings(
        ((projectDocs.data ?? []) as { id: string | null }[]).map(
            (row) => row.id,
        ),
    );
    const chatIds = uniqueStrings(
        ((projectChats.data ?? []) as { id: string | null }[]).map(
            (row) => row.id,
        ),
    );
    const reviewIds = uniqueStrings(
        ((projectReviews.data ?? []) as { id: string | null }[]).map(
            (row) => row.id,
        ),
    );
    const folderIds = uniqueStrings(
        ((projectFolders.data ?? []) as { id: string | null }[]).map(
            (row) => row.id,
        ),
    );

    const { data: reviewChats, error: reviewChatsError } =
        reviewIds.length > 0
            ? await db
                  .from("tabular_review_chats")
                  .select("id")
                  .in("review_id", reviewIds)
            : { data: [], error: null };
    await throwIfError(reviewChatsError, "Failed to load project review chats");

    const reviewChatIds = uniqueStrings(
        ((reviewChats ?? []) as { id: string | null }[]).map((row) => row.id),
    );

    // Collect the storage keys BEFORE the version rows go away, but delete
    // the files AFTER the rows via the durable storage.cleanup job: if any
    // row delete below fails, no file has been touched; if the process dies
    // after them, the queued job still removes the files (the old inline
    // Promise.all died with the request and leaked on any storage error).
    const storagePaths = await collectDocumentVersionPaths(db, documentIds);
    await deleteWhereIn(
        db,
        "tabular_review_chat_messages",
        "chat_id",
        reviewChatIds,
    );
    await deleteWhereIn(db, "tabular_review_chats", "review_id", reviewIds);
    await deleteWhereIn(db, "tabular_cells", "review_id", reviewIds);
    await deleteByIds(db, "tabular_reviews", reviewIds);
    await deleteWhereIn(db, "chat_messages", "chat_id", chatIds);
    await deleteByIds(db, "chats", chatIds);
    await deleteByIds(db, "documents", documentIds);
    await deleteByIds(db, "project_subfolders", folderIds);
    await deleteByIds(db, "projects", ownedProjectIds);
    // Only now, with every row that pointed at them gone, do the bytes go.

    await enqueueStorageCleanup(db, storagePaths);

    return ownedProjectIds.length;
}

/**
 * Remove the projects a user created — but only the personal ones.
 *
 * A project that belongs to an organization is the organization's, not the
 * creator's: the firm's other admins are still administering it and its
 * matter documents are still live. Those projects are DETACHED instead
 * (user_id → NULL, which the nullable FK now permits) so they survive their
 * creator's departure with their contents intact. Only `org_id IS NULL`
 * projects — the genuinely personal ones — are destroyed.
 *
 * The return value counts destroyed projects, so a caller deleting a single
 * org project sees 0 and can report "nothing was removed" accurately.
 */
export async function deleteUserProjects(
    db: Db,
    userId: string,
    projectIds?: string[],
) {
    const requestedProjectIds = projectIds
        ? uniqueStrings(projectIds)
        : undefined;
    if (requestedProjectIds && requestedProjectIds.length === 0) return 0;

    let query = db.from("projects").select("id, org_id").eq("user_id", userId);
    if (requestedProjectIds) query = query.in("id", requestedProjectIds);

    const { data: projects, error: projectsError } = await query;
    await throwIfError(projectsError, "Failed to load user projects");

    const rows = (projects ?? []) as {
        id: string | null;
        org_id?: string | null;
    }[];
    const personalProjectIds = uniqueStrings(
        rows.filter((row) => !row.org_id).map((row) => row.id),
    );
    const orgProjectIds = uniqueStrings(
        rows.filter((row) => !!row.org_id).map((row) => row.id),
    );

    if (orgProjectIds.length > 0) {
        for (const batch of chunks(orgProjectIds)) {
            const { error } = await db
                .from("projects")
                .update({ user_id: null })
                .in("id", batch);
            await throwIfError(error, "Failed to detach organization projects");
        }
    }

    return deleteProjectsByIds(db, personalProjectIds);
}

export async function deleteUserAccountData(
    db: Db,
    userId: string,
    userEmail?: string | null,
) {
    // REFUSAL BEFORE DESTRUCTION — and this must be the first statement in
    // the function. The same question used to be asked by
    // deleteUserOrganizations at the very END of the cascade, by which point
    // the account's documents, storage objects and audit rows were already
    // gone: the refusal was real, but it arrived after the data it was meant
    // to protect had been destroyed, and the failed job could never undo it.
    // Ask while nothing has been touched, so a refusal costs nothing.
    const blockers = await listOrgsBlockingAccountDeletion(db, userId);
    if (blockers.length > 0) {
        throw new NonRetryableJobError(
            `Cannot delete this account while it is the only admin of ${blockers
                .map((blocker) => `${blocker.org_id} (${blocker.reason})`)
                .join(", ")}`,
        );
    }

    const { personal: personalProjectIds, org: createdOrgProjectIds } =
        await partitionOwnedProjects(db, userId);
    // Retention follows the organization's projects, not this user's. Their
    // own org projects must be kept AND detached; a colleague's org project
    // they contributed to must be kept without changing hands.
    const orgProjectIds = uniqueStrings([
        ...createdOrgProjectIds,
        ...(await orgProjectIdsHoldingUserContent(db, userId)),
    ]);
    const documentIds = await getDocumentIdsForAccountDeletion(
        db,
        userId,
        personalProjectIds,
        orgProjectIds,
    );

    // Collected up front — the version rows cascade away with their
    // documents below, taking the only record of these paths with them —
    // but not DELETED until every row is gone; see deleteStorageFiles.
    const doomedVersionPaths = await collectDocumentVersionPaths(
        db,
        documentIds,
    );

    await Promise.all([
        // Direct project access is a grant row, so revoking this person's
        // access means deleting every grant addressed to their email.
        removeGrantsForEmail(db, userEmail),
        // Chat and review invitations are grant rows too. They can outlive
        // the recipient's account, so remove them explicitly by email.
        removeContentGrantsForEmail(db, userEmail),
        deleteUserExportArtifacts(userId),
    ]);

    // Hand the organization's projects (and the content inside them) over to
    // the organization BEFORE the by-user deletions below run, so those
    // deletions no longer match the rows we are keeping.
    await detachOrgProjectContent(db, userId, orgProjectIds);

    await deleteByIds(db, "documents", documentIds);

    const deletions = [
        db.from("tabular_review_chats").delete().eq("user_id", userId),
        db.from("tabular_reviews").delete().eq("user_id", userId),
        db.from("chats").delete().eq("user_id", userId),
        db.from("word_documents").delete().eq("user_id", userId),
        db.from("project_subfolders").delete().eq("user_id", userId),
        db.from("hidden_workflows").delete().eq("user_id", userId),
        db
            .from("workflow_open_source_submissions")
            .delete()
            .eq("submitted_by_user_id", userId),
        db.from("workflow_shares").delete().eq("shared_by_user_id", userId),
        userEmail
            ? db
                  .from("workflow_shares")
                  .delete()
                  .eq("shared_with_email", userEmail.trim().toLowerCase())
            : Promise.resolve({ error: null }),
        // Audit rows carry the user's id, email, chat/document titles and prompt
        // excerpts, so account erasure must remove them as well.
        db.from("audit_events").delete().eq("user_id", userId),
        db.from("projects").delete().eq("user_id", userId),
        db.from("quick_actions").delete().eq("user_id", userId),
        db
            .from("default_workflow_installations")
            .delete()
            .eq("user_id", userId),
    ];

    const results = await Promise.all(deletions);
    for (const result of results) {
        await throwIfError(result.error, "Failed to delete account data");
    }

    const { error: workflowsError } = await db
        .from("workflows")
        .delete()
        .eq("user_id", userId);
    await throwIfError(workflowsError, "Failed to delete workflows");

    // Every doomed row is gone; now the bytes they pointed at may follow.
    // Doing this earlier — before the row deletions — meant any failure in
    // between left a live account whose documents all 404. In this order a
    // failure leaves orphaned bytes instead, and the claim-filtered sweep
    // below reclaims those in the same request.
    await deleteStorageFiles(doomedVersionPaths);

    // Only now — with every doomed row actually gone — is it safe to ask the
    // database which objects under this user's storage prefixes are orphans.
    await deleteOrphanedUserStorage(db, userId);

    // An organization's content is held by ON DELETE RESTRICT foreign keys —
    // deleting an org that still owns anything is refused outright, never
    // silently detached — so none of the content deletions above touch the
    // user's org memberships. Settle those here.
    await deleteUserOrganizations(db, userId, userEmail);
}
