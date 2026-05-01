/**
 * Project / document access helpers.
 *
 * Sharing makes the previous "scope by user_id" pattern incorrect — a doc
 * can belong to user A's project that A has shared with B's email, and B
 * must still be able to read/edit it. These helpers centralize the
 * "owner OR shared project member" check so every route uses the same
 * logic instead of re-implementing the join.
 *
 * Returned `isOwner` lets callers gate operations that should stay
 * owner-only (delete, rename, member management).
 */

import type { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

export type ProjectAccess =
    | {
          ok: true;
          isOwner: boolean;
          project: {
              id: string;
              user_id: string;
              shared_with: string[] | null;
          };
      }
    | { ok: false };

export async function checkProjectAccess(
    projectId: string,
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<ProjectAccess> {
    const { data: project } = await db
        .from("projects")
        .select("id, user_id, shared_with")
        .eq("id", projectId)
        .single();
    if (!project) return { ok: false };
    const proj = project as {
        id: string;
        user_id: string;
        shared_with: string[] | null;
    };
    if (proj.user_id === userId) {
        return { ok: true, isOwner: true, project: proj };
    }
    const sharedWith = Array.isArray(proj.shared_with) ? proj.shared_with : [];
    const email = (userEmail ?? "").toLowerCase();
    if (
        email &&
        sharedWith.some((e) => (e ?? "").toLowerCase() === email)
    ) {
        return { ok: true, isOwner: false, project: proj };
    }
    return { ok: false };
}

/**
 * Check whether the current user can access a document the caller has
 * already loaded (saves a round-trip vs. having the helper re-fetch).
 * Owner-of-doc passes immediately; otherwise we fall through to a
 * project-membership check via `shared_with`.
 */
export async function ensureDocAccess(
    doc: { user_id: string; project_id: string | null },
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<{ ok: true; isOwner: boolean } | { ok: false }> {
    if (doc.user_id === userId) return { ok: true, isOwner: true };
    if (!doc.project_id) return { ok: false };
    const access = await checkProjectAccess(
        doc.project_id,
        userId,
        userEmail,
        db,
    );
    if (access.ok) return { ok: true, isOwner: false };
    return { ok: false };
}

/**
 * Same shape as `ensureDocAccess`, for tabular_reviews. A review can be
 * shared in two ways:
 *   1. Indirectly — if `project_id` is set, everyone with project access
 *      can read/operate on it.
 *   2. Directly — `tabular_reviews.shared_with` is a per-review email list
 *      so standalone reviews (project_id null) can also be shared.
 * The owner (review.user_id) always has access.
 */
export async function ensureReviewAccess(
    review: {
        user_id: string;
        project_id: string | null;
        shared_with?: string[] | null;
    },
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<{ ok: true; isOwner: boolean } | { ok: false }> {
    if (review.user_id === userId) return { ok: true, isOwner: true };
    const email = (userEmail ?? "").toLowerCase();
    if (email && Array.isArray(review.shared_with)) {
        if (review.shared_with.some((e) => (e ?? "").toLowerCase() === email)) {
            return { ok: true, isOwner: false };
        }
    }
    if (!review.project_id) return { ok: false };
    const access = await checkProjectAccess(
        review.project_id,
        userId,
        userEmail,
        db,
    );
    if (access.ok) return { ok: true, isOwner: false };
    return { ok: false };
}

/**
 * Returns the set of project IDs the user can access — own projects plus
 * any project where their email is in `shared_with`. Used to scope chat
 * lists and similar collection queries.
 */
export async function listAccessibleProjectIds(
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<string[]> {
    const [{ data: own }, { data: shared }] = await Promise.all([
        db.from("projects").select("id").eq("user_id", userId),
        userEmail
            ? db
                  .from("projects")
                  .select("id")
                  .filter("shared_with", "cs", JSON.stringify([userEmail]))
                  .neq("user_id", userId)
            : Promise.resolve({ data: [] as { id: string }[] }),
    ]);
    const ids = new Set<string>();
    for (const p of (own ?? []) as { id: string }[]) ids.add(p.id);
    for (const p of (shared ?? []) as { id: string }[]) ids.add(p.id);
    return [...ids];
}
