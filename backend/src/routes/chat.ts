import { Router } from "express";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { enqueueChatTurnAudit } from "../lib/audit";
import {
    buildDocContext,
    buildMessages,
    buildUserPersonalisationPrompt,
    enrichWithPriorEvents,
    buildWorkflowStore,
    appendAskInputsResponseToLastAssistantMessage,
    appendAssistantEventsToLastAssistantMessage,
    AssistantStreamError,
    ASSISTANT_ERROR_MESSAGE,
    buildCancelledAssistantMessage,
    extractCitations,
    generateSpotlightNonce,
    isAbortError,
    runLLMStream,
    stripTransientAssistantEvents,
    parseChatMessages,
    parseOptionalAskInputsResponse,
    parseOptionalChatId,
    parseOptionalModel,
    parseOptionalReasoning,
    parseOptionalProjectId,
    createReservedAssistantMessageUpdater,
    openAssistantSse,
    reserveAssistantMessage,
    withoutEmptyAssistantReservations,
} from "../lib/chat";
import {
    getUserModelSettings,
    persistLastSelectedChatModel,
    persistLastSelectedReasoningLevel,
} from "../lib/userSettings";
import {
    checkProjectAccess,
    ensureChatAccess,
    normalizeEmail,
    resolveContentOrgId,
} from "../lib/access";
import {
    deleteContentGrant,
    listContentGrants,
    upsertContentGrant,
} from "../lib/contentAccess";
import { can, type ProjectRole } from "../lib/permissions";
import { listContentPeople } from "../lib/resourcePeople";
import { generateAssistantChatTitle } from "../lib/chatTitle";
import { sendInternalError } from "../lib/httpError";
import {
    resolveEffectiveChatModel,
    resolveEffectiveReasoningLevel,
    titleModelForChat,
} from "../lib/modelSelection";

export const chatRouter = Router();

type Db = ReturnType<typeof createServerSupabase>;
const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
    if (isDev) console.log(...args);
};

type AccessibleChat = {
    id: string;
    title: string | null;
    // Nullable since 20260902_01: content in an organization project outlives
    // the account that created it (the FK is ON DELETE SET NULL).
    user_id: string | null;
    project_id: string | null;
    model: string | null;
    reasoning_level: string | null;
    org_id?: string | null;
} & Record<string, unknown>;

async function validateAccessibleProjectId(
    projectId: string | null,
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<{ ok: true } | { ok: false; status: number; detail: string }> {
    if (!projectId) return { ok: true };
    // Creating a chat under a project contributes content to it: member+.
    // A Viewer can see the project, so answering 404 would claim it does not
    // exist; the refusal is 403 and names the reason instead.
    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
        return { ok: false, status: 404, detail: "Project not found" };
    if (!can(access.projectRole, "content.edit"))
        return {
            ok: false,
            status: 403,
            detail: "You do not have permission to write in this project.",
        };
    return { ok: true };
}

type ChatAccess =
    | {
          ok: true;
          chat: AccessibleChat;
          /** Provenance only ("I started this thread"), not a right — the
           *  admin role the creator branch derives is what grants. */
          isCreator: boolean;
          projectRole: ProjectRole;
      }
    | { ok: false };

// Resolve a chat AND the caller's role for it, so callers can gate reads and
// writes separately: "can you see it" (project.view) and "can you write to
// it" (content.edit) are different questions. The role comes from
// `ensureChatAccess` (lib/access.ts) — the same derivation reviews use: the
// project chats inherit the project role exactly. Standalone chats use
// role-aware direct grants.
async function getAccessibleChat(
    chatId: string,
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<ChatAccess> {
    const { data: chat, error } = await db
        .from("chats")
        .select("*")
        .eq("id", chatId)
        .maybeSingle();
    if (error || !chat) return { ok: false };

    const row = chat as AccessibleChat;
    const access = await ensureChatAccess(row, userId, userEmail, db);
    if (!access.ok) return { ok: false };
    return {
        ok: true,
        chat: row,
        isCreator: access.isCreator,
        projectRole: access.projectRole,
    };
}

// GET /chat
// Lists every chat the caller could open: the RPC's predicate mirrors
// ensureChatAccess branch for branch (creator, direct grant, accessible
// project), so the list and GET /chat/:chatId can never disagree
// about what exists. Each row carries is_owner so the sidebar can tell the
// caller's own chats from colleagues' ones — provenance, not a role.
chatRouter.get("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const requestedLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const requestedOffset = Number.parseInt(String(req.query.offset ?? ""), 10);
    const limit = Number.isFinite(requestedLimit)
        ? Math.min(Math.max(requestedLimit, 1), 100)
        : null;
    const offset =
        Number.isFinite(requestedOffset) && requestedOffset > 0
            ? requestedOffset
            : 0;

    const { data, error } = await db.rpc("get_chats_overview", {
        p_user_id: userId,
        p_user_email: userEmail?.trim().toLowerCase() ?? null,
        p_limit: limit,
        p_offset: offset,
    });
    if (error) return void sendInternalError(res, error);
    res.json(data ?? []);
});

// POST /chat/create
chatRouter.post("/create", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const parsedProjectId = parseOptionalProjectId(req.body?.project_id);
    if (!parsedProjectId.ok) {
        return void res.status(400).json({ detail: parsedProjectId.detail });
    }
    const projectId = parsedProjectId.value.projectId;
    const db = createServerSupabase();
    const projectAccess = await validateAccessibleProjectId(
        projectId,
        userId,
        userEmail,
        db,
    );
    if (!projectAccess.ok)
        return void res
            .status(projectAccess.status)
            .json({ detail: projectAccess.detail });

    // Tenant stamping, like every other content create: a project chat
    // inherits the project's org; a standalone chat is personal (org_id
    // null) and stays private until it receives a direct grant.
    const resolvedOrg = await resolveContentOrgId(db, { projectId });
    if (!resolvedOrg.ok) return void sendInternalError(res, resolvedOrg.detail);
    const { data, error } = await db
        .from("chats")
        .insert({
            user_id: userId,
            project_id: projectId ?? null,
            org_id: resolvedOrg.orgId,
        })
        .select("id")
        .single();

    if (error) return void sendInternalError(res, error);
    res.json({ id: data.id });
});

// GET /chat/:chatId
chatRouter.get("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const db = createServerSupabase();

    // Reading a chat only needs visibility (project.view) — org viewers
    // are allowed here even though they cannot write to the chat.
    const access = await getAccessibleChat(chatId, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Chat not found" });
    const chat = access.chat;

    const { data: messages } = await db
        .from("chat_messages")
        .select("*")
        .eq("chat_id", chatId)
        .order("created_at", { ascending: true });

    const hydrated = await hydrateEditStatuses(
        withoutEmptyAssistantReservations(messages ?? []),
        db,
    );
    // access_role/is_owner mirror the project and review detail responses so
    // the client can render per-role affordances instead of re-deriving them.
    res.json({
        chat,
        is_owner: access.isCreator,
        access_role: access.projectRole,
        messages: hydrated,
    });
});

// GET /chat/:chatId/people
// The chat's creator + every direct grantee, resolved to
// {email, display_name, role} — the same roster shape as
// GET /projects/:projectId/people, including its nullable `owner` (a chat in
// an organization project outlives its author's account). Visible to anyone
// who can see the chat.
chatRouter.get("/:chatId/people", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const db = createServerSupabase();

    const access = await getAccessibleChat(chatId, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Chat not found" });
    const chat = access.chat;

    const people = await listContentPeople(db, "chat", chat);
    if (!people.ok) return void sendInternalError(res, people.detail);
    res.json(people);
});

// GET /chat/:chatId/access — role-aware direct grants, admin-only.
chatRouter.get("/:chatId/access", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const db = createServerSupabase();
    const access = await getAccessibleChat(chatId, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Chat not found" });
    if (!can(access.projectRole, "access.manage"))
        return void res.status(403).json({
            detail: "Only a chat owner can change who has access.",
        });
    if (access.chat.project_id)
        return void res.json({
            scope: "project",
            inherited_from_project_id: access.chat.project_id,
            org_id: access.chat.org_id ?? null,
            access_role: access.projectRole,
            grants: [],
        });
    const listed = await listContentGrants(db, "chat", chatId);
    if (!listed.ok) return void sendInternalError(res, listed.detail);
    res.json({
        scope: "direct",
        org_id: null,
        access_role: access.projectRole,
        grants: listed.grants,
    });
});

// POST /chat/:chatId/access — grant or re-role one recipient.
chatRouter.post("/:chatId/access", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const db = createServerSupabase();
    const access = await getAccessibleChat(chatId, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Chat not found" });
    if (!can(access.projectRole, "access.manage"))
        return void res.status(403).json({
            detail: "Only a chat owner can change who has access.",
        });
    if (access.chat.project_id)
        return void res.status(409).json({
            code: "access_inherited",
            detail: "Project-owned chats inherit access from their project.",
        });
    const email = normalizeEmail(
        typeof req.body?.email === "string" ? req.body.email : null,
    );
    if (email && normalizeEmail(userEmail) === email)
        return void res
            .status(400)
            .json({ detail: "You cannot share a chat with yourself." });
    if (req.body?.role === "deny")
        return void res.status(400).json({
            detail: "Deny is only available for organization members",
        });
    // One creator's email, one row read. This used to scan every profile in
    // the deployment to build two maps and then use a single entry.
    const creatorProfile = access.chat.user_id
        ? await db
              .from("user_profiles")
              .select("email")
              .eq("user_id", access.chat.user_id)
              .maybeSingle()
        : null;
    // A failed read is not "the creator has no email". Swallowing the error
    // sent `creatorEmail: null` into upsertContentGrant, which is what stops
    // the creator being handed a guest grant on their own chat — so a
    // transient database fault quietly created exactly the row the check
    // exists to prevent.
    if (creatorProfile?.error)
        return void sendInternalError(res, creatorProfile.error);
    const result = await upsertContentGrant(db, {
        kind: "chat",
        resourceId: chatId,
        email: req.body?.email,
        role: req.body?.role,
        createdBy: userId,
        creatorEmail:
            (creatorProfile?.data as { email?: string | null } | null)?.email ??
            null,
    });
    if (!result.ok) {
        if (result.kind === "validation")
            return void res.status(400).json({ detail: result.detail });
        return void sendInternalError(res, result.detail);
    }
    res.status(201).json(result.grant);
});

// DELETE /chat/:chatId/access/:email — revoke one recipient.
chatRouter.delete("/:chatId/access/:email", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const db = createServerSupabase();
    const access = await getAccessibleChat(chatId, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Chat not found" });
    if (!can(access.projectRole, "access.manage"))
        return void res.status(403).json({
            detail: "Only a chat owner can change who has access.",
        });
    if (access.chat.project_id)
        return void res.status(409).json({
            code: "access_inherited",
            detail: "Project-owned chats inherit access from their project.",
        });
    const result = await deleteContentGrant(db, {
        kind: "chat",
        resourceId: chatId,
        email: decodeURIComponent(req.params.email),
    });
    if (!result.ok) return void sendInternalError(res, result.detail);
    if (!result.removed)
        return void res.status(404).json({ detail: "Access grant not found" });
    res.status(204).send();
});

// Stored doc_edited events capture the `status` at the time the assistant
// produced the edit (always "pending"). If the user later accepts or rejects,
// `document_edits.status` is updated but the stored event is not. On chat load
// we merge the current DB status in so EditCards render with the real state.
async function hydrateEditStatuses(
    messages: Record<string, unknown>[],
    db: ReturnType<typeof createServerSupabase>,
): Promise<Record<string, unknown>[]> {
    const editIds = new Set<string>();
    const versionIds = new Set<string>();
    const collectFromAnnList = (list: unknown) => {
        if (!Array.isArray(list)) return;
        for (const a of list as Record<string, unknown>[]) {
            if (typeof a?.edit_id === "string") editIds.add(a.edit_id);
            if (typeof a?.version_id === "string") versionIds.add(a.version_id);
        }
    };
    for (const m of messages) {
        const content = m.content;
        if (Array.isArray(content)) {
            for (const ev of content as Record<string, unknown>[]) {
                if (ev?.type === "doc_edited") {
                    collectFromAnnList(ev.annotations);
                    if (typeof ev.version_id === "string")
                        versionIds.add(ev.version_id);
                }
            }
        }
    }
    if (editIds.size === 0 && versionIds.size === 0) return messages;

    // Edit status patch.
    const statusById = new Map<string, "pending" | "accepted" | "rejected">();
    if (editIds.size > 0) {
        const { data: rows } = await db
            .from("document_edits")
            .select("id, status")
            .in("id", Array.from(editIds));
        for (const r of (rows ?? []) as { id: string; status: string }[]) {
            if (
                r.status === "pending" ||
                r.status === "accepted" ||
                r.status === "rejected"
            ) {
                statusById.set(r.id, r.status);
            }
        }
    }

    // Version-number patch — old stored events don't carry `version_number`
    // because they predate the schema change. Look it up from
    // document_versions so the UI can render "V3" chips + download filenames.
    const versionNumberById = new Map<string, number | null>();
    if (versionIds.size > 0) {
        const { data: vrows } = await db
            .from("document_versions")
            .select("id, version_number")
            .in("id", Array.from(versionIds));
        for (const r of (vrows ?? []) as {
            id: string;
            version_number: number | null;
        }[]) {
            versionNumberById.set(r.id, r.version_number ?? null);
        }
    }

    const patchAnnList = (list: unknown): unknown => {
        if (!Array.isArray(list)) return list;
        return (list as Record<string, unknown>[]).map((a) => {
            let next = a;
            if (typeof a?.edit_id === "string" && statusById.has(a.edit_id)) {
                next = { ...next, status: statusById.get(a.edit_id) };
            }
            if (
                typeof a?.version_id === "string" &&
                versionNumberById.has(a.version_id)
            ) {
                next = {
                    ...next,
                    version_number: versionNumberById.get(a.version_id) ?? null,
                };
            }
            return next;
        });
    };
    return messages.map((m) => {
        const next: Record<string, unknown> = { ...m };
        if (Array.isArray(m.content)) {
            next.content = (m.content as Record<string, unknown>[]).map(
                (ev) => {
                    if (ev?.type !== "doc_edited") return ev;
                    let patched: Record<string, unknown> = {
                        ...ev,
                        annotations: patchAnnList(ev.annotations),
                    };
                    if (
                        typeof ev.version_id === "string" &&
                        versionNumberById.has(ev.version_id)
                    ) {
                        patched = {
                            ...patched,
                            version_number:
                                versionNumberById.get(ev.version_id) ?? null,
                        };
                    }
                    return patched;
                },
            );
        }
        return next;
    });
}

// PATCH /chat/:chatId — rename and/or edit sharing.
chatRouter.patch("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const updates: Record<string, unknown> = {};
    const body =
        req.body && typeof req.body === "object" && !Array.isArray(req.body)
            ? (req.body as Record<string, unknown>)
            : {};

    // Validate the SHAPE of what arrived instead of coercing it.
    // `String(req.body.title)` accepts anything: `{}` becomes the literal
    // title "[object Object]" and `42` becomes "42", so a client bug is
    // stored as data and discovered later by a human reading a nonsense chat
    // name. Refusing names the problem while it is still fixable.
    if (body.title != null) {
        if (typeof body.title !== "string")
            return void res
                .status(400)
                .json({ detail: "title must be a string" });
        const title = body.title.trim();
        if (!title)
            return void res.status(400).json({ detail: "title is required" });
        updates.title = title;
    }
    if ("shared_with" in body)
        return void res.status(400).json({
            detail:
                "shared_with is no longer supported; use the chat access endpoints.",
        });
    const hasModel = req.body.model != null;
    const parsedModel = parseOptionalModel(req.body.model);
    if (hasModel && !parsedModel.ok) {
        return void res.status(400).json({ detail: parsedModel.detail });
    }
    const hasReasoning = req.body.reasoningLevel != null;
    const parsedReasoning = parseOptionalReasoning(req.body.reasoningLevel);
    if (hasReasoning && !parsedReasoning.ok) {
        return void res.status(400).json({ detail: parsedReasoning.detail });
    }

    if (Object.keys(updates).length === 0 && !hasModel && !hasReasoning)
        return void res.status(400).json({
            detail: "title, model or reasoningLevel is required",
        });

    const db = createServerSupabase();
    const access = await getAccessibleChat(chatId, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Chat not found" });
    // Title edits are content collaboration (the same tier that already
    // rewrites titles via generate-title).
    if (updates.title != null && !can(access.projectRole, "content.edit"))
        return void res
            .status(403)
            .json({ detail: "You do not have permission to modify this chat" });
    if (
        (hasModel || hasReasoning) &&
        !can(access.projectRole, "content.edit")
    )
        return void res
            .status(403)
            .json({ detail: "You do not have permission to modify this chat" });

    if (hasModel) {
        const settings = await getUserModelSettings(userId, db);
        const resolution = await resolveEffectiveChatModel({
            requested: parsedModel.ok ? parsedModel.value : undefined,
            chatModel: access.chat.model,
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
        updates.model = resolution.model;
    }
    if (hasReasoning && parsedReasoning.ok && parsedReasoning.value) {
        updates.reasoning_level = parsedReasoning.value;
    }

    const { data, error } = await db
        .from("chats")
        .update(updates)
        .eq("id", chatId)
        .select("id, title, model, reasoning_level")
        .single();

    // Two different failures that must not share an answer. Authorization
    // already passed above, so a database error here is OUR fault, not a
    // statement about what exists: reporting it as "404 Chat not found" tells
    // the client a lie it will act on (dropping the chat from the sidebar)
    // and hides the outage from whoever is reading the logs. The row being
    // gone is the only real 404 — the chat was deleted between the access
    // check and the write. DELETE below already splits them this way.
    if (error) return void sendInternalError(res, error);
    if (!data) return void res.status(404).json({ detail: "Chat not found" });

    if (typeof updates.model === "string") {
        const profileError = await persistLastSelectedChatModel(
            userId,
            updates.model,
            db,
        );
        if (profileError) return void sendInternalError(res, profileError);
    }
    if (hasReasoning && parsedReasoning.ok && parsedReasoning.value) {
        const profileError = await persistLastSelectedReasoningLevel(
            userId,
            parsedReasoning.value,
            db,
        );
        if (profileError) return void sendInternalError(res, profileError);
    }
    res.json(data);
});

// DELETE /chat/:chatId
chatRouter.delete("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const db = createServerSupabase();
    // container.delete keeps chat deletion at the top of the ladder: the
    // chat's creator, or an admin of the project it lives in (who could
    // already delete the whole project). Members and viewers get 403.
    const access = await getAccessibleChat(chatId, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Chat not found" });
    if (!can(access.projectRole, "container.delete"))
        return void res
            .status(403)
            .json({ detail: "You do not have permission to delete this chat" });

    const { error } = await db.from("chats").delete().eq("id", chatId);
    if (error) return void sendInternalError(res, error);
    res.status(204).send();
});

// POST /chat/:chatId/generate-title
chatRouter.post("/:chatId/generate-title", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const message =
        typeof req.body?.message === "string" ? req.body.message.trim() : "";
    const requestedModel =
        typeof req.body?.model === "string" ? req.body.model.trim() : null;
    if (!message)
        return void res.status(400).json({ detail: "message is required" });
    const db = createServerSupabase();
    const access = await getAccessibleChat(chatId, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Chat not found" });
    // Generating a title UPDATEs the chat row — a write, so being able to
    // *see* the chat is not enough. Org viewers get 403 here.
    if (!can(access.projectRole, "content.edit"))
        return void res
            .status(403)
            .json({ detail: "You do not have permission to modify this chat" });

    try {
        const settings = await getUserModelSettings(userId, db);
        const resolution = await resolveEffectiveChatModel({
            requested: requestedModel,
            chatModel: access.chat.model,
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
        const title = await generateAssistantChatTitle({
            model: titleModelForChat(resolution.model, settings.title_model),
            message,
            apiKeys: settings.api_keys,
        });

        // Read the write. An ignored error answered 200 with the new title,
        // so the sidebar renamed the chat and reverted on the next reload.
        const { error: titleError } = await db
            .from("chats")
            .update({ title })
            .eq("id", chatId);
        if (titleError) return void sendInternalError(res, titleError);

        res.json({ title });
    } catch (err) {
        console.error("[generate-title]", err);
        res.status(500).json({ detail: "Failed to generate title" });
    }
});

// POST /chat — streaming
chatRouter.post("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const body =
        req.body && typeof req.body === "object" && !Array.isArray(req.body)
            ? (req.body as Record<string, unknown>)
            : {};
    const parsedMessages = parseChatMessages(body.messages);
    if (!parsedMessages.ok) {
        return void res.status(400).json({ detail: parsedMessages.detail });
    }
    const parsedChatId = parseOptionalChatId(body.chat_id);
    if (!parsedChatId.ok) {
        return void res.status(400).json({ detail: parsedChatId.detail });
    }
    const parsedProjectId = parseOptionalProjectId(body.project_id);
    if (!parsedProjectId.ok) {
        return void res.status(400).json({ detail: parsedProjectId.detail });
    }
    const parsedModel = parseOptionalModel(body.model);
    if (!parsedModel.ok) {
        return void res.status(400).json({ detail: parsedModel.detail });
    }
    const parsedReasoning = parseOptionalReasoning(body.reasoning);
    if (!parsedReasoning.ok) {
        return void res.status(400).json({ detail: parsedReasoning.detail });
    }
    const parsedAskInputsResponse = parseOptionalAskInputsResponse(
        body.ask_inputs_response,
    );
    if (!parsedAskInputsResponse.ok) {
        return void res
            .status(400)
            .json({ detail: parsedAskInputsResponse.detail });
    }
    const messages = parsedMessages.value;
    const chat_id = parsedChatId.value;
    const project_id = parsedProjectId.value.projectId;
    const model = parsedModel.value;
    const askInputsResponse = parsedAskInputsResponse.value;
    // Reserve a stable assistant identity before streaming. This lets clients
    // associate streamed UI with the same durable message after a reload.
    const assistantMessageId = askInputsResponse ? null : randomUUID();

    devLog("[chat/stream] incoming request", {
        userId,
        chat_id,
        project_id,
        model,
        messageCount: messages?.length,
    });

    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    let chatId = chat_id ?? null;
    let chatTitle: string | null = null;
    let chatModel: string | null = null;
    let chatReasoningLevel: string | null = null;
    let resolvedProjectId: string | null = parsedProjectId.value.projectId;
    // Whether the document-writing tools are offered this turn. A standalone
    // chat writes into the caller's own library, so it keeps them; a project
    // chat writes into the PROJECT, and that is a question about the caller's
    // project role, never about their standing in the thread. See the long
    // note in routes/projectChat.ts — this is the same partition on the
    // route that serves standalone and project chats alike.
    let allowDocumentMutation = true;

    if (chatId) {
        const access = await getAccessibleChat(chatId, userId, userEmail, db);
        if (!access.ok)
            return void res.status(404).json({ detail: "Chat not found" });
        // Appending messages (and triggering LLM generation) writes to the
        // chat: member+ only, mirroring the new-chat path below. Viewers
        // can read this chat (GET) but must not be able to write into it.
        if (!can(access.projectRole, "content.edit"))
            return void res.status(403).json({
                detail: "You do not have permission to modify this chat",
            });
        const existing = access.chat;

        const existingProjectId = existing.project_id ?? null;
        if (
            parsedProjectId.value.provided &&
            parsedProjectId.value.projectId !== existingProjectId
        ) {
            return void res
                .status(400)
                .json({ detail: "project_id does not match chat" });
        }
        resolvedProjectId = existingProjectId;
        chatTitle = existing.title;
        chatModel = existing.model;
        chatReasoningLevel = existing.reasoning_level;
        if (existingProjectId) {
            // The role above may have come from the chat's own share list;
            // creating documents in the project needs the project's verdict.
            const projectAccess = await checkProjectAccess(
                existingProjectId,
                userId,
                userEmail,
                db,
            );
            allowDocumentMutation =
                projectAccess.ok &&
                can(projectAccess.projectRole, "content.edit");
        }
    }

    const modelSettings = await getUserModelSettings(userId, db);
    const modelResolution = await resolveEffectiveChatModel({
        requested: model,
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
    const selectedModel = modelResolution.model;
    const selectedReasoningLevel = resolveEffectiveReasoningLevel({
        model: selectedModel,
        requested: parsedReasoning.value,
        chatReasoningLevel,
        lastSelectedReasoningLevel: modelSettings.last_selected_reasoning_level,
    });

    if (
        chatId &&
        (chatModel !== selectedModel ||
            chatReasoningLevel !== selectedReasoningLevel)
    ) {
        const { error } = await db
            .from("chats")
            .update({
                model: selectedModel,
                reasoning_level: selectedReasoningLevel,
            })
            .eq("id", chatId);
        if (error) return void sendInternalError(res, error);
    }

    if (!chatId) {
        // If creating a chat tied to a project, the user must have access
        // to the project (own or shared).
        const projectAccess = await validateAccessibleProjectId(
            resolvedProjectId,
            userId,
            userEmail,
            db,
        );
        if (!projectAccess.ok)
            return void res
                .status(projectAccess.status)
                .json({ detail: projectAccess.detail });

        const resolvedOrg = await resolveContentOrgId(db, {
            projectId: resolvedProjectId,
        });
        if (!resolvedOrg.ok)
            return void sendInternalError(res, resolvedOrg.detail);
        const { data: newChat, error } = await db
            .from("chats")
            .insert({
                user_id: userId,
                project_id: resolvedProjectId,
                model: selectedModel,
                reasoning_level: selectedReasoningLevel,
                org_id: resolvedOrg.orgId,
            })
            .select("id, title")
            .single();
        if (error || !newChat) {
            console.error("[chat/stream] failed to create chat", error);
            return void res
                .status(500)
                .json({ detail: "Failed to create chat" });
        }
        chatId = newChat.id as string;
        chatTitle = newChat.title;
    }

    if (!chatId) {
        return void res
            .status(500)
            .json({ detail: "Failed to initialize chat" });
    }

    devLog("[chat/stream] resolved chatId", chatId);

    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (askInputsResponse) {
        await appendAskInputsResponseToLastAssistantMessage(
            db,
            chatId,
            askInputsResponse,
        );
    } else if (lastUser) {
        await db.from("chat_messages").insert({
            chat_id: chatId,
            role: "user",
            content: lastUser.content,
            files: lastUser.files ?? null,
            workflow: lastUser.workflow ?? null,
        });
    }

    const { docIndex, docStore } = await buildDocContext(
        messages,
        userId,
        db,
        chatId,
        "chat_messages",
        userEmail,
    );
    const docAvailability = Object.entries(docIndex).map(([doc_id, info]) => ({
        doc_id,
        filename: info.filename,
    }));
    // Generate the nonce before enriching prior events so document filenames
    // and workflow titles replayed from earlier turns are fenced as well.
    const nonce = generateSpotlightNonce();
    const enrichedMessages = await enrichWithPriorEvents(
        messages,
        chatId,
        db,
        docIndex,
        nonce,
    );
    const {
        api_keys: apiKeys,
        legal_research_us: legalResearchUs,
        title_model: titleModel,
        personalisation,
    } = modelSettings;
    const personalisationPrompt = buildUserPersonalisationPrompt(
        personalisation,
        nonce,
    );
    const apiMessages = buildMessages(
        enrichedMessages,
        docAvailability,
        personalisationPrompt || undefined,
        undefined,
        legalResearchUs,
        nonce,
    );

    const workflowStore = await buildWorkflowStore(userId, userEmail, db);

    devLog("[chat/stream] starting LLM stream", {
        apiMessageCount: apiMessages.length,
        docCount: Object.keys(docIndex).length,
        workflowCount: Object.keys(workflowStore).length,
    });

    // Make the advertised identity durable before the response becomes an
    // SSE stream. If this reservation fails, return a normal HTTP error while
    // headers are still mutable; clients must never receive an ID that cannot
    // subsequently be loaded from chat history.
    if (assistantMessageId) {
        const reserveError = await reserveAssistantMessage({
            db,
            table: "chat_messages",
            id: assistantMessageId,
            chatId,
        });
        if (reserveError) {
            console.error(
                "[chat/stream] failed to reserve assistant message",
                reserveError,
            );
            return void res
                .status(500)
                .json({ detail: "Failed to start assistant response" });
        }
    }

    const stream = openAssistantSse(res);
    const write = stream.write;
    const updateReservedAssistantMessage =
        createReservedAssistantMessageUpdater({
            db,
            table: "chat_messages",
            id: assistantMessageId ?? "",
            chatId,
            enabled: !!assistantMessageId,
        });

    try {
        write(
            `data: ${JSON.stringify({
                type: "chat_id",
                chatId,
                ...(assistantMessageId ? { assistantMessageId } : {}),
            })}\n\n`,
        );

        const shouldGenerateTitle =
            !chatTitle && !!lastUser?.content && !askInputsResponse;
        const titleMessage = lastUser
            ? [
                  lastUser.content,
                  lastUser.workflow
                      ? `Workflow: ${lastUser.workflow.title}`
                      : "",
                  lastUser.files?.length
                      ? `Files: ${lastUser.files.map((file) => file.filename).join(", ")}`
                      : "",
              ]
                  .filter(Boolean)
                  .join("\n")
            : "";
        const titlePromise = shouldGenerateTitle
            ? generateAssistantChatTitle({
                  model: titleModelForChat(selectedModel, titleModel),
                  message: titleMessage,
                  apiKeys,
              })
                  .then(async (title) => {
                      const { error } = await db
                          .from("chats")
                          .update({ title })
                          .eq("id", chatId);
                      if (error) throw error;
                      chatTitle = title;
                      if (!stream.signal.aborted) {
                          write(
                              `data: ${JSON.stringify({ type: "chat_title", chatId, title })}\n\n`,
                          );
                      }
                  })
                  .catch((error) => {
                      console.error(
                          "[chat/stream] failed to generate chat title",
                          error,
                      );
                  })
            : Promise.resolve();

        const { fullText, events, citations } = await runLLMStream({
            apiMessages,
            docStore,
            docIndex,
            userId,
            db,
            write,
            allowDocumentMutation,
            workflowStore,
            includeResearchTools: legalResearchUs,
            model: selectedModel,
            reasoning: selectedReasoningLevel,
            apiKeys,
            signal: stream.signal,
            projectId: resolvedProjectId,
            nonce,
            // This route first makes the advertised assistant ID durable.
            // It emits [DONE] only after the reserved row has been populated.
            emitDone: false,
        });

        devLog("[chat/stream] LLM stream finished", {
            fullTextLen: fullText?.length ?? 0,
            eventCount: events?.length ?? 0,
        });

        // Upstream providers occasionally end the stream cleanly but empty
        // (observed via OpenRouter). Silence reads as a hung composer, so
        // surface it — unless tools produced visible artifacts, which carry
        // their own completion signal.
        if (
            !fullText?.trim() &&
            (!events || events.every((event) => !("error" in event)))
        ) {
            write(
                `data: ${JSON.stringify({
                    type: "error",
                    message:
                        "The model returned an empty response. Try again, or pick a different model.",
                    safe_to_display: true,
                })}\n\n`,
            );
            write("data: [DONE]\n\n");
            return;
        }

        const persistedEvents = stripTransientAssistantEvents(events);
        if (askInputsResponse) {
            await appendAssistantEventsToLastAssistantMessage(
                db,
                chatId,
                persistedEvents,
                citations,
            );
        } else {
            const saveError = await updateReservedAssistantMessage(
                persistedEvents.length ? persistedEvents : null,
                citations.length ? citations : null,
            );
            if (saveError) {
                console.error(
                    "[chat/stream] failed to save assistant response",
                    saveError,
                );
                write(
                    `data: ${JSON.stringify({
                        type: "error",
                        message:
                            "The response was generated but could not be saved.",
                    })}\n\n`,
                );
                write("data: [DONE]\n\n");
                return;
            }
        }

        await titlePromise;

        if (!chatTitle && lastUser?.content) {
            const title = lastUser.content.slice(0, 120);
            // The SSE response is already streaming, so a failure here cannot
            // become an HTTP error — but it must not be announced either: an
            // ignored error pushed a chat_title frame the client rendered and
            // the next reload undid. Log it and leave the chat untitled.
            const { error: titleError } = await db
                .from("chats")
                .update({ title })
                .eq("id", chatId);
            if (titleError) {
                console.error("[chat/stream] failed to save chat title", {
                    chatId,
                    message: titleError.message,
                });
            } else {
                chatTitle = title;
                if (shouldGenerateTitle && !stream.signal.aborted) {
                    write(
                        `data: ${JSON.stringify({ type: "chat_title", chatId, title })}\n\n`,
                    );
                }
            }
        }
        void enqueueChatTurnAudit(
            db,
            {
                userId,
                userEmail,
                chatId,
                projectId: resolvedProjectId,
                title: chatTitle ?? lastUser?.content?.slice(0, 120) ?? null,
                model: selectedModel,
            },
            persistedEvents,
        );
        write("data: [DONE]\n\n");
    } catch (err) {
        if (isAbortError(err)) {
            devLog("[chat/stream] client aborted stream", { chatId });
            void enqueueChatTurnAudit(
                db,
                {
                    userId,
                    userEmail,
                    chatId,
                    projectId: resolvedProjectId,
                    title: chatTitle,
                    model: selectedModel,
                    status: "cancelled",
                },
                null,
            );
            if (err instanceof AssistantStreamError) {
                const partial = buildCancelledAssistantMessage({
                    fullText: err.fullText,
                    events: err.events,
                    buildCitations: (fullText) =>
                        extractCitations(fullText, docIndex),
                });
                const saveError = askInputsResponse
                    ? null
                    : await updateReservedAssistantMessage(
                          partial.events.length ? partial.events : null,
                          partial.citations.length ? partial.citations : null,
                      );
                if (askInputsResponse) {
                    await appendAssistantEventsToLastAssistantMessage(
                        db,
                        chatId,
                        partial.events,
                        partial.citations,
                    );
                }
                if (saveError) {
                    console.error(
                        "[chat/stream] failed to save aborted stream",
                        saveError,
                    );
                }
            }
            return;
        }
        console.error("[chat/stream] error:", err);
        const message = ASSISTANT_ERROR_MESSAGE;
        const errorEvents =
            err instanceof AssistantStreamError
                ? stripTransientAssistantEvents(err.events)
                : [{ type: "error" as const, message }];
        const errorFullText =
            err instanceof AssistantStreamError ? err.fullText : "";
        try {
            const citations = extractCitations(errorFullText, docIndex);
            const saveError = askInputsResponse
                ? null
                : await updateReservedAssistantMessage(
                      errorEvents.length ? errorEvents : null,
                      citations.length ? citations : null,
                  );
            if (askInputsResponse) {
                await appendAssistantEventsToLastAssistantMessage(
                    db,
                    chatId,
                    errorEvents,
                    citations,
                );
            }
            if (saveError)
                console.error("[chat/stream] failed to save error", saveError);
        } catch (saveErr) {
            console.error("[chat/stream] failed to save error", saveErr);
        }
        try {
            write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
            write("data: [DONE]\n\n");
        } catch {
            /* ignore */
        }
    } finally {
        stream.finish();
    }
});
