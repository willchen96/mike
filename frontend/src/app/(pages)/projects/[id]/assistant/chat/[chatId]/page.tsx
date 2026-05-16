"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Trash2 } from "lucide-react";
import {
    deleteChat,
    getChat,
    getProject,
    regenerateDocumentPdf,
} from "@/app/lib/mikeApi";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import { useProjectHandlers } from "@/app/hooks/useProjectHandlers";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useAuth } from "@/app/contexts/AuthContext";
import { useSidebar } from "@/app/contexts/SidebarContext";
import { ChatView } from "@/app/components/assistant/ChatView";
import { ProjectExplorerPanel } from "@/app/components/projects/ProjectExplorerPanel";
import { ProjectDocPanel } from "@/app/components/projects/ProjectDocPanel";
import type { DocTab } from "@/app/components/projects/ProjectDocPanel";
import { OwnerOnlyModal } from "@/app/components/shared/OwnerOnlyModal";
import { PanelDivider } from "@/app/components/shared/PanelDivider";
import type { MikeDocument, MikeMessage, MikeProject } from "@/app/components/shared/types";

interface Props {
    params: Promise<{ id: string; chatId: string }>;
}

const EXPLORER_MIN = 160;
const EXPLORER_DEFAULT = 280;

export default function ProjectAssistantChatPage({ params }: Props) {
    const { id: projectId, chatId } = use(params);
    const router = useRouter();

    const { setSidebarOpen } = useSidebar();
    const { user } = useAuth();

    const [project, setProject] = useState<MikeProject | null>(null);
    const [chatTitle, setChatTitle] = useState<string | null>(null);
    const [chatOwnerId, setChatOwnerId] = useState<string | null>(null);
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
    const [chatLoaded, setChatLoaded] = useState(false);
    const [creatingChat, setCreatingChat] = useState(false);
    const [deletingChat, setDeletingChat] = useState(false);
    const [explorerWidth, setExplorerWidth] = useState(EXPLORER_DEFAULT);
    const [explorerCollapsed, setExplorerCollapsed] = useState(false);
    const [tabs, setTabs] = useState<DocTab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);
    const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
    const { setCurrentChatId, newChatMessages, setNewChatMessages, chats, saveChat } = useChatHistoryContext();
    const [initialMessages] = useState<MikeMessage[]>(newChatMessages ?? []);
    const { messages, isResponseLoading, handleChat, setMessages, cancel } =
        useAssistantChat({ initialMessages, chatId, projectId });
    const hasLoaded = useRef(false);
    const hasAutoSent = useRef(false);

    const {
        uploading,
        uploadFiles,
        handleCreateFolder,
        handleRenameFolder,
        handleDeleteFolder,
        handleMoveDoc,
        handleMoveFolder,
        handleDeleteDoc,
    } = useProjectHandlers(projectId, project, setProject, (docId) => {
        setTabs((prev) => prev.filter((t) => t.documentId !== docId));
        if (activeTabId === docId) { setActiveTabId(null); setSelectedDocId(null); }
    });

    useEffect(() => { setSidebarOpen(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => { setCurrentChatId(chatId); }, [chatId, setCurrentChatId]);

    useEffect(() => {
        getProject(projectId).then(setProject).catch(() => {});
    }, [projectId]);

    // Re-fetch project when assistant mutations complete.
    const completedMutationCount = messages.reduce((n, msg) => {
        for (const ev of msg.events ?? []) {
            if ("isStreaming" in ev && ev.isStreaming) continue;
            if (ev.type === "doc_created" || ev.type === "doc_replicated" || ev.type === "doc_edited") n++;
        }
        return n;
    }, 0);
    useEffect(() => { // eslint-disable-line react-hooks/exhaustive-deps
        if (!completedMutationCount) return;
        getProject(projectId).then(setProject).catch(() => {});
    }, [completedMutationCount, projectId]);

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

    function openTab(docId: string, filename: string) {
        const doc = project?.documents?.find(
            (d) => d.id === docId,
        ) as (MikeDocument & { current_version_id?: string | null }) | undefined;
        setTabs((prev) => {
            const existing = prev.find((t) => t.documentId === docId);
            if (existing) return prev;
            return [
                ...prev,
                {
                    documentId: docId,
                    filename,
                    versionId: doc?.current_version_id ?? null,
                    versionNumber: doc?.latest_version_number ?? null,
                    pdfConversionStatus: doc?.pdf_conversion_status ?? null,
                },
            ];
        });
        setActiveTabId(docId);
        setSelectedDocId(docId);
    }

    function closeTab(docId: string) {
        setTabs((prev) => {
            const next = prev.filter((t) => t.documentId !== docId);
            if (activeTabId === docId) {
                const idx = prev.findIndex((t) => t.documentId === docId);
                const fallback = next[idx] ?? next[idx - 1] ?? null;
                setActiveTabId(fallback?.documentId ?? null);
                setSelectedDocId(fallback?.documentId ?? null);
            }
            return next;
        });
    }

    function switchTab(docId: string) {
        setActiveTabId(docId);
        setSelectedDocId(docId);
    }

    const activeTab = tabs.find((t) => t.documentId === activeTabId) ?? null;

    const handleSubmit = useCallback(
        (message: MikeMessage) => {
            if (!activeTab) return handleChat(message);
            return handleChat(message, {
                displayedDoc: { filename: activeTab.filename, documentId: activeTab.documentId },
            });
        },
        [activeTab, handleChat],
    );

    const handleDocClick = (doc: MikeDocument) => openTab(doc.id, doc.filename);

    const patchTab = (documentId: string, patch: Partial<DocTab>) =>
        setTabs((prev) => prev.map((t) => t.documentId === documentId ? { ...t, ...patch } : t));

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

    const onExplorerDividerDrag = useCallback((dx: number) => {
        setExplorerWidth((w) => Math.max(EXPLORER_MIN, w + dx));
    }, []);

    const getDocumentPreview = useCallback(
        (documentId: string) => {
            const doc = project?.documents?.find(
                (d) => d.id === documentId,
            ) as (MikeDocument & { current_version_id?: string | null }) | undefined;
            if (!doc)
                return {
                    pdfConversionStatus: null,
                    onRetryPdf: undefined,
                };
            return {
                pdfConversionStatus: doc.pdf_conversion_status ?? null,
                onRetryPdf: async () => {
                    await regenerateDocumentPdf(documentId);
                    setProject((prev) =>
                        prev
                            ? {
                                  ...prev,
                                  documents: (prev.documents ?? []).map((item) =>
                                      item.id === documentId
                                          ? {
                                                ...item,
                                                pdf_conversion_status:
                                                    "pending",
                                            }
                                          : item,
                                  ),
                              }
                            : prev,
                    );
                },
            };
        },
        [project],
    );

    // leftPane: Explorer + DocPanel + dividers (page-level, per explicit plan decision)
    const leftPane = (
        <>
            <ProjectExplorerPanel
                width={explorerWidth}
                collapsed={explorerCollapsed}
                uploading={uploading}
                documents={project?.documents ?? []}
                folders={project?.folders ?? []}
                selectedDocId={selectedDocId}
                projectName={project?.name}
                onCollapse={() => setExplorerCollapsed(true)}
                onExpand={() => setExplorerCollapsed(false)}
                onUploadFiles={uploadFiles}
                onDocClick={handleDocClick}
                onCreateFolder={handleCreateFolder}
                onRenameFolder={handleRenameFolder}
                onDeleteFolder={handleDeleteFolder}
                onDeleteDoc={handleDeleteDoc}
                onMoveDoc={handleMoveDoc}
                onMoveFolder={handleMoveFolder}
            />
            {!explorerCollapsed && <PanelDivider onDrag={onExplorerDividerDrag} />}
            <ProjectDocPanel
                tabs={tabs}
                activeTabId={activeTabId}
                activeQuotes={null}
                editScrollTarget={null}
                documents={project?.documents ?? []}
                onSwitchTab={switchTab}
                onCloseTab={closeTab}
                onDocxReady={() => {}}
                onWarningDismiss={(docId) => patchTab(docId, { warning: null })}
                onScrollChange={(docId, top) => patchTab(docId, { scrollTop: top })}
            />
        </>
    );

    return (
        <div className="flex flex-col h-full">
            {/* Page header */}
            <div className="flex items-center justify-between px-8 py-4 shrink-0">
                <div className="flex items-center gap-1.5 text-2xl font-medium font-serif">
                    <button onClick={() => router.push("/projects")} className="text-gray-500 hover:text-gray-700 transition-colors">
                        Projects
                    </button>
                    <span className="text-gray-300">›</span>
                    {project ? (
                        <button onClick={() => router.push(`/projects/${projectId}`)} className="text-gray-500 hover:text-gray-700 transition-colors">
                            {project.name}
                            {project.cm_number && <span className="ml-1 text-gray-400">(#{project.cm_number})</span>}
                        </button>
                    ) : (
                        <div className="h-6 w-32 rounded bg-gray-100 animate-pulse" />
                    )}
                    <span className="text-gray-300">›</span>
                    <button onClick={() => router.push(`/projects/${projectId}?tab=assistant`)} className="text-gray-500 hover:text-gray-700 transition-colors">
                        Assistant
                    </button>
                    <span className="text-gray-300">›</span>
                    {chatLoaded ? (
                        <span className="text-gray-900 truncate max-w-xs">{chatTitle ?? "Untitled New Chat"}</span>
                    ) : (
                        <div className="h-6 w-40 rounded bg-gray-100 animate-pulse" />
                    )}
                </div>
                <div className="flex items-center gap-2">
                    <button onClick={handleNewChat} disabled={creatingChat} title="New chat" className="flex items-center justify-center p-1.5 text-gray-500 hover:text-gray-900 transition-colors disabled:opacity-40">
                        {creatingChat ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                    </button>
                    <button onClick={handleDeleteChat} disabled={deletingChat} title="Delete chat" className="flex items-center justify-center p-1.5 text-gray-500 hover:text-red-600 transition-colors disabled:opacity-40">
                        {deletingChat ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    </button>
                </div>
            </div>

            {/* Body: leftPane (Explorer + DocPanel + dividers) + ChatView */}
            <div className="flex flex-1 min-h-0 border-t border-gray-200 overflow-hidden">
                <ChatView
                    messages={messages}
                    isResponseLoading={isResponseLoading}
                    handleChat={handleSubmit}
                    cancel={cancel}
                projectId={projectId}
                leftPane={leftPane}
                getDocumentPreview={getDocumentPreview}
                chatInputProps={{
                    hideAddDocButton: true,
                    projectName: project?.name,
                        projectCmNumber: project?.cm_number,
                    }}
                />
            </div>

            <OwnerOnlyModal
                open={!!ownerOnlyAction}
                action={ownerOnlyAction ?? undefined}
                onClose={() => setOwnerOnlyAction(null)}
            />
        </div>
    );
}
