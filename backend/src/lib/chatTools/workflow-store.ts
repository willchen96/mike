/**
 * Build the per-turn workflow store: user-scoped + shared workflows from
 * Supabase merged with BUILTIN_WORKFLOWS (lazy-imported).
 */

import { createServerSupabase } from "../supabase";
import type { WorkflowStore } from "./types";

export async function buildWorkflowStore(
    userId: string,
    userEmail: string | null | undefined,
    db: ReturnType<typeof createServerSupabase>,
): Promise<WorkflowStore> {
    const { BUILTIN_WORKFLOWS } = await import("../builtinWorkflows");
    const store: WorkflowStore = new Map();
    const normalizedUserEmail = (userEmail ?? "").trim().toLowerCase();

    // Seed built-ins first
    for (const wf of BUILTIN_WORKFLOWS) {
        store.set(wf.id, { title: wf.title, prompt_md: wf.prompt_md });
    }

    // Then overlay user-owned assistant workflows.
    const { data: workflows } = await db
        .from("workflows")
        .select("id, title, prompt_md")
        .eq("user_id", userId)
        .eq("type", "assistant");
    for (const wf of workflows ?? []) {
        if (wf.prompt_md) {
            store.set(wf.id, { title: wf.title, prompt_md: wf.prompt_md });
        }
    }

    // Shared assistant workflows must also be readable by workflow tools.
    if (normalizedUserEmail) {
        const { data: shares } = await db
            .from("workflow_shares")
            .select("workflow_id")
            .eq("shared_with_email", normalizedUserEmail);
        const sharedIds = [...new Set((shares ?? []).map((share) => share.workflow_id))];
        if (sharedIds.length > 0) {
            const { data: sharedWorkflows } = await db
                .from("workflows")
                .select("id, title, prompt_md")
                .in("id", sharedIds)
                .eq("type", "assistant");
            for (const wf of sharedWorkflows ?? []) {
                if (wf.prompt_md) {
                    store.set(wf.id, { title: wf.title, prompt_md: wf.prompt_md });
                }
            }
        }
    }
    return store;
}
