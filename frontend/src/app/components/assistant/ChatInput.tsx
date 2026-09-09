"use client";

import {
    useState,
    useCallback,
    useEffect,
    useRef,
    forwardRef,
    useImperativeHandle,
} from "react";
import {
    ArrowRight,
    Check,
    Library,
    Loader2,
    Square,
    Waypoints,
    X,
} from "lucide-react";
import { AddDocButton } from "./AddDocButton";
import { UploadOverlay } from "./UploadOverlay";
import { FileTypeIcon } from "../shared/FileTypeIcon";
import { AddDocumentsModal } from "../modals/AddDocumentsModal";
import { AssistantWorkflowModal } from "./AssistantWorkflowModal";
import { WORKFLOW_SLASH_MENU_ID, WorkflowSlashMenu } from "./WorkflowSlashMenu";
import {
    exactSlashWorkflow,
    matchingSlashWorkflows,
    slashCommandQuery,
    workflowSlashCommand,
} from "./workflowSlashCommands";
import { ApiKeyMissingPopup } from "../popups/ApiKeyMissingPopup";
import {
    ModelToggle,
    type NoModelsReason,
    type ReasoningLevel,
} from "./ModelToggle";
import { NoModelsWarningPopup } from "../popups/NoModelsWarningPopup";
import { WarningPopup } from "../popups/WarningPopup";
import {
    useSelectedModel,
    useSelectedReasoning,
} from "@/app/hooks/useSelectedModel";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import {
    getModelProvider,
    isModelAvailable,
    type ModelProvider,
} from "@/app/lib/modelAvailability";
import type { Document, Message, Workflow } from "../shared/types";
import type { DirectoryTab } from "../shared/useDirectoryData";
import { cn } from "@/app/lib/utils";
import {
    LIQUID_GLASS_FLAT_CLASS,
    LIQUID_GLASS_TRANSLUCENT_CLASS,
} from "@/app/components/ui/liquid-surface";
import {
    UploadBatchError,
    failedUploadMessage,
    listWorkflows,
    uploadProjectDocuments,
    uploadStandaloneDocuments,
    type UploadProgress,
} from "@/app/lib/mikeApi";
import {
    formatUnsupportedDocumentWarning,
    partitionSupportedDocumentFiles,
} from "@/app/lib/documentUploadValidation";
import { userFacingApiError } from "@/app/lib/userFacingError";

export interface ChatInputHandle {
    addDoc: (doc: Document) => void;
    startWorkflow: (
        workflow: { id: string; title: string },
        prompt?: string,
    ) => void;
    startWorkflowDocumentSelection: (
        workflow: { id: string; title: string },
        prompt?: string,
        options?: { initialDocumentTab?: DirectoryTab },
    ) => void;
}

interface Props {
    onSubmit: (message: Message) => void;
    onCancel: () => void;
    isLoading: boolean;
    /**
     * Whether the caller may write into this chat. False renders a read-only
     * composer — sending, attaching, and drop-uploads stay off, matching
     * what the server would refuse for a project viewer.
     *
     * `null` means the answer has not arrived. The composer is closed exactly
     * as for `false`, but the placeholder stays neutral: telling an owner
     * "Viewing only — sending needs edit access" for the length of a fetch,
     * on every cold load, is a wrong statement about their access, not a
     * loading state.
     */
    canSend?: boolean | null;
    hideAddDocButton?: boolean;
    hideWorkflowButton?: boolean;
    projectName?: string;
    projectCmNumber?: string | null;
    projectId?: string;
    onDocumentsUploaded?: (documents: Document[]) => void;
    onDocumentClick?: (document: Document) => void;
    chatModel?: string | null;
    chatReasoningLevel?: ReasoningLevel | null;
    chatKey?: string | null;
}

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput(
    {
        onSubmit,
        onCancel,
        isLoading,
        canSend = true,
        hideAddDocButton,
        hideWorkflowButton,
        projectName,
        projectCmNumber,
        projectId,
        onDocumentsUploaded,
        onDocumentClick,
        chatModel,
        chatReasoningLevel,
        chatKey,
    }: Props,
    ref,
) {
    const [value, setValue] = useState("");
    const [attachedDocs, setAttachedDocs] = useState<Document[]>([]);
    const [selectedWorkflow, setSelectedWorkflow] = useState<{
        id: string;
        title: string;
    } | null>(null);
    const {
        profile,
        loading: profileLoading,
        apiKeysDegraded,
        persistChatModelSelection,
        persistChatReasoningSelection,
    } = useUserProfile();
    // A degraded profile is the local fallback, whose router lists are empty
    // because the truth is UNKNOWN. Passing them on would let one dropped
    // /user/profile request rewrite the saved composer selection to the
    // default — permanently. null means "not loaded", which the hook leaves
    // the stored selection alone for.
    const [model, setModel] = useSelectedModel({
        selectionKey: chatKey,
        chatModel,
        lastSelectedModel: profile?.lastSelectedChatModel,
        routerSelections:
            profile && !apiKeysDegraded
                ? {
                  openRouterModels: profile.openRouterModels,
                  vercelModels: profile.vercelModels,
                  openCodeGoModels: profile.openCodeGoModels,
                  }
                : null,
        apiKeys: apiKeysDegraded ? undefined : profile?.apiKeys,
    });
    // Degraded profile → key availability is UNKNOWN; undefined here makes
    // every key gate (submit check + model toggle) fail open instead of
    // treating "we couldn't ask" as "no keys configured".
    const apiKeys = apiKeysDegraded ? undefined : profile?.apiKeys;
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const controlsRef = useRef<HTMLDivElement>(null);
    const [compactControls, setCompactControls] = useState(false);
    const [docSelectorOpen, setDocSelectorOpen] = useState(false);
    const [docSelectorInitialTab, setDocSelectorInitialTab] =
        useState<DirectoryTab>("files");
    const [workflowModalOpen, setWorkflowModalOpen] = useState(false);
    const [apiKeyModalProvider, setApiKeyModalProvider] =
        useState<ModelProvider | null>(null);
    const [noModelsWarning, setNoModelsWarning] =
        useState<NoModelsReason | null>(null);
    const [modelRequiredWarning, setModelRequiredWarning] = useState(false);
    const [reasoningLevel, setReasoningLevel] = useSelectedReasoning({
        selectionKey: chatKey,
        chatReasoningLevel,
        lastSelectedReasoningLevel: profile?.lastSelectedReasoningLevel,
    });
    const [isDraggingFiles, setIsDraggingFiles] = useState(false);
    const [uploadingFiles, setUploadingFiles] = useState<
        Array<{ clientId: string; filename: string }>
    >([]);
    const [uploadWarning, setUploadWarning] = useState<string | null>(null);
    const [droppedDocuments, setDroppedDocuments] = useState<Document[]>([]);
    const [slashWorkflows, setSlashWorkflows] = useState<Workflow[] | null>(
        null,
    );
    const [activeSlashIndex, setActiveSlashIndex] = useState(0);
    const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);
    const dragDepthRef = useRef(0);
    const settingsSaveRef = useRef<Promise<boolean>>(Promise.resolve(true));

    const handleModelChange = useCallback(
        (nextModel: string) => {
            setModel(nextModel);
            // Keep rapid picker changes ordered so the final database value
            // always matches the final visible selection.
            settingsSaveRef.current = settingsSaveRef.current
                .catch(() => false)
                .then(() => persistChatModelSelection(nextModel, chatKey));
        },
        [chatKey, persistChatModelSelection, setModel],
    );

    const handleReasoningChange = useCallback(
        (nextLevel: ReasoningLevel) => {
            setReasoningLevel(nextLevel);
            settingsSaveRef.current = settingsSaveRef.current
                .catch(() => false)
                .then(() =>
                    persistChatReasoningSelection(nextLevel, chatKey),
                );
        }, [
            chatKey,
            persistChatReasoningSelection,
            setReasoningLevel,
        ],
    );

    const chatSettingsLoading =
        !!chatKey &&
        (chatModel === undefined || chatReasoningLevel === undefined);

    const slashQuery = slashCommandQuery(value);
    const matchingWorkflows = matchingSlashWorkflows(
        slashWorkflows ?? [],
        slashQuery,
    );
    const slashCommandsLoading = slashQuery !== null && slashWorkflows === null;
    const slashMenuOpen =
        !slashMenuDismissed &&
        !selectedWorkflow &&
        slashQuery !== null &&
        matchingWorkflows.length > 0;
    const resolvedSlashIndex = Math.min(
        activeSlashIndex,
        Math.max(0, matchingWorkflows.length - 1),
    );

    useImperativeHandle(ref, () => ({
        addDoc: (doc: Document) => {
            setAttachedDocs((prev) => {
                if (prev.some((d) => d.id === doc.id)) return prev;
                return [...prev, doc];
            });
        },
        startWorkflow: (workflow, prompt) => {
            setSelectedWorkflow(workflow);
            if (prompt !== undefined) setValue(prompt);
            requestAnimationFrame(() => textareaRef.current?.focus());
        },
        startWorkflowDocumentSelection: (workflow, prompt, options) => {
            setSelectedWorkflow(workflow);
            setDocSelectorInitialTab(options?.initialDocumentTab ?? "files");
            if (prompt !== undefined) {
                setValue(prompt);
                requestAnimationFrame(() => {
                    if (!textareaRef.current) return;
                    textareaRef.current.style.height = "auto";
                    textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
                });
            }
            setDocSelectorOpen(true);
        },
    }));

    useEffect(() => {
        const el = controlsRef.current;
        if (!el) return;
        const update = () => setCompactControls(el.offsetWidth < 430);
        update();
        const observer = new ResizeObserver(update);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (!slashCommandsLoading) return;

        let cancelled = false;
        listWorkflows("assistant")
            .then((workflows) => {
                if (!cancelled) setSlashWorkflows(workflows);
            })
            .catch(() => {
                if (!cancelled) setSlashWorkflows([]);
            });

        return () => {
            cancelled = true;
        };
    }, [slashCommandsLoading]);

    const handleAddDocsFromSelector = useCallback(
        (selectedDocs: Document[]) => {
            setAttachedDocs((prev) => {
                const existing = new Set(prev.map((d) => d.id));
                return [
                    ...prev,
                    ...selectedDocs.filter((d) => !existing.has(d.id)),
                ];
            });
        },
        [],
    );

    const addAttachedDocuments = useCallback((documents: Document[]) => {
        setAttachedDocs((prev) => {
            const existing = new Set(prev.map((document) => document.id));
            return [
                ...prev,
                ...documents.filter((document) => !existing.has(document.id)),
            ];
        });
    }, []);

    const handleDroppedFiles = useCallback(
        async (files: File[]) => {
            if (!canSend) {
                setUploadWarning(
                    "Only someone with edit access can add documents.",
                );
                return;
            }
            const { supported, unsupported } =
                partitionSupportedDocumentFiles(files);
            setUploadWarning(formatUnsupportedDocumentWarning(unsupported));
            if (supported.length === 0) return;

            const uploadInputs = supported.map((file) => ({
                file,
                clientId: crypto.randomUUID(),
            }));
            setUploadingFiles(
                uploadInputs.map(({ clientId, file }) => ({
                    clientId,
                    filename: file.name,
                })),
            );
            const addCompletedDocument = (document: Document) => {
                addAttachedDocuments([document]);
                setDroppedDocuments((prev) => {
                    const existing = new Set(
                        prev.map((document) => document.id),
                    );
                    return [
                        ...prev,
                        ...(existing.has(document.id) ? [] : [document]),
                    ];
                });
            };
            const handleProgress = (progress: UploadProgress<Document>) => {
                if (
                    progress.status === "completed" ||
                    progress.status === "error"
                ) {
                    setUploadingFiles((current) =>
                        current.filter(
                            (upload) => upload.clientId !== progress.clientId,
                        ),
                    );
                }
                if (progress.status === "completed" && progress.result) {
                    addCompletedDocument(progress.result);
                }
            };
            try {
                const outcomes = projectId
                    ? await uploadProjectDocuments(projectId, uploadInputs, {
                          onProgress: handleProgress,
                      })
                    : await uploadStandaloneDocuments(uploadInputs, {
                          onProgress: handleProgress,
                      });
                const uploaded = outcomes.flatMap((outcome) =>
                    outcome.status === "completed" && outcome.result
                        ? [outcome.result]
                        : [],
                );
                uploaded.forEach(addCompletedDocument);
                if (uploaded.length > 0) onDocumentsUploaded?.(uploaded);
                if (outcomes.some((outcome) => outcome.status === "error")) {
                    setUploadWarning(failedUploadMessage(outcomes));
                }
            } catch (error) {
                setUploadWarning(
                    error instanceof UploadBatchError
                        ? failedUploadMessage(error.outcomes)
                        : userFacingApiError(
                              error,
                              "Documents could not be uploaded. Please try again.",
                          ),
                );
            } finally {
                setUploadingFiles([]);
            }
        },
        [addAttachedDocuments, canSend, onDocumentsUploaded, projectId],
    );

    useEffect(() => {
        const hasFiles = (dataTransfer: DataTransfer | null) =>
            !!dataTransfer && Array.from(dataTransfer.types).includes("Files");

        const handleDragEnter = (event: DragEvent) => {
            if (!hasFiles(event.dataTransfer)) return;
            event.preventDefault();
            dragDepthRef.current += 1;
            setIsDraggingFiles(true);
        };
        const handleDragOver = (event: DragEvent) => {
            if (!hasFiles(event.dataTransfer)) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        };
        const handleDragLeave = (event: DragEvent) => {
            if (!hasFiles(event.dataTransfer)) return;
            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
            if (dragDepthRef.current === 0) setIsDraggingFiles(false);
        };
        const handleDrop = (event: DragEvent) => {
            if (!hasFiles(event.dataTransfer)) return;
            event.preventDefault();
            event.stopPropagation();
            dragDepthRef.current = 0;
            setIsDraggingFiles(false);
            void handleDroppedFiles(
                Array.from(event.dataTransfer?.files ?? []),
            );
        };

        window.addEventListener("dragenter", handleDragEnter);
        window.addEventListener("dragover", handleDragOver);
        window.addEventListener("dragleave", handleDragLeave);
        window.addEventListener("drop", handleDrop);
        return () => {
            window.removeEventListener("dragenter", handleDragEnter);
            window.removeEventListener("dragover", handleDragOver);
            window.removeEventListener("dragleave", handleDragLeave);
            window.removeEventListener("drop", handleDrop);
        };
    }, [handleDroppedFiles]);

    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setValue(e.target.value);
        setActiveSlashIndex(0);
        setSlashMenuDismissed(false);
        const el = e.target;
        el.style.height = "auto";
        el.style.height = `${el.scrollHeight}px`;
    };

    const submitMessage = (
        query: string,
        workflow: { id: string; title: string } | null,
    ) => {
        if (!query || isLoading) return;
        if (!model) {
            setModelRequiredWarning(true);
            return;
        }
        if (apiKeys && !isModelAvailable(model, apiKeys)) {
            setApiKeyModalProvider(getModelProvider(model));
            return;
        }
        setValue("");
        if (textareaRef.current) {
            textareaRef.current.style.height = "auto";
        }

        const files = attachedDocs.map((d) => ({
            filename: d.filename,
            document_id: d.id,
            ...(d.current_version_id
                ? { version_id: d.current_version_id }
                : {}),
            ...(d.active_version_number != null
                ? { version_number: d.active_version_number }
                : {}),
        }));
        setAttachedDocs([]);
        setSelectedWorkflow(null);

        onSubmit?.({
            role: "user",
            content: query,
            files: files.length > 0 ? files : undefined,
            workflow: workflow ?? undefined,
            model,
            reasoning: reasoningLevel,
        });
    };

    const selectSlashWorkflow = (workflow: Workflow) => {
        if (!workflowSlashCommand(workflow)) return;
        setSelectedWorkflow({
            id: workflow.id,
            title: workflow.metadata.title,
        });
        setValue("");
        setSlashMenuDismissed(true);
        if (textareaRef.current) {
            textareaRef.current.style.height = "auto";
            textareaRef.current.focus();
        }
    };

    const handleSubmit = () => {
        const query = value.trim();
        if (!canSend || slashCommandsLoading) return;
        const slashWorkflow = exactSlashWorkflow(slashWorkflows ?? [], query);
        if (slashWorkflow) {
            selectSlashWorkflow(slashWorkflow);
            return;
        }
        submitMessage(query, selectedWorkflow);
    };

    const handleActionClick = () => {
        if (isLoading) {
            onCancel();
        } else {
            handleSubmit();
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (slashMenuOpen && matchingWorkflows.length > 0) {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveSlashIndex(
                    (resolvedSlashIndex + 1) % matchingWorkflows.length,
                );
                return;
            }
            if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveSlashIndex(
                    (resolvedSlashIndex - 1 + matchingWorkflows.length) %
                        matchingWorkflows.length,
                );
                return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                selectSlashWorkflow(matchingWorkflows[resolvedSlashIndex]);
                return;
            }
        }
        if (slashMenuOpen && e.key === "Escape") {
            e.preventDefault();
            setSlashMenuDismissed(true);
            return;
        }
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };

    return (
        <>
            <div className="relative w-full">
                {slashMenuOpen && (
                    <WorkflowSlashMenu
                        workflows={matchingWorkflows}
                        activeIndex={resolvedSlashIndex}
                        onSelect={selectSlashWorkflow}
                    />
                )}
                <div
                    className={cn(
                        "rounded-[21px]",
                        LIQUID_GLASS_TRANSLUCENT_CLASS,
                    )}
                >
                    {/* Attached chips */}
                    {(selectedWorkflow || attachedDocs.length > 0) && (
                        <div className="flex flex-wrap gap-1.5 px-2 pt-2">
                            {selectedWorkflow && (
                                <div className="inline-flex items-center gap-1 pl-2.5 pr-1 py-0.5 rounded-full text-xs bg-blue-600 text-white border border-white/20 shadow backdrop-blur-sm">
                                    <Library className="h-2.5 w-2.5 shrink-0" />
                                    <span className="max-w-[140px] truncate">
                                        {selectedWorkflow.title}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            setSelectedWorkflow(null)
                                        }
                                        className="rounded-full p-0.5 ml-0.5 text-white/60 hover:text-white hover:bg-white/20 transition-colors"
                                    >
                                        <X className="h-2.5 w-2.5" />
                                    </button>
                                </div>
                            )}
                            {attachedDocs.map((doc) => {
                                const documentLabel = (
                                    <>
                                        <FileTypeIcon
                                            fileType={doc.file_type}
                                            className="h-2.5 w-2.5"
                                        />
                                        <span className="max-w-[140px] truncate">
                                            {doc.filename}
                                        </span>
                                    </>
                                );
                                return (
                                    <div
                                        key={doc.id}
                                        className={`inline-flex items-center rounded-[10px] text-xs text-gray-800 ${LIQUID_GLASS_FLAT_CLASS}`}
                                    >
                                        {onDocumentClick ? (
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    onDocumentClick(doc)
                                                }
                                                aria-label={`Open ${doc.filename}`}
                                                className="inline-flex min-w-0 items-center gap-1 py-0.5 pl-2 transition-colors hover:text-gray-950"
                                            >
                                                {documentLabel}
                                            </button>
                                        ) : (
                                            <span className="inline-flex min-w-0 items-center gap-1 py-0.5 pl-2">
                                                {documentLabel}
                                            </span>
                                        )}
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setAttachedDocs((prev) =>
                                                    prev.filter(
                                                        (d) => d.id !== doc.id,
                                                    ),
                                                )
                                            }
                                            aria-label={`Remove ${doc.filename}`}
                                            className="mx-1 rounded-full p-0.5 text-gray-400 transition-colors hover:bg-gray-900/5 hover:text-gray-700"
                                        >
                                            <X className="h-2.5 w-2.5" />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {uploadingFiles.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 px-2 pt-2">
                            {uploadingFiles.map((upload) => (
                                <div
                                    key={upload.clientId}
                                    className={`inline-flex items-center gap-1 rounded-[10px] px-2 py-1 text-xs text-gray-600 ${LIQUID_GLASS_FLAT_CLASS}`}
                                >
                                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                                    <span className="max-w-[140px] truncate">
                                        {upload.filename}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Input */}
                    <div className="px-4 pt-4">
                        <textarea
                            ref={textareaRef}
                            rows={1}
                            disabled={!canSend}
                            placeholder={
                                canSend === null
                                    ? "Loading…"
                                    : canSend
                                      ? "How can I help?"
                                      : "Viewing only — sending needs edit access"
                            }
                            value={value}
                            onChange={handleChange}
                            onKeyDown={handleKeyDown}
                            role="combobox"
                            aria-autocomplete="list"
                            aria-controls={
                                slashMenuOpen
                                    ? WORKFLOW_SLASH_MENU_ID
                                    : undefined
                            }
                            aria-expanded={slashMenuOpen}
                            aria-activedescendant={
                                slashMenuOpen && matchingWorkflows.length > 0
                                    ? `${WORKFLOW_SLASH_MENU_ID}-${resolvedSlashIndex}`
                                    : undefined
                            }
                            className="w-full resize-none text-sm overflow-hidden border-0 text-base p-0 bg-transparent outline-none placeholder:text-gray-400 leading-6 max-h-48"
                        />
                    </div>

                    {/* Controls */}
                    <div
                        ref={controlsRef}
                        className="flex items-center justify-between p-2.5"
                    >
                        <div className="flex items-center gap-1">
                            {!hideAddDocButton && canSend && (
                                <AddDocButton
                                    onBrowseAll={() => {
                                        setDocSelectorInitialTab("files");
                                        setDocSelectorOpen(true);
                                    }}
                                    selectedDocIds={attachedDocs.map(
                                        (d) => d.id,
                                    )}
                                    hideLabel={compactControls}
                                />
                            )}
                            {!hideWorkflowButton && canSend && (
                                <button
                                    type="button"
                                    onClick={() => setWorkflowModalOpen(true)}
                                    aria-label="Open workflows"
                                    className={cn(
                                        "flex items-center gap-1.5 rounded-lg px-2 h-8 text-sm transition-colors",
                                        selectedWorkflow
                                            ? "text-blue-600 hover:text-blue-700"
                                            : "text-gray-400 hover:text-gray-700",
                                    )}
                                >
                                    {selectedWorkflow ? (
                                        <Check className="h-3.5 w-3.5" />
                                    ) : (
                                        <Waypoints className="h-3.5 w-3.5" />
                                    )}
                                    <span
                                        className={
                                            compactControls
                                                ? "hidden"
                                                : "hidden sm:inline"
                                        }
                                    >
                                        Workflows
                                    </span>
                                </button>
                            )}
                        </div>

                        <div className="flex items-center gap-1">
                            {!chatSettingsLoading && (
                                <ModelToggle
                                    value={model}
                                    onChange={handleModelChange}
                                    apiKeys={apiKeys}
                                    apiKeysLoading={
                                        profileLoading && !profile
                                    }
                                    openRouterModels={profile?.openRouterModels}
                                    vercelModels={profile?.vercelModels}
                                    openCodeGoModels={profile?.openCodeGoModels}
                                    compact={compactControls}
                                    onNoModelsClick={setNoModelsWarning}
                                    reasoningLevel={reasoningLevel}
                                    onReasoningChange={handleReasoningChange}
                                />
                            )}
                            <button
                                type="button"
                                aria-label={
                                    isLoading ? "Stop response" : "Send message"
                                }
                                className={cn(
                                    "relative bg-gradient-to-b from-neutral-700 to-black text-white rounded-[11px] h-8 w-8 flex items-center justify-center cursor-pointer disabled:cursor-default disabled:from-neutral-600 disabled:to-black backdrop-blur-xl border-0 active:enabled:scale-95 transition-all duration-150",
                                    "shadow-[0_3px_9px_rgba(15,23,42,0.10),inset_1px_1px_0_rgba(255,255,255,0.22),inset_-1px_-1px_0_rgba(255,255,255,0.10),inset_-4px_-4px_9px_rgba(15,23,42,0.2)]",
                                )}
                                onClick={handleActionClick}
                                disabled={
                                    !canSend ||
                                    (!isLoading &&
                                        (!value.trim() ||
                                            slashCommandsLoading))
                                }
                            >
                                {isLoading ? (
                                    <Square
                                        className="h-4 w-4"
                                        fill="currentColor"
                                        strokeWidth={0}
                                    />
                                ) : (
                                    <ArrowRight className="h-4 w-4" />
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <AddDocumentsModal
                open={docSelectorOpen}
                keepMounted
                onClose={() => setDocSelectorOpen(false)}
                onSelect={handleAddDocsFromSelector}
                initialSelectedDocuments={attachedDocs}
                externalUploadedDocuments={droppedDocuments}
                initialTab={docSelectorInitialTab}
                projectId={projectId}
                uploadStateId={`assistant-chat:${projectId ?? "standalone"}`}
                breadcrumb={
                    selectedWorkflow
                        ? ["Assistant", selectedWorkflow.title, "Add Documents"]
                        : ["Assistant", "Add Documents"]
                }
            />
            <AssistantWorkflowModal
                open={workflowModalOpen}
                onClose={() => setWorkflowModalOpen(false)}
                onSelect={(wf) => {
                    setSelectedWorkflow({
                        id: wf.id,
                        title: wf.metadata.title,
                    });
                    setWorkflowModalOpen(false);
                }}
                projectName={projectName}
                projectCmNumber={projectCmNumber}
            />
            <ApiKeyMissingPopup
                open={apiKeyModalProvider !== null}
                provider={apiKeyModalProvider}
                onClose={() => setApiKeyModalProvider(null)}
            />
            <NoModelsWarningPopup
                reason={noModelsWarning}
                onClose={() => setNoModelsWarning(null)}
            />
            <WarningPopup
                open={modelRequiredWarning}
                onClose={() => setModelRequiredWarning(false)}
                title="Select a model"
                message="Choose a model before sending your message."
            />
            <UploadOverlay
                open={isDraggingFiles}
                warning={uploadWarning}
                onWarningClose={() => setUploadWarning(null)}
            />
        </>
    );
});
