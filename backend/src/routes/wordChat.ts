import { randomUUID } from "node:crypto";
import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
  AssistantStreamError,
  ASSISTANT_ERROR_MESSAGE,
  ACTIVE_WORD_DOCUMENT_ID,
  buildCancelledAssistantMessage,
  buildDocContext,
  buildMessages,
  buildUserPersonalisationPrompt,
  buildWordChatSystemPrompt,
  buildWorkflowStore,
  enrichWithPriorEvents,
  extractCitations,
  generateSpotlightNonce,
  isAbortError,
  parseChatMessages,
  parseOptionalChatId,
  parseOptionalDocumentContext,
  parseOptionalModel,
  parseOptionalReasoning,
  createReservedAssistantMessageUpdater,
  createWordClientToolsAdapter,
  openAssistantSse,
  reserveAssistantMessage,
  runLLMStream,
  stripTransientAssistantEvents,
  submitClientToolResult,
  withoutEmptyAssistantReservations,
} from "../lib/chat";
import { enqueueChatTurnAudit } from "../lib/audit";
import {
  getUserModelSettings,
  persistLastSelectedChatModel,
  persistLastSelectedReasoningLevel,
} from "../lib/userSettings";
import {
  resolveEffectiveChatModel,
  resolveEffectiveReasoningLevel,
} from "../lib/modelSelection";
import {
  persistWordDocumentEdits,
  WORD_EDIT_FORMATS,
  type WordEditApplyMode,
} from "../lib/chat/wordDocumentEdits";

export const wordChatRouter = Router();

type Db = ReturnType<typeof createServerSupabase>;
type WordChatStorageMode = "cloud" | "local";
type LookupResult<T> =
  | { ok: true; value: T | null }
  | { ok: false; detail: string };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseDocumentId(
  value: unknown,
): { ok: true; value: string } | { ok: false; detail: string } {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return { ok: false, detail: "document_id must be a UUID" };
  }
  return { ok: true, value };
}

function parseDocumentName(
  value: unknown,
): { ok: true; value: string } | { ok: false; detail: string } {
  if (value === undefined || value === null) {
    return { ok: true, value: "Word document" };
  }
  if (typeof value !== "string" || !value.trim()) {
    return {
      ok: false,
      detail: "document_name must be a non-empty string",
    };
  }
  const documentName = value.trim();
  if (documentName.length > 255) {
    return {
      ok: false,
      detail: "document_name must be at most 255 characters",
    };
  }
  return { ok: true, value: documentName };
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function parseStorageMode(
  value: unknown,
): { ok: true; value: WordChatStorageMode } | { ok: false; detail: string } {
  if (value === undefined || value === null || value === "cloud") {
    return { ok: true, value: "cloud" };
  }
  if (value === "local") return { ok: true, value: "local" };
  return { ok: false, detail: 'storage must be "cloud" or "local"' };
}

function parseEditApplyMode(
  value: unknown,
): { ok: true; value: WordEditApplyMode } | { ok: false; detail: string } {
  if (value === undefined || value === null || value === "approval") {
    return { ok: true, value: "approval" };
  }
  if (value === "direct") return { ok: true, value: "direct" };
  return {
    ok: false,
    detail: 'edit_apply_mode must be "direct" or "approval"',
  };
}

async function getWordDocumentRowId(
  clientDocumentId: string,
  userId: string,
  db: Db,
): Promise<LookupResult<string>> {
  const { data, error } = await db
    .from("word_documents")
    .select("id")
    .eq("user_id", userId)
    .eq("client_document_id", clientDocumentId)
    .maybeSingle();
  if (error) return { ok: false, detail: error.message };
  if (!data) return { ok: true, value: null };
  return { ok: true, value: data.id as string };
}

async function ensureWordDocumentRow(
  clientDocumentId: string,
  userId: string,
  db: Db,
): Promise<string | null> {
  const { data, error } = await db
    .from("word_documents")
    .upsert(
      {
        user_id: userId,
        client_document_id: clientDocumentId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,client_document_id" },
    )
    .select("id")
    .single();
  if (error || !data) {
    console.error("[word-chat] failed to resolve document", error);
    return null;
  }
  return data.id as string;
}

async function getAccessibleWordChat(
  chatId: string,
  wordDocumentRowId: string,
  userId: string,
  db: Db,
): Promise<LookupResult<Record<string, unknown>>> {
  const { data, error } = await db
    .from("word_chats")
    .select("*")
    .eq("id", chatId)
    .eq("word_document_id", wordDocumentRowId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return { ok: false, detail: error.message };
  if (!data) return { ok: true, value: null };
  return {
    ok: true,
    value: { ...(data as Record<string, unknown>), project_id: null },
  };
}

async function getAccessibleWordMessage(args: {
  messageId: string;
  clientDocumentId: string;
  userId: string;
  db: Db;
}): Promise<LookupResult<Record<string, unknown>>> {
  const documentLookup = await getWordDocumentRowId(
    args.clientDocumentId,
    args.userId,
    args.db,
  );
  if (!documentLookup.ok) return documentLookup;
  if (!documentLookup.value) return { ok: true, value: null };
  const { data: message, error } = await args.db
    .from("word_chat_messages")
    .select("id, chat_id, role")
    .eq("id", args.messageId)
    .maybeSingle();
  if (error) return { ok: false, detail: error.message };
  if (!message || message.role !== "assistant") {
    return { ok: true, value: null };
  }
  const chatLookup = await getAccessibleWordChat(
    message.chat_id as string,
    documentLookup.value,
    args.userId,
    args.db,
  );
  if (!chatLookup.ok || !chatLookup.value) return chatLookup;
  return { ok: true, value: message as Record<string, unknown> };
}

function parseBlockIndex(
  value: string,
): { ok: true; value: number } | { ok: false; detail: string } {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    return {
      ok: false,
      detail: "blockIndex must be a non-negative integer",
    };
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 10_000) {
    return { ok: false, detail: "blockIndex is out of range" };
  }
  return { ok: true, value: parsed };
}

function parseProposedWordEdit(value: unknown):
  | {
      ok: true;
      value: {
        original_text: string;
        replacement_text: string;
        formats: string[];
        occurrence: "all" | null;
        reason: string | null;
        apply_mode: WordEditApplyMode;
      };
    }
  | { ok: false; detail: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, detail: "edit body is required" };
  }
  const body = value as Record<string, unknown>;
  const original =
    typeof body.original_text === "string" ? body.original_text : "";
  if (!original.trim()) {
    return { ok: false, detail: "original_text is required" };
  }
  if (original.length > 200) {
    return {
      ok: false,
      detail: "original_text must be at most 200 characters",
    };
  }
  const replacement =
    typeof body.replacement_text === "string" ? body.replacement_text : "";
  if (replacement.length > 200_000) {
    return { ok: false, detail: "replacement_text is too long" };
  }
  const formats = Array.isArray(body.formats)
    ? body.formats.filter(
        (entry): entry is string =>
          typeof entry === "string" && WORD_EDIT_FORMATS.has(entry),
      )
    : [];
  if (Array.isArray(body.formats) && formats.length !== body.formats.length) {
    return { ok: false, detail: "formats contains an unsupported value" };
  }
  const parsedMode = parseEditApplyMode(body.apply_mode);
  if (!parsedMode.ok) return parsedMode;
  if (
    body.occurrence !== undefined &&
    body.occurrence !== null &&
    body.occurrence !== "all"
  ) {
    return { ok: false, detail: 'occurrence must be "all" or null' };
  }
  return {
    ok: true,
    value: {
      original_text: original,
      replacement_text: replacement,
      formats,
      occurrence: body.occurrence === "all" ? "all" : null,
      reason:
        typeof body.reason === "string" && body.reason.trim()
          ? body.reason.trim().slice(0, 10_000)
          : null,
      apply_mode: parsedMode.value,
    },
  };
}

// GET /word-chat?document_id=<embedded document UUID>&limit=10
wordChatRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const parsedDocumentId = parseDocumentId(req.query.document_id);
  if (!parsedDocumentId.ok) {
    return void res.status(400).json({ detail: parsedDocumentId.detail });
  }
  const requestedLimit = Number.parseInt(String(req.query.limit ?? "50"), 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 100)
    : 50;
  const requestedOffset = Number.parseInt(String(req.query.offset ?? "0"), 10);
  const offset = Number.isFinite(requestedOffset)
    ? Math.max(requestedOffset, 0)
    : 0;
  const db = createServerSupabase();
  const documentLookup = await getWordDocumentRowId(
    parsedDocumentId.value,
    userId,
    db,
  );
  if (!documentLookup.ok) {
    console.error(
      "[word-chat] failed to load document chats",
      documentLookup.detail,
    );
    return void res.status(500).json({ detail: "Failed to load Word chats" });
  }
  const wordDocumentRowId = documentLookup.value;
  if (!wordDocumentRowId) return void res.json([]);

  let query = db
    .from("word_chats")
    .select(
      "id, user_id, title, model, reasoning_level, created_at, updated_at",
    )
    .eq("word_document_id", wordDocumentRowId)
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  query =
    offset > 0 ? query.range(offset, offset + limit - 1) : query.limit(limit);
  const { data, error } = await query;
  if (error) {
    console.error("[word-chat] failed to list chats", error);
    return void res.status(500).json({ detail: "Failed to load Word chats" });
  }
  res.json((data ?? []).map((chat) => ({ ...chat, project_id: null })));
});

// GET /word-chat/:chatId?document_id=<embedded document UUID>
wordChatRouter.get("/:chatId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const parsedDocumentId = parseDocumentId(req.query.document_id);
  if (!parsedDocumentId.ok) {
    return void res.status(400).json({ detail: parsedDocumentId.detail });
  }
  if (!isUuid(req.params.chatId)) {
    return void res.status(404).json({ detail: "Chat not found" });
  }
  const db = createServerSupabase();
  const documentLookup = await getWordDocumentRowId(
    parsedDocumentId.value,
    userId,
    db,
  );
  if (!documentLookup.ok) {
    console.error(
      "[word-chat] failed to resolve chat document",
      documentLookup.detail,
    );
    return void res.status(500).json({ detail: "Failed to load Word chat" });
  }
  const wordDocumentRowId = documentLookup.value;
  if (!wordDocumentRowId) {
    return void res.status(404).json({ detail: "Chat not found" });
  }
  const chatLookup = await getAccessibleWordChat(
    req.params.chatId,
    wordDocumentRowId,
    userId,
    db,
  );
  if (!chatLookup.ok) {
    console.error("[word-chat] failed to load chat", chatLookup.detail);
    return void res.status(500).json({ detail: "Failed to load Word chat" });
  }
  const chat = chatLookup.value;
  if (!chat) return void res.status(404).json({ detail: "Chat not found" });

  const { data: messages, error } = await db
    .from("word_chat_messages")
    .select("*")
    .eq("chat_id", req.params.chatId)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("[word-chat] failed to load messages", error);
    return void res.status(500).json({ detail: "Failed to load Word chat" });
  }
  const visibleMessages = withoutEmptyAssistantReservations(messages ?? []);
  const assistantMessageIds = visibleMessages.flatMap((message) =>
    message.role === "assistant" && typeof message.id === "string"
      ? [message.id]
      : [],
  );
  const editsByMessage = new Map<string, Record<string, unknown>[]>();
  if (assistantMessageIds.length > 0) {
    const { data: edits, error: editsError } = await db
      .from("word_document_edits")
      .select("*")
      .in("word_chat_message_id", assistantMessageIds)
      .order("block_index", { ascending: true });
    if (editsError) {
      console.error("[word-chat] failed to load document edits", editsError);
      return void res.status(500).json({ detail: "Failed to load Word chat" });
    }
    for (const edit of (edits ?? []) as Record<string, unknown>[]) {
      const messageId = edit.word_chat_message_id;
      if (typeof messageId !== "string") continue;
      const current = editsByMessage.get(messageId) ?? [];
      current.push(edit);
      editsByMessage.set(messageId, current);
    }
  }
  res.json({
    chat,
    messages: visibleMessages.map((message) => ({
      ...message,
      ...(typeof message.id === "string" && editsByMessage.has(message.id)
        ? { edits: editsByMessage.get(message.id) }
        : {}),
    })),
  });
});

// PATCH /word-chat/:chatId/model?document_id=<embedded document UUID>
// Selection-time persistence for an existing cloud Word chat.
wordChatRouter.patch("/:chatId/model", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const parsedDocumentId = parseDocumentId(req.query.document_id);
  if (!parsedDocumentId.ok) {
    return void res.status(400).json({ detail: parsedDocumentId.detail });
  }
  if (!isUuid(req.params.chatId)) {
    return void res.status(404).json({ detail: "Chat not found" });
  }
  const parsedModel = parseOptionalModel(req.body?.model);
  if (!parsedModel.ok || !parsedModel.value) {
    return void res.status(400).json({
      detail: parsedModel.ok ? "model is required" : parsedModel.detail,
    });
  }

  const db = createServerSupabase();
  const documentLookup = await getWordDocumentRowId(
    parsedDocumentId.value,
    userId,
    db,
  );
  if (!documentLookup.ok) {
    console.error(
      "[word-chat] failed to resolve model-selection document",
      documentLookup.detail,
    );
    return void res.status(500).json({ detail: "Failed to save chat model" });
  }
  if (!documentLookup.value) {
    return void res.status(404).json({ detail: "Chat not found" });
  }
  const chatLookup = await getAccessibleWordChat(
    req.params.chatId,
    documentLookup.value,
    userId,
    db,
  );
  if (!chatLookup.ok) {
    console.error(
      "[word-chat] failed to load model-selection chat",
      chatLookup.detail,
    );
    return void res.status(500).json({ detail: "Failed to save chat model" });
  }
  if (!chatLookup.value) {
    return void res.status(404).json({ detail: "Chat not found" });
  }

  const settings = await getUserModelSettings(userId, db);
  const resolution = await resolveEffectiveChatModel({
    requested: parsedModel.value,
    chatModel: chatLookup.value.model as string | null,
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

  const { error } = await db
    .from("word_chats")
    .update({
      model: resolution.model,
      updated_at: new Date().toISOString(),
    })
    .eq("id", req.params.chatId)
    .eq("user_id", userId);
  if (error) {
    console.error("[word-chat] failed to save selected chat model", error);
    return void res.status(500).json({ detail: "Failed to save chat model" });
  }
  const profileError = await persistLastSelectedChatModel(
    userId,
    resolution.model,
    db,
  );
  if (profileError) {
    console.error(
      "[word-chat] failed to save last-selected model",
      profileError,
    );
    return void res.status(500).json({ detail: "Failed to save chat model" });
  }
  res.json({ id: req.params.chatId, model: resolution.model });
});

// PATCH /word-chat/:chatId/reasoning?document_id=<embedded document UUID>
wordChatRouter.patch("/:chatId/reasoning", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const parsedDocumentId = parseDocumentId(req.query.document_id);
  if (!parsedDocumentId.ok) {
    return void res.status(400).json({ detail: parsedDocumentId.detail });
  }
  const parsedReasoning = parseOptionalReasoning(req.body?.reasoningLevel);
  if (
    !isUuid(req.params.chatId) ||
    !parsedReasoning.ok ||
    !parsedReasoning.value
  ) {
    return void res.status(400).json({
      detail: parsedReasoning.ok
        ? "reasoningLevel is required"
        : parsedReasoning.detail,
    });
  }
  const db = createServerSupabase();
  const documentLookup = await getWordDocumentRowId(
    parsedDocumentId.value,
    userId,
    db,
  );
  if (!documentLookup.ok || !documentLookup.value) {
    return void res.status(404).json({ detail: "Chat not found" });
  }
  const chatLookup = await getAccessibleWordChat(
    req.params.chatId,
    documentLookup.value,
    userId,
    db,
  );
  if (!chatLookup.ok || !chatLookup.value) {
    return void res.status(404).json({ detail: "Chat not found" });
  }
  const { error } = await db
    .from("word_chats")
    .update({
      reasoning_level: parsedReasoning.value,
      updated_at: new Date().toISOString(),
    })
    .eq("id", req.params.chatId)
    .eq("user_id", userId);
  if (error)
    return void res.status(500).json({ detail: "Failed to save reasoning" });
  const profileError = await persistLastSelectedReasoningLevel(
    userId,
    parsedReasoning.value,
    db,
  );
  if (profileError) {
    return void res.status(500).json({ detail: "Failed to save reasoning" });
  }
  res.json({
    id: req.params.chatId,
    reasoning_level: parsedReasoning.value,
  });
});

// PUT /word-chat/messages/:messageId/edits/:blockIndex
// Idempotently creates the canonical edit row as soon as a streamed edit
// block seals. The final assistant-message save later replaces the raw tags
// with a lightweight reference to the same row.
wordChatRouter.put(
  "/messages/:messageId/edits/:blockIndex",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const parsedDocumentId = parseDocumentId(req.query.document_id);
    if (!parsedDocumentId.ok) {
      return void res.status(400).json({ detail: parsedDocumentId.detail });
    }
    if (!isUuid(req.params.messageId)) {
      return void res.status(404).json({ detail: "Message not found" });
    }
    const parsedBlockIndex = parseBlockIndex(req.params.blockIndex);
    if (!parsedBlockIndex.ok) {
      return void res.status(400).json({ detail: parsedBlockIndex.detail });
    }
    const parsedEdit = parseProposedWordEdit(req.body);
    if (!parsedEdit.ok) {
      return void res.status(400).json({ detail: parsedEdit.detail });
    }
    const db = createServerSupabase();
    const messageLookup = await getAccessibleWordMessage({
      messageId: req.params.messageId,
      clientDocumentId: parsedDocumentId.value,
      userId,
      db,
    });
    if (!messageLookup.ok) {
      console.error(
        "[word-chat] failed to validate edit message",
        messageLookup.detail,
      );
      return void res.status(500).json({ detail: "Failed to save Word edit" });
    }
    if (!messageLookup.value) {
      return void res.status(404).json({ detail: "Message not found" });
    }
    const { error: insertError } = await db
      .from("word_document_edits")
      .upsert(
        {
          word_chat_message_id: req.params.messageId,
          block_index: parsedBlockIndex.value,
          ...parsedEdit.value,
        },
        {
          onConflict: "word_chat_message_id,block_index",
          ignoreDuplicates: true,
        },
      )
      .select("id");
    if (insertError) {
      console.error("[word-chat] failed to save edit", insertError);
      return void res.status(500).json({ detail: "Failed to save Word edit" });
    }
    // The first sealed payload is canonical. A retry returns that row without
    // rewriting its text, apply mode, or any lifecycle state already recorded.
    const { data, error } = await db
      .from("word_document_edits")
      .select("*")
      .eq("word_chat_message_id", req.params.messageId)
      .eq("block_index", parsedBlockIndex.value)
      .maybeSingle();
    if (error || !data) {
      console.error("[word-chat] failed to load edit", error);
      return void res.status(500).json({ detail: "Failed to save Word edit" });
    }
    res.json(data);
  },
);

// PATCH /word-chat/messages/:messageId/edits/:blockIndex
// Stores durable apply and accept/reject outcomes without rewriting the
// assistant message JSON.
wordChatRouter.patch(
  "/messages/:messageId/edits/:blockIndex",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const parsedDocumentId = parseDocumentId(req.query.document_id);
    if (!parsedDocumentId.ok) {
      return void res.status(400).json({ detail: parsedDocumentId.detail });
    }
    if (!isUuid(req.params.messageId)) {
      return void res.status(404).json({ detail: "Message not found" });
    }
    const parsedBlockIndex = parseBlockIndex(req.params.blockIndex);
    if (!parsedBlockIndex.ok) {
      return void res.status(400).json({ detail: parsedBlockIndex.detail });
    }
    const body =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (body.apply_status !== undefined) {
      if (
        body.apply_status !== "proposed" &&
        body.apply_status !== "applied" &&
        body.apply_status !== "unmanaged" &&
        body.apply_status !== "failed"
      ) {
        return void res.status(400).json({ detail: "Invalid apply_status" });
      }
      patch.apply_status = body.apply_status;
      if (body.apply_status === "applied") {
        patch.applied_at = new Date().toISOString();
      }
    }
    if (body.resolution_status !== undefined) {
      if (
        body.resolution_status !== "accepted" &&
        body.resolution_status !== "rejected"
      ) {
        return void res
          .status(400)
          .json({ detail: "Invalid resolution_status" });
      }
      patch.resolution_status = body.resolution_status;
      patch.apply_status = "applied";
      patch.resolved_at = new Date().toISOString();
    }
    for (const field of [
      "matched_occurrences",
      "applied_occurrences",
    ] as const) {
      if (body[field] === undefined) continue;
      if (
        typeof body[field] !== "number" ||
        !Number.isSafeInteger(body[field]) ||
        body[field] < 0
      ) {
        return void res.status(400).json({ detail: `Invalid ${field}` });
      }
      patch[field] = body[field];
    }
    for (const field of ["error_code", "error_message"] as const) {
      if (body[field] === undefined) continue;
      if (body[field] !== null && typeof body[field] !== "string") {
        return void res.status(400).json({ detail: `Invalid ${field}` });
      }
      patch[field] =
        typeof body[field] === "string" ? body[field].slice(0, 10_000) : null;
    }
    if (Object.keys(patch).length === 1) {
      return void res.status(400).json({ detail: "No edit fields supplied" });
    }
    const db = createServerSupabase();
    const messageLookup = await getAccessibleWordMessage({
      messageId: req.params.messageId,
      clientDocumentId: parsedDocumentId.value,
      userId,
      db,
    });
    if (!messageLookup.ok) {
      return void res
        .status(500)
        .json({ detail: "Failed to update Word edit" });
    }
    if (!messageLookup.value) {
      return void res.status(404).json({ detail: "Message not found" });
    }
    const { data, error } = await db
      .from("word_document_edits")
      .update(patch)
      .eq("word_chat_message_id", req.params.messageId)
      .eq("block_index", parsedBlockIndex.value)
      .select("*")
      .maybeSingle();
    if (error) {
      console.error("[word-chat] failed to update edit", error);
      return void res
        .status(500)
        .json({ detail: "Failed to update Word edit" });
    }
    if (!data) return void res.status(404).json({ detail: "Edit not found" });
    res.json(data);
  },
);

// POST /word-chat/tool-result — the task pane's return channel for a
// client-executed tool call. The SSE stream carries a `client_tool_call`
// frame down to the pane; the pane executes it with Office.js and posts the
// outcome here, which resolves the tool loop awaiting inside POST /word-chat.
wordChatRouter.post("/tool-result", requireAuth, (req, res) => {
  const userId = res.locals.userId as string;
  const body =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};
  if (typeof body.tool_call_id !== "string" || !isUuid(body.tool_call_id)) {
    return void res.status(400).json({ detail: "tool_call_id must be a UUID" });
  }
  // `result` is opaque here; the awaiting adapter normalizes it. Delivery
  // fails for expired, unknown, or foreign ids — all three answer the same
  // 404 so the endpoint cannot be probed for live call ids.
  const delivered = submitClientToolResult(
    body.tool_call_id,
    userId,
    body.result,
  );
  if (!delivered) {
    return void res
      .status(404)
      .json({ detail: "Unknown or expired tool call" });
  }
  res.status(204).end();
});

// POST /word-chat — Word-specific streaming endpoint.
wordChatRouter.post("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
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
  if (parsedChatId.value && !isUuid(parsedChatId.value)) {
    return void res.status(400).json({ detail: "chat_id must be a UUID" });
  }
  const parsedModel = parseOptionalModel(body.model);
  if (!parsedModel.ok) {
    return void res.status(400).json({ detail: parsedModel.detail });
  }
  const parsedReasoning = parseOptionalReasoning(body.reasoning);
  if (!parsedReasoning.ok) {
    return void res.status(400).json({ detail: parsedReasoning.detail });
  }
  const parsedDocumentContext = parseOptionalDocumentContext(
    body.document_context,
  );
  if (!parsedDocumentContext.ok) {
    return void res.status(400).json({ detail: parsedDocumentContext.detail });
  }
  const parsedDocumentId = parseDocumentId(body.document_id);
  if (!parsedDocumentId.ok) {
    return void res.status(400).json({ detail: parsedDocumentId.detail });
  }
  const parsedDocumentName = parseDocumentName(body.document_name);
  if (!parsedDocumentName.ok) {
    return void res.status(400).json({ detail: parsedDocumentName.detail });
  }
  const parsedStorage = parseStorageMode(body.storage);
  if (!parsedStorage.ok) {
    return void res.status(400).json({ detail: parsedStorage.detail });
  }
  const parsedEditApplyMode = parseEditApplyMode(body.edit_apply_mode);
  if (!parsedEditApplyMode.ok) {
    return void res.status(400).json({ detail: parsedEditApplyMode.detail });
  }
  // Capability flag from the task pane. Only a pane that declares it can
  // answer client_tool_call frames; older panes keep the streamed <EDITS>
  // protocol so they are never handed tool calls they would ignore.
  const clientToolsEnabled = body.client_tools === true;

  const messages = parsedMessages.value;
  const clientDocumentId = parsedDocumentId.value;
  const activeDocumentName = parsedDocumentName.value;
  const persistChat = parsedStorage.value === "cloud";
  const editApplyMode = parsedEditApplyMode.value;
  const db = createServerSupabase();
  let chatId = parsedChatId.value;
  let chatTitle: string | null = null;
  let chatModel: string | null = null;
  let chatReasoningLevel: string | null = null;
  let wordDocumentRowId: string | null = null;

  if (persistChat) {
    wordDocumentRowId = await ensureWordDocumentRow(
      clientDocumentId,
      userId,
      db,
    );
    if (!wordDocumentRowId) {
      return void res
        .status(500)
        .json({ detail: "Failed to initialize Word chat storage" });
    }
  }

  if (chatId && persistChat) {
    const existingLookup = await getAccessibleWordChat(
      chatId,
      wordDocumentRowId as string,
      userId,
      db,
    );
    if (!existingLookup.ok) {
      console.error("[word-chat] failed to resume chat", existingLookup.detail);
      return void res
        .status(500)
        .json({ detail: "Failed to resume Word chat" });
    }
    const existing = existingLookup.value;
    if (!existing) {
      return void res.status(404).json({ detail: "Chat not found" });
    }
    chatTitle = typeof existing.title === "string" ? existing.title : null;
    chatModel = typeof existing.model === "string" ? existing.model : null;
    chatReasoningLevel =
      typeof existing.reasoning_level === "string"
        ? existing.reasoning_level
        : null;
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
  const selectedModel = modelResolution.model;
  const selectedReasoningLevel = resolveEffectiveReasoningLevel({
    model: selectedModel,
    requested: parsedReasoning.value,
    chatReasoningLevel,
    lastSelectedReasoningLevel: modelSettings.last_selected_reasoning_level,
  });

  if (
    chatId &&
    persistChat &&
    (chatModel !== selectedModel ||
      chatReasoningLevel !== selectedReasoningLevel)
  ) {
    const { error } = await db
      .from("word_chats")
      .update({
        model: selectedModel,
        reasoning_level: selectedReasoningLevel,
      })
      .eq("id", chatId)
      .eq("user_id", userId);
    if (error) {
      return void res.status(500).json({ detail: "Failed to save chat model" });
    }
  }

  if (!chatId && persistChat) {
    const { data, error } = await db
      .from("word_chats")
      .insert({
        user_id: userId,
        word_document_id: wordDocumentRowId,
        model: selectedModel,
        reasoning_level: selectedReasoningLevel,
      })
      .select("id, title")
      .single();
    if (error || !data) {
      console.error("[word-chat] failed to create chat", error);
      return void res
        .status(500)
        .json({ detail: "Failed to create Word chat" });
    }
    chatId = data.id as string;
    chatTitle = (data.title as string | null) ?? null;
  }
  if (!chatId) chatId = randomUUID();

  const lastUser = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  if (lastUser && persistChat) {
    // Persist only the user's actual message. The Word edit contract is added
    // later as a system prompt and therefore cannot leak into chat history.
    const { error } = await db.from("word_chat_messages").insert({
      chat_id: chatId,
      role: "user",
      content: lastUser.content,
      files: lastUser.files ?? null,
      workflow: lastUser.workflow ?? null,
    });
    if (error) {
      return void res
        .status(500)
        .json({ detail: "Failed to save Word message" });
    }
  }

  const { docIndex, docStore } = await buildDocContext(
    messages,
    userId,
    db,
    persistChat ? chatId : null,
    "word_chat_messages",
    userEmail,
  );
  const activeDocumentText = parsedDocumentContext.documentContext;
  if (activeDocumentText !== undefined) {
    docStore.set(ACTIVE_WORD_DOCUMENT_ID, {
      // This is an in-memory identity, never a Supabase storage path.
      storage_path: `inline:word-document:${clientDocumentId}`,
      file_type: "text/markdown",
      filename: activeDocumentName,
      inline_text: activeDocumentText,
    });
  }
  const docAvailability = [
    ...(activeDocumentText !== undefined
      ? [
          {
            doc_id: ACTIVE_WORD_DOCUMENT_ID,
            filename: activeDocumentName,
          },
        ]
      : []),
    ...Object.entries(docIndex).map(([doc_id, info]) => ({
      doc_id,
      filename: info.filename,
    })),
  ];
  const nonce = generateSpotlightNonce();
  const enrichedMessages = await enrichWithPriorEvents(
    messages,
    persistChat ? chatId : null,
    db,
    docIndex,
    nonce,
    "word_chat_messages",
  );
  const { api_keys: configuredApiKeys, personalisation } = modelSettings;
  const apiKeys = { ...configuredApiKeys };
  delete apiKeys.courtlistener;
  const personalisationPrompt = buildUserPersonalisationPrompt(
    personalisation,
    nonce,
  );
  const wordSystemPrompt = [
    buildWordChatSystemPrompt(clientToolsEnabled),
    personalisationPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");
  const apiMessages = buildMessages(
    enrichedMessages,
    docAvailability,
    wordSystemPrompt,
    docIndex,
    false,
    nonce,
    "replace",
  );
  const workflowStore = await buildWorkflowStore(userId, userEmail, db);
  const assistantMessageId = randomUUID();

  if (persistChat) {
    const error = await reserveAssistantMessage({
      db,
      table: "word_chat_messages",
      id: assistantMessageId,
      chatId,
    });
    if (error) {
      console.error("[word-chat] failed to reserve assistant message", error);
      return void res
        .status(500)
        .json({ detail: "Failed to start Word assistant response" });
    }
  }

  const stream = openAssistantSse(res);
  const write = stream.write;
  const updateAssistantMessage = createReservedAssistantMessageUpdater({
    db,
    table: "word_chat_messages",
    id: assistantMessageId,
    chatId,
    enabled: persistChat,
  });
  const normalizeAssistantEvents = async (
    events: unknown[],
  ): Promise<unknown[]> => {
    if (!persistChat) return events;
    const normalized = await persistWordDocumentEdits({
      db,
      messageId: assistantMessageId,
      events,
      applyMode: editApplyMode,
    });
    return normalized.events;
  };
  const updateChatActivity = async (): Promise<void> => {
    if (!persistChat) return;
    const nextTitle =
      !chatTitle && lastUser?.content ? lastUser.content.slice(0, 120) : null;
    const update = {
      ...(nextTitle ? { title: nextTitle } : {}),
      updated_at: new Date().toISOString(),
    };
    const { error } = await db
      .from("word_chats")
      .update(update)
      .eq("id", chatId)
      .eq("user_id", userId);
    if (error) {
      console.error("[word-chat] failed to update chat activity", error);
      return;
    }
    // Mirror the title we just persisted back into the local variable so the
    // audit enqueue below names the chat, the way chat.ts does. Without this
    // the first turn of every Word chat would audit under a null title.
    if (nextTitle) chatTitle = nextTitle;
  };

  try {
    write(
      `data: ${JSON.stringify({
        type: "chat_id",
        chatId,
        assistantMessageId,
      })}\n\n`,
    );
    const { events, citations } = await runLLMStream({
      apiMessages,
      docStore,
      docIndex,
      userId,
      db,
      write,
      workflowStore,
      // CourtListener is intentionally unavailable in document-scoped Word
      // chats. Legal research remains a web-assistant capability.
      includeResearchTools: false,
      includeAskInputs: false,
      ...(clientToolsEnabled
        ? {
            clientTools: createWordClientToolsAdapter({
              userId,
              write,
              signal: stream.signal,
              nonce,
            }),
            // The edit flow is built around retry round-trips (propose →
            // fail → read_active_document → retry), each costing one
            // iteration; the default budget of 10 can end the loop before
            // the model gets to write its summary.
            maxIterations: 16,
          }
        : {}),
      model: selectedModel,
      reasoning: selectedReasoningLevel,
      apiKeys,
      signal: stream.signal,
      nonce,
      emitDone: false,
    });
    const persistedEvents = await normalizeAssistantEvents(
      stripTransientAssistantEvents(events),
    );
    const saveError = await updateAssistantMessage(
      persistedEvents.length ? persistedEvents : null,
      citations.length ? citations : null,
    );
    await updateChatActivity();
    if (saveError) {
      console.error("[word-chat] failed to save assistant response", saveError);
      write(
        `data: ${JSON.stringify({
          type: "error",
          message:
            "The response was generated but could not be saved. Keep this document open and review its tracked changes in Word.",
        })}\n\n`,
      );
      write("data: [DONE]\n\n");
      return;
    }
    // Word turns used to be audited nowhere, unlike routes/chat.ts and
    // routes/projectChat.ts. chatId/projectId stay null because a Word chat
    // lives in word_chats — neither chats.id nor projects.id is a legal value
    // for those columns — so `surface: "word"` is what makes these rows
    // identifiable in the history feed. Placement mirrors chat.ts: after the
    // response is durable, immediately before [DONE].
    void enqueueChatTurnAudit(
      db,
      {
        userId,
        userEmail,
        chatId: null,
        projectId: null,
        surface: "word",
        // Never the raw prompt: storage:"local" is the user asking that this
        // conversation NOT be kept server-side, so the audit row records that
        // a Word turn happened and which document it touched, not what was
        // said. In cloud mode chatTitle is the prompt-derived title the
        // server already stores, so nothing is lost there.
        title: chatTitle ?? activeDocumentName ?? null,
        model: selectedModel,
      },
      // Word edits are applied client-side in the document, not persisted as
      // doc_created/doc_edited artifacts, so there is nothing here for the
      // artifact fan-out to map — only the chat.message row.
      [],
    );
    write("data: [DONE]\n\n");
  } catch (error) {
    if (isAbortError(error)) {
      void enqueueChatTurnAudit(
        db,
        {
          userId,
          userEmail,
          chatId: null,
          projectId: null,
          surface: "word",
          title: chatTitle ?? activeDocumentName ?? null,
          model: selectedModel,
          status: "cancelled",
        },
        null,
      );
      if (error instanceof AssistantStreamError) {
        const partial = buildCancelledAssistantMessage({
          fullText: error.fullText,
          events: error.events,
          buildCitations: (fullText) =>
            extractCitations(fullText, docIndex, docStore),
        });
        const partialEvents = await normalizeAssistantEvents(partial.events);
        const saveError = await updateAssistantMessage(
          partialEvents.length ? partialEvents : null,
          partial.citations.length ? partial.citations : null,
        );
        if (saveError) {
          console.error("[word-chat] failed to save aborted stream", saveError);
        }
      }
      await updateChatActivity();
      return;
    }
    console.error("[word-chat] stream error", error);
    const message = ASSISTANT_ERROR_MESSAGE;
    const errorEvents =
      error instanceof AssistantStreamError
        ? stripTransientAssistantEvents(error.events)
        : [{ type: "error" as const, message }];
    const errorFullText =
      error instanceof AssistantStreamError ? error.fullText : "";
    try {
      const citations = extractCitations(errorFullText, docIndex, docStore);
      const normalizedErrorEvents = await normalizeAssistantEvents(errorEvents);
      const saveError = await updateAssistantMessage(
        normalizedErrorEvents.length ? normalizedErrorEvents : null,
        citations.length ? citations : null,
      );
      if (saveError) {
        console.error("[word-chat] failed to save stream error", saveError);
      }
    } catch (saveError) {
      console.error("[word-chat] failed to persist stream error", saveError);
    }
    try {
      write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
      write("data: [DONE]\n\n");
    } catch {
      // The client disconnected while the error was being handled.
    }
  } finally {
    stream.finish();
  }
});
