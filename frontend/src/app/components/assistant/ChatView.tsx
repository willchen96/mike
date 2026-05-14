"use client";

import { useCallback, useState, useRef, useEffect } from "react";
import type { ReactNode } from "react";
import { ArrowDown } from "lucide-react";
import { UserMessage } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";
import { ChatInput } from "./ChatInput";
import {
    AssistantSidePanel,
    type AssistantSidePanelTab,
} from "./AssistantSidePanel";
import { AssistantWorkflowModal } from "./AssistantWorkflowModal";
import type {
    MikeCitationAnnotation,
    MikeEditAnnotation,
    MikeMessage,
} from "../shared/types";
import { useSidebar } from "@/app/contexts/SidebarContext";
import { invalidateDocxBytes } from "@/app/hooks/useFetchDocxBytes";

interface ChatInputOverrides {
    hideAddDocButton?: boolean;
    projectName?: string;
    projectCmNumber?: string | null;
}

interface Props {
    messages: MikeMessage[];
    isResponseLoading: boolean;
    handleChat: (message: MikeMessage) => Promise<string | null>;
    cancel: () => void;
    /** Project-only UI rendered to the left of the chat column. When absent, layout is unchanged. */
    leftPane?: ReactNode;
    /** Project context identifier — passed through for features that need it. */
    projectId?: string;
    /** Optional overrides forwarded to ChatInput (project pages use hideAddDocButton + project name). */
    chatInputProps?: ChatInputOverrides;
    getDocumentPreview?: (documentId: string) => {
        pdfConversionStatus?: "pending" | "ok" | "failed" | null;
        onRetryPdf?: () => void | Promise<void>;
    } | null;
}

export function ChatView({
    messages,
    isResponseLoading,
    handleChat,
    cancel,
    leftPane,
    projectId: _projectId,
    chatInputProps,
    getDocumentPreview,
}: Props) {
    const [tabs, setTabs] = useState<AssistantSidePanelTab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);
    const [panelMounted, setPanelMounted] = useState(false);
    const [panelVisible, setPanelVisible] = useState(false);
    const [workflowModalOpen, setWorkflowModalOpen] = useState(false);
    const [workflowModalInitialId, setWorkflowModalInitialId] = useState<
        string | undefined
    >();
    const [reloadingDocIds, setReloadingDocIds] = useState<Set<string>>(
        () => new Set(),
    );
    // Per-edit in-flight set — disables Accept/Reject on only the one
    // edit currently being resolved, so sibling edits in the same message
    // (and their twins in DocPanel) stay clickable.
    const [reloadingEditIds, setReloadingEditIds] = useState<Set<string>>(
        () => new Set(),
    );
    const { setSidebarOpen } = useSidebar();


    const showPanel = useCallback(() => {
        setPanelMounted(true);
        setSidebarOpen(false);
        requestAnimationFrame(() =>
            requestAnimationFrame(() => setPanelVisible(true)),
        );
    }, [setSidebarOpen]);

    const closeAllTabs = useCallback(() => {
        setPanelVisible(false);
        setTimeout(() => {
            setTabs([]);
            setActiveTabId(null);
            setPanelMounted(false);
            setSidebarOpen(true);
        }, 300);
    }, [setSidebarOpen]);

    const closeTab = useCallback(
        (id: string) => {
            setTabs((prev) => {
                const next = prev.filter((t) => t.id !== id);
                if (next.length === 0) {
                    setPanelVisible(false);
                    setTimeout(() => {
                        setActiveTabId(null);
                        setPanelMounted(false);
                        setSidebarOpen(true);
                    }, 300);
                    return next;
                }
                if (activeTabId === id) {
                    const idx = prev.findIndex((t) => t.id === id);
                    const neighbour = next[idx] ?? next[idx - 1] ?? next[0];
                    setActiveTabId(neighbour?.id ?? null);
                }
                return next;
            });
        },
        [activeTabId, setSidebarOpen],
    );

    /**
     * One tab per document. If a tab for `tab.documentId` already exists,
     * the panel stays mounted and only the header-relevant fields swap
     * (kind, citation/edit, version, filename). Per-tab UI state — the
     * dismissable warning and the saved scroll position — is preserved
     * so switching headers doesn't blow away viewer state. If no tab
     * exists for the document, a new one is appended.
     */
    const upsertTab = useCallback(
        (tab: AssistantSidePanelTab) => {
            setTabs((prev) => {
                const idx = prev.findIndex(
                    (t) => t.documentId === tab.documentId,
                );
                if (idx >= 0) {
                    const existing = prev[idx];
                    const copy = prev.slice();
                    const preview =
                        tab.documentId && getDocumentPreview
                            ? getDocumentPreview(tab.documentId)
                            : null;
                    copy[idx] = {
                        ...tab,
                        id: existing.id,
                        pdfConversionStatus:
                            preview?.pdfConversionStatus ??
                            tab.pdfConversionStatus,
                        onRetryPdf:
                            preview?.onRetryPdf ?? tab.onRetryPdf,
                        warning: existing.warning,
                        initialScrollTop: existing.initialScrollTop,
                    };
                    return copy;
                }
                const preview =
                    tab.documentId && getDocumentPreview
                        ? getDocumentPreview(tab.documentId)
                        : null;
                if (preview) {
                    return [
                        ...prev,
                        {
                            ...tab,
                            pdfConversionStatus: preview.pdfConversionStatus,
                            onRetryPdf: preview.onRetryPdf,
                        },
                    ];
                }
                return [...prev, tab];
            });
            setActiveTabId(tab.id);
            showPanel();
        },
        [showPanel, getDocumentPreview],
    );

    /**
     * Open a tab showing a single citation quote. Called from
     * AssistantMessage when the user clicks a numbered citation pill.
     */
    const openCitation = useCallback(
        (citation: MikeCitationAnnotation) => {
            upsertTab({
                kind: "citation",
                id: citation.document_id,
                documentId: citation.document_id,
                filename: citation.filename,
                versionId: citation.version_id ?? null,
                versionNumber: citation.version_number ?? null,
                pdfConversionStatus: undefined,
                citation,
            });
        },
        [upsertTab],
    );

    /**
     * Open a tab showing a single tracked change. Called from
     * AssistantMessage when the user clicks an EditCard's View button.
     */
    const openEditor = useCallback(
        (ann: MikeEditAnnotation, filename: string) => {
            upsertTab({
                kind: "edit",
                id: ann.document_id,
                documentId: ann.document_id,
                filename,
                versionId: ann.version_id ?? null,
                versionNumber: ann.version_number ?? null,
                pdfConversionStatus: undefined,
                edit: ann,
            });
        },
        [upsertTab],
    );

    /**
     * Open a tab showing a document without targeting a specific
     * citation/edit — used by the download-card click.
     */
    const openDocument = useCallback(
        (args: {
            documentId: string;
            filename: string;
            versionId: string | null;
            versionNumber: number | null;
        }) => {
            upsertTab({
                kind: "document",
                id: args.documentId,
                documentId: args.documentId,
                filename: args.filename,
                versionId: args.versionId,
                versionNumber: args.versionNumber,
            });
        },
        [upsertTab],
    );

    const [resolvedEditStatuses, setResolvedEditStatuses] = useState<
        Record<string, "accepted" | "rejected">
    >({});

    const handleEditResolveStart = useCallback(
        (args: {
            editId: string;
            documentId: string;
            verb: "accept" | "reject";
        }) => {
            setReloadingDocIds((prev) => {
                if (prev.has(args.documentId)) return prev;
                const next = new Set(prev);
                next.add(args.documentId);
                return next;
            });
            setReloadingEditIds((prev) => {
                if (prev.has(args.editId)) return prev;
                const next = new Set(prev);
                next.add(args.editId);
                return next;
            });
        },
        [],
    );

    const handleEditResolved = useCallback(
        (args: {
            editId: string;
            documentId: string;
            status: "accepted" | "rejected";
            versionId: string | null;
            downloadUrl: string | null;
        }) => {
            setResolvedEditStatuses((prev) => ({
                ...prev,
                [args.editId]: args.status,
            }));
            setReloadingDocIds((prev) => {
                if (!prev.has(args.documentId)) return prev;
                const next = new Set(prev);
                next.delete(args.documentId);
                return next;
            });
            setReloadingEditIds((prev) => {
                if (!prev.has(args.editId)) return prev;
                const next = new Set(prev);
                next.delete(args.editId);
                return next;
            });
            // Propagate the new status onto any open edit-tab for this
            // edit so DocPanel's Accept/Reject buttons flip and disable
            // (their sync effect keys off edit.status). Without this, a
            // resolve triggered from the inline EditCard or BulkEditActions
            // leaves the panel buttons looking live.
            setTabs((prev) =>
                prev.map((t) =>
                    t.kind === "edit" && t.edit.edit_id === args.editId
                        ? {
                              ...t,
                              edit: { ...t.edit, status: args.status },
                          }
                        : t,
                ),
            );
            // Accept/reject mutates bytes for this document's current
            // version; drop the cache so the next DocxView render (or an
            // explicit re-open) fetches the fresh file.
            invalidateDocxBytes(args.documentId);
        },
        [],
    );


    const patchTab = useCallback(
        (
            tabId: string,
            patch: Partial<Pick<AssistantSidePanelTab, "warning" | "initialScrollTop">>,
        ) => {
            setTabs((prev) => {
                const idx = prev.findIndex((t) => t.id === tabId);
                if (idx < 0) return prev;
                const copy = prev.slice();
                copy[idx] = { ...copy[idx], ...patch };
                return copy;
            });
        },
        [],
    );

    const handleEditError = useCallback(
        (args: {
            editId?: string;
            documentId: string;
            versionId?: string | null;
            message: string;
        }) => {
            // Surface the warning on every tab tied to this document.
            setTabs((prev) =>
                prev.map((t) =>
                    t.documentId === args.documentId
                        ? { ...t, warning: args.message }
                        : t,
                ),
            );
            setReloadingDocIds((prev) => {
                if (!prev.has(args.documentId)) return prev;
                const next = new Set(prev);
                next.delete(args.documentId);
                return next;
            });
            if (args.editId) {
                setReloadingEditIds((prev) => {
                    if (!prev.has(args.editId!)) return prev;
                    const next = new Set(prev);
                    next.delete(args.editId!);
                    return next;
                });
            }
        },
        [],
    );

    const handleWarningDismiss = useCallback(
        (tabId: string) => {
            patchTab(tabId, { warning: null });
        },
        [patchTab],
    );

    const handleScrollChange = useCallback(
        (tabId: string, scrollTop: number) => {
            patchTab(tabId, { initialScrollTop: scrollTop });
        },
        [patchTab],
    );

    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const latestUserMessageRef = useRef<HTMLDivElement>(null);
    const chatInputRef = useRef<HTMLDivElement>(null);
    const hasScrolledRef = useRef(false);
    const [messagesVisible, setMessagesVisible] = useState(false);
    const [showScrollButton, setShowScrollButton] = useState(false);
    const [inputHeight, setInputHeight] = useState(0);
    const [minHeight, setMinHeight] = useState("0px");

    useEffect(() => {
        const el = chatInputRef.current;
        if (!el) return;
        const observer = new ResizeObserver(() =>
            setInputHeight(el.offsetHeight),
        );
        observer.observe(el);
        setInputHeight(el.offsetHeight);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (latestUserMessageRef.current) {
            const headerHeight = window.innerWidth < 768 ? 56 : 0;
            const gap = window.innerWidth < 768 ? 16 : 24;
            const paddingBottom = 128;
            const marginBottom = 48;
            const userMessageHeight = latestUserMessageRef.current.offsetHeight;
            setMinHeight(
                `calc(100dvh - ${headerHeight + gap + userMessageHeight + paddingBottom + marginBottom}px)`,
            );
        }
    }, [messages.length, latestUserMessageRef.current]); // eslint-disable-line react-hooks/exhaustive-deps

    const updateScrollButton = useCallback(() => {
        const c = messagesContainerRef.current;
        if (!c) return;
        const isScrolledUp = c.scrollHeight - c.scrollTop - c.clientHeight > 10;
        setShowScrollButton(isScrolledUp && c.scrollHeight > c.clientHeight);
    }, []);

    useEffect(() => {
        const c = messagesContainerRef.current;
        if (!c) return;
        c.addEventListener("scroll", updateScrollButton);
        updateScrollButton();
        return () => c.removeEventListener("scroll", updateScrollButton);
    }, [messages, updateScrollButton]);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    const scrollLatestUserToTop = useCallback(() => {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const container = messagesContainerRef.current;
                const element = latestUserMessageRef.current;
                if (!container || !element) return;
                container.scrollTo({
                    top: element.offsetTop - 24,
                    behavior: "smooth",
                });
            });
        });
    }, []);

    useEffect(() => {
        const last = messages[messages.length - 1];
        if (last?.role === "user") scrollLatestUserToTop();
    }, [messages, scrollLatestUserToTop]);

    useEffect(() => {
        if (isResponseLoading) scrollLatestUserToTop();
    }, [isResponseLoading, scrollLatestUserToTop]);

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
                            top: element.offsetTop - 24,
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
        if (panelMounted && window.innerWidth < 768) {
            document.body.style.overflow = "hidden";
        } else {
            document.body.style.overflow = "unset";
        }
        return () => {
            document.body.style.overflow = "unset";
        };
    }, [panelMounted]);

    const chatContents = (
        <>
            {/* Chat column */}
            <div className="flex flex-col h-full flex-1 relative">
                {/* Scrollable messages */}
                <div
                    ref={messagesContainerRef}
                    className="flex-1 w-full overflow-y-auto"
                    style={{ scrollbarGutter: "stable both-edges" }}
                >
                    <div className="w-full max-w-4xl mx-auto pb-32 px-6 md:px-8 pt-4 md:pt-6 min-h-full flex flex-col relative">
                        {!messagesVisible && (
                            <div className="space-y-6 w-full">
                                <div className="flex justify-end">
                                    <div className="bg-gray-100 rounded-2xl p-4 w-2/5">
                                        <div className="h-4 bg-gradient-to-r from-gray-200 via-gray-300 to-gray-200 bg-[length:200%_100%] animate-[shimmer_2s_ease-in-out_infinite] rounded w-full" />
                                    </div>
                                </div>
                                <div className="space-y-3">
                                    {[1, 2, 3, 4].map((i) => (
                                        <div
                                            key={i}
                                            className={`h-4 bg-gradient-to-r from-gray-200 via-gray-300 to-gray-200 bg-[length:200%_100%] animate-[shimmer_2s_ease-in-out_infinite] rounded ${i === 3 ? "w-5/6" : i === 4 ? "w-4/6" : "w-full"}`}
                                        />
                                    ))}
                                </div>
                            </div>
                        )}
                        <div
                            className="space-y-6 transition-opacity duration-150"
                            style={{ opacity: messagesVisible ? 1 : 0 }}
                        >
                            {(() => {
                                const lastUserIndex = messages
                                    .map((m) => m.role)
                                    .lastIndexOf("user");
                                const lastAssistantIndex = messages
                                    .map((m) => m.role)
                                    .lastIndexOf("assistant");
                                return messages.map((msg, i) => (
                                    <div
                                        key={i}
                                        ref={
                                            i === lastUserIndex
                                                ? latestUserMessageRef
                                                : null
                                        }
                                    >
                                        {msg.role === "user" ? (
                                            <UserMessage
                                                content={msg.content ?? ""}
                                                files={(msg as any).files}
                                                workflow={(msg as any).workflow}
                                            />
                                        ) : (
                                            <AssistantMessage
                                                content={msg.content ?? ""}
                                                events={msg.events}
                                                isStreaming={
                                                    i === messages.length - 1 &&
                                                    isResponseLoading
                                                }
                                                isError={!!(msg as any).error}
                                                errorMessage={
                                                    typeof (msg as any).error ===
                                                    "string"
                                                        ? (msg as any).error
                                                        : undefined
                                                }
                                                annotations={msg.annotations}
                                                onCitationClick={openCitation}
                                                minHeight={
                                                    i === lastAssistantIndex
                                                        ? minHeight
                                                        : "0px"
                                                }
                                                onWorkflowClick={(id) => {
                                                    setWorkflowModalInitialId(
                                                        id,
                                                    );
                                                    setWorkflowModalOpen(true);
                                                }}
                                                onEditViewClick={openEditor}
                                                onOpenDocument={openDocument}
                                                onEditResolveStart={
                                                    handleEditResolveStart
                                                }
                                                onEditResolved={
                                                    handleEditResolved
                                                }
                                                onEditError={handleEditError}
                                                isDocReloading={(docId) =>
                                                    reloadingDocIds.has(docId)
                                                }
                                                isEditReloading={(editId) =>
                                                    reloadingEditIds.has(editId)
                                                }
                                                resolvedEditStatuses={
                                                    resolvedEditStatuses
                                                }
                                            />
                                        )}
                                    </div>
                                ));
                            })()}
                            <div ref={messagesEndRef} />
                        </div>
                    </div>
                </div>

                {/* Scroll to bottom button */}
                {showScrollButton && (
                    <div
                        className="absolute left-1/2 -translate-x-1/2 z-19"
                        style={{ bottom: inputHeight + 12 }}
                    >
                        <button
                            onClick={scrollToBottom}
                            className="p-2 rounded-full bg-white/70 backdrop-blur-xs shadow-lg cursor-pointer border border-gray-300"
                        >
                            <ArrowDown className="h-6 w-6 text-gray-500" />
                        </button>
                    </div>
                )}

                {/* Chat input */}
                <div
                    ref={chatInputRef}
                    className="absolute bottom-0 left-0 right-0 w-full z-30"
                >
                    <div className="w-full max-w-4xl mx-auto px-4 md:px-6">
                        <div className="w-full rounded-t-[20px] bg-white">
                            <ChatInput
                                onSubmit={handleChat}
                                onCancel={cancel}
                                isLoading={isResponseLoading}
                                hideAddDocButton={chatInputProps?.hideAddDocButton}
                                projectName={chatInputProps?.projectName}
                                projectCmNumber={chatInputProps?.projectCmNumber}
                            />
                            <div className="py-3 text-center">
                                <p className="text-xs text-gray-500">
                                    AI can make mistakes. Answers are not legal
                                    advice.
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <AssistantWorkflowModal
                open={workflowModalOpen}
                onClose={() => setWorkflowModalOpen(false)}
                onSelect={() => setWorkflowModalOpen(false)}
                initialWorkflowId={workflowModalInitialId}
            />

            {panelMounted && (
                <div
                    className={`fixed md:relative inset-0 md:inset-auto md:h-full md:flex-shrink-0 z-40 md:z-auto transition-transform duration-300 ease-in-out ${panelVisible ? "translate-x-0" : "translate-x-full"}`}
                >
                    <AssistantSidePanel
                        tabs={tabs}
                        activeTabId={activeTabId}
                        onActivateTab={setActiveTabId}
                        onCloseTab={closeTab}
                        onCloseAll={closeAllTabs}
                        isEditorReloading={(documentId) =>
                            reloadingDocIds.has(documentId)
                        }
                        isEditReloading={(editId) =>
                            reloadingEditIds.has(editId)
                        }
                        onEditResolveStart={handleEditResolveStart}
                        onEditResolved={handleEditResolved}
                        onEditError={handleEditError}
                        onWarningDismiss={handleWarningDismiss}
                        onScrollChange={handleScrollChange}
                    />
                </div>
            )}
        </>
    );

    if (leftPane) {
        return (
            <div className="h-full w-full flex relative">
                <aside className="flex-shrink-0 h-full overflow-hidden flex">
                    {leftPane}
                </aside>
                <div className="flex-1 min-w-0 h-full flex relative">
                    {chatContents}
                </div>
            </div>
        );
    }

    return (
        <div className="h-full w-full flex relative">
            {chatContents}
        </div>
    );
}
