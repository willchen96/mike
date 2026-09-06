import {
  streamChatWithTools,
  resolveModel,
  type LlmMessage,
  type OpenAIToolSchema,
} from "../llm";
import { resolveRequestedModel } from "../routerModels";
import { UserFacingError } from "../userFacingError";
import { createServerSupabase } from "../supabase";
import { buildUserMcpTools, type McpToolEvent } from "../mcpConnectors";
import { buildGoogleDriveTools } from "../integrations/googleDrive";
import type { SourceDocument } from "../sourceDocuments";
import {
  COURTLISTENER_TOOLS,
  type CaseCitationEvent,
  type CourtlistenerToolEvent,
} from "./tools/courtlistenerTools";
import {
  type DocStore,
  type DocIndex,
  type TabularCellStore,
  type WorkflowStore,
  type ToolCall,
  type AskInputResponseItem,
  type AskInputsEvent,
  type EditAnnotation,
  devLog,
  resolveDocLabel,
} from "./types";
import {
  TOOLS,
  WORKFLOW_TOOLS,
  isDocumentMutatingTool,
  withoutDocumentMutatingTools,
} from "./tools/toolSchemas";
import {
  parseCitationsWithDiagnostics,
  parsePartialCitationObjects,
  createCitation,
  CITATIONS_OPEN_TAG,
} from "./citations";
import { runToolCalls } from "./tools/toolDispatcher";
import {
  getCachedCaseOpinionTexts,
  type CourtlistenerTurnState,
} from "./tools/courtlistenerTurnState";
import {
  readDocumentContent,
  type TurnEditState,
  type TurnReadState,
} from "./tools/documentOps";
import { verifyCitations } from "./verifyCitations";

export type AssistantEvent =
  | { type: "reasoning"; text: string }
  | AskInputsEvent
  | {
      type: "ask_inputs_response";
      responses: AskInputResponseItem[];
    }
  | {
      type: "doc_read";
      filename: string;
      document_id?: string;
      version_id?: string | null;
      version_number?: number | null;
    }
  | {
      type: "doc_find";
      filename: string;
      document_id?: string;
      version_id?: string | null;
      version_number?: number | null;
      query: string;
      total_matches: number;
    }
  | {
      type: "doc_created";
      filename: string;
      download_url: string;
      document_id?: string;
      version_id?: string;
      version_number?: number | null;
    }
  | { type: "doc_download"; filename: string; download_url: string }
  | {
      type: "doc_replicated";
      /** Source document being copied. */
      filename: string;
      count: number;
      copies: {
        new_filename: string;
        document_id: string;
        version_id: string;
      }[];
    }
  | { type: "workflow_applied"; workflow_id: string; title: string }
  | {
      type: "doc_edited";
      filename: string;
      document_id: string;
      version_id: string;
      /** Per-document monotonic Vn; null if backend couldn't determine it. */
      version_number: number | null;
      download_url: string;
      annotations: EditAnnotation[];
    }
  | CaseCitationEvent
  | CourtlistenerToolEvent
  | McpToolEvent
  | {
      type: "case_opinions";
      cluster_id: number;
      document: SourceDocument;
    }
  | { type: "content"; text: string }
  | {
      /**
       * Placement marker for one edit a client tool proposed, spliced into
       * the event stream exactly where the tool call landed between content
       * blocks. `persistWordDocumentEdits` upserts it into the canonical
       * `word_document_edits` row and swaps it for a `word_edit_ref` — the
       * same normalization the `<EDITS>` protocol's blocks go through, so
       * both channels produce identical persisted history.
       */
      type: "word_edit_block";
      block_index: number;
      original_text: string;
      replacement_text: string;
      formats: string[];
      occurrence: "all" | null;
      reason: string | null;
    }
  | { type: "error"; message: string; safe_to_display?: boolean };

/**
 * Tools the model can call that execute outside this process — in the Word
 * task pane. The adapter owns forwarding the call to the client and awaiting
 * its posted result; the loop treats the returned content exactly like a
 * server-side tool result.
 */
export interface ClientToolsAdapter {
  schemas: OpenAIToolSchema[];
  owns: (name: string) => boolean;
  execute: (
    call: import("../llm").NormalizedToolCall,
  ) => Promise<{ content: string; events: AssistantEvent[] }>;
}

export class AssistantStreamError extends Error {
  fullText: string;
  events: AssistantEvent[];

  constructor(message: string, fullText: string, events: AssistantEvent[]) {
    super(message);
    this.name = "AssistantStreamError";
    this.fullText = fullText;
    this.events = events;
  }
}

export const ASSISTANT_ERROR_MESSAGE =
  "The response could not be completed. Please try again.";
const TOOL_ERROR_MESSAGE = "This tool could not complete its request.";

function sanitizeAssistantEvent(event: AssistantEvent): AssistantEvent {
  if (event.type === "error") {
    return event.safe_to_display
      ? event
      : { ...event, message: ASSISTANT_ERROR_MESSAGE };
  }
  if ("error" in event && typeof event.error === "string" && event.error) {
    return { ...event, error: TOOL_ERROR_MESSAGE };
  }
  return event;
}

export function sanitizeAssistantSseChunk(chunk: string): string {
  if (!chunk.startsWith("data: ")) return chunk;
  const payload = chunk.slice(6).trim();
  if (!payload || payload === "[DONE]") return chunk;
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return chunk;
    }
    const sanitized = sanitizeAssistantEvent(parsed as AssistantEvent);
    return `data: ${JSON.stringify(sanitized)}\n\n`;
  } catch {
    return chunk;
  }
}

export class AssistantStreamAbortError extends AssistantStreamError {
  constructor(fullText: string, events: AssistantEvent[]) {
    super("Stream aborted.", fullText, events);
    this.name = "AbortError";
  }
}

class AssistantStreamAskInputsPause extends Error {
  constructor() {
    super("Waiting for user input.");
    this.name = "AssistantStreamAskInputsPause";
  }
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: unknown; message?: unknown };
  return record.name === "AbortError" || record.message === "Stream aborted.";
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const err = new Error("Stream aborted.");
  err.name = "AbortError";
  throw err;
}

export async function runLLMStream(params: {
  apiMessages: unknown[];
  docStore: DocStore;
  docIndex: DocIndex;
  userId: string;
  db: ReturnType<typeof createServerSupabase>;
  write: (s: string) => void;
  extraTools?: unknown[];
  includeResearchTools?: boolean;
  /** Expose ask_inputs only to clients that can render and answer it. */
  includeAskInputs?: boolean;
  /**
   * May this turn WRITE documents (edit_document, replicate_document, the
   * generate_* family)? Defaults to true; pass false and those tools are
   * neither advertised to the model nor executed if it asks for one anyway.
   *
   * The caller decides this from the role the caller holds on the CONTAINER
   * whose documents the tools would touch — not from their standing in the
   * chat. The two come apart: a project viewer named on one chat's share
   * list writes in that thread as a member, and without this partition the
   * thread would hand them edit_document over every document in the project.
   */
  allowDocumentMutation?: boolean;
  workflowStore?: WorkflowStore;
  tabularStore?: TabularCellStore;
  /** Tools executed by the connected client (Word add-in) instead of here. */
  clientTools?: ClientToolsAdapter;
  /**
   * Tool-loop iteration budget (default 10). Surfaces whose tools are built
   * around retry round-trips (Word client edits: propose → fail → re-read →
   * retry) need headroom, or the loop ends before the model's summary.
   */
  maxIterations?: number;
  buildCitations?: (fullText: string) => unknown[];
  model?: string;
  /** AI SDK reasoning effort for this interactive request. */
  reasoning?: import("../llm").ReasoningLevel;
  apiKeys?: import("../llm").UserApiKeys;
  signal?: AbortSignal;
  /** Let a route persist the completed turn before it signals stream success. */
  emitDone?: boolean;
  /**
   * If set, generate_docx will attach created docs to this project so
   * they appear in the project sidebar. Leave null for general chats —
   * generated docs still get persisted, but as standalone documents.
   */
  projectId?: string | null;
  /** Per-request spotlighting nonce — generated by the caller and passed
   *  here so that the same nonce fences both the system-prompt filenames
   *  (added by buildMessages) and the document bodies returned by tools. */
  nonce?: string;
}): Promise<{
  fullText: string;
  events: AssistantEvent[];
  citations: unknown[];
}> {
  const {
    apiMessages,
    docStore,
    docIndex,
    userId,
    db,
    write: unsafeWrite,
    extraTools,
    includeResearchTools = true,
    includeAskInputs = true,
    allowDocumentMutation = true,
    workflowStore,
    tabularStore,
    clientTools,
    buildCitations,
    model,
    apiKeys,
    signal,
    projectId,
    nonce,
  } = params;
  const write = (chunk: string) =>
    unsafeWrite(sanitizeAssistantSseChunk(chunk));
  const researchTools = includeResearchTools ? COURTLISTENER_TOOLS : [];
  const mcpTools = await buildUserMcpTools(userId, db);
  const googleDriveTools = await buildGoogleDriveTools(userId, db);
  const conversationTools = includeAskInputs
    ? TOOLS
    : TOOLS.filter((tool) => tool.function.name !== "ask_inputs");
  const baseTools = [...conversationTools, ...researchTools, ...WORKFLOW_TOOLS];
  const advertisedTools = [
    ...baseTools,
    ...mcpTools,
    ...googleDriveTools,
    ...(extraTools ?? []),
    ...(clientTools?.schemas ?? []),
  ];
  // Hiding the schema is the first half of the gate: a tool the model was
  // never shown is a tool it will not plan around. The second half is in
  // `runTools` below, because "not advertised" is not "not callable" — a
  // model can name a tool from memory.
  const activeTools = allowDocumentMutation
    ? advertisedTools
    : withoutDocumentMutatingTools(advertisedTools);

  // Extract system prompt; pass remaining turns to the adapter as
  // plain user/assistant messages.
  const rawMsgs = apiMessages as { role: string; content: string | null }[];
  const systemPrompt =
    rawMsgs[0]?.role === "system" ? (rawMsgs[0].content ?? "") : "";
  const chatMessages: LlmMessage[] = rawMsgs
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content ?? "",
    }));

  const events: AssistantEvent[] = [];
  // One assistant turn produces at most one document_versions row per
  // edited doc. `runToolCalls` fires once per tool-call batch; the model
  // may emit multiple batches in a single turn, so this map persists
  // across batches to let subsequent edit_document calls overwrite the
  // turn's existing version instead of creating a new one.
  const turnEditState: TurnEditState = new Map();
  // Suppress repeated full-document reads for the same document/version in
  // one assistant response. The guard is invalidated when edit_document
  // changes that document so a post-edit verification read can still happen.
  const turnReadState: TurnReadState = new Map();
  const courtlistenerTurnState: CourtlistenerTurnState = {
    casesByClusterId: new Map(),
  };
  let fullText = "";
  let iterText = "";
  let iterVisibleText = "";
  let iterReasoning = "";
  let visibleTailBuffer = "";
  let citationsOpenSeen = false;
  let streamingCitationsBuffer = "";
  let streamedCitationCount = 0;

  const emitCitationStreamSnapshot = (
    status: "started" | "partial",
    citations: unknown[],
  ) => {
    if (buildCitations) return;
    write(
      `data: ${JSON.stringify({ type: "citations", status, citations })}\n\n`,
    );
  };

  const streamHiddenCitationContent = (delta: string) => {
    if (buildCitations || !delta) return;
    streamingCitationsBuffer += delta;
    const partial = parsePartialCitationObjects(streamingCitationsBuffer);
    if (partial.length <= streamedCitationCount) return;
    streamedCitationCount = partial.length;
    const citations = partial.map((c) =>
      createCitation(
        c,
        docIndex,
        courtlistenerTurnState.casesByClusterId,
        docStore,
      ),
    );
    emitCitationStreamSnapshot("partial", citations);
  };

  const streamVisibleContent = (delta: string) => {
    if (!delta) return;
    if (citationsOpenSeen) {
      streamHiddenCitationContent(delta);
      return;
    }

    const combined = visibleTailBuffer + delta;
    const markerIdx = combined.indexOf(CITATIONS_OPEN_TAG);
    if (markerIdx >= 0) {
      const visible = combined.slice(0, markerIdx);
      if (visible) {
        iterVisibleText += visible;
        write(
          `data: ${JSON.stringify({ type: "content_delta", text: visible })}\n\n`,
        );
      }
      visibleTailBuffer = "";
      citationsOpenSeen = true;
      streamingCitationsBuffer = "";
      streamedCitationCount = 0;
      emitCitationStreamSnapshot("started", []);
      streamHiddenCitationContent(
        combined.slice(markerIdx + CITATIONS_OPEN_TAG.length),
      );
      return;
    }

    const keep = Math.min(CITATIONS_OPEN_TAG.length - 1, combined.length);
    const visible = combined.slice(0, combined.length - keep);
    visibleTailBuffer = combined.slice(combined.length - keep);
    if (visible) {
      iterVisibleText += visible;
      write(
        `data: ${JSON.stringify({ type: "content_delta", text: visible })}\n\n`,
      );
    }
  };

  const flushVisibleTail = (opts: { emit?: boolean } = {}) => {
    const emit = opts.emit ?? true;
    if (citationsOpenSeen || !visibleTailBuffer) {
      visibleTailBuffer = "";
      return;
    }
    iterVisibleText += visibleTailBuffer;
    if (emit) {
      write(
        `data: ${JSON.stringify({ type: "content_delta", text: visibleTailBuffer })}\n\n`,
      );
    }
    visibleTailBuffer = "";
  };

  const flushText = (opts: { emit?: boolean } = {}) => {
    if (!iterText) return;
    fullText += iterText;
    flushVisibleTail(opts);
    if (iterVisibleText) {
      events.push({ type: "content", text: iterVisibleText });
    }
    iterText = "";
    iterVisibleText = "";
    visibleTailBuffer = "";
    citationsOpenSeen = false;
    streamingCitationsBuffer = "";
    streamedCitationCount = 0;
  };

  const flushPartialTurn = (opts: { emit?: boolean } = {}) => {
    flushText(opts);
    if (iterReasoning) {
      events.push({ type: "reasoning", text: iterReasoning });
      iterReasoning = "";
    }
  };

  try {
    throwIfAborted(signal);
    // Single request-time choke point for every runLLMStream caller (chat,
    // project chat, Word chat, tabular): router-prefixed models must be in the
    // user's saved selection.
    //
    // This lives INSIDE the try because it touches the database. Above it, a
    // read failure escaped as a bare rejection — before any error event was
    // pushed and before AssistantStreamError could carry the partial turn — so
    // the SSE client saw the socket end with no explanation. Inside, a blip
    // takes the same path as any other mid-stream failure.
    //
    // "throw" (not silent fallback) because `model` here is what the caller
    // asked for in THIS request. Stored task models are validated by their
    // route before they arrive here, but this guard keeps every caller safe.
    const requestedModel = resolveModel(model, "");
    if (!requestedModel) {
      throw new UserFacingError(
        model
          ? `Model "${model}" is not available. Select another model.`
          : "Select a model before sending a message.",
      );
    }
    const selectedModel = await resolveRequestedModel(
      requestedModel,
      "",
      userId,
      db,
      "throw",
    );
    await streamChatWithTools({
      model: selectedModel,
      systemPrompt,
      messages: chatMessages,
      tools: activeTools as OpenAIToolSchema[],
      maxIterations: params.maxIterations ?? 10,
      apiKeys,
      reasoning: params.reasoning ?? "high",
      abortSignal: signal,
      callbacks: {
        onContentDelta: (delta) => {
          iterText += delta;
          streamVisibleContent(delta);
        },
        onReasoningDelta: (delta) => {
          iterReasoning += delta;
          write(
            `data: ${JSON.stringify({ type: "reasoning_delta", text: delta })}\n\n`,
          );
        },
        onReasoningBlockEnd: () => {
          if (!iterReasoning) return;
          events.push({ type: "reasoning", text: iterReasoning });
          write(`data: ${JSON.stringify({ type: "reasoning_block_end" })}\n\n`);
          iterReasoning = "";
        },
        // Fires after Claude's turn ends with stop_reason=tool_use, before
        // the tool actually runs. Flushes any buffered assistant text so
        // it's emitted in chronological order, then signals the client so
        // it can open a fresh PreResponseWrapper (shows "Working…") while
        // the tool executes — avoids the dead gap between message_stop
        // and the first tool-specific event.
        onToolCallStart: (call) => {
          flushText();
          write(
            `data: ${JSON.stringify({
              type: "tool_call_start",
              name: call.name,
            })}\n\n`,
          );
        },
      },
      runTools: async (calls) => {
        throwIfAborted(signal);
        // Emit any text the model produced before this tool turn so the
        // UI sees it before the tool results stream in.
        flushText();

        // Client-executed tools (Word add-in) round-trip through the SSE
        // stream and never enter the server dispatcher. They run before the
        // server batch and sequentially among themselves: each call mutates
        // or reads the live document, so order is part of their semantics.
        const clientResultByCallId = new Map<string, string>();
        // Enforcement, not just omission: a document-writing call from a
        // caller who may not write is dropped before dispatch, on the server
        // side and the client side alike. It falls through to the
        // "Tool 'x' is not available." answer below, which every tool_use
        // without a result already gets, so the model is told plainly rather
        // than left waiting on a call that silently did nothing.
        const permittedCalls = allowDocumentMutation
          ? calls
          : calls.filter((c) => !isDocumentMutatingTool(c.name));
        const serverCalls = clientTools
          ? permittedCalls.filter((c) => !clientTools.owns(c.name))
          : permittedCalls;
        if (clientTools) {
          for (const call of permittedCalls) {
            if (!clientTools.owns(call.name)) continue;
            const { content, events: clientEvents } =
              await clientTools.execute(call);
            clientResultByCallId.set(call.id, content);
            events.push(...clientEvents);
            throwIfAborted(signal);
          }
        }

        const toolCalls: ToolCall[] = serverCalls.map((c) => ({
          id: c.id,
          function: {
            name: c.name,
            arguments: JSON.stringify(c.input),
          },
        }));
        const {
          toolResults,
          docsRead,
          docsFound,
          docsCreated,
          docsReplicated,
          workflowsApplied,
          docsEdited,
          askInputsEvents,
          courtlistenerEvents,
          caseCitationEvents,
          mcpEvents,
        } = await runToolCalls(
          toolCalls,
          docStore,
          userId,
          db,
          write,
          workflowStore,
          tabularStore,
          docIndex,
          turnEditState,
          turnReadState,
          projectId,
          courtlistenerTurnState,
          apiKeys,
          nonce,
        );
        throwIfAborted(signal);
        for (const r of docsRead) {
          events.push({
            type: "doc_read",
            filename: r.filename,
            document_id: r.document_id,
            version_id: r.version_id,
            version_number: r.version_number,
          });
        }
        for (const f of docsFound) {
          events.push({
            type: "doc_find",
            filename: f.filename,
            document_id: f.document_id,
            version_id: f.version_id,
            version_number: f.version_number,
            query: f.query,
            total_matches: f.total_matches,
          });
        }
        for (const dl of docsCreated) {
          events.push({
            type: "doc_created",
            filename: dl.filename,
            download_url: dl.download_url,
            document_id: dl.document_id,
            version_id: dl.version_id,
            version_number: dl.version_number ?? null,
          });
        }
        for (const r of docsReplicated) {
          events.push({
            type: "doc_replicated",
            filename: r.filename,
            count: r.count,
            copies: r.copies,
          });
        }
        for (const wf of workflowsApplied) {
          events.push({
            type: "workflow_applied",
            workflow_id: wf.workflow_id,
            title: wf.title,
          });
        }
        for (const e of docsEdited) {
          events.push({
            type: "doc_edited",
            filename: e.filename,
            document_id: e.document_id,
            version_id: e.version_id,
            version_number: e.version_number,
            download_url: e.download_url,
            annotations: e.annotations,
          });
        }
        for (const askInputsEvent of askInputsEvents) {
          write(`data: ${JSON.stringify(askInputsEvent)}\n\n`);
          events.push(askInputsEvent);
        }
        for (const event of courtlistenerEvents) {
          events.push(event);
        }
        for (const event of mcpEvents) {
          events.push(event);
        }
        for (const event of caseCitationEvents) {
          events.push(event);
        }

        if (askInputsEvents.length > 0) {
          throw new AssistantStreamAskInputsPause();
        }

        // Index alignment would break if any tool branch skips its
        // push (unhandled tool name, disabled store, guard failure).
        // Each tool_result already carries its tool_call_id, so key off
        // that directly — and fall back to an error result for any
        // tool_use that didn't produce one, so Claude's next request
        // has a tool_result for every tool_use it sent.
        const resultByCallId = new Map<string, string>(clientResultByCallId);
        for (const r of toolResults) {
          const row = r as {
            tool_call_id: string;
            content?: unknown;
          };
          resultByCallId.set(row.tool_call_id, String(row.content ?? ""));
        }
        // Answer every tool_use the model sent — client and server alike —
        // in the model's original call order.
        return calls.map((c) => ({
          tool_use_id: c.id,
          content:
            resultByCallId.get(c.id) ??
            JSON.stringify({
              error: `Tool '${c.name}' is not available.`,
            }),
        }));
      },
    });
  } catch (err) {
    if (err instanceof AssistantStreamAskInputsPause) {
      // The ask_inputs event has already been emitted and persisted in `events`.
      // Stop this assistant turn here so the model does not add redundant
      // prose telling the user to answer the picker or attach documents.
    } else if (isAbortError(err)) {
      flushPartialTurn({ emit: false });
      throw new AssistantStreamAbortError(
        fullText,
        events.map(sanitizeAssistantEvent),
      );
    } else {
      flushPartialTurn();
      console.error("[chat/stream] model stream failed", err);
      const safeToDisplay = err instanceof UserFacingError;
      const message = safeToDisplay ? err.message : ASSISTANT_ERROR_MESSAGE;
      events.push({
        type: "error",
        message,
        ...(safeToDisplay ? { safe_to_display: true } : {}),
      });
      throw new AssistantStreamError(
        message,
        fullText,
        events.map(sanitizeAssistantEvent),
      );
    }
  }

  flushText();

  // Parse and emit citations from <CITATIONS> block
  const { citations: parsedCitations, diagnostics: citationDiagnostics } =
    parseCitationsWithDiagnostics(fullText);
  let citations: unknown[];
  if (buildCitations) {
    // Custom builders (tabular) bypass document-citation verification.
    citations = buildCitations(fullText);
  } else {
    const rawCitations = parsedCitations.map((c) =>
      createCitation(
        c,
        docIndex,
        courtlistenerTurnState.casesByClusterId,
        docStore,
      ),
    );
    // Server-side quote verification. Fetch each document's extracted source
    // text at most once per turn (memoized by doc_id), reading only bytes
    // already in storage with emitEvents:false. Case citations are matched
    // against the opinion text cached during this turn.
    const sourceTextByDocId = new Map<string, Promise<string>>();
    const getSourceText = (docId: string): Promise<string> => {
      let pending = sourceTextByDocId.get(docId);
      if (!pending) {
        const label = resolveDocLabel(docId, docStore, docIndex);
        pending = label
          ? readDocumentContent(label, docStore, () => {}, docIndex, db, {
              emitEvents: false,
            })
          : Promise.resolve("");
        sourceTextByDocId.set(docId, pending);
      }
      return pending;
    };
    citations = await verifyCitations(
      rawCitations,
      getSourceText,
      async (clusterId) =>
        getCachedCaseOpinionTexts(courtlistenerTurnState, clusterId),
    );
  }
  devLog("[chat/stream] final citations", {
    hasCitationsBlock: citationDiagnostics.hasBlock,
    citationsBlockLength: citationDiagnostics.rawLength,
    parseError: citationDiagnostics.error,
    parsedCitationCount: parsedCitations.length,
    emittedCitationCount: citations.length,
    usedCustomCitationBuilder: !!buildCitations,
  });
  write(
    `data: ${JSON.stringify({ type: "citations", status: "final", citations })}\n\n`,
  );
  if (params.emitDone !== false) {
    write("data: [DONE]\n\n");
  }

  return {
    fullText,
    events: events.map(sanitizeAssistantEvent),
    citations,
  };
}
