"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
    X,
    Clock,
    MessageSquarePlus,
    Search,
    Square,
    ArrowRight,
    ChevronDown,
    Trash2,
} from "lucide-react";
import { MikeIcon } from "@/components/chat/mike-icon";
import {
    streamTabularChat,
    getTabularChats,
    getTabularChatMessages,
    deleteTabularChat,
    mapTRMessages,
    type TRChat,
    type TRCitationAnnotation,
} from "@/app/lib/mikeApi";
import type {
    AssistantEvent,
    ColumnConfig,
    MikeDocument,
} from "../shared/types";
import { ModelToggle } from "../assistant/ModelToggle";
import { ApiKeyMissingModal } from "../shared/ApiKeyMissingModal";
import { PreResponseWrapper } from "../shared/PreResponseWrapper";
import { useUserProfile } from "@/contexts/UserProfileContext";
import {
    getModelProvider,
    isModelAvailable,
    type ModelProvider,
} from "@/app/lib/modelAvailability";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TRMessage {
    role: "user" | "assistant";
    content: string;
    events?: AssistantEvent[];
    annotations?: TRCitationAnnotation[];
    isStreaming?: boolean;
}

interface Props {
    reviewId: string;
    reviewTitle?: string | null;
    projectName?: string | null;
    columns: ColumnConfig[];
    documents: MikeDocument[];
    onCitationClick: (colIdx: number, rowIdx: number) => void;
    onClose: () => void;
    initialChatId?: string | null;
    onChatIdChange?: (chatId: string | null) => void;
}

// ---------------------------------------------------------------------------
// Reasoning block
// ---------------------------------------------------------------------------

const THINKING_PHRASES = [
    "Thinking...",
    "Pondering...",
    "Analyzing...",
    "Reasoning...",
];

function ReasoningBlock({
    text,
    isStreaming,
}: {
    text: string;
    isStreaming: boolean;
}) {
    const [isOpen, setIsOpen] = useState(false);
    const [phraseIdx, setPhraseIdx] = useState(0);

    useEffect(() => {
        if (!isStreaming) return;
        const interval = setInterval(
            () => setPhraseIdx((i) => (i + 1) % THINKING_PHRASES.length),
            2000,
        );
        return () => clearInterval(interval);
    }, [isStreaming]);

    return (
        <div className="ml-1">
            <button
                onClick={() => !isStreaming && setIsOpen((v) => !v)}
                className="flex items-center text-sm text-gray-400 hover:text-gray-500 transition-colors"
            >
                {isStreaming ? (
                    <div className="w-1.5 h-1.5 rounded-full border border-gray-400 border-t-transparent animate-spin shrink-0" />
                ) : (
                    <div className="w-1.5 h-1.5 rounded-full bg-gray-300 shrink-0" />
                )}
                <span className="font-medium ml-2">
                    {isStreaming
                        ? THINKING_PHRASES[phraseIdx]
                        : "Thought process"}
                </span>
                {!isStreaming && (
                    <ChevronDown
                        size={10}
                        className={`ml-1.5 transition-transform duration-200 ${isOpen ? "" : "-rotate-90"}`}
                    />
                )}
            </button>
            {(isOpen || isStreaming) && (
                <div className="mt-1.5 ml-[14px] text-sm text-gray-400 prose prose-sm max-w-none [&>*]:text-gray-400 [&>*]:text-sm">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {text}
                    </ReactMarkdown>
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// DocRead block
// ---------------------------------------------------------------------------

function DocReadBlock({
    label,
    isStreaming,
}: {
    label: string;
    isStreaming?: boolean;
}) {
    return (
        <div className="flex items-center text-sm text-gray-400 ml-1">
            {isStreaming ? (
                <div className="w-1.5 h-1.5 rounded-full border border-gray-400 border-t-transparent animate-spin shrink-0" />
            ) : (
                <div className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
            )}
            <span className="font-medium ml-2">
                {isStreaming ? "Reading" : "Read"}
            </span>
            <span className="ml-1 text-gray-500">{label}</span>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Citation preprocessing (matches AssistantMessage.tsx pattern)
// ---------------------------------------------------------------------------

function preprocessTRCitations(
    text: string,
    annotations: TRCitationAnnotation[],
    citationsList: TRCitationAnnotation[],
): string {
    return text.replace(/\[(\d+(?:,\s*\d+)*)\]/g, (full, refsStr) => {
        const refs = (refsStr as string)
            .split(",")
            .map((s: string) => parseInt(s.trim(), 10));
        const tokens = refs.flatMap((ref: number) => {
            const ann = annotations.find((a) => a.ref === ref);
            if (!ann) return [];
            const idx = citationsList.length;
            citationsList.push(ann);
            return [`\`§${idx}§\`\u200B`];
        });
        return tokens.length > 0 ? tokens.join("") : full;
    });
}

// ---------------------------------------------------------------------------
// ResponseStatus
// ---------------------------------------------------------------------------

function TRResponseStatus({ isActive }: { isActive: boolean }) {
    const [showDone, setShowDone] = useState(false);
    const [doneVisible, setDoneVisible] = useState(false);
    const wasActiveRef = useRef(false);

    useEffect(() => {
        if (wasActiveRef.current && !isActive) {
            setShowDone(true);
            setDoneVisible(true);
            const t = setTimeout(() => setDoneVisible(false), 1500);
            wasActiveRef.current = isActive;
            return () => clearTimeout(t);
        }
        if (!wasActiveRef.current && isActive) {
            setShowDone(false);
            setDoneVisible(false);
        }
        wasActiveRef.current = isActive;
    }, [isActive]);

    return (
        <div className="w-full h-9 flex items-center mb-2">
            <MikeIcon
                spin={isActive}
                done={showDone && doneVisible}
                mike={!(showDone && doneVisible)}
                size={22}
            />
        </div>
    );
}

// ---------------------------------------------------------------------------
// TRAssistantMessage
// ---------------------------------------------------------------------------

type TREventGroup =
    | { kind: "pre"; events: AssistantEvent[]; indices: number[] }
    | {
          kind: "content";
          event: Extract<AssistantEvent, { type: "content" }>;
          index: number;
      };

function TRAssistantMessage({
    msg,
    onCitationClick,
}: {
    msg: TRMessage;
    onCitationClick: (colIdx: number, rowIdx: number) => void;
}) {
    const annotations = msg.annotations ?? [];
    const citationsList: TRCitationAnnotation[] = [];

    // Pre-process all content events
    const processedTexts: string[] = (msg.events ?? []).map((e) =>
        e.type === "content"
            ? preprocessTRCitations(e.text, annotations, citationsList)
            : "",
    );

    const events = msg.events ?? [];

    // Group consecutive non-content events together so they share a single
    // PreResponseWrapper. Content events render between wrappers.
    const groups: TREventGroup[] = [];
    {
        let current: Extract<TREventGroup, { kind: "pre" }> | null = null;
        events.forEach((e, i) => {
            if (e.type === "content") {
                if (current) {
                    groups.push(current);
                    current = null;
                }
                groups.push({ kind: "content", event: e, index: i });
            } else {
                if (!current)
                    current = { kind: "pre", events: [], indices: [] };
                current.events.push(e);
                current.indices.push(i);
            }
        });
        if (current) groups.push(current);
    }

    const hasContentAfter = (groupIdx: number): boolean => {
        for (let i = groupIdx + 1; i < groups.length; i++) {
            const g = groups[i];
            if (g.kind === "content") return true;
        }
        return false;
    };

    const renderPreEvent = (event: AssistantEvent, key: number) => {
        if (event.type === "reasoning") {
            return (
                <ReasoningBlock
                    key={key}
                    text={event.text}
                    isStreaming={!!event.isStreaming && !!msg.isStreaming}
                />
            );
        }
        if (event.type === "doc_read") {
            return (
                <DocReadBlock
                    key={key}
                    label={event.filename}
                    isStreaming={event.isStreaming}
                />
            );
        }
        if (event.type === "thinking") {
            return (
                <div
                    key={key}
                    className="flex items-center text-sm text-gray-400 ml-1"
                >
                    <div className="w-1.5 h-1.5 rounded-full border border-gray-400 border-t-transparent animate-spin shrink-0" />
                    <span className="ml-2">Thinking...</span>
                </div>
            );
        }
        return null;
    };

    const renderContent = (text: string, key: number) => (
        <div
            key={key}
            className="prose prose-sm max-w-none text-sm leading-relaxed"
        >
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                    p: ({ node, ...props }) => (
                        <p className="mb-2 leading-6" {...props} />
                    ),
                    ul: ({ node, ...props }) => (
                        <ul
                            className="list-disc list-outside mb-2 pl-4"
                            {...props}
                        />
                    ),
                    ol: ({ node, ...props }) => (
                        <ol
                            className="list-decimal list-outside mb-2 pl-4"
                            {...props}
                        />
                    ),
                    li: ({ node, ...props }) => (
                        <li className="mb-0.5 leading-6" {...props} />
                    ),
                    strong: ({ node, ...props }) => (
                        <strong className="font-semibold" {...props} />
                    ),
                    code: ({ children }) => {
                        const codeText = String(children);
                        const citMatch = codeText.match(/^§(\d+)§$/);
                        if (citMatch) {
                            const idx = parseInt(citMatch[1]);
                            const cit = citationsList[idx];
                            if (cit) {
                                return (
                                    <button
                                        onClick={() =>
                                            onCitationClick(
                                                cit.col_index,
                                                cit.row_index,
                                            )
                                        }
                                        title={`${cit.col_name} · ${cit.doc_name.replace(/\.[^.]+$/, "")}`}
                                        className="mx-0.5 inline-flex items-center justify-center rounded-full w-4 h-4 text-[10px] font-medium bg-gray-100 text-gray-900 hover:bg-gray-200 transition-colors align-super font-serif"
                                    >
                                        {idx + 1}
                                    </button>
                                );
                            }
                        }
                        return (
                            <code className="bg-gray-100 px-1 py-0.5 rounded text-xs font-mono">
                                {children}
                            </code>
                        );
                    },
                }}
            >
                {text}
            </ReactMarkdown>
        </div>
    );

    return (
        <div className="text-gray-900 font-serif">
            <TRResponseStatus isActive={!!msg.isStreaming} />
            {groups.length > 0 && (
                <div className="flex flex-col gap-2.5">
                    {groups.map((g, gIdx) => {
                        if (g.kind === "content") {
                            return renderContent(
                                processedTexts[g.index],
                                g.index,
                            );
                        }
                        const subsequentContent = hasContentAfter(gIdx);
                        // "Working" while at least one event in *this*
                        // wrapper is actively streaming. Gaps between real
                        // events are bridged by `pushThinkingPlaceholder`
                        // so this check stays continuously true through
                        // the whole pre-content phase.
                        const wrapperIsStreaming = g.events.some(
                            (event) =>
                                "isStreaming" in event && !!event.isStreaming,
                        );
                        return (
                            <PreResponseWrapper
                                key={`p-${g.indices[0]}`}
                                stepCount={g.events.length}
                                shouldMinimize={subsequentContent}
                                isStreaming={wrapperIsStreaming}
                                compact
                            >
                                {g.events.map((event, i) =>
                                    renderPreEvent(event, g.indices[i]),
                                )}
                            </PreResponseWrapper>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// MessageBubble
// ---------------------------------------------------------------------------

function MessageBubble({
    msg,
    onCitationClick,
}: {
    msg: TRMessage;
    onCitationClick: (colIdx: number, rowIdx: number) => void;
}) {
    if (msg.role === "user") {
        return (
            <div className="flex justify-end">
                <div className="max-w-[90%] rounded-md bg-gray-100 px-3 py-2 text-xs text-gray-800 whitespace-pre-wrap">
                    {msg.content}
                </div>
            </div>
        );
    }
    return <TRAssistantMessage msg={msg} onCitationClick={onCitationClick} />;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

function TRChatInput({
    isLoading,
    onSubmit,
    onCancel,
    model,
    onModelChange,
    apiKeys,
}: {
    isLoading: boolean;
    onSubmit: (value: string) => void;
    onCancel: () => void;
    model: string;
    onModelChange: (id: string) => void;
    apiKeys: { claudeApiKey: string | null; geminiApiKey: string | null; openaiApiKey: string | null };
}) {
    const [value, setValue] = useState("");
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    function handleAction() {
        if (isLoading) {
            onCancel();
            return;
        }
        const trimmed = value.trim();
        if (!trimmed) return;
        setValue("");
        if (textareaRef.current) textareaRef.current.style.height = "auto";
        onSubmit(trimmed);
    }

    return (
        <div className="absolute bottom-0 left-0 right-0 mx-4 pb-4 bg-white">
            <div className="border border-gray-300 rounded-xl bg-white  pt-1.5 pb-1.5 flex flex-col gap-1">
                <textarea
                    ref={textareaRef}
                    rows={1}
                    placeholder="Ask a question about your documents..."
                    value={value}
                    onChange={(e) => {
                        setValue(e.target.value);
                        e.target.style.height = "auto";
                        e.target.style.height = `${e.target.scrollHeight}px`;
                    }}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            handleAction();
                        }
                    }}
                    className="flex-1 resize-none text-sm bg-transparent outline-none placeholder:text-gray-400 leading-6 max-h-48 overflow-y-auto border-0 p-0 pl-3 pr-2 pt-1"
                />
                <div className="flex items-center justify-between pl-1 pr-2">
                    <ModelToggle
                        value={model}
                        onChange={onModelChange}
                        apiKeys={apiKeys}
                    />
                    <button
                        type="button"
                        onClick={handleAction}
                        disabled={!isLoading && !value.trim()}
                        className="relative bg-gradient-to-b from-neutral-700 to-black text-white rounded-[10px] h-7 w-7 shrink-0 flex items-center justify-center disabled:cursor-default disabled:from-neutral-600 disabled:to-black border border-white/30 active:enabled:scale-95 transition-all duration-150"
                    >
                        {isLoading ? (
                            <Square
                                className="h-3.5 w-3.5"
                                fill="currentColor"
                                strokeWidth={0}
                            />
                        ) : (
                            <ArrowRight className="h-3.5 w-3.5" />
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// History dropdown
// ---------------------------------------------------------------------------

function HistoryDropdown({
    chats,
    currentChatId,
    onLoad,
}: {
    chats: TRChat[];
    currentChatId: string | null;
    onLoad: (chatId: string) => void;
}) {
    const [query, setQuery] = useState("");
    const filtered = chats
        .filter((c) => c.id !== currentChatId)
        .filter((c) => {
            const label = c.title ?? "";
            return label.toLowerCase().includes(query.toLowerCase());
        });

    return (
        <>
            <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-gray-100">
                <Search className="h-3 w-3 text-gray-400 shrink-0" />
                <input
                    autoFocus
                    type="text"
                    placeholder="Search chats…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="flex-1 text-xs bg-transparent outline-none placeholder:text-gray-400 text-gray-700"
                />
            </div>
            <div className="max-h-48 overflow-y-auto">
                {filtered.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-gray-400">
                        {chats.filter((c) => c.id !== currentChatId).length ===
                        0
                            ? "No previous chats."
                            : "No matches."}
                    </p>
                ) : (
                    filtered.map((chat) => {
                        const label = chat.title ?? "Chat";
                        return (
                            <button
                                key={chat.id}
                                onClick={() => onLoad(chat.id)}
                                className="w-full px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-50 transition-colors truncate"
                            >
                                {label}
                            </button>
                        );
                    })
                )}
            </div>
        </>
    );
}

// ---------------------------------------------------------------------------
// Drip helpers
// ---------------------------------------------------------------------------

function findLastContentIndex(events: AssistantEvent[]): number {
    for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === "content") return i;
    }
    return -1;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function TRChatPanel({
    reviewId,
    reviewTitle,
    projectName,
    columns: _columns,
    documents: _documents,
    onCitationClick,
    onClose,
    initialChatId,
    onChatIdChange,
}: Props) {
    const { profile, updateModelPreference } = useUserProfile();
    const apiKeys = {
        claudeApiKey: profile?.claudeApiKey ?? null,
        geminiApiKey: profile?.geminiApiKey ?? null,
        openaiApiKey: process.env.NEXT_PUBLIC_VLLM_API_KEY || "configured",
    };
    const currentModel = profile?.tabularModel ?? "gemini-3-flash-preview";
    const [apiKeyModalProvider, setApiKeyModalProvider] =
        useState<ModelProvider | null>(null);
    const [chats, setChats] = useState<TRChat[]>([]);
    const [currentChatId, setCurrentChatId] = useState<string | null>(
        initialChatId ?? null,
    );
    const [currentChatTitle, setCurrentChatTitle] = useState<string | null>(
        null,
    );
    const [messages, setMessages] = useState<TRMessage[]>([]);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [isLoadingMessages, setIsLoadingMessages] = useState(false);
    const [minHeight, setMinHeight] = useState("0px");
    const [messagesVisible, setMessagesVisible] = useState(false);
    const [panelWidth, setPanelWidth] = useState(380);
    const [isResizing, setIsResizing] = useState(false);

    useEffect(() => {
        if (!isResizing) return;
        const MIN_WIDTH = 280;
        const MAX_WIDTH = 800;
        function onMove(e: MouseEvent) {
            setPanelWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, e.clientX)));
        }
        function onUp() {
            setIsResizing(false);
        }
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        return () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        };
    }, [isResizing]);

    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const latestUserMessageRef = useRef<HTMLDivElement>(null);
    const abortRef = useRef<AbortController | null>(null);
    const historyRef = useRef<HTMLDivElement>(null);
    const hasScrolledRef = useRef(false);

    // Drip animation refs
    const dripIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const dripTargetRef = useRef<string>("");
    const dripDisplayLenRef = useRef<number>(0);
    const eventsRef = useRef<AssistantEvent[]>([]);
    const DRIP_CHARS = 8;

    // Load existing chats from DB on mount
    useEffect(() => {
        getTabularChats(reviewId)
            .then(setChats)
            .catch(() => {});
    }, [reviewId]);

    // Load messages for an initial chat id (e.g. from URL)
    useEffect(() => {
        if (!initialChatId) return;
        setIsLoadingMessages(true);
        getTabularChatMessages(reviewId, initialChatId)
            .then((raw) => setMessages(mapTRMessages(raw) as TRMessage[]))
            .catch(() => {})
            .finally(() => setIsLoadingMessages(false));
    }, [reviewId]); // eslint-disable-line react-hooks/exhaustive-deps

    // Fill in title once chats list arrives
    useEffect(() => {
        if (currentChatId && !currentChatTitle) {
            const chat = chats.find((c) => c.id === currentChatId);
            if (chat) setCurrentChatTitle(chat.title ?? null);
        }
    }, [chats, currentChatId, currentChatTitle]);

    // Emit currentChatId changes to parent
    const onChatIdChangeRef = useRef(onChatIdChange);
    useEffect(() => {
        onChatIdChangeRef.current = onChatIdChange;
    });
    useEffect(() => {
        onChatIdChangeRef.current?.(currentChatId);
    }, [currentChatId]);

    useEffect(() => {
        if (messages.length === 0) {
            hasScrolledRef.current = false;
            setMessagesVisible(false);
        } else if (!hasScrolledRef.current) {
            const userMsgCount = messages.filter(
                (m) => m.role === "user",
            ).length;
            if (
                userMsgCount >= 2 &&
                latestUserMessageRef.current &&
                messagesContainerRef.current
            ) {
                setTimeout(() => {
                    const container = messagesContainerRef.current;
                    const element = latestUserMessageRef.current;
                    if (container && element) {
                        container.scrollTo({
                            top: element.offsetTop - 44,
                            behavior: "instant",
                        });
                    }
                    hasScrolledRef.current = true;
                    setMessagesVisible(true);
                }, 100);
            } else {
                hasScrolledRef.current = true;
                setMessagesVisible(true);
            }
        }
    }, [messages]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        const userEl = latestUserMessageRef.current;
        const containerEl = messagesContainerRef.current;
        if (!userEl || !containerEl) return;
        const BOTTOM_PAD = 96;
        const messageContainerTopPadding = 16;
        const messageGap = 16;
        setMinHeight(
            `${Math.max(0, containerEl.clientHeight - BOTTOM_PAD - userEl.offsetHeight - messageContainerTopPadding - messageGap)}px`,
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [messages.length, latestUserMessageRef.current]);

    useEffect(() => {
        if (!historyOpen) return;
        function handleClick(e: MouseEvent) {
            if (
                historyRef.current &&
                !historyRef.current.contains(e.target as Node)
            ) {
                setHistoryOpen(false);
            }
        }
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [historyOpen]);

    // ---- drip ----

    function stopDrip() {
        if (dripIntervalRef.current !== null) {
            clearInterval(dripIntervalRef.current);
            dripIntervalRef.current = null;
        }
    }

    function updateLastContentEvent(
        prev: TRMessage[],
        text: string,
        isStreaming?: boolean,
    ): TRMessage[] {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role !== "assistant") return prev;
        const evts = last.events ?? [];
        const idx = findLastContentIndex(evts);
        if (idx < 0) return prev;
        const newEvents = [...evts];
        newEvents[idx] = isStreaming
            ? { type: "content", text, isStreaming: true }
            : { type: "content", text };
        updated[updated.length - 1] = { ...last, events: newEvents };
        return updated;
    }

    // Mirror the dripped content text onto eventsRef.current so that any
    // subsequent setMessages built from a refsnapshot (pushEvent,
    // updateMatchingEvent, reasoning_*, etc.) doesn't wipe out the content
    // by replacing it with the stale empty placeholder.
    function syncDripIntoEventsRef(text: string, isStreaming: boolean) {
        const evts = eventsRef.current;
        const idx = findLastContentIndex(evts);
        if (idx < 0) return;
        const newEvents = [...evts];
        newEvents[idx] = isStreaming
            ? { type: "content", text, isStreaming: true }
            : { type: "content", text };
        eventsRef.current = newEvents;
    }

    function flushDrip() {
        stopDrip();
        const target = dripTargetRef.current;
        dripDisplayLenRef.current = target.length;
        syncDripIntoEventsRef(target, false);
        setMessages((prev) => updateLastContentEvent(prev, target));
    }

    function startDrip() {
        if (dripIntervalRef.current !== null) return;
        dripIntervalRef.current = setInterval(() => {
            const target = dripTargetRef.current;
            const displayLen = dripDisplayLenRef.current;
            if (displayLen >= target.length) return;
            const newLen = Math.min(displayLen + DRIP_CHARS, target.length);
            dripDisplayLenRef.current = newLen;
            const slice = target.slice(0, newLen);
            syncDripIntoEventsRef(slice, true);
            setMessages((prev) => updateLastContentEvent(prev, slice, true));
        }, 16);
    }

    // ---- event helpers ----

    // Transient placeholder events that bridge the gap between real SSE
    // events so the PreResponseWrapper doesn't briefly flip to "Completed"
    // when one block ends before the next starts. Anytime a real event
    // arrives (or content begins streaming), drop them first.
    function isStreamingPlaceholder(e: AssistantEvent) {
        return e.type === "thinking" && !!e.isStreaming;
    }

    function clearStreamingPlaceholders() {
        const before = eventsRef.current;
        const after = before.filter((e) => !isStreamingPlaceholder(e));
        if (after.length === before.length) return;
        eventsRef.current = after;
        const snapshot = [...after];
        setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
                updated[updated.length - 1] = { ...last, events: snapshot };
            }
            return updated;
        });
    }

    function pushThinkingPlaceholder() {
        const events = eventsRef.current;
        const last = events[events.length - 1];
        // Don't stack placeholders back-to-back.
        if (last && isStreamingPlaceholder(last)) return;
        eventsRef.current = [
            ...events,
            { type: "thinking" as const, isStreaming: true },
        ];
        const snapshot = [...eventsRef.current];
        setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
                updated[updated.length - 1] = { ...last, events: snapshot };
            }
            return updated;
        });
    }

    function pushEvent(event: AssistantEvent) {
        // Drop any in-flight placeholder unless we're pushing one ourselves.
        let next = eventsRef.current;
        if (event.type !== "thinking") {
            next = next.filter((e) => !isStreamingPlaceholder(e));
        }
        eventsRef.current = [...next, event];
        const snapshot = [...eventsRef.current];
        setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
                updated[updated.length - 1] = { ...last, events: snapshot };
            }
            return updated;
        });
    }

    function updateMatchingEvent(
        predicate: (e: AssistantEvent) => boolean,
        updater: (e: AssistantEvent) => AssistantEvent,
    ) {
        const events = eventsRef.current;
        const idx = [...events]
            .map((_, i) => i)
            .reverse()
            .find((i) => predicate(events[i]));
        if (idx === undefined) return;
        const newEvents = [...events];
        newEvents[idx] = updater(events[idx]);
        eventsRef.current = newEvents;
        const snapshot = [...newEvents];
        setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
                updated[updated.length - 1] = { ...last, events: snapshot };
            }
            return updated;
        });
    }

    // ---- chat actions ----

    function handleNewChat() {
        setCurrentChatId(null);
        setCurrentChatTitle(null);
        setMessages([]);
        setHistoryOpen(false);
    }

    async function handleDeleteChat() {
        if (!currentChatId) return;
        const chatIdToDelete = currentChatId;
        setChats((prev) => prev.filter((c) => c.id !== chatIdToDelete));
        setCurrentChatId(null);
        setCurrentChatTitle(null);
        setMessages([]);
        try {
            await deleteTabularChat(reviewId, chatIdToDelete);
        } catch {
            /* ignore */
        }
    }

    async function handleLoadChat(chatId: string) {
        const chat = chats.find((c) => c.id === chatId);
        setCurrentChatId(chatId);
        setCurrentChatTitle(chat?.title ?? null);
        setMessages([]);
        setHistoryOpen(false);
        setIsLoadingMessages(true);
        try {
            const raw = await getTabularChatMessages(reviewId, chatId);
            setMessages(mapTRMessages(raw) as TRMessage[]);
        } catch {
            /* ignore */
        } finally {
            setIsLoadingMessages(false);
        }
    }

    function handleCancel() {
        abortRef.current?.abort();
    }

    async function handleSubmit(trimmed: string) {
        if (!trimmed || isLoading) return;
        if (!isModelAvailable(currentModel, apiKeys)) {
            setApiKeyModalProvider(getModelProvider(currentModel));
            return;
        }

        // Build messages array for backend (plain text history)
        const history: { role: string; content: string }[] = messages.map(
            (m) => ({
                role: m.role,
                content: m.content,
            }),
        );
        const allMessages = [...history, { role: "user", content: trimmed }];

        const userMsg: TRMessage = { role: "user", content: trimmed };
        const assistantMsg: TRMessage = {
            role: "assistant",
            content: "",
            events: [],
            isStreaming: true,
        };

        setMessages((prev) => [...prev, userMsg, assistantMsg]);
        setIsLoading(true);

        setTimeout(() => {
            const container = messagesContainerRef.current;
            const element = latestUserMessageRef.current;
            if (container && element) {
                container.scrollTo({
                    top: element.offsetTop - 44,
                    behavior: "smooth",
                });
            }
        }, 50);

        stopDrip();
        dripTargetRef.current = "";
        dripDisplayLenRef.current = 0;
        eventsRef.current = [];

        const controller = new AbortController();
        abortRef.current = controller;

        try {
            const response = await streamTabularChat(
                reviewId,
                allMessages,
                currentChatId,
                controller.signal,
                { reviewTitle, projectName },
            );
            if (!response.body) throw new Error("No response body");

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";

                for (const line of lines) {
                    if (!line.startsWith("data:")) continue;
                    const dataStr = line.slice(5).trim();
                    if (dataStr === "[DONE]") continue;

                    try {
                        const data = JSON.parse(dataStr);

                        if (data.type === "chat_id") {
                            const newId = data.chatId as string;
                            setCurrentChatId(newId);
                            setChats((prev) =>
                                prev.some((c) => c.id === newId)
                                    ? prev
                                    : [
                                          {
                                              id: newId,
                                              title: null,
                                              created_at:
                                                  new Date().toISOString(),
                                              updated_at:
                                                  new Date().toISOString(),
                                          },
                                          ...prev,
                                      ],
                            );
                            continue;
                        }

                        if (data.type === "chat_title") {
                            const { chatId, title } = data as {
                                chatId: string;
                                title: string;
                            };
                            setChats((prev) =>
                                prev.map((c) =>
                                    c.id === chatId ? { ...c, title } : c,
                                ),
                            );
                            setCurrentChatTitle(title);
                            continue;
                        }

                        if (data.type === "reasoning_delta") {
                            const text = data.text as string;
                            const events = eventsRef.current;
                            const last = events[events.length - 1];
                            if (
                                last?.type === "reasoning" &&
                                last.isStreaming
                            ) {
                                eventsRef.current = [
                                    ...events.slice(0, -1),
                                    {
                                        type: "reasoning" as const,
                                        text: last.text + text,
                                        isStreaming: true,
                                    },
                                ];
                            } else {
                                // New reasoning block — drop any bridging
                                // placeholder before it so the wrapper
                                // doesn't render both.
                                const cleaned = events.filter(
                                    (e) => !isStreamingPlaceholder(e),
                                );
                                eventsRef.current = [
                                    ...cleaned,
                                    {
                                        type: "reasoning" as const,
                                        text,
                                        isStreaming: true,
                                    },
                                ];
                            }
                            const snapshot = [...eventsRef.current];
                            setMessages((prev) => {
                                const updated = [...prev];
                                const last = updated[updated.length - 1];
                                if (last?.role === "assistant") {
                                    updated[updated.length - 1] = {
                                        ...last,
                                        events: snapshot,
                                    };
                                }
                                return updated;
                            });
                            continue;
                        }

                        if (data.type === "reasoning_block_end") {
                            const events = eventsRef.current;
                            const last = events[events.length - 1];
                            if (
                                last?.type === "reasoning" &&
                                last.isStreaming
                            ) {
                                eventsRef.current = [
                                    ...events.slice(0, -1),
                                    {
                                        type: "reasoning" as const,
                                        text: last.text,
                                    },
                                ];
                            }
                            const snapshot = [...eventsRef.current];
                            setMessages((prev) => {
                                const updated = [...prev];
                                const last = updated[updated.length - 1];
                                if (last?.role === "assistant") {
                                    updated[updated.length - 1] = {
                                        ...last,
                                        events: snapshot,
                                    };
                                }
                                return updated;
                            });
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "content_delta") {
                            const text = data.text as string;
                            dripTargetRef.current += text;
                            const events = eventsRef.current;
                            const lastEvent = events[events.length - 1];
                            if (
                                lastEvent?.type !== "content" ||
                                !lastEvent.isStreaming
                            ) {
                                // Finalize any still-streaming reasoning
                                // event AND drop bridging placeholders so
                                // the wrapper transitions cleanly into
                                // content.
                                const finalized = events
                                    .filter((e) => !isStreamingPlaceholder(e))
                                    .map((e) =>
                                        e.type === "reasoning" && e.isStreaming
                                            ? {
                                                  type: "reasoning" as const,
                                                  text: e.text,
                                              }
                                            : e,
                                    );
                                eventsRef.current = [
                                    ...finalized,
                                    {
                                        type: "content" as const,
                                        text: "",
                                        isStreaming: true,
                                    },
                                ];
                                const snapshot = [...eventsRef.current];
                                setMessages((prev) => {
                                    const updated = [...prev];
                                    const last = updated[updated.length - 1];
                                    if (last?.role === "assistant") {
                                        updated[updated.length - 1] = {
                                            ...last,
                                            events: snapshot,
                                        };
                                    }
                                    return updated;
                                });
                            }
                            startDrip();
                            continue;
                        }

                        if (data.type === "doc_read_start") {
                            pushEvent({
                                type: "doc_read",
                                filename: data.filename as string,
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "doc_read") {
                            updateMatchingEvent(
                                (e) =>
                                    e.type === "doc_read" &&
                                    e.filename === data.filename &&
                                    !!e.isStreaming,
                                (e) => ({ ...e, isStreaming: false }),
                            );
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "citations") {
                            // End-of-stream signal — scrub any lingering
                            // placeholders so they don't persist into the
                            // finalised message.
                            clearStreamingPlaceholders();
                            const incoming = (data.citations ??
                                []) as TRCitationAnnotation[];
                            setMessages((prev) => {
                                const updated = [...prev];
                                const last = updated[updated.length - 1];
                                if (last?.role === "assistant") {
                                    updated[updated.length - 1] = {
                                        ...last,
                                        annotations: incoming,
                                    };
                                }
                                return updated;
                            });
                            continue;
                        }
                    } catch {
                        /* skip malformed */
                    }
                }
            }

            flushDrip();
            clearStreamingPlaceholders();
            setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === "assistant") {
                    updated[updated.length - 1] = {
                        ...last,
                        isStreaming: false,
                    };
                }
                return updated;
            });
        } catch (err: unknown) {
            const isAbort = err instanceof Error && err.name === "AbortError";
            stopDrip();
            clearStreamingPlaceholders();
            setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === "assistant") {
                    const hasContent = (last.events ?? []).some(
                        (e) =>
                            e.type === "content" &&
                            (e as { type: "content"; text: string }).text,
                    );
                    if (!hasContent) {
                        updated[updated.length - 1] = {
                            ...last,
                            isStreaming: false,
                            events: [
                                ...(last.events ?? []),
                                {
                                    type: "content" as const,
                                    text: isAbort
                                        ? ""
                                        : "An error occurred. Please try again.",
                                },
                            ],
                        };
                    } else {
                        updated[updated.length - 1] = {
                            ...last,
                            isStreaming: false,
                        };
                    }
                }
                return updated;
            });
        } finally {
            setIsLoading(false);
            abortRef.current = null;
        }
    }

    // ---- render ----

    const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
    const lastAssistantIdx = messages
        .map((m) => m.role)
        .lastIndexOf("assistant");

    return (
        <div
            style={{ width: panelWidth }}
            className="shrink-0 flex flex-col border-r border-gray-200 bg-white h-full relative"
        >
            {/* Resize handle */}
            <div
                onMouseDown={(e) => {
                    e.preventDefault();
                    setIsResizing(true);
                }}
                className={`absolute top-0 right-0 h-full w-1 cursor-col-resize z-20 transition-colors ${
                    isResizing
                        ? "bg-blue-500"
                        : "bg-transparent hover:bg-blue-500"
                }`}
            />
            {/* Header */}
            <div className="flex items-center justify-between h-8 px-2 border-b border-gray-200 shrink-0">
                <div className="flex items-center gap-1.5 px-2 min-w-0">
                    <MikeIcon mike size={14} />
                    <div
                        onMouseEnter={(e) => {
                            const el = e.currentTarget;
                            const overflow = el.scrollWidth - el.clientWidth;
                            if (overflow > 0)
                                el.scrollTo({
                                    left: overflow,
                                    behavior: "smooth",
                                });
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.scrollTo({
                                left: 0,
                                behavior: "smooth",
                            });
                        }}
                        className="min-w-0 overflow-x-hidden whitespace-nowrap scrollbar-none"
                    >
                        <span className="text-xs font-medium text-gray-700">
                            {currentChatTitle ?? "Assistant"}
                        </span>
                    </div>
                </div>
                <div className="flex items-center">
                    <div ref={historyRef} className="relative">
                        <button
                            onClick={() => setHistoryOpen((v) => !v)}
                            title="Chat history"
                            className={`flex items-center justify-center h-7 w-7 rounded-md transition-colors ${historyOpen ? "text-gray-900" : "text-gray-400 hover:text-gray-700"}`}
                        >
                            <Clock className="h-3.5 w-3.5" />
                        </button>
                        {historyOpen && (
                            <div className="absolute top-full right-0 mt-1 w-64 rounded-lg border border-gray-100 bg-white shadow-lg z-50 overflow-hidden">
                                <HistoryDropdown
                                    chats={chats}
                                    currentChatId={currentChatId}
                                    onLoad={handleLoadChat}
                                />
                            </div>
                        )}
                    </div>
                    <button
                        onClick={handleNewChat}
                        title="New chat"
                        className="flex items-center justify-center h-7 w-7 rounded-md text-gray-400 hover:text-gray-700 transition-colors"
                    >
                        <MessageSquarePlus className="h-3.5 w-3.5" />
                    </button>
                    {currentChatId && (
                        <button
                            onClick={handleDeleteChat}
                            title="Delete chat"
                            className="flex items-center justify-center h-7 w-7 rounded-md text-gray-400 hover:text-red-600 transition-colors"
                        >
                            <Trash2 className="h-3.5 w-3.5" />
                        </button>
                    )}
                    <button
                        onClick={onClose}
                        title="Close"
                        className="flex items-center justify-center h-7 w-7 rounded-md text-gray-400 hover:text-gray-700 transition-colors"
                    >
                        <X className="h-3.5 w-3.5" />
                    </button>
                </div>
            </div>

            {/* Messages */}
            <div
                ref={messagesContainerRef}
                className="flex-1 overflow-y-auto px-4 pt-4 pb-[96px] flex flex-col"
            >
                {messages.length === 0 && !isLoadingMessages && (
                    <div className="flex flex-1 flex-col items-center justify-center gap-2">
                        <MikeIcon size={24} />
                        <p className="text-sm text-gray-400 text-center">
                            Ask a question about this tabular review.
                        </p>
                    </div>
                )}
                {isLoadingMessages && (
                    <div className="flex flex-col gap-4">
                        <div className="flex justify-end">
                            <div className="bg-gray-100 rounded-2xl p-3 w-3/5">
                                <div className="h-3 bg-gradient-to-r from-gray-200 via-gray-300 to-gray-200 bg-[length:200%_100%] animate-[shimmer_2s_ease-in-out_infinite] rounded w-full" />
                            </div>
                        </div>
                        <div className="space-y-2">
                            {[1, 2, 3, 4].map((i) => (
                                <div
                                    key={i}
                                    className={`h-3 bg-gradient-to-r from-gray-200 via-gray-300 to-gray-200 bg-[length:200%_100%] animate-[shimmer_2s_ease-in-out_infinite] rounded ${i === 3 ? "w-5/6" : i === 4 ? "w-4/6" : "w-full"}`}
                                />
                            ))}
                        </div>
                    </div>
                )}
                {messages.length > 0 && (
                    <div
                        className="flex flex-col gap-4 transition-opacity duration-150"
                        style={{ opacity: messagesVisible ? 1 : 0 }}
                    >
                        {messages.map((msg, i) => (
                            <div
                                key={i}
                                ref={
                                    i === lastUserIdx
                                        ? latestUserMessageRef
                                        : null
                                }
                                style={
                                    i === lastAssistantIdx
                                        ? { minHeight }
                                        : undefined
                                }
                            >
                                <MessageBubble
                                    msg={msg}
                                    onCitationClick={onCitationClick}
                                />
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Input */}
            <TRChatInput
                isLoading={isLoading}
                onSubmit={handleSubmit}
                onCancel={handleCancel}
                model={currentModel}
                onModelChange={(id) =>
                    updateModelPreference("tabularModel", id)
                }
                apiKeys={apiKeys}
            />

            <ApiKeyMissingModal
                open={apiKeyModalProvider !== null}
                provider={apiKeyModalProvider}
                onClose={() => setApiKeyModalProvider(null)}
            />
        </div>
    );
}
