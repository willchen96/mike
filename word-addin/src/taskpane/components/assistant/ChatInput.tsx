import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Library, X } from "lucide-react";
import { WorkflowModal } from "../workflows/WorkflowModal";
import { ChatInput as ChatInputShell } from "../../../shared/chat/ChatInput";
import {
  getApiKeyStatus,
  failedUploadMessage,
  getUserProfile,
  listWorkflows,
  uploadStandaloneDocuments,
  UploadBatchError,
  type ApiKeyStatus,
  type UploadOutcome,
  type UploadProgress,
} from "../../api/mikeApi";
import { useSelectedModel } from "../../hooks/useSelectedModel";
import type { Document, Workflow } from "../../types";
import {
  partitionSupportedDocumentFiles,
  SUPPORTED_DOCUMENT_ACCEPT,
} from "../../lib/documentUpload";
import { EditApplyModeMenu } from "./EditApplyModeMenu";
import type { WordEditApplyMode } from "../../lib/wordChatSettings";
import { AddDocumentsModal } from "../documents/AddDocumentsModal";
import { FileTypeIcon } from "../documents/DirectoryIcons";
import { DocumentSourceMenu } from "../documents/DocumentSourceMenu";
import { ModelToggle } from "./ModelToggle";
import type {
  WorkflowAttachment,
  ReasoningLevel,
  WordChatSubmission,
  WordChatSubmitOptions,
} from "../../lib/wordChatTypes";
import { isModelAvailable, missingModelProvider } from "../../lib/modelCatalog";
import { loadWithRetry } from "../../lib/composerPreflight";
import { workflowSlashCommandFromTitle } from "@mike/workflow-slash-command-ui";
import {
  WORD_WORKFLOW_SLASH_MENU_ID,
  WorkflowSlashMenu,
} from "./WorkflowSlashMenu";

export interface ChatInputHandle {
  setDraft: (prompt: string) => void;
  requestDocuments: () => void;
}

interface ChatInputProps {
  sessionKey: number;
  chatModel?: string | null;
  lastSelectedModel?: string | null;
  chatReasoningLevel?: ReasoningLevel | null;
  lastSelectedReasoningLevel: ReasoningLevel;
  onModelSelected: (model: string) => Promise<void>;
  onReasoningSelected: (level: ReasoningLevel) => Promise<void>;
  isResponseLoading: boolean;
  requestError: string | null;
  selectedWorkflow: WorkflowAttachment | null;
  onSelectedWorkflowChange: (workflow: WorkflowAttachment | null) => void;
  onSubmit: (
    submission: WordChatSubmission,
    options?: WordChatSubmitOptions,
  ) => Promise<void>;
  onCancel: () => void;
  onDismissRequestError: () => void;
  onTurnReady: () => void;
  containerRef: React.Ref<HTMLDivElement>;
  editApplyMode: WordEditApplyMode;
  onEditApplyModeChange: (mode: WordEditApplyMode) => void;
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(
  function ChatInput(
    {
      sessionKey,
      chatModel,
      lastSelectedModel,
      chatReasoningLevel,
      lastSelectedReasoningLevel,
      onModelSelected,
      onReasoningSelected,
      isResponseLoading,
      requestError,
      selectedWorkflow,
      onSelectedWorkflowChange,
      onSubmit,
      onCancel,
      onDismissRequestError,
      onTurnReady,
      containerRef,
      editApplyMode,
      onEditApplyModeChange,
    },
    ref,
  ): React.ReactElement {
    const [input, setInput] = useState("");
    const [attachedDocuments, setAttachedDocuments] = useState<Document[]>([]);
    const [documentsModalOpen, setDocumentsModalOpen] = useState(false);
    const [workflowModalOpen, setWorkflowModalOpen] = useState(false);
    const [uploadingLocalFiles, setUploadingLocalFiles] = useState(false);
    const [documentUploadError, setDocumentUploadError] = useState<
      string | null
    >(null);
    const [keyStatus, setKeyStatus] = useState<ApiKeyStatus | null>(null);
    const [keyStatusLoading, setKeyStatusLoading] = useState(true);
    const [openRouterModels, setOpenRouterModels] = useState<string[]>([]);
    const [vercelModels, setVercelModels] = useState<string[]>([]);
    const [openCodeGoModels, setOpenCodeGoModels] = useState<string[]>([]);
    const [profileLastSelectedModel, setProfileLastSelectedModel] = useState<
      string | null
    >(null);
    const [profileLoaded, setProfileLoaded] = useState(false);
    const [model, setModel, modelSettingsResolved] = useSelectedModel({
      sessionKey,
      chatModel,
      lastSelectedModel: lastSelectedModel ?? profileLastSelectedModel,
      routerSelections: profileLoaded
        ? { openRouterModels, vercelModels, openCodeGoModels }
        : null,
      apiKeyStatus: keyStatus,
    });
    const [modelError, setModelError] = useState<string | null>(null);
    const [profileLastSelectedReasoningLevel, setProfileLastSelectedReasoningLevel] =
      useState<ReasoningLevel>(lastSelectedReasoningLevel);
    const [reasoningLevel, setReasoningLevel] = useState<ReasoningLevel>(
      chatReasoningLevel ?? lastSelectedReasoningLevel ?? "high",
    );
    const [slashWorkflows, setSlashWorkflows] = useState<Workflow[] | null>(
      null,
    );
    const [activeSlashIndex, setActiveSlashIndex] = useState(0);
    const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);
    const localFileInputRef = useRef<HTMLInputElement>(null);
    const composerRef = useRef<HTMLDivElement>(null);
    const [compactControls, setCompactControls] = useState(false);
    const mountedRef = useRef(true);
    const uploadGenerationRef = useRef(0);
    const modelSelectionSaveRef = useRef<Promise<void>>(Promise.resolve());
    const reasoningManuallySelectedRef = useRef(false);
    const resolvedReasoningLevel = reasoningManuallySelectedRef.current
      ? reasoningLevel
      : (chatReasoningLevel ??
        lastSelectedReasoningLevel ??
        profileLastSelectedReasoningLevel ??
        "high");
    const chatSettingsLoading =
      chatModel === undefined ||
      chatReasoningLevel === undefined ||
      !modelSettingsResolved;

    const slashQuery = (() => {
      const trimmed = input.trim();
      return /^\/\S*$/.test(trimmed) ? trimmed.toLowerCase() : null;
    })();
    const matchingSlashWorkflows = (slashWorkflows ?? []).filter((workflow) =>
      workflowSlashCommandFromTitle(workflow.metadata.title)?.startsWith(
        slashQuery ?? "",
      ),
    );
    const slashCommandsLoading = slashQuery !== null && slashWorkflows === null;
    const slashMenuOpen =
      !slashMenuDismissed &&
      !selectedWorkflow &&
      slashQuery !== null &&
      matchingSlashWorkflows.length > 0;
    const resolvedSlashIndex = Math.min(
      activeSlashIndex,
      Math.max(0, matchingSlashWorkflows.length - 1),
    );

    useImperativeHandle(
      ref,
      () => ({
        setDraft: (prompt: string): void => setInput(prompt),
        requestDocuments: (): void => setDocumentsModalOpen(true),
      }),
      [],
    );

    useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        uploadGenerationRef.current += 1;
      };
    }, []);

    useEffect(() => {
      if (!slashCommandsLoading) return;
      let cancelled = false;
      void listWorkflows("assistant")
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

    useEffect(() => {
      const composer = composerRef.current;
      if (!composer || typeof ResizeObserver === "undefined") return;
      const update = (): void => setCompactControls(composer.offsetWidth < 430);
      update();
      const observer = new ResizeObserver(update);
      observer.observe(composer);
      return () => observer.disconnect();
    }, []);

    useEffect(() => {
      let cancelled = false;
      // Three-state preflight: while it runs the model toggle stays neutral
      // (no premature "No Models"); each request retries once with backoff; after a
      // final failure keyStatus stays null and availability FAILS OPEN (the
      // backend still authoritatively rejects models it cannot serve).
      void Promise.all([
        loadWithRetry(getApiKeyStatus, {
          onFinalFailure: (error) =>
            console.warn(
              "[word-addin] API key status unavailable after retry; model availability fails open",
              error,
            ),
        }),
        loadWithRetry(getUserProfile, {
          onFinalFailure: (error) =>
            console.warn(
              "[word-addin] user profile unavailable after retry; router models hidden this session",
              error,
            ),
        }),
      ]).then(([status, profile]) => {
        if (cancelled) return;
        setKeyStatus(status);
        if (profile) {
          setOpenRouterModels(profile.openRouterModels ?? []);
          setVercelModels(profile.vercelModels ?? []);
          setOpenCodeGoModels(profile.openCodeGoModels ?? []);
          setProfileLastSelectedModel(profile.lastSelectedChatModel ?? null);
          setProfileLastSelectedReasoningLevel(
            profile.lastSelectedReasoningLevel ?? "high",
          );
          setProfileLoaded(true);
        }
        setKeyStatusLoading(false);
      });
      return () => {
        cancelled = true;
      };
    }, []);

    useEffect(() => {
      uploadGenerationRef.current += 1;
      setInput("");
      setAttachedDocuments([]);
      setDocumentsModalOpen(false);
      setWorkflowModalOpen(false);
      setUploadingLocalFiles(false);
      setDocumentUploadError(null);
      setModelError(null);
      reasoningManuallySelectedRef.current = false;
      setReasoningLevel(
        chatReasoningLevel ??
          lastSelectedReasoningLevel ??
          profileLastSelectedReasoningLevel ??
          "high",
      );
    }, [sessionKey]);

    useEffect(() => {
      if (reasoningManuallySelectedRef.current) return;
      setReasoningLevel(
        chatReasoningLevel ??
          lastSelectedReasoningLevel ??
          profileLastSelectedReasoningLevel ??
          "high",
      );
    }, [
      chatReasoningLevel,
      lastSelectedReasoningLevel,
      profileLastSelectedReasoningLevel,
    ]);

    const handleLocalFiles = async (
      event: React.ChangeEvent<HTMLInputElement>,
    ): Promise<void> => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      if (files.length === 0) return;

      const generation = uploadGenerationRef.current;
      const { supported, unsupported } = partitionSupportedDocumentFiles(files);
      if (supported.length === 0) {
        setDocumentUploadError(
          "Only PDF, Word, Excel, and PowerPoint files can be uploaded.",
        );
        return;
      }

      setUploadingLocalFiles(true);
      setDocumentUploadError(
        unsupported.length > 0 ? "Unsupported files were skipped." : null,
      );
      // Documents that finished are kept even when the batch as a whole did
      // not: attach them as they land, and again from whatever accounting the
      // upload returns (or carries on an UploadBatchError).
      const attachDocuments = (documents: Document[]): void => {
        if (documents.length === 0) return;
        if (!mountedRef.current || generation !== uploadGenerationRef.current) {
          return;
        }
        setAttachedDocuments((current) => {
          const existing = new Set(current.map((document) => document.id));
          return [
            ...current,
            ...documents.filter((document) => !existing.has(document.id)),
          ];
        });
      };
      const completedDocuments = (
        outcomes: UploadOutcome<Document>[],
      ): Document[] =>
        outcomes.flatMap((outcome) =>
          outcome.status === "completed" && outcome.result
            ? [outcome.result]
            : [],
        );

      try {
        const outcomes = await uploadStandaloneDocuments(supported, {
          onProgress: (progress: UploadProgress<Document>) => {
            if (progress.status === "completed" && progress.result) {
              attachDocuments([progress.result]);
            }
          },
        });

        if (!mountedRef.current || generation !== uploadGenerationRef.current) {
          return;
        }
        attachDocuments(completedDocuments(outcomes));
        if (outcomes.some((outcome) => outcome.status === "error")) {
          setDocumentUploadError(failedUploadMessage(outcomes));
        }
      } catch (reason) {
        if (!mountedRef.current || generation !== uploadGenerationRef.current) {
          return;
        }
        if (reason instanceof UploadBatchError) {
          const outcomes = reason.outcomes as UploadOutcome<Document>[];
          attachDocuments(completedDocuments(outcomes));
          setDocumentUploadError(
            failedUploadMessage(outcomes, reason.message),
          );
        } else {
          setDocumentUploadError(
            reason instanceof Error
              ? reason.message
              : "Documents could not be uploaded. Please try again.",
          );
        }
      } finally {
        if (
          mountedRef.current &&
          generation === uploadGenerationRef.current
        ) {
          setUploadingLocalFiles(false);
        }
      }
    };

    const selectSlashWorkflow = (workflow: Workflow): void => {
      if (!workflowSlashCommandFromTitle(workflow.metadata.title)) return;
      onSelectedWorkflowChange({
        id: workflow.id,
        title: workflow.metadata.title,
      });
      setInput("");
      setSlashMenuDismissed(true);
    };

    const submit = (): void => {
      const content = input.trim();
      if (slashCommandsLoading) return;
      const exactSlashWorkflow = (slashWorkflows ?? []).find(
        (workflow) =>
          workflowSlashCommandFromTitle(workflow.metadata.title) ===
          content.toLowerCase(),
      );
      if (exactSlashWorkflow) {
        selectSlashWorkflow(exactSlashWorkflow);
        return;
      }
      if (!content || isResponseLoading) return;
      if (!model) {
        setModelError("Select a model before sending your message.");
        return;
      }
      if (!isModelAvailable(model, keyStatus)) {
        setModelError(
          model.startsWith("gateway/")
            ? `${keyStatus?.gateway?.label ?? "Gateway"} model is unavailable. Select another model.`
            : `Add a ${missingModelProvider(model)} API key before using this model.`,
        );
        return;
      }
      setModelError(null);
      const files = attachedDocuments.map((document) => ({
        filename: document.filename,
        document_id: document.id,
      }));
      void onSubmit(
        {
          content,
          files: files.length > 0 ? files : undefined,
          workflow: selectedWorkflow ?? undefined,
          model,
          reasoning: resolvedReasoningLevel,
        },
        {
          onAccepted: () => {
            setInput("");
            setAttachedDocuments([]);
            onSelectedWorkflowChange(null);
          },
          onTurnReady,
        },
      );
    };

    const composerError = requestError ?? documentUploadError ?? modelError;

    return (
      <>
        <div
          ref={containerRef}
          data-testid="chat-composer-overlay"
          className="absolute inset-x-0 bottom-0 z-30 p-3 @sm:py-4"
        >
          <input
            ref={localFileInputRef}
            type="file"
            accept={SUPPORTED_DOCUMENT_ACCEPT}
            multiple
            className="hidden"
            aria-label="Upload desktop files"
            onChange={(event) => void handleLocalFiles(event)}
          />
          {composerError && (
            <div
              role="alert"
              className="mb-2 flex items-center justify-between gap-2 rounded-xl border border-red-100 bg-red-50/95 px-3 py-2 text-xs text-gray-700 shadow-sm backdrop-blur-xl"
            >
              <span>{composerError}</span>
              <button
                type="button"
                onClick={() => {
                  onDismissRequestError();
                  setDocumentUploadError(null);
                  setModelError(null);
                }}
                aria-label="Dismiss error"
                className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-900/5 hover:text-gray-700"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <div ref={composerRef} className="relative">
            {slashMenuOpen && (
              <WorkflowSlashMenu
                workflows={matchingSlashWorkflows}
                activeIndex={resolvedSlashIndex}
                onSelect={selectSlashWorkflow}
              />
            )}
            <ChatInputShell
              value={input}
              onValueChange={(value) => {
                setInput(value);
                setActiveSlashIndex(0);
                setSlashMenuDismissed(false);
              }}
              onSubmit={submit}
              onKeyDown={(event) => {
                if (slashMenuOpen && matchingSlashWorkflows.length > 0) {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setActiveSlashIndex(
                      (resolvedSlashIndex + 1) %
                        matchingSlashWorkflows.length,
                    );
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setActiveSlashIndex(
                      (resolvedSlashIndex -
                        1 +
                        matchingSlashWorkflows.length) %
                        matchingSlashWorkflows.length,
                    );
                    return;
                  }
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    const workflow =
                      matchingSlashWorkflows[resolvedSlashIndex];
                    if (workflow) selectSlashWorkflow(workflow);
                    return;
                  }
                }
                if (slashMenuOpen && event.key === "Escape") {
                  event.preventDefault();
                  setSlashMenuDismissed(true);
                }
              }}
              combobox={{
                controls: slashMenuOpen
                  ? WORD_WORKFLOW_SLASH_MENU_ID
                  : undefined,
                expanded: slashMenuOpen,
                activeDescendant:
                  slashMenuOpen && matchingSlashWorkflows.length > 0
                    ? `${WORD_WORKFLOW_SLASH_MENU_ID}-${resolvedSlashIndex}`
                    : undefined,
              }}
              isLoading={isResponseLoading}
              onCancel={onCancel}
              disabled={false}
              placeholder="How can I help?"
              attachments={
                selectedWorkflow || attachedDocuments.length > 0 ? (
                  <>
                    {selectedWorkflow && (
                      <div className="inline-flex items-center gap-1 rounded-full border border-white/20 bg-blue-600 py-0.5 pl-2.5 pr-1 text-xs text-white shadow backdrop-blur-sm">
                        <Library className="h-2.5 w-2.5 shrink-0" />
                        <span className="max-w-[140px] truncate">
                          {selectedWorkflow.title}
                        </span>
                        <button
                          type="button"
                          onClick={() => onSelectedWorkflowChange(null)}
                          aria-label={`Remove workflow ${selectedWorkflow.title}`}
                          className="ml-0.5 rounded-full p-0.5 text-white/60 transition-colors hover:bg-white/20 hover:text-white"
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </div>
                    )}
                    {attachedDocuments.map((document) => (
                      <div
                        key={document.id}
                        className="inline-flex items-center gap-1 rounded-[10px] border border-white/70 bg-white py-0.5 pl-2 pr-1 text-xs text-gray-800 shadow-sm backdrop-blur-xl"
                      >
                        <FileTypeIcon
                          fileType={document.file_type ?? document.filename}
                          className="h-2.5 w-2.5"
                        />
                        <span className="max-w-[140px] truncate">
                          {document.filename}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setAttachedDocuments((current) =>
                              current.filter((item) => item.id !== document.id),
                            )
                          }
                          aria-label={`Remove document ${document.filename}`}
                          className="ml-0.5 rounded-full p-0.5 text-gray-400 transition-colors hover:bg-gray-900/5 hover:text-gray-700"
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </div>
                    ))}
                  </>
                ) : undefined
              }
              leftSlot={
                <div className="flex min-w-0 items-center gap-1">
                  <DocumentSourceMenu
                    disabled={isResponseLoading}
                    uploading={uploadingLocalFiles}
                    attachedCount={attachedDocuments.length}
                    onLocalFiles={() => localFileInputRef.current?.click()}
                    onWebFiles={() => setDocumentsModalOpen(true)}
                    onWorkflows={() => setWorkflowModalOpen(true)}
                  />
                  <EditApplyModeMenu
                    mode={editApplyMode}
                    onModeChange={onEditApplyModeChange}
                  />
                </div>
              }
              rightSlot={
                chatSettingsLoading ? undefined : (
                  <ModelToggle
                    value={model}
                    onChange={(next) => {
                      setModelError(null);
                      setModel(next);
                      modelSelectionSaveRef.current =
                        modelSelectionSaveRef.current
                          .catch(() => undefined)
                          .then(() => onModelSelected(next));
                    }}
                    keyStatus={keyStatus}
                    keyStatusLoading={keyStatusLoading}
                    openRouterModels={openRouterModels}
                    vercelModels={vercelModels}
                    openCodeGoModels={openCodeGoModels}
                    compact={compactControls}
                    reasoningLevel={resolvedReasoningLevel}
                    onReasoningChange={(next) => {
                      reasoningManuallySelectedRef.current = true;
                      setReasoningLevel(next);
                      modelSelectionSaveRef.current =
                        modelSelectionSaveRef.current
                          .catch(() => undefined)
                          .then(() => onReasoningSelected(next));
                    }}
                    onNoModelsClick={() => {
                      const routerHasNoModels =
                        (keyStatus?.openrouter &&
                          openRouterModels.length === 0) ||
                        (keyStatus?.vercel && vercelModels.length === 0) ||
                        (keyStatus?.["opencode-go"] &&
                          openCodeGoModels.length === 0);
                      setModelError(
                        routerHasNoModels
                          ? "Your router is connected, but it has no saved models. Add one in Bring Your Own Keys → Routers."
                          : "Add an API key in Bring Your Own Keys before selecting a model.",
                      );
                    }}
                  />
                )
              }
            />
          </div>
        </div>
        <AddDocumentsModal
          open={documentsModalOpen}
          onClose={() => setDocumentsModalOpen(false)}
          initialSelectedDocuments={attachedDocuments}
          onSelect={setAttachedDocuments}
        />
        <WorkflowModal
          open={workflowModalOpen}
          onClose={() => setWorkflowModalOpen(false)}
          initialWorkflowId={selectedWorkflow?.id}
          onSelect={(workflow) =>
            onSelectedWorkflowChange({
              id: workflow.id,
              title: workflow.metadata.title,
            })
          }
        />
      </>
    );
  },
);
