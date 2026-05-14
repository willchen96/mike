import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { llmRateLimiter } from "../lib/rateLimiter";
import { createServerSupabase } from "../lib/supabase";
import { logger } from "../lib/logger";
import {
    buildDocContext,
    buildMessages,
    enrichWithPriorEvents,
    buildWorkflowStore,
    extractAnnotations,
    runLLMStream,
    type ChatMessage,
} from "../lib/chatTools";
import { completeText } from "../lib/llm";
import { getUserApiKeys, getUserModelSettings } from "../lib/userSettings";
import { checkProjectAccess } from "../lib/access";
import { parseBody } from "../lib/validate";

const CreateChatSchema = z.object({
    project_id: z.string().uuid().optional().nullable(),
});

const PatchChatSchema = z.object({
    title: z.string().min(1),
});

const GenerateTitleSchema = z.object({
    message: z.string().min(1),
});

const ChatStreamSchema = z.object({
    messages: z.array(
        z.object({
            role: z.enum(["user", "assistant"]),
            content: z.string(),
            files: z.array(z.unknown()).optional().nullable(),
            workflow: z.unknown().optional().nullable(),
        }),
    ).min(1),
    chat_id: z.string().uuid().optional(),
    project_id: z.string().uuid().optional().nullable(),
    model: z.string().optional(),
});

export const chatRouter = Router();

// GET /chat
// Visible chats = the user's own chats + every chat under a project the
// user owns (so a project owner sees all collaborator chats in their
// own projects in the global recent-chats list). Chats in projects that
// are merely *shared with* the user are NOT included here — those are
// listed per-project via GET /projects/:projectId/chats.
chatRouter.get("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();

    const [ownProjectsResult, ownChatsResult] = await Promise.all([
        db.from("projects").select("id").eq("user_id", userId),
        db.from("chats").select("*").eq("user_id", userId),
    ]);
    if (ownProjectsResult.error)
        return void res
            .status(500)
            .json({ detail: ownProjectsResult.error.message });
    if (ownChatsResult.error)
        return void res
            .status(500)
            .json({ detail: ownChatsResult.error.message });

    const ownProjectIds = (
        (ownProjectsResult.data ?? []) as { id: string }[]
    ).map((p) => p.id);

    let projectChats: Record<string, unknown>[] = [];
    if (ownProjectIds.length > 0) {
        const { data, error } = await db
            .from("chats")
            .select("*")
            .in("project_id", ownProjectIds);
        if (error)
            return void res.status(500).json({ detail: error.message });
        projectChats = (data ?? []) as Record<string, unknown>[];
    }

    // Merge + dedupe on id, then sort by created_at desc to preserve
    // prior server-side ordering semantics (RESEARCH.md Pitfall 4).
    const byId = new Map<string, Record<string, unknown>>();
    for (const c of (ownChatsResult.data ?? []) as Record<
        string,
        unknown
    >[]) {
        byId.set(c.id as string, c);
    }
    for (const c of projectChats) byId.set(c.id as string, c);
    const merged = [...byId.values()].sort((a, b) => {
        const ta = String(a.created_at ?? "");
        const tb = String(b.created_at ?? "");
        return tb.localeCompare(ta);
    });
    res.json(merged);
});

// POST /chat/create
chatRouter.post("/create", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const body = parseBody(CreateChatSchema, req, res);
    if (!body) return;
    const projectId: string | null = body.project_id ?? null;
    const db = createServerSupabase();
    const { data, error } = await db
        .from("chats")
        .insert({ user_id: userId, project_id: projectId ?? undefined })
        .select("id")
        .single();

    if (error) return void res.status(500).json({ detail: error.message });
    res.json({ id: data.id });
});

// GET /chat/:chatId
chatRouter.get("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const db = createServerSupabase();

    const { data: chat, error } = await db
        .from("chats")
        .select("*")
        .eq("id", chatId)
        .single();
    if (error || !chat)
        return void res.status(404).json({ detail: "Chat not found" });
    // Owner of the chat OR a member of the chat's project can view it.
    let canView = chat.user_id === userId;
    if (!canView && chat.project_id) {
        const access = await checkProjectAccess(
            chat.project_id,
            userId,
            userEmail,
            db,
        );
        canView = access.ok;
    }
    if (!canView)
        return void res.status(404).json({ detail: "Chat not found" });

    // CLEAN-27: paginate to limit+before; default 50 most-recent. Cap 200.
    // Cursor is exclusive (lt) to avoid duplicate at page boundary.
    const limitRaw =
        typeof req.query.limit === "string"
            ? parseInt(req.query.limit, 10)
            : NaN;
    const limit = Number.isFinite(limitRaw)
        ? Math.min(Math.max(limitRaw, 1), 200)
        : 50;

    // Validate `before` cursor BEFORE building the query.
    // An unparseable cursor must 400 — silent fallback to no-cursor would
    // mask client bugs and return a different page than the caller asked for.
    const beforeRaw = req.query.before;
    if (beforeRaw !== undefined) {
        const ts =
            typeof beforeRaw === "string" ? Date.parse(beforeRaw) : NaN;
        if (Number.isNaN(ts)) {
            return void res.status(400).json({
                detail: "invalid 'before' cursor — expected ISO 8601",
            });
        }
    }
    const before =
        typeof beforeRaw === "string" ? beforeRaw : null;

    let mq = db
        .from("chat_messages")
        .select("*")
        .eq("chat_id", chatId);
    if (before) mq = mq.lt("created_at", before);
    const { data: messagesDesc } = await mq
        .order("created_at", { ascending: false })
        .limit(limit + 1); // fetch one extra to compute has_more
    const hasMore = (messagesDesc ?? []).length > limit;
    const pageDesc = (messagesDesc ?? []).slice(0, limit);
    const messages = [...pageDesc].reverse(); // back to ASC for client rendering

    const hydrated = await hydrateEditStatuses(messages, db);
    res.json({ chat, messages: hydrated, has_more: hasMore });
});

// Stored message annotations/events capture the `status` at the time the
// assistant produced the edit (always "pending"). If the user later accepts
// or rejects, `document_edits.status` is updated but the stored message
// annotation is not. On chat load we merge the current DB status in so
// EditCards render with the real state.
export async function hydrateEditStatuses(
    messages: Record<string, unknown>[],
    db: ReturnType<typeof createServerSupabase>,
): Promise<Record<string, unknown>[]> {
    const editIds = new Set<string>();
    const versionIds = new Set<string>();
    const collectFromAnnList = (list: unknown) => {
        if (!Array.isArray(list)) return;
        for (const a of list as Record<string, unknown>[]) {
            if (typeof a?.edit_id === "string") editIds.add(a.edit_id);
            if (typeof a?.version_id === "string")
                versionIds.add(a.version_id);
        }
    };
    for (const m of messages) {
        collectFromAnnList(m.annotations);
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
        next.annotations = patchAnnList(m.annotations);
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

// PATCH /chat/:chatId
chatRouter.patch("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { chatId } = req.params;
    const body = parseBody(PatchChatSchema, req, res);
    if (!body) return;
    const title = body.title.trim();

    const db = createServerSupabase();
    const { data, error } = await db
        .from("chats")
        .update({ title })
        .eq("id", chatId)
        .eq("user_id", userId)
        .select("id, title")
        .single();

    if (error || !data)
        return void res.status(404).json({ detail: "Chat not found" });
    res.json(data);
});

// DELETE /chat/:chatId
chatRouter.delete("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { chatId } = req.params;
    const db = createServerSupabase();
    const { data, error } = await db
        .from("chats")
        .delete()
        .eq("id", chatId)
        .eq("user_id", userId)
        .select("id");
    if (error) return void res.status(500).json({ detail: error.message });
    if (!data || data.length === 0)
        return void res.status(404).json({ detail: "Chat not found" });
    res.status(204).send();
});

// POST /chat/:chatId/generate-title
chatRouter.post("/:chatId/generate-title", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const body = parseBody(GenerateTitleSchema, req, res);
    if (!body) return;
    const message = body.message.trim();

    const db = createServerSupabase();
    const { data: chat, error } = await db
        .from("chats")
        .select("id, user_id, project_id")
        .eq("id", chatId)
        .single();

    if (error || !chat)
        return void res.status(404).json({ detail: "Chat not found" });
    let canTitle = chat.user_id === userId;
    if (!canTitle && chat.project_id) {
        const access = await checkProjectAccess(
            chat.project_id,
            userId,
            userEmail,
            db,
        );
        canTitle = access.ok;
    }
    if (!canTitle)
        return void res.status(404).json({ detail: "Chat not found" });

    try {
        const { title_model, api_keys } = await getUserModelSettings(
            userId,
            db,
            { route: req.path, requestId: req.id },
        );
        const titleText = await completeText({
            model: title_model,
            user: `Generate a concise title (3–6 words) for a chat in an AI Legal Platform that starts with this message. The title should describe the topic or document — do NOT include words like "Legal Assistant", "AI", "Chat", or any similar prefix. Return only the title, no quotes or punctuation.\n\nMessage: ${message.slice(0, 500)}`,
            maxTokens: 64,
            apiKeys: api_keys,
        });
        const title = titleText.trim() || message.slice(0, 60);

        // CLEAN-24: access already validated via checkProjectAccess above (~lines 301-311);
        // no user_id predicate here so shared-project members can persist titles.
        await db
            .from("chats")
            .update({ title })
            .eq("id", chatId);

        res.json({ title });
    } catch (err) {
        logger.error({ err }, "[generate-title] error");
        res.status(500).json({ detail: "Failed to generate title" });
    }
});

// POST /chat — streaming
chatRouter.post("/", requireAuth, llmRateLimiter, async (req, res) => {
    const userId = res.locals.userId as string;
    const body = parseBody(ChatStreamSchema, req, res);
    if (!body) return;
    const { messages, chat_id, project_id, model } = body as unknown as {
        messages: ChatMessage[];
        chat_id?: string;
        project_id?: string | null;
        model?: string;
    };

    logger.info({
        userId,
        chatId: chat_id,
        projectId: project_id,
        model,
        messageCount: messages?.length,
    }, "[chat/stream] incoming request");

    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    let chatId = chat_id ?? null;
    let chatTitle: string | null = null;

    if (chatId) {
        // Either chat owner OR a member of the chat's project can post.
        const { data: existing } = await db
            .from("chats")
            .select("id, title, user_id, project_id")
            .eq("id", chatId)
            .single();
        let canUse = !!existing && existing.user_id === userId;
        if (!canUse && existing?.project_id) {
            const access = await checkProjectAccess(
                existing.project_id,
                userId,
                userEmail,
                db,
            );
            canUse = access.ok;
        }
        if (!canUse || !existing) chatId = null;
        else chatTitle = existing.title;
    }

    if (!chatId) {
        // If creating a chat tied to a project, the user must have access
        // to the project (own or shared).
        if (project_id) {
            const access = await checkProjectAccess(
                project_id,
                userId,
                userEmail,
                db,
            );
            if (!access.ok)
                return void res
                    .status(404)
                    .json({ detail: "Project not found" });
        }
        const { data: newChat, error } = await db
            .from("chats")
            .insert({ user_id: userId, project_id: project_id ?? null })
            .select("id, title")
            .single();
        if (error || !newChat) {
            logger.error({ err: error }, "[chat/stream] failed to create chat");
            return void res
                .status(500)
                .json({ detail: "Failed to create chat" });
        }
        chatId = newChat.id as string;
        chatTitle = newChat.title;
    }

    logger.info({ chatId }, "[chat/stream] resolved chatId");

    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser) {
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
    );
    const docAvailability = Object.entries(docIndex).map(([doc_id, info]) => ({
        doc_id,
        filename: info.filename,
    }));
    const enrichedMessages = await enrichWithPriorEvents(
        messages,
        chatId,
        db,
        docIndex,
    );
    const apiMessages = buildMessages(enrichedMessages, docAvailability);

    const workflowStore = await buildWorkflowStore(userId, userEmail, db);

    logger.info({
        apiMessageCount: apiMessages.length,
        docCount: Object.keys(docIndex).length,
        workflowCount: Object.keys(workflowStore).length,
    }, "[chat/stream] starting LLM stream");

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const write = (line: string) => res.write(line);

    const apiKeys = await getUserApiKeys(userId, db, { route: req.path, requestId: req.id });

    try {
        write(`data: ${JSON.stringify({ type: "chat_id", chatId })}\n\n`);

        const { fullText, events } = await runLLMStream({
            apiMessages,
            docStore,
            docIndex,
            userId,
            db,
            write,
            workflowStore,
            model,
            apiKeys,
            projectId: project_id ?? null,
        });

        logger.info({
            fullTextLen: fullText?.length ?? 0,
            eventCount: events?.length ?? 0,
        }, "[chat/stream] LLM stream finished");

        const annotations = extractAnnotations(fullText, docIndex, events);
        await db.from("chat_messages").insert({
            chat_id: chatId,
            role: "assistant",
            content: events.length ? events : null,
            annotations: annotations.length ? annotations : null,
        });

        if (!chatTitle && lastUser?.content) {
            await db
                .from("chats")
                .update({ title: lastUser.content.slice(0, 120) })
                .eq("id", chatId);
        }
    } catch (err) {
        logger.error({ err }, "[chat/stream] error");
        try {
            write(
                `data: ${JSON.stringify({ type: "error", message: "Stream error" })}\n\n`,
            );
            write("data: [DONE]\n\n");
        } catch {
            /* ignore */
        }
    } finally {
        res.end();
    }
});
