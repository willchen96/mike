import { useCallback, useEffect, useRef, useState } from "react";
import { streamAssistant, type WordClientToolCall } from "../api/stream";
import { reportError } from "../lib/errorReporting";
import { postWordChatToolResult } from "../api/mikeApi";
import { useWordDoc } from "./useWordDoc";
import type {
  DocumentReadActivity,
  Message as SavedMessage,
  WordAssistantEvent,
  WordDocumentEdit,
} from "../types";
import type { RedlineEdit, WordEditFormat } from "../lib/redline";
import { TOOL_EDIT_INDEX_BASE } from "../lib/wordTrackedEditKeys";
import { saveLocalWordMessage } from "../lib/localWordChats";
import type { WordChatStorageMode } from "../lib/wordChatSettings";
import { notifyWordChatHistoryChanged } from "../lib/wordChatHistoryEvents";
import type {
  WordAssistantChatController,
  WordChatMessage,
  WordChatSubmission,
  WordChatSubmitOptions,
  WordEditStreamController,
  WordToolEditItem,
} from "../lib/wordChatTypes";
import {
  appendAssistantContent,
  appendAssistantReasoning,
  assistantContentForModel,
  assistantContentFromEvents,
  completeAssistantEvents,
  finishAssistantReasoning,
  messageFromStorage,
  normalizeLocalWordEditEvents,
  setAssistantError,
  upsertDocumentReadEvent,
} from "../lib/wordChatEvents";
import { readCurrentDocumentName } from "../lib/wordDocumentIdentity";

let localMessageSequence = 0;

function createMessageId(role: WordChatMessage["role"]): string {
  localMessageSequence += 1;
  return `${role}-${Date.now()}-${localMessageSequence}`;
}

const WORD_EDIT_FORMATS: readonly string[] = [
  "bold",
  "italic",
  "underline",
  "heading1",
  "heading2",
  "heading3",
];

/**
 * Read one row of an apply_word_edits tool input. The backend validated the
 * batch before forwarding it, so anything rejected here is a protocol
 * mismatch between the two halves rather than a model mistake.
 */
function parseToolEdit(raw: unknown): RedlineEdit | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.original !== "string" || !row.original) return null;
  const formats = Array.isArray(row.formats)
    ? row.formats.filter(
        (format): format is WordEditFormat =>
          typeof format === "string" && WORD_EDIT_FORMATS.includes(format),
      )
    : [];
  if (formats.length === 0 && typeof row.replacement !== "string") return null;
  if (row.occurrence !== undefined && row.occurrence !== "all") return null;
  return {
    original: row.original,
    replacement: typeof row.replacement === "string" ? row.replacement : "",
    ...(formats.length > 0 ? { format: formats } : {}),
    ...(row.occurrence === "all" ? { occurrence: "all" as const } : {}),
    ...(typeof row.reason === "string" && row.reason
      ? { reason: row.reason }
      : {}),
  };
}

/** The live card row for a tool-proposed edit, before any outcome is known. */
function toolEditRow(
  messageId: string,
  item: WordToolEditItem,
  applyMode: "direct" | "approval",
): WordDocumentEdit {
  return {
    // Matches the id device-only storage assigns, so a local reload resolves
    // the same card without a round trip.
    id: `${messageId}:edit-${item.blockIndex}`,
    messageId,
    blockIndex: item.blockIndex,
    originalText: item.edit.original,
    replacementText: item.edit.replacement,
    formats: item.edit.format ?? [],
    ...(item.edit.occurrence ? { occurrence: item.edit.occurrence } : {}),
    ...(item.edit.reason ? { reason: item.edit.reason } : {}),
    applyMode,
    applyStatus: "proposed",
  };
}

interface UseWordAssistantChatOptions {
  sessionKey: number;
  chatId: string | null;
  initialMessages: SavedMessage[];
  onChatIdChange: (chatId: string) => void;
  onChatStarted: () => void;
  wordDocumentId: string;
  wordChatStorage: WordChatStorageMode;
  wordChatOwnerId: string;
  editApplyMode: "direct" | "approval";
  editController: WordEditStreamController;
}

export function useWordAssistantChat({
  sessionKey,
  chatId,
  initialMessages,
  onChatIdChange,
  onChatStarted,
  wordDocumentId,
  wordChatStorage,
  wordChatOwnerId,
  editApplyMode,
  editController,
}: UseWordAssistantChatOptions): WordAssistantChatController {
  const [messages, setMessages] = useState<WordChatMessage[]>([]);
  const [isResponseLoading, setIsResponseLoading] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  // Render-synced mirrors so handleChat can read the latest transcript
  // without depending on it — a per-chunk `messages` dependency changes the
  // callback's identity on every streamed delta and re-renders the composer.
  const messagesRef = useRef<WordChatMessage[]>(messages);
  messagesRef.current = messages;
  const isResponseLoadingRef = useRef(isResponseLoading);
  isResponseLoadingRef.current = isResponseLoading;
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const sessionGenerationRef = useRef(0);
  const sendSequenceRef = useRef(0);
  const sendingRef = useRef(false);
  const { readDocumentMarkdown } = useWordDoc();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sendSequenceRef.current += 1;
      sendingRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    sendSequenceRef.current += 1;
    sendingRef.current = false;
    sessionGenerationRef.current += 1;
    setMessages(
      initialMessages.map((message, index) =>
        messageFromStorage(message, `history-${sessionKey}-${index}`),
      ),
    );
    setIsResponseLoading(false);
    setRequestError(null);
    // sessionKey is the explicit boundary between conversations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  const cancel = useCallback((): void => abortRef.current?.abort(), []);
  const dismissRequestError = useCallback(
    (): void => setRequestError(null),
    [],
  );

  const handleChat = useCallback(
    async (
      submission: WordChatSubmission,
      options: WordChatSubmitOptions = {},
    ): Promise<void> => {
      const text = submission.content.trim();
      if (!text || isResponseLoadingRef.current || sendingRef.current) return;

      const generation = sessionGenerationRef.current;
      const sendToken = sendSequenceRef.current + 1;
      sendSequenceRef.current = sendToken;
      sendingRef.current = true;
      const controller = new AbortController();
      abortRef.current = controller;
      setRequestError(null);
      // A submitted turn is already an active chat, even while Office is
      // still reading the document snapshot. Expose New Chat immediately so
      // the user can abandon a slow read and invalidate this generation.
      onChatStarted();
      let cleanupAssistantMessageId: string | null = null;
      let assistantEvents: WordAssistantEvent[] = [];

      // Whether this send still owns the transcript. Cancellation is tracked
      // separately: an aborted stream is no longer current, but the sealed
      // edits it already received must still be applied (see the abort path).
      const sendIsCurrent = (): boolean =>
        mountedRef.current &&
        generation === sessionGenerationRef.current &&
        sendToken === sendSequenceRef.current;
      const requestIsCurrent = (): boolean =>
        !controller.signal.aborted && sendIsCurrent();

      try {
        let documentContext: string;
        try {
          documentContext = await readDocumentMarkdown();
        } catch (error) {
          console.error("Failed to read the current Word document", error);
          if (requestIsCurrent()) {
            setRequestError(
              "Mike couldn't read the current Word document. Please try again.",
            );
          }
          return;
        }
        if (!requestIsCurrent()) return;

        const userMessage: WordChatMessage = {
          id: createMessageId("user"),
          role: "user",
          content: text,
          files: submission.files,
          workflow: submission.workflow,
        };
        const history = [...messagesRef.current, userMessage];
        const requestChatId =
          chatId ??
          (wordChatStorage === "local" ? crypto.randomUUID() : undefined);
        if (requestChatId && !chatId) {
          onChatIdChange(requestChatId);
        }

        let assistantMessageId = createMessageId("assistant");
        cleanupAssistantMessageId = assistantMessageId;
        let assistantMessageHasStableId = false;
        // Keep the assistant turn empty until the stream emits a real event.
        // ResponseStatus supplies the general loading indicator; the activity
        // wrapper should only appear for actual reasoning, reads, or edits.
        assistantEvents = [];
        // Match the frontend: mark the response as loading in the same React
        // batch that appends its assistant row. Otherwise the previous final
        // assistant is briefly treated as the active response while Office is
        // still producing the document snapshot.
        setIsResponseLoading(true);
        setMessages([
          ...history,
          {
            id: assistantMessageId,
            role: "assistant",
            events: assistantEvents,
            live: true,
          },
        ]);
        options.onAccepted?.();

        // Match the frontend chat placement: render an empty assistant
        // turn first, then let the view scroll the completed layout.
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (requestIsCurrent()) options.onTurnReady?.();
              resolve();
            });
          });
        });
        if (!requestIsCurrent()) return;

        let streamedContent = "";
        let assistantCitations: SavedMessage["citations"];
        // Canonical rows for this turn's tool-proposed edits. A live turn
        // learns an edit exists when the call is forwarded, long before the
        // backend finalizer writes the durable row, and the card renderer
        // reads them exactly like restored history.
        let assistantEdits: WordDocumentEdit[] = [];
        const buildLocalAssistantMessage = (
          fallbackContent = "",
        ): SavedMessage => {
          const events = normalizeLocalWordEditEvents(
            completeAssistantEvents(assistantEvents),
            assistantMessageId,
          );
          return {
            id: assistantMessageId,
            role: "assistant",
            content: assistantContentFromEvents(events) || fallbackContent,
            events,
            citations: assistantCitations,
          };
        };
        // Fast streams deliver many SSE events per frame; committing React
        // state per event re-renders the transcript far more often than the
        // screen can paint. Publishes coalesce onto one rAF, and the flush
        // reads the live locals so it always commits the latest snapshot.
        let publishFrame: number | null = null;
        // Redline projection re-parses the accumulated answer from index zero,
        // so running it per SSE chunk costs O(n²) over a whole stream. Sealing
        // only needs to be observed once per painted frame, so the projection
        // rides the same flush as the transcript publish. The abort signal is
        // deliberately not consulted: a cancelled stream's already-received
        // sealed edits must still apply, exactly as they did when each chunk
        // was processed synchronously.
        let redlineParsePending = false;
        const flushAssistantEvents = (): void => {
          publishFrame = null;
          const messageId = assistantMessageId;
          const eventSnapshot = assistantEvents;
          if (redlineParsePending) {
            redlineParsePending = false;
            if (sendIsCurrent() && !clientToolsSeen) {
              editController.processLiveRedlines(
                messageId,
                streamedContent,
                assistantMessageHasStableId,
              );
            }
          }
          const citationSnapshot = assistantCitations;
          const editSnapshot = assistantEdits;
          setMessages((current) =>
            current.map((message) =>
              message.id === messageId && message.role === "assistant"
                ? {
                    ...message,
                    events: eventSnapshot,
                    ...(editSnapshot.length > 0 ? { edits: editSnapshot } : {}),
                    ...(citationSnapshot && citationSnapshot.length > 0
                      ? { citations: citationSnapshot }
                      : {}),
                  }
                : message,
            ),
          );
        };
        const publishAssistantEvents = (): void => {
          if (publishFrame !== null) return;
          publishFrame = requestAnimationFrame(flushAssistantEvents);
        };
        const publishAssistantEventsNow = (): void => {
          if (publishFrame !== null) {
            cancelAnimationFrame(publishFrame);
            publishFrame = null;
          }
          flushAssistantEvents();
        };
        // Message-wide flat ordinal for tool-proposed edits; keys card state,
        // persisted rows, and hidden bookmarks (see getToolEditKey). Tool
        // calls arrive strictly sequentially — the backend awaits each result
        // before forwarding the next.
        let nextToolBlockIndex = TOOL_EDIT_INDEX_BASE;
        // Once the backend forwards a tool call, this turn's edits travel as
        // tools; any <EDITS> block still appearing in the prose is quoted
        // text (or a misbehaving model), never the edit channel, and must not
        // be scraped into document mutations on top of the tool applies.
        let clientToolsSeen = false;
        // The terminal saves must not run while a tool call is still settling
        // its cards; runClientToolCall registers itself here and the save
        // paths await the set.
        const pendingClientToolCalls = new Set<Promise<void>>();
        const awaitClientToolCalls = async (): Promise<void> => {
          while (pendingClientToolCalls.size > 0) {
            await Promise.all([...pendingClientToolCalls]);
          }
        };

        const runClientToolCall = async (
          call: WordClientToolCall,
        ): Promise<void> => {
          const respond = async (result: unknown): Promise<void> => {
            // An aborted stream has no awaiting tool loop; the backend
            // rejected its pending call when the SSE socket closed.
            if (controller.signal.aborted) return;
            for (let attempt = 0; attempt < 2; attempt += 1) {
              try {
                await postWordChatToolResult({
                  tool_call_id: call.toolCallId,
                  result,
                  signal: controller.signal,
                });
                return;
              } catch (error) {
                // An expired call (backend timeout, closed stream) answers
                // 404; the backend has moved on and silence is correct. Any
                // other failure leaves the backend waiting out its whole
                // deadline, so one quick retry is worth it before giving up.
                if ((error as { status?: number }).status === 404) return;
                if (attempt === 0 && !controller.signal.aborted) {
                  await new Promise((resolve) => setTimeout(resolve, 1500));
                  continue;
                }
                reportError(error, {
                  tags: { component: "word-chat", stage: "tool-result" },
                  extra: { tool_call_id: call.toolCallId, tool: call.name },
                });
                console.error("Failed to post Word tool result", error);
                return;
              }
            }
          };
          try {
            // The transcript record and the document interaction must live or
            // die together: once this send no longer owns the transcript there
            // is nowhere to record what happened, so nothing may touch (or
            // even read) the document either.
            if (!sendIsCurrent()) {
              await respond({
                error: "The chat session changed; the tool did not run.",
              });
              return;
            }
            if (call.name === "read_active_document") {
              await respond({ document: await readDocumentMarkdown() });
              return;
            }
            if (call.name === "apply_word_edits") {
              const rawEdits = Array.isArray(call.input.edits)
                ? call.input.edits
                : [];
              const edits = rawEdits.map(parseToolEdit);
              // All-or-nothing, mirroring the backend's validation: the
              // backend only ever forwards fully-valid batches, so a bad row
              // here means a protocol mismatch — refuse the whole call rather
              // than applying a subset the two sides would count differently.
              if (edits.length === 0 || edits.some((edit) => edit === null)) {
                await respond({ error: "No valid edits in tool input." });
                return;
              }
              // The backend assigns the ordinals because it also persists the
              // canonical rows; taking its number keeps one authority instead
              // of two counters that can silently drift.
              const forwarded = call.input.block_index;
              const firstBlockIndex =
                typeof forwarded === "number" &&
                Number.isSafeInteger(forwarded) &&
                forwarded >= TOOL_EDIT_INDEX_BASE
                  ? forwarded
                  : nextToolBlockIndex;
              const items: WordToolEditItem[] = (edits as RedlineEdit[]).map(
                (edit, index) => ({
                  blockIndex: firstBlockIndex + index,
                  edit,
                }),
              );
              nextToolBlockIndex = Math.max(
                nextToolBlockIndex,
                firstBlockIndex + items.length,
              );
              assistantEdits = [
                ...assistantEdits,
                ...items.map((item) =>
                  toolEditRow(assistantMessageId, item, editApplyMode),
                ),
              ];
              assistantEvents = [
                ...completeAssistantEvents(assistantEvents),
                ...items.map((item) => ({
                  type: "word_edit_block" as const,
                  blockIndex: item.blockIndex,
                })),
              ];
              publishAssistantEvents();
              const outcomes = await editController.applyToolEdits(
                assistantMessageId,
                items,
                assistantMessageHasStableId,
              );
              if (sendIsCurrent()) {
                // Stamp the settled outcome onto the live rows so the cards,
                // and the summary the next turn replays to the model, say
                // what actually happened rather than "proposed" forever.
                const outcomeByBlockIndex = new Map(
                  items.map((item, index) => [
                    item.blockIndex,
                    outcomes[index],
                  ]),
                );
                assistantEdits = assistantEdits.map((row) => {
                  const outcome = outcomeByBlockIndex.get(row.blockIndex);
                  if (!outcome) return row;
                  return {
                    ...row,
                    applyStatus:
                      outcome.status === "applied"
                        ? "applied"
                        : outcome.status === "applied-unmanaged"
                          ? "unmanaged"
                          : outcome.status === "proposed"
                            ? "proposed"
                            : "failed",
                    ...(outcome.matches !== undefined
                      ? { matchedOccurrences: outcome.matches }
                      : {}),
                    ...(outcome.status === "proposed" ||
                    outcome.status === "applied" ||
                    outcome.status === "applied-unmanaged"
                      ? {}
                      : {
                          errorCode: outcome.reason ?? outcome.status,
                          ...(outcome.error
                            ? { errorMessage: outcome.error }
                            : {}),
                        }),
                  };
                });
                publishAssistantEvents();
              }
              await respond({
                edits: items.map((_item, index) => {
                  const outcome = outcomes[index];
                  return outcome
                    ? { ...outcome, index }
                    : {
                        index,
                        status: "error" as const,
                        error: "Word did not return an edit result.",
                      };
                }),
              });
              return;
            }
            await respond({ error: `Unknown client tool: ${call.name}` });
          } catch (error) {
            await respond({
              error:
                error instanceof Error
                  ? error.message
                  : "The Word add-in failed to execute the tool.",
            });
          }
        };

        try {
          if (wordChatStorage === "local" && requestChatId) {
            await saveLocalWordMessage({
              documentId: wordDocumentId,
              ownerId: wordChatOwnerId,
              chatId: requestChatId,
              message: userMessage,
              title: text.slice(0, 120),
              model: submission.model,
              reasoningLevel: submission.reasoning,
            });
          }

          await streamAssistant(
            {
              messages: history.map((message) => ({
                role: message.role,
                content:
                  message.role === "assistant"
                    ? assistantContentForModel(message)
                    : message.content,
                files: message.files,
                workflow: message.workflow,
              })),
              documentContext,
              model: submission.model,
              reasoning: submission.reasoning,
              chatId: requestChatId,
              wordDocumentId,
              documentName: readCurrentDocumentName(),
              wordChatStorage,
              editApplyMode,
              signal: controller.signal,
              onMetadata: (metadata) => {
                if (!requestIsCurrent()) return;
                if (metadata.chatId) {
                  onChatIdChange(metadata.chatId);
                }
                if (
                  metadata.assistantMessageId &&
                  streamedContent.length === 0
                ) {
                  const temporaryId = assistantMessageId;
                  assistantMessageId = metadata.assistantMessageId;
                  cleanupAssistantMessageId = assistantMessageId;
                  assistantMessageHasStableId = true;
                  setMessages((current) =>
                    current.map((message) =>
                      message.id === temporaryId
                        ? {
                            ...message,
                            id: assistantMessageId,
                          }
                        : message,
                    ),
                  );
                }
              },
              onReasoningDelta: (reasoning) => {
                if (!requestIsCurrent()) return;
                assistantEvents = appendAssistantReasoning(
                  assistantEvents,
                  reasoning,
                );
                publishAssistantEvents();
              },
              onReasoningBlockEnd: () => {
                if (!requestIsCurrent()) return;
                assistantEvents = finishAssistantReasoning(assistantEvents);
                publishAssistantEvents();
              },
              onClientToolCall: (call) => {
                if (!requestIsCurrent()) return;
                clientToolsSeen = true;
                const job = runClientToolCall(call);
                pendingClientToolCalls.add(job);
                void job.finally(() => pendingClientToolCalls.delete(job));
              },
              onCitations: (citations) => {
                if (!requestIsCurrent()) return;
                // Later frames supersede earlier partial ones; the final
                // frame arrives before [DONE].
                assistantCitations = citations as SavedMessage["citations"];
                publishAssistantEvents();
              },
              onDocumentRead: (event) => {
                if (!requestIsCurrent()) return;
                const read: DocumentReadActivity = {
                  filename: event.filename,
                  ...(event.documentId ? { documentId: event.documentId } : {}),
                  status: event.type === "doc_read" ? "read" : "reading",
                };
                assistantEvents = upsertDocumentReadEvent(
                  assistantEvents,
                  read,
                );
                publishAssistantEvents();
              },
            },
            (chunk) => {
              if (!requestIsCurrent()) return;
              streamedContent += chunk;
              assistantEvents = appendAssistantContent(assistantEvents, chunk);
              redlineParsePending = true;
              publishAssistantEvents();
            },
          );
          publishAssistantEventsNow();
          // readSSE deliberately resolves normally when cancelling its reader.
          // Route that clean cancellation through the same abort cleanup below
          // as transports that reject with AbortError.
          if (controller.signal.aborted) {
            throw new DOMException("The request was aborted.", "AbortError");
          }
          if (!requestIsCurrent()) return;
          if (!clientToolsSeen) {
            editController.processLiveRedlines(
              assistantMessageId,
              streamedContent,
              assistantMessageHasStableId,
            );
            // A malformed block (e.g. no usable replacement or format) never
            // seals; settle its card on "incomplete" rather than leaving the
            // receiving spinner up forever. Already-scheduled edits are
            // skipped by the controller, so this cannot demote an applied
            // change.
            editController.markIncompleteRedlines(
              assistantMessageId,
              streamedContent,
            );
          }
          // Cover both the card lifecycles and the outcome POSTs: the saved
          // turn must carry final per-edit statuses.
          await awaitClientToolCalls();
          await editController.waitForMessageEdits(assistantMessageId);
          if (wordChatStorage === "local" && requestChatId) {
            await saveLocalWordMessage({
              documentId: wordDocumentId,
              ownerId: wordChatOwnerId,
              chatId: requestChatId,
              message: buildLocalAssistantMessage(),
            });
          } else if (wordChatStorage === "cloud") {
            notifyWordChatHistoryChanged();
          }
        } catch (error) {
          // Commit whatever streamed before the failure so the terminal UI
          // state below always builds on the latest transcript.
          publishAssistantEventsNow();
          const sessionIsCurrent = sendIsCurrent();
          if (!controller.signal.aborted) {
            // The stream failed for a reason other than the user stopping
            // it. The 5xx/network layers already reported transport-level
            // failures; this is the only report for mid-stream `error`
            // frames and Office.js failures inside the turn.
            reportError(error, {
              tags: { component: "word-chat", storage: wordChatStorage },
            });
          }
          if (controller.signal.aborted) {
            if (sessionIsCurrent) {
              if (!clientToolsSeen) {
                editController.markIncompleteRedlines(
                  assistantMessageId,
                  streamedContent,
                );
              }
              await awaitClientToolCalls();
              await editController.waitForMessageEdits(assistantMessageId);
            }
            if (
              wordChatStorage === "local" &&
              requestChatId &&
              (streamedContent ||
                completeAssistantEvents(assistantEvents).length > 0)
            ) {
              await saveLocalWordMessage({
                documentId: wordDocumentId,
                ownerId: wordChatOwnerId,
                chatId: requestChatId,
                message: buildLocalAssistantMessage(),
              }).catch(() => {});
            } else if (wordChatStorage === "cloud") {
              notifyWordChatHistoryChanged();
            }
            return;
          }
          if (!requestIsCurrent()) return;
          if (!clientToolsSeen) {
            editController.markIncompleteRedlines(
              assistantMessageId,
              streamedContent,
            );
          }
          await awaitClientToolCalls();
          await editController.waitForMessageEdits(assistantMessageId);
          if (!requestIsCurrent()) return;
          const errorMessage =
            error instanceof Error
              ? `Error: ${error.message}`
              : "An error occurred.";
          assistantEvents = setAssistantError(assistantEvents, errorMessage);
          if (wordChatStorage === "local" && requestChatId) {
            await saveLocalWordMessage({
              documentId: wordDocumentId,
              ownerId: wordChatOwnerId,
              chatId: requestChatId,
              message: buildLocalAssistantMessage(errorMessage),
            }).catch(() => {});
          } else if (wordChatStorage === "cloud") {
            // The Word-chat backend persists non-abort stream failures before
            // sending its terminal error frame. Refresh history exactly once
            // for this terminal path; cancelled requests return above.
            notifyWordChatHistoryChanged();
          }
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantMessageId && message.role === "assistant"
                ? {
                    ...message,
                    events: assistantEvents,
                  }
                : message,
            ),
          );
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        if (sendToken === sendSequenceRef.current) {
          sendingRef.current = false;
          if (
            mountedRef.current &&
            generation === sessionGenerationRef.current
          ) {
            if (cleanupAssistantMessageId) {
              assistantEvents = completeAssistantEvents(assistantEvents);
              setMessages((current) =>
                current.map((message) =>
                  message.id === cleanupAssistantMessageId &&
                  message.role === "assistant"
                    ? {
                        ...message,
                        events: assistantEvents,
                      }
                    : message,
                ),
              );
            }
            setIsResponseLoading(false);
          }
        }
      }
    },
    [
      chatId,
      editController,
      editApplyMode,
      onChatIdChange,
      onChatStarted,
      readDocumentMarkdown,
      wordChatOwnerId,
      wordChatStorage,
      wordDocumentId,
    ],
  );

  return {
    messages,
    isResponseLoading,
    requestError,
    handleChat,
    cancel,
    dismissRequestError,
  };
}
