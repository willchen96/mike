"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { streamChat, streamProjectChat } from "@/app/lib/mikeApi";
import { reportError } from "@/app/lib/errorReporting";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { isPanelDocument } from "@/app/components/shared/types";
import type {
  AssistantEvent,
  Citation,
  Message,
} from "@/app/components/shared/types";

interface UseAssistantChatOptions {
  initialMessages?: Message[];
  chatId?: string;
  projectId?: string;
}

function readableStreamError(value: unknown, safeToDisplay: boolean): string {
  if (safeToDisplay && typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return "Sorry, something went wrong.";
}

function parseCourtlistenerEventCases(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const row = item as Record<string, unknown>;
      return {
        cluster_id: typeof row.cluster_id === "number" ? row.cluster_id : 0,
        case_name: typeof row.case_name === "string" ? row.case_name : null,
        citation: typeof row.citation === "string" ? row.citation : null,
        dateFiled: typeof row.dateFiled === "string" ? row.dateFiled : null,
        url: typeof row.url === "string" ? row.url : null,
      };
    })
    .filter(
      (item): item is NonNullable<typeof item> => !!item && item.cluster_id > 0,
    );
}

function parseCourtlistenerCaseSearches(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const row = item as Record<string, unknown>;
      return {
        cluster_id: typeof row.cluster_id === "number" ? row.cluster_id : null,
        query: typeof row.query === "string" ? row.query : "",
        total_matches:
          typeof row.total_matches === "number" ? row.total_matches : 0,
        case_name: typeof row.case_name === "string" ? row.case_name : null,
        citation: typeof row.citation === "string" ? row.citation : null,
        error: typeof row.error === "string" ? row.error : undefined,
      };
    })
    .filter((item): item is NonNullable<typeof item> => !!item);
}

export function useAssistantChat({
  initialMessages = [],
  chatId: initialChatId,
  projectId,
}: UseAssistantChatOptions = {}) {
  const router = useRouter();
  const {
    replaceChatId,
    loadChats,
    setCurrentChatId,
    saveChat,
    setNewChatMessages,
    updateChatTitle,
  } = useChatHistoryContext();

  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [isResponseLoading, setIsResponseLoading] = useState(false);
  const [isLoadingCitations, setIsLoadingCitations] = useState(false);
  const [chatId, setChatId] = useState<string | undefined>(initialChatId);

  const abortControllerRef = useRef<AbortController | null>(null);

  const eventsRef = useRef<AssistantEvent[]>([]);

  const updateLatestAssistantMessage = (
    updater: (message: Message) => Message,
  ) => {
    setMessages((prev) => {
      const assistantIndex = [...prev]
        .map((message, index) => ({ message, index }))
        .reverse()
        .find(({ message }) => message.role === "assistant")?.index;
      if (assistantIndex === undefined) return prev;
      const updated = [...prev];
      updated[assistantIndex] = updater(updated[assistantIndex]);
      return updated;
    });
  };

  /**
   * Finalize any in-flight streaming content event so the next
   * content_delta starts a fresh block. Called
   * before any non-content event is appended, so interleaved content /
   * reasoning / tool events stay in chronological order — without the
   * later content block inheriting the earlier block's accumulated text.
   */
  const finalizeStreamingContent = () => {
    const events = eventsRef.current;
    const last = events[events.length - 1];
    if (last?.type === "content" && last.isStreaming) {
      eventsRef.current = [
        ...events.slice(0, -1),
        { type: "content", text: last.text },
      ];
      const snapshot = [...eventsRef.current];
      updateLatestAssistantMessage((message) => ({
        ...message,
        events: snapshot,
      }));
    }
  };

  // If the model transitions from reasoning into content/tool without a
  // reasoning_block_end (or the events arrive out of order), the prior
  // reasoning event would otherwise stay flagged isStreaming forever.
  const finalizeStreamingReasoning = () => {
    const events = eventsRef.current;
    const last = events[events.length - 1];
    if (last?.type !== "reasoning" || !last.isStreaming) return;
    eventsRef.current = [
      ...events.slice(0, -1),
      { type: "reasoning", text: last.text },
    ];
    const snapshot = [...eventsRef.current];
    updateLatestAssistantMessage((message) => ({
      ...message,
      events: snapshot,
    }));
  };

  // Transient placeholder events (tool_call_start, thinking) fill the
  // latency gap between real SSE events so the wrapper doesn't look stuck.
  // Anytime a real event arrives, drop any streaming placeholder first.
  const isStreamingPlaceholder = (e: AssistantEvent) =>
    (e.type === "tool_call_start" || e.type === "thinking") && !!e.isStreaming;

  const cancelStreamingEvents = (events: AssistantEvent[]) =>
    events
      .filter((event) => !isStreamingPlaceholder(event))
      .map((event) => {
        if (!("isStreaming" in event) || !event.isStreaming) return event;
        const rest = { ...event };
        delete (rest as { isStreaming?: boolean }).isStreaming;
        return rest as AssistantEvent;
      });

  const appendCancellationEvent = (events: AssistantEvent[]) => {
    const cancelledEvents = cancelStreamingEvents(events);
    return [
      ...cancelledEvents,
      { type: "content" as const, text: "Cancelled by user." },
    ];
  };

  const cancel = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      const snapshot = cancelStreamingEvents(eventsRef.current);
      eventsRef.current = snapshot;
      updateLatestAssistantMessage((message) => ({
        ...message,
        events: cancelStreamingEvents(message.events ?? snapshot),
      }));
      setIsResponseLoading(false);
      setIsLoadingCitations(false);
    }
  };

  const clearStreamingPlaceholders = () => {
    const before = eventsRef.current;
    const after = before.filter((e) => !isStreamingPlaceholder(e));
    if (after.length === before.length) return;
    eventsRef.current = after;
    const snapshot = [...after];
    updateLatestAssistantMessage((message) => ({
      ...message,
      events: snapshot,
    }));
  };

  const pushThinkingPlaceholder = () => {
    const events = eventsRef.current;
    const last = events[events.length - 1];
    // Don't stack placeholders back-to-back; one "Thinking…" line is plenty.
    if (last && isStreamingPlaceholder(last)) return;
    eventsRef.current = [
      ...events,
      { type: "thinking" as const, isStreaming: true },
    ];
    const snapshot = [...eventsRef.current];
    updateLatestAssistantMessage((message) => ({
      ...message,
      events: snapshot,
    }));
  };

  const pushEvent = (event: AssistantEvent) => {
    finalizeStreamingContent();
    finalizeStreamingReasoning();
    // A real event, or a more specific placeholder such as
    // tool_call_start, should replace any generic "Thinking..." line.
    const next = eventsRef.current.filter((e) => !isStreamingPlaceholder(e));
    eventsRef.current = [...next, event];
    const snapshot = [...eventsRef.current];
    updateLatestAssistantMessage((message) => ({
      ...message,
      events: snapshot,
    }));
  };

  const updateMatchingEvent = (
    predicate: (e: AssistantEvent) => boolean,
    updater: (e: AssistantEvent) => AssistantEvent,
  ) => {
    const events = eventsRef.current;
    const idx = [...events]
      .map((_, i) => i)
      .reverse()
      .find((i) => predicate(events[i]));
    if (idx === undefined) return false;
    const newEvents = [...events];
    newEvents[idx] = updater(events[idx]);
    eventsRef.current = newEvents;
    const snapshot = [...newEvents];
    updateLatestAssistantMessage((message) => ({
      ...message,
      events: snapshot,
    }));
    return true;
  };

  const handleChat = async (
    message: Message,
    opts?: {
      displayedDoc?: { filename: string; documentId: string } | null;
      askInputsResponse?: Extract<
        AssistantEvent,
        { type: "ask_inputs_response" }
      >;
    },
  ): Promise<string | null> => {
    if (!message.content.trim()) return null;

    setIsResponseLoading(true);

    const lastMessage = messages[messages.length - 1];
    const isMessageAlreadyAdded =
      lastMessage &&
      lastMessage.role === "user" &&
      lastMessage.content === message.content;

    const apiMessagesForTurn: Message[] = isMessageAlreadyAdded
      ? messages
      : [...messages, message];
    const askInputsResponseEvent = opts?.askInputsResponse ?? null;
    const optimisticResponseEvent = askInputsResponseEvent;
    const userInputThinkingEvent = optimisticResponseEvent
      ? ({
          type: "thinking" as const,
          isStreaming: true,
        } satisfies AssistantEvent)
      : null;
    const displayMessages: Message[] = optimisticResponseEvent
      ? (() => {
          const updated = messages.map((item) => ({
            ...item,
            events: item.events ? [...item.events] : item.events,
          }));
          for (let i = updated.length - 1; i >= 0; i--) {
            const current = updated[i];
            if (current.role !== "assistant") continue;
            updated[i] = {
              ...current,
              events: [
                ...(current.events ?? []),
                optimisticResponseEvent,
                ...(userInputThinkingEvent ? [userInputThinkingEvent] : []),
              ],
            };
            return updated;
          }
          return updated;
        })()
      : apiMessagesForTurn;

    setMessages(
      optimisticResponseEvent
        ? displayMessages
        : [
            ...displayMessages,
            {
              role: "assistant",
              content: "",
              citations: [],
              events: [],
            },
          ],
    );

    let streamedChatId: string | null = null;

    eventsRef.current = optimisticResponseEvent
      ? ([...displayMessages]
          .reverse()
          .find((item) => item.role === "assistant")?.events ?? [])
      : [];

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const apiMessages = apiMessagesForTurn.map((currentMessage) => ({
        role: currentMessage.role,
        content: currentMessage.content,
        files: currentMessage.files,
        workflow: currentMessage.workflow,
      }));

      const model = message.model;
      const reasoning = message.reasoning;

      const displayedDoc = opts?.displayedDoc ?? null;

      // Pull the user's attachments from the just-submitted message.
      // These are the files dragged into / picked from the chat input
      // for this turn (separate from the running history of past
      // attachments). Sent as a request-level field so the backend
      // can call them out specifically in the system prompt.
      const attachedDocs = (
        message.files?.filter((f) => !!f.document_id) ?? []
      ).map((f) => ({
        filename: f.filename,
        document_id: f.document_id as string,
      }));

      const response = await (projectId
        ? streamProjectChat({
            projectId,
            messages: apiMessages,
            chat_id: chatId,
            model,
            reasoning,
            displayed_doc: displayedDoc
              ? {
                  filename: displayedDoc.filename,
                  document_id: displayedDoc.documentId,
                }
              : undefined,
            attached_documents:
              attachedDocs.length > 0 ? attachedDocs : undefined,
            ask_inputs_response: opts?.askInputsResponse,
            signal: controller.signal,
          })
        : streamChat({
            messages: apiMessages,
            chat_id: chatId,
            model,
            reasoning,
            ask_inputs_response: opts?.askInputsResponse,
            signal: controller.signal,
          }));

      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`Chat request failed with status ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // Flush any bytes still held by TextDecoder. A response is allowed
          // to close without a final newline, so the remaining buffer must be
          // parsed as the last SSE record instead of being discarded.
          buffer += decoder.decode();
        } else {
          buffer += decoder.decode(value, { stream: true });
        }
        const lines = buffer.split("\n");
        buffer = done ? "" : lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;

          const dataStr = trimmed.slice(5).trim();
          if (dataStr === "[DONE]") continue;

          try {
            const data = JSON.parse(dataStr);

            if (data.type === "chat_id") {
              streamedChatId = data.chatId;
              setChatId(data.chatId);
              setCurrentChatId(data.chatId);
              continue;
            }

            if (
              data.type === "chat_title" &&
              typeof data.chatId === "string" &&
              typeof data.title === "string"
            ) {
              updateChatTitle(data.chatId, data.title);
              continue;
            }

            if (data.type === "content_done") {
              setIsLoadingCitations(true);
              continue;
            }

            if (data.type === "error") {
              const safeToDisplay = data.safe_to_display === true;
              const message = readableStreamError(
                data.message,
                safeToDisplay,
              );
              clearStreamingPlaceholders();
              finalizeStreamingContent();
              finalizeStreamingReasoning();
              eventsRef.current = [
                ...eventsRef.current,
                {
                  type: "error",
                  message,
                  ...(safeToDisplay ? { safe_to_display: true } : {}),
                },
              ];
              const snapshot = [...eventsRef.current];
              updateLatestAssistantMessage((assistantMessage) => ({
                ...assistantMessage,
                events: snapshot,
                error: message,
              }));
              setIsResponseLoading(false);
              setIsLoadingCitations(false);
              continue;
            }

            if (data.type === "content_delta") {
              const text = data.text as string;

              // Real content is streaming — retire any
              // "Thinking…" / "Running…" placeholders, and
              // finalize any in-flight reasoning block so it
              // doesn't get stuck rendering as streaming.
              clearStreamingPlaceholders();
              finalizeStreamingReasoning();

              // Ensure a streaming content event exists. If
              // the last event isn't already a streaming
              // content block, start a fresh one so interleaved
              // tool/reasoning events split content naturally.
              const events = eventsRef.current;
              const lastEvent = events[events.length - 1];
              if (lastEvent?.type !== "content" || !lastEvent.isStreaming) {
                eventsRef.current = [
                  ...events,
                  {
                    type: "content" as const,
                    text,
                    isStreaming: true,
                  },
                ];
                const snapshot = [...eventsRef.current];
                updateLatestAssistantMessage((message) => ({
                  ...message,
                  events: snapshot,
                }));
              } else {
                const nextEvents = [...events];
                nextEvents[nextEvents.length - 1] = {
                  type: "content" as const,
                  text: `${lastEvent.text}${text}`,
                  isStreaming: true,
                };
                eventsRef.current = nextEvents;
                const snapshot = [...nextEvents];
                updateLatestAssistantMessage((message) => ({
                  ...message,
                  events: snapshot,
                }));
              }
              continue;
            }

            if (data.type === "reasoning_delta") {
              const text = data.text as string;
              let events = eventsRef.current;
              const last = events[events.length - 1];
              if (last?.type === "reasoning" && last.isStreaming) {
                eventsRef.current = [
                  ...events.slice(0, -1),
                  {
                    type: "reasoning" as const,
                    text: last.text + text,
                    isStreaming: true,
                  },
                ];
              } else {
                // New reasoning block — finalize any in-flight
                // content event first so the next content_delta
                // starts a fresh block at the correct position.
                finalizeStreamingContent();
                clearStreamingPlaceholders();
                events = eventsRef.current;
                eventsRef.current = [
                  ...events,
                  {
                    type: "reasoning" as const,
                    text,
                    isStreaming: true,
                  },
                ];
              }
              const snapshot = [...eventsRef.current];
              updateLatestAssistantMessage((message) => ({
                ...message,
                events: snapshot,
              }));
              continue;
            }

            if (data.type === "reasoning_block_end") {
              const events = eventsRef.current;
              const last = events[events.length - 1];
              if (last?.type === "reasoning" && last.isStreaming) {
                eventsRef.current = [
                  ...events.slice(0, -1),
                  {
                    type: "reasoning" as const,
                    text: last.text,
                  },
                ];
              }
              const snapshot = [...eventsRef.current];
              updateLatestAssistantMessage((message) => ({
                ...message,
                events: snapshot,
              }));
              pushThinkingPlaceholder();
              continue;
            }

            if (data.type === "tool_call_start") {
              // Transient placeholder so the client immediately
              // shows activity after Claude ends a turn with
              // tool_use. Replaced by the real tool event
              // (doc_edited_start, doc_read_start, …) if one
              // arrives; otherwise it lingers as a "Working…"
              // indicator until the next iteration streams.
              pushEvent({
                type: "tool_call_start",
                name: (data.name as string) ?? "",
                isStreaming: true,
              });
              continue;
            }

            if (data.type === "workflow_applied") {
              pushEvent({
                type: "workflow_applied",
                workflow_id: data.workflow_id as string,
                title: data.title as string,
              });
              continue;
            }

            if (data.type === "case_citation") {
              pushEvent({
                type: "case_citation",
                cluster_id:
                  typeof data.cluster_id === "number"
                    ? (data.cluster_id as number)
                    : null,
                case_name:
                  typeof data.case_name === "string"
                    ? (data.case_name as string)
                    : null,
                citation:
                  typeof data.citation === "string"
                    ? (data.citation as string)
                    : null,
                url: data.url as string,
                pdfUrl:
                  typeof data.pdfUrl === "string"
                    ? (data.pdfUrl as string)
                    : null,
                dateFiled:
                  typeof data.dateFiled === "string"
                    ? (data.dateFiled as string)
                    : null,
                document: isPanelDocument(data.document)
                    ? data.document
                    : undefined,
              });
              continue;
            }

            if (data.type === "case_opinions") {
              pushEvent({
                type: "case_opinions",
                cluster_id:
                  typeof data.cluster_id === "number"
                    ? (data.cluster_id as number)
                    : 0,
                document: isPanelDocument(data.document)
                    ? data.document
                    : undefined,
              });
              continue;
            }

            if (data.type === "mcp_tool_start") {
              pushEvent({
                type: "mcp_tool_call",
                connector_id: "",
                connector_name: "",
                tool_name: (data.name as string) ?? "",
                openai_tool_name: (data.name as string) ?? "",
                status: "ok",
                isStreaming: true,
              });
              continue;
            }

            if (data.type === "mcp_tool_result") {
              const openaiToolName = (data.name as string) ?? "";
              updateMatchingEvent(
                (e) =>
                  e.type === "mcp_tool_call" &&
                  e.openai_tool_name === openaiToolName &&
                  !!e.isStreaming,
                () => ({
                  type: "mcp_tool_call",
                  connector_id: "",
                  connector_name:
                    typeof data.connector_name === "string"
                      ? (data.connector_name as string)
                      : "",
                  tool_name:
                    typeof data.tool_name === "string"
                      ? (data.tool_name as string)
                      : openaiToolName,
                  openai_tool_name: openaiToolName,
                  status: data.status === "error" ? "error" : "ok",
                  error:
                    typeof data.error === "string"
                      ? (data.error as string)
                      : undefined,
                  isStreaming: false,
                }),
              );
              pushThinkingPlaceholder();
              continue;
            }

            if (data.type === "courtlistener_search_case_law_start") {
              pushEvent({
                type: "courtlistener_search_case_law",
                query: (data.query as string) ?? "",
                isStreaming: true,
              });
              continue;
            }

            if (data.type === "courtlistener_search_case_law") {
              updateMatchingEvent(
                (e) =>
                  e.type === "courtlistener_search_case_law" &&
                  e.query === (data.query as string) &&
                  !!e.isStreaming,
                () => ({
                  type: "courtlistener_search_case_law",
                  query: (data.query as string) ?? "",
                  result_count:
                    typeof data.result_count === "number"
                      ? (data.result_count as number)
                      : 0,
                  error:
                    typeof data.error === "string"
                      ? (data.error as string)
                      : undefined,
                  isStreaming: false,
                }),
              );
              pushThinkingPlaceholder();
              continue;
            }

            if (data.type === "courtlistener_get_cases_start") {
              pushEvent({
                type: "courtlistener_get_cases",
                cluster_ids: Array.isArray(data.cluster_ids)
                  ? (data.cluster_ids as unknown[]).filter(
                      (value: unknown): value is number =>
                        typeof value === "number",
                    )
                  : [],
                isStreaming: true,
              });
              continue;
            }

            if (data.type === "courtlistener_get_cases") {
              updateMatchingEvent(
                (e) => e.type === "courtlistener_get_cases" && !!e.isStreaming,
                () => ({
                  type: "courtlistener_get_cases",
                  cluster_ids: Array.isArray(data.cluster_ids)
                    ? (data.cluster_ids as unknown[]).filter(
                        (value: unknown): value is number =>
                          typeof value === "number",
                      )
                    : [],
                  case_count:
                    typeof data.case_count === "number"
                      ? (data.case_count as number)
                      : 0,
                  opinion_count:
                    typeof data.opinion_count === "number"
                      ? (data.opinion_count as number)
                      : 0,
                  cases: parseCourtlistenerEventCases(data.cases),
                  error:
                    typeof data.error === "string"
                      ? (data.error as string)
                      : undefined,
                  isStreaming: false,
                }),
              );
              pushThinkingPlaceholder();
              continue;
            }

            if (data.type === "courtlistener_find_in_case_start") {
              const searches = parseCourtlistenerCaseSearches(data.searches);
              pushEvent({
                type: "courtlistener_find_in_case",
                cluster_id: searches?.length
                  ? null
                  : typeof data.cluster_id === "number"
                    ? (data.cluster_id as number)
                    : null,
                query: searches?.length ? "" : ((data.query as string) ?? ""),
                searches,
                isStreaming: true,
              });
              continue;
            }

            if (data.type === "courtlistener_find_in_case") {
              const searches = parseCourtlistenerCaseSearches(data.searches);
              updateMatchingEvent(
                (e) =>
                  e.type === "courtlistener_find_in_case" &&
                  (searches?.length
                    ? Array.isArray(e.searches)
                    : e.cluster_id ===
                        (typeof data.cluster_id === "number"
                          ? (data.cluster_id as number)
                          : null) && e.query === (data.query as string)) &&
                  !!e.isStreaming,
                () => ({
                  type: "courtlistener_find_in_case",
                  cluster_id: searches?.length
                    ? null
                    : typeof data.cluster_id === "number"
                      ? (data.cluster_id as number)
                      : null,
                  query: searches?.length ? "" : ((data.query as string) ?? ""),
                  total_matches:
                    typeof data.total_matches === "number"
                      ? (data.total_matches as number)
                      : 0,
                  searches,
                  case_name:
                    typeof data.case_name === "string"
                      ? (data.case_name as string)
                      : null,
                  citation:
                    typeof data.citation === "string"
                      ? (data.citation as string)
                      : null,
                  error:
                    typeof data.error === "string"
                      ? (data.error as string)
                      : undefined,
                  isStreaming: false,
                }),
              );
              pushThinkingPlaceholder();
              continue;
            }

            if (data.type === "courtlistener_read_case_start") {
              pushEvent({
                type: "courtlistener_read_case",
                cluster_id:
                  typeof data.cluster_id === "number"
                    ? (data.cluster_id as number)
                    : null,
                isStreaming: true,
              });
              continue;
            }

            if (data.type === "courtlistener_read_case") {
              updateMatchingEvent(
                (e) =>
                  e.type === "courtlistener_read_case" &&
                  e.cluster_id ===
                    (typeof data.cluster_id === "number"
                      ? (data.cluster_id as number)
                      : null) &&
                  !!e.isStreaming,
                () => ({
                  type: "courtlistener_read_case",
                  cluster_id:
                    typeof data.cluster_id === "number"
                      ? (data.cluster_id as number)
                      : null,
                  case_name:
                    typeof data.case_name === "string"
                      ? (data.case_name as string)
                      : null,
                  citation:
                    typeof data.citation === "string"
                      ? (data.citation as string)
                      : null,
                  opinion_count:
                    typeof data.opinion_count === "number"
                      ? (data.opinion_count as number)
                      : 0,
                  error:
                    typeof data.error === "string"
                      ? (data.error as string)
                      : undefined,
                  isStreaming: false,
                }),
              );
              pushThinkingPlaceholder();
              continue;
            }

            if (data.type === "courtlistener_verify_citations_start") {
              pushEvent({
                type: "courtlistener_verify_citations",
                citation_count:
                  typeof data.citation_count === "number"
                    ? (data.citation_count as number)
                    : 0,
                isStreaming: true,
              });
              continue;
            }

            if (data.type === "courtlistener_verify_citations") {
              updateMatchingEvent(
                (e) =>
                  e.type === "courtlistener_verify_citations" &&
                  !!e.isStreaming,
                () => ({
                  type: "courtlistener_verify_citations",
                  citation_count:
                    typeof data.citation_count === "number"
                      ? (data.citation_count as number)
                      : 0,
                  match_count:
                    typeof data.match_count === "number"
                      ? (data.match_count as number)
                      : 0,
                  error:
                    typeof data.error === "string"
                      ? (data.error as string)
                      : undefined,
                  isStreaming: false,
                }),
              );
              pushThinkingPlaceholder();
              continue;
            }

            if (data.type === "doc_read_start") {
              pushEvent({
                type: "doc_read",
                filename: data.filename as string,
                document_id:
                  typeof data.document_id === "string"
                    ? (data.document_id as string)
                    : undefined,
                version_id:
                  typeof data.version_id === "string"
                    ? (data.version_id as string)
                    : null,
                version_number:
                  typeof data.version_number === "number"
                    ? (data.version_number as number)
                    : null,
                isStreaming: true,
              });
              continue;
            }

            if (data.type === "ask_inputs") {
              const rawItems = Array.isArray(data.items)
                ? (data.items as unknown[])
                : [];
              const items = rawItems.reduce<
                Extract<AssistantEvent, { type: "ask_inputs" }>["items"]
              >((acc, item, index) => {
                if (!item || typeof item !== "object") return acc;
                const row = item as Record<string, unknown>;
                const id =
                  typeof row.id === "string" && row.id.trim()
                    ? row.id.trim()
                    : `input-${index + 1}`;
                if (row.kind === "choice") {
                  const options = Array.isArray(row.options)
                    ? (row.options as unknown[]).flatMap((option) => {
                        if (!option || typeof option !== "object") return [];
                        const optionRow = option as Record<string, unknown>;
                        const value =
                          typeof optionRow.value === "string"
                            ? optionRow.value
                            : typeof optionRow.label === "string"
                              ? optionRow.label
                              : "";
                        if (!value.trim()) return [];
                        return [
                          {
                            value,
                          },
                        ];
                      })
                    : [];
                  acc.push({
                    id,
                    kind: "choice" as const,
                    question:
                      typeof row.question === "string"
                        ? row.question
                        : "Please choose an option.",
                    options,
                    allow_other: row.allow_other !== false,
                    other_label:
                      typeof row.other_label === "string"
                        ? row.other_label
                        : "Other",
                    response_prefix:
                      typeof row.response_prefix === "string"
                        ? row.response_prefix
                        : undefined,
                  });
                  return acc;
                }
                if (row.kind === "text") {
                  acc.push({
                    id,
                    kind: "text" as const,
                    question:
                      typeof row.question === "string"
                        ? row.question
                        : "Please provide the requested information.",
                    response_prefix:
                      typeof row.response_prefix === "string"
                        ? row.response_prefix
                        : undefined,
                  });
                  return acc;
                }
                if (row.kind === "documents") {
                  const documentTypes = Array.isArray(row.document_types)
                    ? (row.document_types as unknown[])
                        .filter(
                          (type): type is string => typeof type === "string",
                        )
                        .map((type) => type.trim())
                        .filter(Boolean)
                    : [];
                  acc.push({
                    id,
                    kind: "documents" as const,
                    document_types: documentTypes,
                    response_prefix:
                      typeof row.response_prefix === "string"
                        ? row.response_prefix
                        : undefined,
                  });
                  return acc;
                }
                return acc;
              }, []);
              if (items.length > 0) {
                pushEvent({ type: "ask_inputs", items });
              }
              continue;
            }

            if (data.type === "doc_read") {
              updateMatchingEvent(
                (e) =>
                  e.type === "doc_read" &&
                  e.filename === data.filename &&
                  !!e.isStreaming,
                (e) => {
                  const event = e as Extract<
                    AssistantEvent,
                    { type: "doc_read" }
                  >;
                  return {
                    ...event,
                    document_id:
                      typeof data.document_id === "string"
                        ? (data.document_id as string)
                        : event.document_id,
                    version_id:
                      typeof data.version_id === "string"
                        ? (data.version_id as string)
                        : event.version_id,
                    version_number:
                      typeof data.version_number === "number"
                        ? (data.version_number as number)
                        : event.version_number,
                    isStreaming: false,
                  };
                },
              );
              pushThinkingPlaceholder();
              continue;
            }

            if (data.type === "doc_find_start") {
              pushEvent({
                type: "doc_find",
                filename: data.filename as string,
                document_id:
                  typeof data.document_id === "string"
                    ? (data.document_id as string)
                    : undefined,
                version_id:
                  typeof data.version_id === "string"
                    ? (data.version_id as string)
                    : null,
                version_number:
                  typeof data.version_number === "number"
                    ? (data.version_number as number)
                    : null,
                query: (data.query as string) ?? "",
                total_matches: 0,
                isStreaming: true,
              });
              continue;
            }

            if (data.type === "doc_find") {
              updateMatchingEvent(
                (e) =>
                  e.type === "doc_find" &&
                  e.filename === data.filename &&
                  e.query === (data.query as string) &&
                  !!e.isStreaming,
                (e) => {
                  const event = e as Extract<
                    AssistantEvent,
                    { type: "doc_find" }
                  >;
                  return {
                    ...event,
                    document_id:
                      typeof data.document_id === "string"
                        ? (data.document_id as string)
                        : event.document_id,
                    version_id:
                      typeof data.version_id === "string"
                        ? (data.version_id as string)
                        : event.version_id,
                    version_number:
                      typeof data.version_number === "number"
                        ? (data.version_number as number)
                        : event.version_number,
                    isStreaming: false,
                    total_matches:
                      typeof data.total_matches === "number"
                        ? (data.total_matches as number)
                        : event.total_matches,
                  };
                },
              );
              pushThinkingPlaceholder();
              continue;
            }

            if (data.type === "doc_created_start") {
              pushEvent({
                type: "doc_created",
                filename: data.filename as string,
                download_url: "",
                isStreaming: true,
              });
              continue;
            }

            if (data.type === "doc_download") {
              pushEvent({
                type: "doc_download",
                filename: data.filename as string,
                download_url: data.download_url as string,
              });
              continue;
            }

            if (data.type === "doc_created") {
              updateMatchingEvent(
                (e) =>
                  e.type === "doc_created" &&
                  e.filename === data.filename &&
                  !!e.isStreaming,
                (e) => {
                  const next: Extract<AssistantEvent, { type: "doc_created" }> =
                    {
                      type: "doc_created",
                      filename: (e as { filename: string }).filename,
                      download_url: data.download_url as string,
                      isStreaming: false,
                    };
                  if (typeof data.document_id === "string") {
                    next.document_id = data.document_id as string;
                  }
                  if (typeof data.version_id === "string") {
                    next.version_id = data.version_id as string;
                  }
                  if (typeof data.version_number === "number") {
                    next.version_number = data.version_number as number;
                  }
                  return next;
                },
              );
              pushThinkingPlaceholder();
              continue;
            }

            if (data.type === "doc_replicate_start") {
              pushEvent({
                type: "doc_replicated",
                filename: data.filename as string,
                count:
                  typeof data.count === "number" ? (data.count as number) : 1,
                isStreaming: true,
              });
              continue;
            }

            if (data.type === "doc_replicated") {
              updateMatchingEvent(
                (e) =>
                  e.type === "doc_replicated" &&
                  e.filename === data.filename &&
                  !!e.isStreaming,
                () => ({
                  type: "doc_replicated",
                  filename: data.filename as string,
                  count:
                    typeof data.count === "number"
                      ? (data.count as number)
                      : Array.isArray(data.copies)
                        ? (data.copies as unknown[]).length
                        : 1,
                  copies: Array.isArray(data.copies)
                    ? (data.copies as {
                        new_filename: string;
                        document_id: string;
                        version_id: string;
                      }[])
                    : undefined,
                  error:
                    typeof data.error === "string"
                      ? (data.error as string)
                      : undefined,
                  isStreaming: false,
                }),
              );
              pushThinkingPlaceholder();
              continue;
            }

            if (data.type === "doc_edited_start") {
              pushEvent({
                type: "doc_edited",
                filename: data.filename as string,
                document_id: "",
                version_id: "",
                download_url: "",
                annotations: [],
                isStreaming: true,
              });
              continue;
            }

            if (data.type === "doc_edited") {
              updateMatchingEvent(
                (e) =>
                  e.type === "doc_edited" &&
                  e.filename === data.filename &&
                  !!e.isStreaming,
                () => ({
                  type: "doc_edited",
                  filename: data.filename as string,
                  document_id: (data.document_id as string) ?? "",
                  version_id: (data.version_id as string) ?? "",
                  version_number:
                    typeof data.version_number === "number"
                      ? (data.version_number as number)
                      : null,
                  download_url: (data.download_url as string) ?? "",
                  annotations: Array.isArray(data.annotations)
                    ? (data.annotations as import("@/app/components/shared/types").EditAnnotation[])
                    : [],
                  error:
                    typeof data.error === "string"
                      ? (data.error as string)
                      : undefined,
                  isStreaming: false,
                }),
              );
              pushThinkingPlaceholder();
              continue;
            }

            if (data.type === "citations") {
              const status =
                data.status === "started" ||
                data.status === "partial" ||
                data.status === "final"
                  ? data.status
                  : "final";
              const incoming = (data.citations ?? []) as Citation[];
              if (status === "started" || status === "partial") {
                updateLatestAssistantMessage((message) => ({
                  ...message,
                  citations: incoming,
                  citationStatus: status,
                }));
                continue;
              }
              // End-of-stream signal — scrub any lingering
              // placeholders so they don't persist into the
              // finalised message. First finalize content so adding
              // citations cannot re-render the markdown/citation view
              // against a streaming block.
              finalizeStreamingContent();
              clearStreamingPlaceholders();
              updateLatestAssistantMessage((message) => ({
                ...message,
                citations: incoming,
                citationStatus: incoming.length ? "final" : undefined,
              }));
              continue;
            }
          } catch (e) {
            console.warn(
              "[useAssistantChat] failed to parse SSE line:",
              trimmed,
              e,
            );
          }
        }

        if (done) break;
      }

      finalizeStreamingReasoning();
      setIsResponseLoading(false);
      setIsLoadingCitations(false);

      const finalChatId = streamedChatId || chatId || null;
      if (finalChatId && finalChatId !== chatId) {
        if (chatId) {
          replaceChatId(
            chatId,
            finalChatId,
            message.content.trim().slice(0, 120) || "New Chat",
          );
        }
        setCurrentChatId(finalChatId);
        const chatBasePath = projectId
          ? `/projects/${projectId}/assistant/chat`
          : `/assistant/chat`;
        router.replace(`${chatBasePath}/${finalChatId}`);
      }

      await loadChats();

      return streamedChatId || null;
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        finalizeStreamingContent();
        finalizeStreamingReasoning();
        eventsRef.current = appendCancellationEvent(eventsRef.current);
        setMessages((prev) => {
          const assistantIndex = [...prev]
            .map((message, index) => ({ message, index }))
            .reverse()
            .find(({ message }) => message.role === "assistant")?.index;
          if (assistantIndex !== undefined) {
            const assistantMessage = prev[assistantIndex];
            const events = appendCancellationEvent(
              assistantMessage.events ?? eventsRef.current,
            );
            eventsRef.current = events;
            const updated = [...prev];
            updated[assistantIndex] = {
              ...assistantMessage,
              events,
            };
            return updated;
          }
          eventsRef.current = [{ type: "content", text: "Cancelled by user." }];
          return [
            ...prev,
            {
              role: "assistant",
              content: "",
              events: [{ type: "content", text: "Cancelled by user." }],
            },
          ];
        });
      } else {
        // The stream broke for a reason other than the user stopping it:
        // the user sees a generic message, Sentry gets the real one.
        reportError(error, {
          tags: { component: "assistant-chat", project: Boolean(projectId) },
        });
        finalizeStreamingContent();
        const errorMessage = "Sorry, something went wrong.";
        setMessages((prev) => {
          const assistantIndex = [...prev]
            .map((message, index) => ({ message, index }))
            .reverse()
            .find(({ message }) => message.role === "assistant")?.index;
          if (assistantIndex !== undefined) {
            const updated = [...prev];
            updated[assistantIndex] = {
              ...updated[assistantIndex],
              error: errorMessage,
            };
            return updated;
          }
          return [
            ...prev,
            {
              role: "assistant",
              content: "",
              error: errorMessage,
            },
          ];
        });
      }

      setIsResponseLoading(false);
      setIsLoadingCitations(false);
      return null;
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  };

  const handleNewChat = async (
    message: Message,
    projectId?: string,
  ): Promise<string | null> => {
    if (!message.content.trim()) return null;

    setMessages([message]);
    setNewChatMessages([message]);

    const newChatId = await saveChat(projectId);
    if (newChatId) {
      setChatId(newChatId);
      setCurrentChatId(newChatId);
    }

    return newChatId;
  };

  return {
    messages,
    isResponseLoading,
    setIsResponseLoading,
    isLoadingCitations,
    handleChat,
    handleNewChat,
    setMessages,
    cancel,
    chatId,
  };
}
