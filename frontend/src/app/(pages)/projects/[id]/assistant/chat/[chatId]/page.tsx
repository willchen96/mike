"use client";

import {
    use,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { useRouter } from "next/navigation";
import {
    ChevronLeft,
    ChevronRight,
    FileText,
    Loader2,
    Plus,
    Trash2,
    Upload,
    X,
} from "lucide-react";
import {
    deleteChat,
    deleteDocument,
    getChat,
    getProject,
    uploadProjectDocument,
    createProjectFolder,
    renameProjectFolder,
    deleteProjectFolder,
    moveDocumentToFolder,
    moveSubfolderToFolder,
} from "@/app/lib/mikeApi";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { UserMessage } from "@/app/components/assistant/UserMessage";
import { AssistantMessage } from "@/app/components/assistant/AssistantMessage";
import { ChatInput } from "@/app/components/assistant/ChatInput";
import type { ChatInputHandle } from "@/app/components/assistant/ChatInput";
import { ProjectExplorer } from "@/app/components/projects/ProjectExplorer";
import { DocView } from "@/app/components/shared/DocView";
import { OwnerOnlyModal } from "@/app/components/shared/OwnerOnlyModal";
import { DocxView } from "@/app/components/shared/DocxView";
import { MikeIcon } from "@/components/chat/mike-icon";
import { useAuth } from "@/contexts/AuthContext";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { useSidebar } from "@/app/contexts/SidebarContext";
import type {
    CitationQuote,
    MikeCitationAnnotation,
    MikeDocument,
    MikeEditAnnotation,
    MikeMessage,
    MikeProject,
} from "@/app/components/shared/types";
import { expandCitationToEntries } from "@/app/components/shared/types";

interface Props {
    params: Promise<{ id: string; chatId: string }>;
}

type DocTab = {
    documentId: string;
    filename: string;
    quotes?: CitationQuote[];
    versionId?: string | null;
    refetchKey?: number;
    warning?: string | null;
    scrollTop?: number;
};

type EditScrollTarget = {
    key: string;
    documentId: string;
    inserted_text?: string;
    deleted_text?: string;
    ins_w_id?: string | null;
    del_w_id?: string | null;
};

function isDocxTab(filename: string) {
    const ext = filename.split(".").pop()?.toLowerCase();
    return ext === "docx" || ext === "doc";
}

const ICON_SIZE = 30;
const GAP = 14;
const EXPLORER_MIN = 160;
const EXPLORER_DEFAULT = 280;
const CHAT_MIN = 320;
const CHAT_DEFAULT = 420;

function AssistantGreeting({ username }: { username: string }) {
    const [loaded, setLoaded] = useState(false);
    const [iconOffset, setIconOffset] = useState(0);
    const [textOffset, setTextOffset] = useState(0);
    const textRef = useRef<HTMLHeadingElement>(null);

    useLayoutEffect(() => {
        if (!textRef.current) return;
        const h1Width = textRef.current.offsetWidth;
        setIconOffset((h1Width + GAP) / 2);
        setTextOffset((ICON_SIZE + GAP) / 2);
    }, [username]);

    useEffect(() => {
        if (!iconOffset) return;
        const t = setTimeout(() => setLoaded(true), 100);
        return () => clearTimeout(t);
    }, [iconOffset]);

    return (
        <div className="flex-1 flex items-center justify-center">
            <div className="relative flex items-center justify-center h-[30px]">
                <div
                    className="absolute h-[30px]"
                    style={{
                        left: "50%",
                        transform: loaded
                            ? `translateX(calc(-50% - ${iconOffset}px))`
                            : "translateX(-50%)",
                        transition:
                            "transform 900ms cubic-bezier(0.25, 0.46, 0.45, 0.94)",
                    }}
                >
                    <MikeIcon size={ICON_SIZE} />
                </div>
                <h1
                    ref={textRef}
                    className="absolute text-2xl font-serif font-light text-gray-900 whitespace-nowrap"
                    style={{
                        left: "50%",
                        transform: loaded
                            ? `translateX(calc(-50% + ${textOffset}px))`
                            : "translateX(-50%)",
                        opacity: loaded ? 1 : 0,
                        transition:
                            "transform 900ms cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 800ms ease-in-out 300ms",
                    }}
                >
                    Hi, {username}
                </h1>
            </div>
        </div>
    );
}

/** Drag-handle divider for resizing panels */
function Divider({ onDrag }: { onDrag: (dx: number) => void }) {
    const dragging = useRef(false);
    const lastX = useRef(0);
    const [isDragging, setIsDragging] = useState(false);

    const onMouseDown = (e: React.MouseEvent) => {
        dragging.current = true;
        setIsDragging(true);
        lastX.current = e.clientX;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    };

    useEffect(() => {
        function onMouseMove(e: MouseEvent) {
            if (!dragging.current) return;
            onDrag(e.clientX - lastX.current);
            lastX.current = e.clientX;
        }
        function onMouseUp() {
            if (!dragging.current) return;
            dragging.current = false;
            setIsDragging(false);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        }
        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);
        return () => {
            window.removeEventListener("mousemove", onMouseMove);
            window.removeEventListener("mouseup", onMouseUp);
        };
    }, [onDrag]);

    return (
        <div className="relative w-0 shrink-0 z-10">
            <div
                onMouseDown={onMouseDown}
                className="absolute inset-y-0 -left-2 -right-2 cursor-col-resize flex items-stretch justify-center"
            >
                {isDragging && (
                    <div className="w-1 bg-blue-500 transition-colors" />
                )}
            </div>
        </div>
    );
}

export default function ProjectAssistantChatPage({ params }: Props) {
    const { id: projectId, chatId } = use(params);
    const router = useRouter();

    const { setSidebarOpen } = useSidebar();
    const { user } = useAuth();
    const { profile } = useUserProfile();
    const username =
        profile?.displayName?.trim() || user?.email?.split("@")[0] || "there";

    const [project, setProject] = useState<MikeProject | null>(null);
    const [chatTitle, setChatTitle] = useState<string | null>(null);
    const [chatOwnerId, setChatOwnerId] = useState<string | null>(null);
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
    const [chatLoaded, setChatLoaded] = useState(false);
    const [creatingChat, setCreatingChat] = useState(false);
    const [deletingChat, setDeletingChat] = useState(false);

    // Panel widths
    const [explorerWidth, setExplorerWidth] = useState(EXPLORER_DEFAULT);
    const [chatWidth, setChatWidth] = useState(CHAT_DEFAULT);
    const [explorerCollapsed, setExplorerCollapsed] = useState(false);

    // Upload state
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [uploading, setUploading] = useState(false);
    const [explorerDragOver, setExplorerDragOver] = useState(false);

    // Tabs
    const [tabs, setTabs] = useState<DocTab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);
    const [activeQuotes, setActiveQuotes] = useState<CitationQuote[] | null>(
        null,
    );
    const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
    const [editScrollTarget, setEditScrollTarget] =
        useState<EditScrollTarget | null>(null);
    const [reloadingDocIds, setReloadingDocIds] = useState<Set<string>>(
        () => new Set(),
    );
    const [resolvedEditStatuses, setResolvedEditStatuses] = useState<
        Record<string, "accepted" | "rejected">
    >({});
    const [reloadingEditIds, setReloadingEditIds] = useState<Set<string>>(
        () => new Set(),
    );

    const activeTab = tabs.find((t) => t.documentId === activeTabId) ?? null;
    const tabBarRef = useRef<HTMLDivElement | null>(null);
    const tabItemRefs = useRef<Record<string, HTMLDivElement | null>>({});

    const chatInputRef = useRef<ChatInputHandle | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const latestUserMessageRef = useRef<HTMLDivElement>(null);
    const [minHeight, setMinHeight] = useState("0px");

    const {
        setCurrentChatId,
        newChatMessages,
        setNewChatMessages,
        chats,
        saveChat,
    } = useChatHistoryContext();
    const [initialMessages] = useState<MikeMessage[]>(newChatMessages ?? []);
    const { messages, isResponseLoading, handleChat, setMessages, cancel } =
        useAssistantChat({ initialMessages, chatId, projectId });

    const hasLoaded = useRef(false);
    const hasAutoSent = useRef(false);
    const hasInitialScrolled = useRef(false);

    useEffect(() => {
        setSidebarOpen(false);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        getProject(projectId)
            .then(setProject)
            .catch(() => {});
    }, [projectId]);

    // Whenever the assistant mutates project documents — creating a new
    // doc, creating a new version via edit_document, or replicating a doc —
    // refresh the project so the explorer picks up the new/changed files
    // without a manual reload. Keyed by completed mutation events only, so
    // we refetch once the backend has finished persisting the change.
    const projectMutationSignature = useMemo(() => {
        const created: string[] = [];
        const replicated: string[] = [];
        const editedPerDoc: Record<string, number> = {};
        for (const msg of messages) {
            for (const ev of msg.events ?? []) {
                if ("isStreaming" in ev && ev.isStreaming) continue;
                if (ev.type === "doc_created" && ev.document_id) {
                    created.push(
                        `${ev.document_id}:${ev.version_id ?? ""}:${ev.filename}`,
                    );
                    continue;
                }
                if (ev.type === "doc_replicated") {
                    for (const c of ev.copies ?? []) {
                        replicated.push(
                            `${c.document_id}:${c.version_id}:${c.new_filename}`,
                        );
                    }
                    continue;
                }
                if (ev.type === "doc_edited") {
                    editedPerDoc[ev.document_id] = Math.max(
                        editedPerDoc[ev.document_id] ?? 0,
                        (ev.version_number as number | null | undefined) ?? 0,
                    );
                }
            }
        }
        return [
            `created=${created.sort().join(",")}`,
            `replicated=${replicated.sort().join(",")}`,
            `edited=${Object.entries(editedPerDoc)
            .map(([k, v]) => `${k}=${v}`)
            .sort()
            .join(",")}`,
        ].join("|");
    }, [messages]);

    useEffect(() => {
        if (!projectMutationSignature) return;
        getProject(projectId)
            .then(setProject)
            .catch(() => {});
    }, [projectMutationSignature, projectId]);

    useEffect(() => {
        setCurrentChatId(chatId);
    }, [chatId, setCurrentChatId]);

    useEffect(() => {
        if (hasLoaded.current) return;
        hasLoaded.current = true;
        getChat(chatId)
            .then(({ chat, messages: loaded }) => {
                setChatTitle(chat.title);
                setChatOwnerId(chat.user_id ?? null);
                if (loaded.length > 0) setMessages(loaded);
            })
            .catch(() => router.replace(`/projects/${projectId}?tab=assistant`))
            .finally(() => setChatLoaded(true));
    }, [chatId]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        const match = chats?.find((c) => c.id === chatId);
        if (match?.title) setChatTitle(match.title);
    }, [chats, chatId]);

    useEffect(() => {
        if (
            newChatMessages &&
            newChatMessages.length === 1 &&
            newChatMessages[0].role === "user" &&
            !hasAutoSent.current &&
            !isResponseLoading &&
            messages.length === 1
        ) {
            hasAutoSent.current = true;
            setNewChatMessages(null);
            void handleChat(newChatMessages[0]);
        }
    }, [newChatMessages, messages.length, isResponseLoading]); // eslint-disable-line react-hooks/exhaustive-deps

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
        if (!chatLoaded || hasInitialScrolled.current || messages.length === 0)
            return;
        const container = messagesContainerRef.current;
        const el = latestUserMessageRef.current;
        if (!container || !el) return;
        hasInitialScrolled.current = true;
        setTimeout(() => {
            container.scrollTo({
                top: el.offsetTop - 16,
                behavior: "auto",
            });
        }, 100);
    }, [chatLoaded, messages.length]);

    useEffect(() => {
        if (isResponseLoading) scrollLatestUserToTop();
    }, [isResponseLoading, scrollLatestUserToTop]);

    useEffect(() => {
        const userEl = latestUserMessageRef.current;
        const containerEl = messagesContainerRef.current;
        if (!userEl || !containerEl) return;
        setMinHeight(
            `${Math.max(0, containerEl.clientHeight - 48 - userEl.offsetHeight - 16)}px`,
        );
    }, [messages.length, latestUserMessageRef.current]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (!activeTabId) return;
        const el = tabItemRefs.current[activeTabId];
        if (!el) return;
        el.scrollIntoView({
            behavior: "smooth",
            block: "nearest",
            inline: "nearest",
        });
    }, [activeTabId, tabs.length]);

    // ── Tabs ──────────────────────────────────────────────────────────────────
    function openTab(
        docId: string,
        filename: string,
        quotes?: CitationQuote[],
        versionId?: string | null,
    ) {
        setTabs((prev) => {
            const existing = prev.find((t) => t.documentId === docId);
            if (existing) {
                if (
                    versionId !== undefined &&
                    existing.versionId !== versionId
                ) {
                    return prev.map((t) =>
                        t.documentId === docId ? { ...t, versionId } : t,
                    );
                }
                return prev;
            }
            return [
                ...prev,
                { documentId: docId, filename, quotes, versionId },
            ];
        });
        setActiveTabId(docId);
        setActiveQuotes(quotes && quotes.length ? quotes : null);
        setSelectedDocId(docId);
    }

    function closeTab(docId: string) {
        setTabs((prev) => {
            const next = prev.filter((t) => t.documentId !== docId);
            if (activeTabId === docId) {
                const idx = prev.findIndex((t) => t.documentId === docId);
                const fallback = next[idx] ?? next[idx - 1] ?? null;
                setActiveTabId(fallback?.documentId ?? null);
                setActiveQuotes(null);
                setSelectedDocId(fallback?.documentId ?? null);
            }
            return next;
        });
    }

    function switchTab(docId: string) {
        setActiveTabId(docId);
        setActiveQuotes(null);
        setSelectedDocId(docId);
    }

    // ── Handlers ──────────────────────────────────────────────────────────────
    const handleSubmit = useCallback(
        (message: MikeMessage) => {
            if (!activeTab) return handleChat(message);
            return handleChat(message, {
                displayedDoc: {
                    filename: activeTab.filename,
                    documentId: activeTab.documentId,
                },
            });
        },
        [activeTab, handleChat],
    );

    const handleDocClick = (doc: MikeDocument) => {
        openTab(doc.id, doc.filename);
    };

    const handleCitationClick = (citation: MikeCitationAnnotation) => {
        openTab(
            citation.document_id,
            citation.filename,
            expandCitationToEntries(citation),
        );
    };

    const handleOpenDocument = (args: {
        documentId: string;
        filename: string;
        versionId: string | null;
        versionNumber: number | null;
    }) => {
        openTab(args.documentId, args.filename, undefined, args.versionId);
    };

    const handleEditViewClick = (ann: MikeEditAnnotation, filename: string) => {
        openTab(ann.document_id, filename, undefined, ann.version_id ?? null);
        setEditScrollTarget({
            key: `${ann.edit_id}-${Date.now()}`,
            documentId: ann.document_id,
            inserted_text: ann.inserted_text,
            deleted_text: ann.deleted_text,
            ins_w_id: ann.ins_w_id ?? null,
            del_w_id: ann.del_w_id ?? null,
        });
    };

    const handleEditResolveStart = (args: {
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
    };

    const handleEditResolved = (args: {
        editId: string;
        documentId: string;
        status: "accepted" | "rejected";
        versionId: string | null;
        downloadUrl: string | null;
    }) => {
        // Mark edit as resolved so EditCard UI updates
        setResolvedEditStatuses((prev) => ({
            ...prev,
            [args.editId]: args.status,
        }));
        // Clear loading states
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
        // Bump refetchKey to invalidate the cached docx bytes and re-render
        // with the resolved changes.
        setTabs((prev) =>
            prev.map((t) =>
                t.documentId === args.documentId
                    ? { ...t, refetchKey: (t.refetchKey ?? 0) + 1 }
                    : t,
            ),
        );
    };

    const patchTab = (documentId: string, patch: Partial<DocTab>) => {
        setTabs((prev) =>
            prev.map((t) =>
                t.documentId === documentId ? { ...t, ...patch } : t,
            ),
        );
    };

    const handleEditError = (args: { documentId: string; message: string }) => {
        patchTab(args.documentId, { warning: args.message });
    };

    const dismissTabWarning = (documentId: string) => {
        patchTab(documentId, { warning: null });
    };

    const handleTabScrollChange = (documentId: string, scrollTop: number) => {
        patchTab(documentId, { scrollTop });
    };

    const handleDocxReady = (documentId: string) => {
        setReloadingDocIds((prev) => {
            if (!prev.has(documentId)) return prev;
            const next = new Set(prev);
            next.delete(documentId);
            return next;
        });
    };

    const handleChatDrop = (e: React.DragEvent) => {
        e.preventDefault();
        const docId = e.dataTransfer.getData("application/mike-doc");
        if (!docId) return;
        const doc = project?.documents?.find((d) => d.id === docId);
        if (doc) chatInputRef.current?.addDoc(doc);
    };

    // ── Chat actions ──────────────────────────────────────────────────────────
    async function handleNewChat() {
        setCreatingChat(true);
        try {
            const id = await saveChat(projectId);
            if (id) router.push(`/projects/${projectId}/assistant/chat/${id}`);
        } finally {
            setCreatingChat(false);
        }
    }

    async function handleDeleteChat() {
        if (chatOwnerId && user?.id && chatOwnerId !== user.id) {
            setOwnerOnlyAction("delete this chat");
            return;
        }
        setDeletingChat(true);
        try {
            await deleteChat(chatId);
            router.push(`/projects/${projectId}?tab=assistant`);
        } finally {
            setDeletingChat(false);
        }
    }

    // ── Upload ────────────────────────────────────────────────────────────────
    async function uploadFiles(files: File[]) {
        if (!files.length) return;
        setUploading(true);
        try {
            const uploaded = await Promise.all(
                files.map((f) => uploadProjectDocument(projectId, f)),
            );
            setProject((prev) => {
                if (!prev) return prev;
                return {
                    ...prev,
                    documents: [...(prev.documents ?? []), ...uploaded],
                };
            });
        } catch (err) {
            console.error("Upload failed:", err);
        } finally {
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    }

    const handleExplorerFileDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        setExplorerDragOver(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) {
            await uploadFiles(files);
        }
        // Internal doc/folder moves are handled inside ProjectExplorer (stopPropagation)
    };

    // ── Folder handlers ───────────────────────────────────────────────────────
    const handleCreateFolder = async (
        parentId: string | null,
        name: string,
    ) => {
        const folder = await createProjectFolder(
            projectId,
            name,
            parentId ?? undefined,
        );
        setProject((prev) =>
            prev
                ? { ...prev, folders: [...(prev.folders ?? []), folder] }
                : prev,
        );
    };

    const handleRenameFolder = async (folderId: string, name: string) => {
        await renameProjectFolder(projectId, folderId, name);
        setProject((prev) =>
            prev
                ? {
                      ...prev,
                      folders: (prev.folders ?? []).map((f) =>
                          f.id === folderId ? { ...f, name } : f,
                      ),
                  }
                : prev,
        );
    };

    const handleDeleteFolder = async (folderId: string) => {
        const toDelete = new Set<string>();
        function collectIds(id: string) {
            toDelete.add(id);
            (project?.folders ?? [])
                .filter((f) => f.parent_folder_id === id)
                .forEach((f) => collectIds(f.id));
        }
        collectIds(folderId);
        await deleteProjectFolder(projectId, folderId);
        setProject((prev) =>
            prev
                ? {
                      ...prev,
                      folders: (prev.folders ?? []).filter(
                          (f) => !toDelete.has(f.id),
                      ),
                      documents: (prev.documents ?? []).map((d) =>
                          d.folder_id && toDelete.has(d.folder_id)
                              ? { ...d, folder_id: null }
                              : d,
                      ),
                  }
                : prev,
        );
    };

    const handleMoveDoc = async (
        docId: string,
        targetFolderId: string | null,
    ) => {
        setProject((prev) =>
            prev
                ? {
                      ...prev,
                      documents: (prev.documents ?? []).map((d) =>
                          d.id === docId
                              ? { ...d, folder_id: targetFolderId }
                              : d,
                      ),
                  }
                : prev,
        );
        await moveDocumentToFolder(projectId, docId, targetFolderId);
    };

    const handleMoveFolder = async (
        folderId: string,
        targetFolderId: string | null,
    ) => {
        setProject((prev) =>
            prev
                ? {
                      ...prev,
                      folders: (prev.folders ?? []).map((f) =>
                          f.id === folderId
                              ? { ...f, parent_folder_id: targetFolderId }
                              : f,
                      ),
                  }
                : prev,
        );
        await moveSubfolderToFolder(projectId, folderId, targetFolderId);
    };

    const handleDeleteDoc = async (docId: string) => {
        await deleteDocument(docId);
        setProject((prev) =>
            prev
                ? {
                      ...prev,
                      documents: (prev.documents ?? []).filter(
                          (d) => d.id !== docId,
                      ),
                  }
                : prev,
        );
        setTabs((prev) => prev.filter((t) => t.documentId !== docId));
        if (activeTabId === docId) {
            setActiveTabId(null);
            setActiveQuotes(null);
            setSelectedDocId(null);
            setEditScrollTarget(null);
        }
    };

    // ── Resize handlers ───────────────────────────────────────────────────────
    const onExplorerDividerDrag = useCallback((dx: number) => {
        setExplorerWidth((w) => Math.max(EXPLORER_MIN, w + dx));
    }, []);

    const onChatDividerDrag = useCallback((dx: number) => {
        setChatWidth((w) => Math.max(CHAT_MIN, w - dx));
    }, []);

    return (
        <div className="flex flex-col h-full">
            {/* Page header */}
            <div className="flex items-center justify-between px-8 py-4 shrink-0">
                <div className="flex items-center gap-1.5 text-2xl font-medium font-serif">
                    <button
                        onClick={() => router.push("/projects")}
                        className="text-gray-500 hover:text-gray-700 transition-colors"
                    >
                        Projects
                    </button>
                    <span className="text-gray-300">›</span>
                    {project ? (
                        <button
                            onClick={() =>
                                router.push(`/projects/${projectId}`)
                            }
                            className="text-gray-500 hover:text-gray-700 transition-colors"
                        >
                            {project.name}
                            {project.cm_number && (
                                <span className="ml-1 text-gray-400">
                                    (#{project.cm_number})
                                </span>
                            )}
                        </button>
                    ) : (
                        <div className="h-6 w-32 rounded bg-gray-100 animate-pulse" />
                    )}
                    <span className="text-gray-300">›</span>
                    <button
                        onClick={() =>
                            router.push(`/projects/${projectId}?tab=assistant`)
                        }
                        className="text-gray-500 hover:text-gray-700 transition-colors"
                    >
                        Assistant
                    </button>
                    <span className="text-gray-300">›</span>
                    {chatLoaded ? (
                        <span className="text-gray-900 truncate max-w-xs">
                            {chatTitle ?? "Untitled New Chat"}
                        </span>
                    ) : (
                        <div className="h-6 w-40 rounded bg-gray-100 animate-pulse" />
                    )}
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={handleNewChat}
                        disabled={creatingChat}
                        title="New chat"
                        className="flex items-center justify-center p-1.5 text-gray-500 hover:text-gray-900 transition-colors disabled:opacity-40"
                    >
                        {creatingChat ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <Plus className="h-4 w-4" />
                        )}
                    </button>
                    <button
                        onClick={handleDeleteChat}
                        disabled={deletingChat}
                        title="Delete chat"
                        className="flex items-center justify-center p-1.5 text-gray-500 hover:text-red-600 transition-colors disabled:opacity-40"
                    >
                        {deletingChat ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <Trash2 className="h-4 w-4" />
                        )}
                    </button>
                </div>
            </div>

            {/* Three-panel body */}
            <div className="flex flex-1 min-h-0 border-t border-gray-200 overflow-hidden">
                {/* LEFT: Project Explorer */}
                {!explorerCollapsed && (
                    <>
                        <div
                            style={{ width: explorerWidth }}
                            className="shrink-0 flex flex-col border-r border-gray-200"
                            onDragOver={(e) => {
                                e.preventDefault();
                                // Only show the upload overlay for external file drags, not internal moves
                                const isInternal =
                                    Array.from(e.dataTransfer.types).includes(
                                        "application/mike-doc",
                                    ) ||
                                    Array.from(e.dataTransfer.types).includes(
                                        "application/mike-folder",
                                    );
                                if (!isInternal) setExplorerDragOver(true);
                            }}
                            onDragLeave={(e) => {
                                if (
                                    !e.currentTarget.contains(
                                        e.relatedTarget as Node,
                                    )
                                )
                                    setExplorerDragOver(false);
                            }}
                            onDrop={handleExplorerFileDrop}
                        >
                            {/* Explorer header */}
                            <div className="h-10 flex items-center justify-between px-3 border-b border-gray-200 shrink-0">
                                <span className="text-xs text-gray-700">
                                    Explorer
                                </span>
                                <div className="flex items-center gap-1">
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        accept=".pdf,.docx,.doc"
                                        multiple
                                        className="hidden"
                                        onChange={(e) =>
                                            uploadFiles(
                                                Array.from(
                                                    e.target.files ?? [],
                                                ),
                                            )
                                        }
                                    />
                                    <button
                                        onClick={() =>
                                            fileInputRef.current?.click()
                                        }
                                        disabled={uploading}
                                        title="Upload documents"
                                        className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-40"
                                    >
                                        {uploading ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <Upload className="h-3.5 w-3.5" />
                                        )}
                                    </button>
                                    <button
                                        onClick={() =>
                                            setExplorerCollapsed(true)
                                        }
                                        title="Collapse explorer"
                                        className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                                    >
                                        <ChevronLeft className="h-3.5 w-3.5" />
                                    </button>
                                </div>
                            </div>

                            {/* Drop overlay */}
                            <div
                                className={`flex-1 overflow-y-auto relative h-full ${explorerDragOver ? "bg-blue-50" : ""}`}
                                onDragOver={(e) => {
                                    e.preventDefault();
                                }}
                                onDrop={async (e) => {
                                    e.preventDefault();
                                    const docId = e.dataTransfer.getData(
                                        "application/mike-doc",
                                    );
                                    const folderId = e.dataTransfer.getData(
                                        "application/mike-folder",
                                    );
                                    if (docId) {
                                        e.stopPropagation();
                                        await handleMoveDoc(docId, null);
                                    } else if (folderId) {
                                        e.stopPropagation();
                                        await handleMoveFolder(folderId, null);
                                    }
                                    // External file drops are not stopped — they bubble to handleExplorerFileDrop
                                }}
                            >
                                {explorerDragOver && (
                                    <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
                                        <p className="text-xs text-blue-500 font-medium">
                                            Drop to upload
                                        </p>
                                    </div>
                                )}
                                <ProjectExplorer
                                    projectName={project?.name}
                                    documents={project?.documents ?? []}
                                    folders={project?.folders ?? []}
                                    selectedDocId={selectedDocId}
                                    onDocClick={handleDocClick}
                                    onCreateFolder={handleCreateFolder}
                                    onRenameFolder={handleRenameFolder}
                                    onDeleteFolder={handleDeleteFolder}
                                    onDeleteDoc={handleDeleteDoc}
                                    onMoveDoc={handleMoveDoc}
                                    onMoveFolder={handleMoveFolder}
                                />
                            </div>
                        </div>
                        <Divider onDrag={onExplorerDividerDrag} />
                    </>
                )}

                {/* Collapsed explorer toggle */}
                {explorerCollapsed && (
                    <div className="shrink-0 flex flex-col border-r border-gray-200">
                        <div className="h-10 flex items-center justify-center border-b border-gray-200 shrink-0 px-1">
                            <button
                                onClick={() => setExplorerCollapsed(false)}
                                title="Expand explorer"
                                className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                            >
                                <ChevronRight className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    </div>
                )}

                {/* CENTER: Document Panel */}
                <div className="flex-1 flex flex-col min-w-0 border-r border-gray-200">
                    {/* Tab bar */}
                    <div
                        ref={tabBarRef}
                        className="h-10 flex items-end border-b border-gray-200 shrink-0 overflow-x-auto min-w-0 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
                    >
                        {tabs.length === 0 ? (
                            <span className="px-4 self-center text-xs text-gray-700">
                                Document Viewer
                            </span>
                        ) : (
                            tabs.map((tab) => {
                                const isActive = tab.documentId === activeTabId;
                                const ext = tab.filename
                                    .split(".")
                                    .pop()
                                    ?.toLowerCase();
                                const iconColor =
                                    ext === "pdf"
                                        ? "text-red-500"
                                        : ext === "doc" || ext === "docx"
                                          ? "text-blue-500"
                                          : "text-gray-400";
                                // Pull the doc's latest_version_number out
                                // of the project state so the tab shows V#
                                // whenever the doc has been edited.
                                const versionNumber = (
                                    project?.documents ?? []
                                ).find((d) => d.id === tab.documentId)
                                    ?.latest_version_number as
                                    | number
                                    | null
                                    | undefined;
                                const showVersionBadge =
                                    typeof versionNumber === "number" &&
                                    Number.isFinite(versionNumber) &&
                                    versionNumber > 1;
                                return (
                                    <div
                                        key={tab.documentId}
                                        ref={(el) => {
                                            tabItemRefs.current[tab.documentId] =
                                                el;
                                        }}
                                        onClick={() =>
                                            switchTab(tab.documentId)
                                        }
                                        className={`group flex items-center gap-1.5 px-3 h-full border-r border-gray-200 cursor-pointer shrink-0 max-w-[260px] transition-colors ${
                                            isActive
                                                ? "bg-gray-100"
                                                : "bg-white hover:bg-gray-50"
                                        }`}
                                    >
                                        <FileText
                                            className={`h-3.5 w-3.5 shrink-0 ${iconColor}`}
                                        />
                                        <span
                                            className={`text-xs truncate ${isActive ? "text-gray-900 font-medium" : "text-gray-500"}`}
                                        >
                                            {tab.filename}
                                        </span>
                                        {showVersionBadge && (
                                            <span
                                                className={`shrink-0 inline-flex items-center rounded border px-1 py-px text-[9px] font-medium ${
                                                    isActive
                                                        ? "border-gray-200 bg-white text-gray-600"
                                                        : "border-gray-200 bg-gray-50 text-gray-500"
                                                }`}
                                            >
                                                V{versionNumber}
                                            </span>
                                        )}
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                closeTab(tab.documentId);
                                            }}
                                            className={`shrink-0 transition-colors ${isActive ? "text-gray-500 hover:text-gray-700" : "text-gray-300 hover:text-gray-600"}`}
                                        >
                                            <X className="h-3 w-3" />
                                        </button>
                                    </div>
                                );
                            })
                        )}
                    </div>
                    <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                        {activeTab ? (
                            isDocxTab(activeTab.filename) ? (
                                <DocxView
                                    key={`${activeTab.documentId}-${activeTab.refetchKey ?? 0}`}
                                    documentId={activeTab.documentId}
                                    versionId={activeTab.versionId}
                                    refetchKey={activeTab.refetchKey}
                                    quotes={activeQuotes ?? undefined}
                                    highlightEdit={
                                        editScrollTarget &&
                                        editScrollTarget.documentId ===
                                            activeTab.documentId
                                            ? editScrollTarget
                                            : null
                                    }
                                    onReady={() =>
                                        handleDocxReady(activeTab.documentId)
                                    }
                                    warning={activeTab.warning ?? null}
                                    onWarningDismiss={() =>
                                        dismissTabWarning(activeTab.documentId)
                                    }
                                    initialScrollTop={
                                        activeTab.scrollTop ?? null
                                    }
                                    onScrollChange={(top) =>
                                        handleTabScrollChange(
                                            activeTab.documentId,
                                            top,
                                        )
                                    }
                                    rounded={false}
                                    bordered={false}
                                />
                            ) : (
                                <DocView
                                    key={activeTab.documentId}
                                    doc={{ document_id: activeTab.documentId }}
                                    quotes={activeQuotes ?? undefined}
                                    rounded={false}
                                    bordered={false}
                                />
                            )
                        ) : (
                            <div className="flex items-center justify-center h-full px-8 bg-gray-100">
                                <div className="text-center space-y-3">
                                    <p className="font-serif text-gray-700 text-xl">
                                        Click on a document to display here.
                                    </p>
                                    <p className="font-serif text-base text-gray-500">
                                        Pro tip: Drag a document from the
                                        Project Explorer to the Assistant to
                                        direct it to read or edit.
                                    </p>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                <Divider onDrag={onChatDividerDrag} />

                {/* RIGHT: Assistant Panel */}
                <div
                    style={{ width: chatWidth }}
                    className="shrink-0 flex flex-col"
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={handleChatDrop}
                >
                    <div className="h-10 flex items-center gap-2 px-4 border-b border-gray-200 shrink-0">
                        <MikeIcon size={16} />
                        <span className="text-xs text-gray-700">
                            Project Assistant
                        </span>
                    </div>

                    {/* Messages / greeting / shimmer */}
                    {!chatLoaded ? (
                        <div className="flex-1 px-4 py-4 space-y-4">
                            <div className="flex justify-end">
                                <div className="bg-gray-100 rounded-2xl p-4 w-3/4">
                                    <div className="h-3 bg-gradient-to-r from-gray-200 via-gray-300 to-gray-200 bg-[length:200%_100%] animate-[shimmer_2s_ease-in-out_infinite] rounded w-full" />
                                </div>
                            </div>
                            <div className="space-y-2">
                                {[1, 2, 3].map((i) => (
                                    <div
                                        key={i}
                                        className={`h-3 bg-gradient-to-r from-gray-200 via-gray-300 to-gray-200 bg-[length:200%_100%] animate-[shimmer_2s_ease-in-out_infinite] rounded ${i === 3 ? "w-4/6" : "w-full"}`}
                                    />
                                ))}
                            </div>
                        </div>
                    ) : messages.length === 0 ? (
                        <div className="flex-1 flex flex-col min-h-0">
                            <AssistantGreeting username={username} />
                        </div>
                    ) : (
                        <div
                            ref={messagesContainerRef}
                            className="flex-1 overflow-y-auto px-4 py-4 space-y-4 min-h-0"
                            style={{ scrollbarGutter: "stable" }}
                        >
                            {(() => {
                                const lastUserIdx = messages
                                    .map((m) => m.role)
                                    .lastIndexOf("user");
                                const lastAssistantIdx = messages
                                    .map((m) => m.role)
                                    .lastIndexOf("assistant");
                                return messages.map((msg, i) =>
                                    msg.role === "user" ? (
                                        <div
                                            key={i}
                                            ref={
                                                i === lastUserIdx
                                                    ? latestUserMessageRef
                                                    : null
                                            }
                                        >
                                            <UserMessage
                                                content={msg.content ?? ""}
                                                files={(msg as any).files}
                                            />
                                        </div>
                                    ) : (
                                        <AssistantMessage
                                            key={i}
                                            content={msg.content ?? ""}
                                            events={msg.events}
                                            isStreaming={
                                                i === messages.length - 1 &&
                                                isResponseLoading
                                            }
                                            isError={!!(msg as any).error}
                                            annotations={msg.annotations}
                                            onCitationClick={
                                                handleCitationClick
                                            }
                                            minHeight={
                                                i === lastAssistantIdx
                                                    ? minHeight
                                                    : "0px"
                                            }
                                            onEditViewClick={
                                                handleEditViewClick
                                            }
                                            onOpenDocument={handleOpenDocument}
                                            onEditResolveStart={
                                                handleEditResolveStart
                                            }
                                            onEditResolved={handleEditResolved}
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
                                    ),
                                );
                            })()}
                            <div ref={messagesEndRef} />
                        </div>
                    )}

                    {/* ChatInput */}
                    <div className="shrink-0 px-4 pb-4">
                        <ChatInput
                            ref={chatInputRef}
                            onSubmit={handleSubmit}
                            onCancel={cancel}
                            isLoading={isResponseLoading}
                            hideAddDocButton
                            projectName={project?.name}
                            projectCmNumber={project?.cm_number}
                        />
                    </div>
                </div>
            </div>
            <OwnerOnlyModal
                open={!!ownerOnlyAction}
                action={ownerOnlyAction ?? undefined}
                onClose={() => setOwnerOnlyAction(null)}
            />
        </div>
    );
}
