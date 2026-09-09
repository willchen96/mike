"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
    MoreHorizontal,
    Pencil,
    Plus,
    Search,
    ChevronDown,
    Trash2,
    X,
} from "lucide-react";
import { MikeIcon } from "@/app/components/chat/mike-icon";
import {
    streamTabularChat,
    getTabularChats,
    getTabularChatMessages,
    deleteTabularChat,
    renameTabularChat,
    tabularChatSelectionKey,
    mapTRMessages,
    type TRChat,
    type TRCitationAnnotation,
} from "@/app/lib/mikeApi";
import {
    isPanelDocument,
    type AssistantEvent,
    type Message,
} from "../shared/types";
import { ChatInput } from "../assistant/ChatInput";
import { PreResponseWrapper } from "../assistant/PreResponseWrapper";
import {
    DocReadBlock,
    EventBlock,
    ReasoningBlock,
} from "../assistant/message/EventBlocks";
import {
    LIQUID_GLASS_FLAT_CLASS,
    LIQUID_GLASS_SELECTED_CLASS,
    LIQUID_GLASS_HOVER_CLASS,
    LIQUID_GLASS_SUBTLE_CLASS,
} from "@/app/components/ui/liquid-surface";
import {
    LiquidDropdownButton,
    LiquidDropdownSurface,
} from "@/app/components/ui/liquid-dropdown";
import { cn } from "@/app/lib/utils";
import { CitationPillUI } from "@/shared/ui/CitationPillUI";
import { subscribeToTabularChatSettingsUpdates } from "@/app/lib/tabularChatSettingsEvents";

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

function parseCourtlistenerEventCases(value: unknown) {
    if (!Array.isArray(value)) return undefined;
    return value
        .map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
                return null;
            }
            const row = item as Record<string, unknown>;
            return {
                cluster_id:
                    typeof row.cluster_id === "number" ? row.cluster_id : 0,
                case_name:
                    typeof row.case_name === "string" ? row.case_name : null,
                citation:
                    typeof row.citation === "string" ? row.citation : null,
                dateFiled:
                    typeof row.dateFiled === "string" ? row.dateFiled : null,
                url: typeof row.url === "string" ? row.url : null,
            };
        })
        .filter(
            (item): item is NonNullable<typeof item> =>
                !!item && item.cluster_id > 0,
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
                cluster_id:
                    typeof row.cluster_id === "number" ? row.cluster_id : null,
                query: typeof row.query === "string" ? row.query : "",
                total_matches:
                    typeof row.total_matches === "number"
                        ? row.total_matches
                        : 0,
                case_name:
                    typeof row.case_name === "string" ? row.case_name : null,
                citation:
                    typeof row.citation === "string" ? row.citation : null,
                error: typeof row.error === "string" ? row.error : undefined,
            };
        })
        .filter((item): item is NonNullable<typeof item> => !!item);
}

interface Props {
    reviewId: string;
    reviewTitle?: string | null;
    projectName?: string | null;
    onCitationClick: (colIdx: number, rowIdx: number) => void;
    onClose: () => void;
    initialChatId?: string | null;
    onChatIdChange?: (chatId: string | null) => void;
    /**
     * Sending is member-tier server-side; false renders a read-only composer.
     *
     * `null` is the third answer — the review's role has not arrived yet. It
     * closes the composer like `false`, but ChatInput's placeholder stays
     * neutral instead of telling an owner they are "viewing only" for the
     * length of a fetch.
     */
    canSend?: boolean | null;
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
            // eslint-disable-next-line react-hooks/set-state-in-effect -- timed 'Done' flash on the active->idle transition
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

    const renderPreEvent = (
        event: AssistantEvent,
        index: number,
        allEvents: AssistantEvent[],
        key: number,
    ) => {
        const nextEvent = allEvents[index + 1];
        const showConnector =
            nextEvent !== undefined && nextEvent.type !== "content";

        if (event.type === "reasoning") {
            return (
                <ReasoningBlock
                    key={key}
                    text={event.text}
                    isStreaming={!!event.isStreaming && !!msg.isStreaming}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "doc_read") {
            return (
                <DocReadBlock
                    key={key}
                    filename={event.filename}
                    isStreaming={event.isStreaming}
                    showConnector={showConnector}
                    showFileIcon={false}
                />
            );
        }
        if (event.type === "thinking") {
            return (
                <EventBlock key={key} showConnector={showConnector} isStreaming>
                    <span>Thinking...</span>
                </EventBlock>
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
                                    <CitationPillUI
                                        onClick={() =>
                                            onCitationClick(
                                                cit.col_index,
                                                cit.row_index,
                                            )
                                        }
                                        title={`${cit.col_name} · ${cit.doc_name.replace(/\.[^.]+$/, "")}`}
                                        className="mx-0.5 align-super"
                                    >
                                        {cit.ref}
                                    </CitationPillUI>
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
                            >
                                {g.events.map((event, i) =>
                                    renderPreEvent(
                                        event,
                                        i,
                                        g.events,
                                        g.indices[i],
                                    ),
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
// History dropdown
// ---------------------------------------------------------------------------

function HistoryDropdown({
    chats,
    currentChatId,
    onLoad,
    onRename,
    onDelete,
}: {
    chats: TRChat[];
    currentChatId: string | null;
    onLoad: (chatId: string) => void;
    onRename: (chatId: string, title: string) => void;
    onDelete: (chatId: string) => void;
}) {
    const [query, setQuery] = useState("");
    const [menu, setMenu] = useState<{
        chatId: string;
        top: number;
        left: number;
    } | null>(null);
    const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const filtered = chats
        .filter((c) => c.id !== currentChatId)
        .filter((c) => {
            const label = c.title ?? "";
            return label.toLowerCase().includes(query.toLowerCase());
        });

    function commitRename(chatId: string) {
        const trimmed = renameValue.trim();
        setRenamingChatId(null);
        if (trimmed) onRename(chatId, trimmed);
    }

    return (
        <>
            <div className="flex items-center gap-1.5 px-3 py-2 border-b border-white/40">
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
            <div
                className="max-h-48 overflow-y-auto p-1"
                onScroll={() => setMenu(null)}
            >
                {filtered.length === 0 ? (
                    <p className="px-2 py-1.5 text-xs text-gray-400">
                        {chats.filter((c) => c.id !== currentChatId).length ===
                        0
                            ? "No previous chats."
                            : "No matches."}
                    </p>
                ) : (
                    filtered.map((chat) => {
                        const label = chat.title ?? "Chat";
                        if (renamingChatId === chat.id) {
                            return (
                                <input
                                    key={chat.id}
                                    autoFocus
                                    type="text"
                                    value={renameValue}
                                    onChange={(e) =>
                                        setRenameValue(e.target.value)
                                    }
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter")
                                            commitRename(chat.id);
                                        if (e.key === "Escape")
                                            setRenamingChatId(null);
                                    }}
                                    onBlur={() => commitRename(chat.id)}
                                    className={`w-full rounded-lg px-2 py-1.5 text-xs text-gray-700 outline-none ${LIQUID_GLASS_SELECTED_CLASS}`}
                                />
                            );
                        }
                        return (
                            <div
                                key={chat.id}
                                className="group relative flex items-center"
                            >
                                <LiquidDropdownButton
                                    onClick={() => onLoad(chat.id)}
                                    className="w-full min-w-0 rounded-lg px-2 py-1.5 pr-7 text-left truncate"
                                >
                                    {label}
                                </LiquidDropdownButton>
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        const rect =
                                            e.currentTarget.getBoundingClientRect();
                                        setMenu((v) =>
                                            v?.chatId === chat.id
                                                ? null
                                                : {
                                                      chatId: chat.id,
                                                      top: rect.bottom + 4,
                                                      left: rect.right - 112,
                                                  },
                                        );
                                    }}
                                    title="Chat options"
                                    className={cn(
                                        `absolute right-1.5 flex h-5 w-5 items-center justify-center rounded-full text-gray-400 transition-colors hover:text-gray-700 ${LIQUID_GLASS_HOVER_CLASS}`,
                                        menu?.chatId === chat.id
                                            ? "opacity-100"
                                            : "opacity-0 group-hover:opacity-100",
                                    )}
                                >
                                    <MoreHorizontal className="h-3.5 w-3.5" />
                                </button>
                                {menu?.chatId === chat.id &&
                                    createPortal(
                                        <LiquidDropdownSurface
                                            onMouseDown={(e) =>
                                                e.stopPropagation()
                                            }
                                            className="fixed z-[130] w-28 p-1"
                                            style={{
                                                top: menu.top,
                                                left: menu.left,
                                            }}
                                        >
                                            <LiquidDropdownButton
                                                onClick={() => {
                                                    setMenu(null);
                                                    setRenameValue(
                                                        chat.title ?? "",
                                                    );
                                                    setRenamingChatId(chat.id);
                                                }}
                                                className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left"
                                            >
                                                <Pencil className="h-3 w-3" />
                                                Rename
                                            </LiquidDropdownButton>
                                            <LiquidDropdownButton
                                                onClick={() => {
                                                    setMenu(null);
                                                    onDelete(chat.id);
                                                }}
                                                className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-red-600 hover:text-red-600 focus:text-red-600"
                                            >
                                                <Trash2 className="h-3 w-3" />
                                                Delete
                                            </LiquidDropdownButton>
                                        </LiquidDropdownSurface>,
                                        document.body,
                                    )}
                            </div>
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
// Header pills (matches PageHeader action group styling)
// ---------------------------------------------------------------------------

const HEADER_PILL_CLASS = `flex shrink-0 items-center gap-1 rounded-full px-1 py-0.5 ${LIQUID_GLASS_SUBTLE_CLASS} backdrop-blur-xl`;
const HEADER_PILL_BUTTON_CLASS = `flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-gray-500 transition-colors hover:text-gray-900 ${LIQUID_GLASS_HOVER_CLASS}`;
const MESSAGE_TOP_INSET = 48;
const MESSAGE_GAP = 16;
const COMPOSER_GAP = 16;

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function TRChatPanel({
    reviewId,
    reviewTitle,
    projectName,
    onCitationClick,
    onClose,
    initialChatId,
    onChatIdChange,
    canSend = true,
}: Props) {
    const [chats, setChats] = useState<TRChat[]>([]);
    const [currentChatId, setCurrentChatId] = useState<string | null>(
        initialChatId ?? null,
    );
    const [currentChatTitle, setCurrentChatTitle] = useState<string | null>(
        null,
    );
    const [currentChatModel, setCurrentChatModel] = useState<
        string | null | undefined
    >(initialChatId ? undefined : null);
    const [currentChatReasoningLevel, setCurrentChatReasoningLevel] = useState<
        NonNullable<Message["reasoning"]> | null | undefined
    >(initialChatId ? undefined : null);
    const [messages, setMessages] = useState<TRMessage[]>([]);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [isLoadingMessages, setIsLoadingMessages] = useState(false);
    const [minHeight, setMinHeight] = useState("0px");
    const [messagesVisible, setMessagesVisible] = useState(false);
    const [panelWidth, setPanelWidth] = useState(380);
    const [isResizing, setIsResizing] = useState(false);
    const [inputHeight, setInputHeight] = useState(96);

    const resizeStartRef = useRef({ x: 0, width: 380 });
    const composerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isResizing) return;
        const MIN_WIDTH = 280;
        const MAX_WIDTH = 800;
        function onMove(e: MouseEvent) {
            const delta = resizeStartRef.current.x - e.clientX;
            setPanelWidth(
                Math.min(
                    MAX_WIDTH,
                    Math.max(MIN_WIDTH, resizeStartRef.current.width + delta),
                ),
            );
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

    useEffect(() => {
        const composer = composerRef.current;
        if (!composer) return;
        const updateHeight = () => {
            setInputHeight(composer.getBoundingClientRect().height);
        };
        updateHeight();
        const observer = new ResizeObserver(updateHeight);
        observer.observe(composer);
        window.addEventListener("resize", updateHeight);
        return () => {
            observer.disconnect();
            window.removeEventListener("resize", updateHeight);
        };
    }, []);

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
            .then((loadedChats) => {
                setChats(loadedChats);
                if (!initialChatId) return;
                const initialChat = loadedChats.find(
                    (chat) => chat.id === initialChatId,
                );
                setCurrentChatModel(initialChat?.model ?? null);
                setCurrentChatReasoningLevel(
                    initialChat?.reasoning_level ?? null,
                );
            })
            .catch(() => {
                if (initialChatId) {
                    setCurrentChatModel(null);
                    setCurrentChatReasoningLevel(null);
                }
            });
    }, [reviewId]); // eslint-disable-line react-hooks/exhaustive-deps -- initialChatId is the mount-time thread; live chat id changes must not refetch settings

    // ChatInput persists through UserProfileContext. Mirror successful saves
    // into this panel's chat cache so navigating away and back does not restore
    // the stale model/reasoning values fetched when the panel first mounted.
    useEffect(
        () =>
            subscribeToTabularChatSettingsUpdates((update) => {
                if (update.reviewId !== reviewId) return;
                setChats((current) =>
                    current.map((chat) =>
                        chat.id === update.chatId
                            ? {
                                  ...chat,
                                  ...(update.model !== undefined
                                      ? { model: update.model }
                                      : {}),
                                  ...(update.reasoningLevel !== undefined
                                      ? {
                                            reasoning_level:
                                                update.reasoningLevel,
                                        }
                                      : {}),
                              }
                            : chat,
                    ),
                );
                if (update.chatId !== currentChatId) return;
                if (update.model !== undefined) {
                    setCurrentChatModel(update.model);
                }
                if (update.reasoningLevel !== undefined) {
                    setCurrentChatReasoningLevel(update.reasoningLevel);
                }
            }),
        [currentChatId, reviewId],
    );

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
                            top: element.offsetTop - MESSAGE_TOP_INSET,
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
    }, [messages]);

    useEffect(() => {
        const userEl = latestUserMessageRef.current;
        const containerEl = messagesContainerRef.current;
        if (!userEl || !containerEl) return;
        const composerSpace = Math.ceil(inputHeight + COMPOSER_GAP);
        setMinHeight(
            `${Math.max(
                0,
                containerEl.clientHeight -
                    MESSAGE_TOP_INSET -
                    userEl.offsetHeight -
                    MESSAGE_GAP -
                    composerSpace,
            )}px`,
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [inputHeight, messages.length, latestUserMessageRef.current]);

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
        if (idx === undefined) return false;
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
        return true;
    }

    // ---- chat actions ----

    function handleNewChat() {
        setCurrentChatId(null);
        setCurrentChatTitle(null);
        setCurrentChatModel(null);
        setCurrentChatReasoningLevel(null);
        setMessages([]);
        setHistoryOpen(false);
    }

    async function handleDeleteChat(chatId: string) {
        setChats((prev) => prev.filter((c) => c.id !== chatId));
        if (chatId === currentChatId) {
            setCurrentChatId(null);
            setCurrentChatTitle(null);
            setCurrentChatModel(null);
            setCurrentChatReasoningLevel(null);
            setMessages([]);
        }
        try {
            await deleteTabularChat(reviewId, chatId);
        } catch {
            /* ignore */
        }
    }

    async function handleRenameChat(chatId: string, title: string) {
        setChats((prev) =>
            prev.map((c) => (c.id === chatId ? { ...c, title } : c)),
        );
        if (chatId === currentChatId) setCurrentChatTitle(title);
        try {
            await renameTabularChat(reviewId, chatId, title);
        } catch {
            /* ignore */
        }
    }

    async function handleLoadChat(chatId: string) {
        const chat = chats.find((c) => c.id === chatId);
        setCurrentChatId(chatId);
        setCurrentChatTitle(chat?.title ?? null);
        setCurrentChatModel(chat?.model ?? null);
        setCurrentChatReasoningLevel(chat?.reasoning_level ?? null);
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

    async function handleSubmit(message: Message) {
        const trimmed = message.content.trim();
        if (!trimmed || isLoading) return;
        if (!message.model || !message.reasoning) return;
        setCurrentChatModel(message.model);
        setCurrentChatReasoningLevel(message.reasoning);

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
                    top: element.offsetTop - MESSAGE_TOP_INSET,
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
                message.model,
                message.reasoning,
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
                                              model: message.model ?? null,
                                              reasoning_level:
                                                  message.reasoning ?? null,
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

                        if (
                            data.type === "courtlistener_search_case_law_start"
                        ) {
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
                                    e.type ===
                                        "courtlistener_search_case_law" &&
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
                                (e) =>
                                    e.type === "courtlistener_get_cases" &&
                                    !!e.isStreaming,
                                () => ({
                                    type: "courtlistener_get_cases",
                                    cluster_ids: Array.isArray(data.cluster_ids)
                                        ? (
                                              data.cluster_ids as unknown[]
                                          ).filter(
                                              (
                                                  value: unknown,
                                              ): value is number =>
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
                                    cases: parseCourtlistenerEventCases(
                                        data.cases,
                                    ),
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
                            const searches = parseCourtlistenerCaseSearches(
                                data.searches,
                            );
                            pushEvent({
                                type: "courtlistener_find_in_case",
                                cluster_id: searches?.length
                                    ? null
                                    : typeof data.cluster_id === "number"
                                      ? (data.cluster_id as number)
                                      : null,
                                query: searches?.length
                                    ? ""
                                    : ((data.query as string) ?? ""),
                                searches,
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "courtlistener_find_in_case") {
                            const searches = parseCourtlistenerCaseSearches(
                                data.searches,
                            );
                            updateMatchingEvent(
                                (e) =>
                                    e.type === "courtlistener_find_in_case" &&
                                    (searches?.length
                                        ? Array.isArray(e.searches)
                                        : e.cluster_id ===
                                              (typeof data.cluster_id ===
                                              "number"
                                                  ? (data.cluster_id as number)
                                                  : null) &&
                                          e.query === (data.query as string)) &&
                                    !!e.isStreaming,
                                () => ({
                                    type: "courtlistener_find_in_case",
                                    cluster_id: searches?.length
                                        ? null
                                        : typeof data.cluster_id === "number"
                                          ? (data.cluster_id as number)
                                          : null,
                                    query: searches?.length
                                        ? ""
                                        : ((data.query as string) ?? ""),
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

                        if (
                            data.type === "courtlistener_verify_citations_start"
                        ) {
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
                                    e.type ===
                                        "courtlistener_verify_citations" &&
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
            style={
                {
                    "--tr-chat-panel-width": `${panelWidth}px`,
                } as CSSProperties
            }
            className={cn(
                "flex flex-col relative",
                // Mobile: replaces the table, filling the row minus margins.
                // md+: fixed width beside the table, top-aligned with it
                // (below the toolbar).
                "flex-1 min-w-0 mx-3 mb-3 md:flex-none md:w-[var(--tr-chat-panel-width)] md:mt-12 md:-ml-4 md:mr-6",
                "rounded-2xl",
                LIQUID_GLASS_FLAT_CLASS,
                "overflow-hidden",
            )}
        >
            {/* Resize handle */}
            <div
                onMouseDown={(e) => {
                    e.preventDefault();
                    resizeStartRef.current = {
                        x: e.clientX,
                        width: panelWidth,
                    };
                    setIsResizing(true);
                }}
                className={`absolute top-0 left-0 h-full w-1 cursor-col-resize z-20 transition-colors hidden md:block ${
                    isResizing
                        ? "bg-blue-400/70"
                        : "bg-transparent hover:bg-blue-400/70"
                }`}
            />
            {/* Header — fixed, overlaid on top of the messages */}
            <div className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between gap-2 px-2 py-2">
                {/* Title pill — opens chat history */}
                <div ref={historyRef} className="relative shrink min-w-0">
                    <div className={cn(HEADER_PILL_CLASS, "min-w-0")}>
                        <button
                            onClick={() => setHistoryOpen((v) => !v)}
                            title="Chat history"
                            className={`flex h-5 min-w-0 items-center gap-1 rounded-full px-1.5 text-gray-700 transition-colors ${LIQUID_GLASS_HOVER_CLASS}`}
                        >
                            <span className="min-w-0 truncate text-xs font-medium">
                                {currentChatTitle ?? "New chat"}
                            </span>
                            <ChevronDown
                                className={cn(
                                    "h-3 w-3 shrink-0 text-gray-400 transition-transform duration-200",
                                    historyOpen && "rotate-180",
                                )}
                            />
                        </button>
                    </div>
                    {historyOpen && (
                        <LiquidDropdownSurface className="absolute top-full left-0 z-50 mt-2 w-64 overflow-hidden">
                            <HistoryDropdown
                                chats={chats}
                                currentChatId={currentChatId}
                                onLoad={handleLoadChat}
                                onRename={handleRenameChat}
                                onDelete={handleDeleteChat}
                            />
                        </LiquidDropdownSurface>
                    )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                    {/* New chat circle — only once a chat has started */}
                    {messages.length > 0 && (
                        <div className={cn(HEADER_PILL_CLASS, "px-0.5")}>
                            <button
                                onClick={handleNewChat}
                                title="New chat"
                                className={HEADER_PILL_BUTTON_CLASS}
                            >
                                <Plus className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    )}
                    {/* Close circle */}
                    <div className={cn(HEADER_PILL_CLASS, "px-0.5")}>
                        <button
                            onClick={onClose}
                            title="Close"
                            className={HEADER_PILL_BUTTON_CLASS}
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    </div>
                </div>
            </div>

            {/* Messages */}
            <div
                ref={messagesContainerRef}
                className="tr-chat-message-fades flex-1 overflow-y-auto px-4 pt-12 flex flex-col"
                style={{ paddingBottom: Math.ceil(inputHeight + 16) }}
            >
                {isLoadingMessages && (
                    <div className="flex flex-col gap-4">
                        <div className="flex justify-end">
                            <div className="bg-gray-100 rounded-2xl p-3 w-3/5">
                                <div className="theme-shimmer h-3 bg-[length:200%_100%] animate-[shimmer_2s_ease-in-out_infinite] rounded w-full" />
                            </div>
                        </div>
                        <div className="space-y-2">
                            {[1, 2, 3, 4].map((i) => (
                                <div
                                    key={i}
                                    className={`theme-shimmer h-3 bg-[length:200%_100%] animate-[shimmer_2s_ease-in-out_infinite] rounded ${i === 3 ? "w-5/6" : i === 4 ? "w-4/6" : "w-full"}`}
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
            <div
                ref={composerRef}
                className="absolute bottom-0 left-0 right-0 z-10 px-3 pb-3"
            >
                <ChatInput
                    onSubmit={(message) => void handleSubmit(message)}
                    onCancel={handleCancel}
                    isLoading={isLoading}
                    canSend={canSend}
                    hideAddDocButton
                    hideWorkflowButton
                    chatModel={currentChatModel}
                    chatReasoningLevel={currentChatReasoningLevel}
                    chatKey={
                        currentChatId
                            ? tabularChatSelectionKey(reviewId, currentChatId)
                            : null
                    }
                />
            </div>
        </div>
    );
}
