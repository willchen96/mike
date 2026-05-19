import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
    buildProjectDocContext,
    buildMessages,
    buildWorkflowStore,
    enrichWithPriorEvents,
    extractAnnotations,
    runLLMStream,
    PROJECT_EXTRA_TOOLS,
    type ChatMessage,
} from "../lib/chatTools";
import { getUserApiKeys } from "../lib/userSettings";
import { checkProjectAccess } from "../lib/access";

const PROJECT_SYSTEM_PROMPT_EXTRA = `PROJECT CONTEXT:
You are operating within a project folder that contains a collection of legal documents the user has organised for a single matter. The user's questions will usually refer to one or more documents in this project — your job is to find the relevant files to work on. Use list_documents to see what is available and fetch_documents / read_document to pull in any documents you need before answering.

A document may currently be displayed in the user's side panel; when provided, treat it as context for the user's likely focus, but do NOT assume it is the only or definitive document the user is asking about. If the request could apply to other files in the project, identify and read those as well. Prefer coverage across the relevant project documents over an over-narrow reading of only the displayed one.

REPLICATING A DOCUMENT:
When the user wants to use an existing project document as a starting point for a new file (e.g. "use this NDA as a template", "make me a copy of the SOW so I can edit it", "duplicate this and adapt it for company X"), call the replicate_document tool with the source doc_id. This creates a byte-for-byte copy as a new project document, returns a fresh doc_id slug, and shows a download/open card in the UI. Then call edit_document on the returned slug to make the user's requested changes — do NOT call generate_docx for cases where the user clearly wants the existing document's structure and formatting preserved.`;

export const projectChatRouter = Router({ mergeParams: true });

// Mirrors the hand-written parsers in routes/chat.ts so this route doesn't
// rely on a bare `req.body as { ... }` cast — every field flowing into the
// LLM, the DB, or the response stream is shape-checked first.

function parseChatMessages(value: unknown):
    | { ok: true; messages: ChatMessage[] }
    | { ok: false; detail: string } {
    if (!Array.isArray(value) || value.length === 0) {
        return { ok: false, detail: "messages must be a non-empty array" };
    }
    for (const message of value) {
        if (!message || typeof message !== "object" || Array.isArray(message)) {
            return { ok: false, detail: "messages must contain objects" };
        }
        const row = message as Record<string, unknown>;
        if (typeof row.role !== "string") {
            return { ok: false, detail: "message.role must be a string" };
        }
        if (row.content !== null && typeof row.content !== "string") {
            return {
                ok: false,
                detail: "message.content must be a string or null",
            };
        }
    }
    return { ok: true, messages: value as ChatMessage[] };
}

function parseOptionalChatId(value: unknown):
    | { ok: true; chatId: string | null }
    | { ok: false; detail: string } {
    if (value === undefined || value === null) return { ok: true, chatId: null };
    if (typeof value !== "string" || !value.trim()) {
        return { ok: false, detail: "chat_id must be a non-empty string" };
    }
    return { ok: true, chatId: value.trim() };
}

function parseOptionalModel(value: unknown):
    | { ok: true; model: string | undefined }
    | { ok: false; detail: string } {
    if (value === undefined) return { ok: true, model: undefined };
    if (typeof value !== "string" || !value.trim()) {
        return { ok: false, detail: "model must be a non-empty string" };
    }
    return { ok: true, model: value.trim() };
}

function parseDocRef(value: unknown):
    | { ok: true; ref: { filename: string; document_id: string } }
    | { ok: false; detail: string } {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { ok: false, detail: "expected an object with filename and document_id" };
    }
    const row = value as Record<string, unknown>;
    if (typeof row.filename !== "string" || !row.filename.trim()) {
        return { ok: false, detail: "filename must be a non-empty string" };
    }
    if (typeof row.document_id !== "string" || !row.document_id.trim()) {
        return { ok: false, detail: "document_id must be a non-empty string" };
    }
    return {
        ok: true,
        ref: { filename: row.filename, document_id: row.document_id },
    };
}

function parseOptionalDisplayedDoc(value: unknown):
    | { ok: true; doc: { filename: string; document_id: string } | undefined }
    | { ok: false; detail: string } {
    if (value === undefined || value === null) return { ok: true, doc: undefined };
    const parsed = parseDocRef(value);
    if (!parsed.ok) return { ok: false, detail: `displayed_doc: ${parsed.detail}` };
    return { ok: true, doc: parsed.ref };
}

function parseOptionalAttachedDocuments(value: unknown):
    | { ok: true; docs: { filename: string; document_id: string }[] | undefined }
    | { ok: false; detail: string } {
    if (value === undefined || value === null) return { ok: true, docs: undefined };
    if (!Array.isArray(value)) {
        return { ok: false, detail: "attached_documents must be an array" };
    }
    const out: { filename: string; document_id: string }[] = [];
    for (const entry of value) {
        const parsed = parseDocRef(entry);
        if (!parsed.ok)
            return { ok: false, detail: `attached_documents: ${parsed.detail}` };
        out.push(parsed.ref);
    }
    return { ok: true, docs: out };
}

// POST /projects/:projectId/chat — streaming
projectChatRouter.post("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const messagesParsed = parseChatMessages(body.messages);
    if (!messagesParsed.ok)
        return void res.status(400).json({ detail: messagesParsed.detail });
    const chatIdParsed = parseOptionalChatId(body.chat_id);
    if (!chatIdParsed.ok)
        return void res.status(400).json({ detail: chatIdParsed.detail });
    const modelParsed = parseOptionalModel(body.model);
    if (!modelParsed.ok)
        return void res.status(400).json({ detail: modelParsed.detail });
    const displayedDocParsed = parseOptionalDisplayedDoc(body.displayed_doc);
    if (!displayedDocParsed.ok)
        return void res.status(400).json({ detail: displayedDocParsed.detail });
    const attachedDocsParsed = parseOptionalAttachedDocuments(
        body.attached_documents,
    );
    if (!attachedDocsParsed.ok)
        return void res.status(400).json({ detail: attachedDocsParsed.detail });

    const messages = messagesParsed.messages;
    const chat_id = chatIdParsed.chatId ?? undefined;
    const model = modelParsed.model;
    const displayed_doc = displayedDocParsed.doc;
    const attached_documents = attachedDocsParsed.docs;

    const db = createServerSupabase();

    // Verify the user has access to the project (owner or shared member).
    const projectAccess = await checkProjectAccess(
        projectId,
        userId,
        userEmail,
        db,
    );
    if (!projectAccess.ok)
        return void res.status(404).json({ detail: "Project not found" });

    let chatId = chat_id ?? null;
    let chatTitle: string | null = null;

    if (chatId) {
        const { data: existing } = await db
            .from("chats")
            .select("id, title, project_id")
            .eq("id", chatId)
            .single();
        const canUse = !!existing && existing.project_id === projectId;
        if (!canUse) chatId = null;
        else chatTitle = existing!.title;
    }

    if (!chatId) {
        const { data: newChat, error } = await db
            .from("chats")
            .insert({ user_id: userId, project_id: projectId })
            .select("id, title")
            .single();
        if (error || !newChat)
            return void res
                .status(500)
                .json({ detail: "Failed to create chat" });
        chatId = newChat.id as string;
        chatTitle = newChat.title;
    }

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

    const { docIndex, docStore, folderPaths } = await buildProjectDocContext(
        projectId,
        userId,
        db,
    );
    const docAvailability = Object.entries(docIndex).map(([doc_id, info]) => ({
        doc_id,
        filename: info.filename,
        folder_path: folderPaths.get(doc_id),
    }));

    const enrichedMessages = await enrichWithPriorEvents(
        messages,
        chatId,
        db,
        docIndex,
    );
    const messagesForLLM: ChatMessage[] = displayed_doc
        ? enrichedMessages.map((m, i) => {
              if (i !== enrichedMessages.length - 1 || m.role !== "user")
                  return m;
              return {
                  ...m,
                  content: `${m.content}\n\ndisplayed_doc: ${displayed_doc.filename}, displayed_doc_id: ${displayed_doc.document_id}`,
              };
          })
        : enrichedMessages;

    // The user-attached docs for this turn (dragged into / picked from
    // the chat input) come in as a request-level field. Surface them in
    // the system prompt with the current-turn doc_id slugs so the model
    // knows which docs the user is highlighting *now*, distinct from
    // the broader project doc list.
    let systemPromptExtra = PROJECT_SYSTEM_PROMPT_EXTRA;
    if (attached_documents?.length) {
        const slugByDocumentId = new Map<string, string>();
        for (const [slug, info] of Object.entries(docIndex)) {
            if (info.document_id)
                slugByDocumentId.set(info.document_id, slug);
        }
        const lines = attached_documents.map((d) => {
            const slug = slugByDocumentId.get(d.document_id);
            return slug ? `- ${slug}: ${d.filename}` : `- ${d.filename}`;
        });
        systemPromptExtra += `\n\nUSER-ATTACHED DOCUMENTS FOR THIS TURN:\nThe user has attached the following document(s) directly to their latest message. Treat these as the primary focus of the request unless their message clearly says otherwise.\n${lines.join("\n")}`;
    }

    const apiMessages = buildMessages(
        messagesForLLM,
        docAvailability,
        systemPromptExtra,
    );

    const workflowStore = await buildWorkflowStore(userId, userEmail, db);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const write = (line: string) => res.write(line);

    const apiKeys = await getUserApiKeys(userId, db);

    try {
        write(`data: ${JSON.stringify({ type: "chat_id", chatId })}\n\n`);

        const { fullText, events } = await runLLMStream({
            apiMessages,
            docStore,
            docIndex,
            userId,
            db,
            write,
            extraTools: PROJECT_EXTRA_TOOLS,
            workflowStore,
            model,
            apiKeys,
            projectId,
        });

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
        console.error("[project-chat/stream] error:", err);
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
