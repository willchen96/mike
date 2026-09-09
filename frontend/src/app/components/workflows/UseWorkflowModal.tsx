"use client";

import { useEffect, useState } from "react";
import type { Document, Workflow } from "../shared/types";
import { createTabularReview, listWorkflows } from "@/app/lib/mikeApi";
import { useRouter } from "next/navigation";
import { useDirectoryData } from "../shared/useDirectoryData";
import { FileDirectory } from "../shared/FileDirectory";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { Modal } from "../modals/Modal";
import { FieldLabel } from "../ui/form-field";
import { ModalSegmentedToggle } from "../modals/ModalSegmentedToggle";
import { ModalSelect } from "../modals/ModalSelect";
import { ModalTextarea } from "../modals/ModalTextarea";
import { WorkflowPickerContent } from "./WorkflowPickerContent";
import { workflowDetailPath } from "./workflowRoutes";
import {
    ModelToggle,
    type NoModelsReason,
    type RouterSlug,
} from "../assistant/ModelToggle";
import { NoModelsWarningPopup } from "../popups/NoModelsWarningPopup";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { isModelAvailable } from "@/app/lib/modelAvailability";
import { roleFrom } from "@/app/lib/permissions";

interface Props {
    workflow: Workflow | null;
    onClose: () => void;
    skipSelect?: boolean;
}

function SelectedWorkflowSummary({ workflow }: { workflow: Workflow }) {
    return (
        <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
            <span className="shrink-0 text-xs font-medium text-gray-700">
                Selected workflow
            </span>
            <span className="min-w-0 flex-1 truncate text-right text-xs text-gray-500">
                {workflow.metadata.title}
            </span>
        </div>
    );
}

// ---------------------------------------------------------------------------
// UseWorkflowModal
// ---------------------------------------------------------------------------
export function UseWorkflowModal({ workflow, onClose, skipSelect = false }: Props) {
    const [screen, setScreen] = useState<"select" | "details" | "documents">("select");
    const [selected, setSelected] = useState<Workflow | null>(workflow);
    const [listSearch, setListSearch] = useState("");
    // Self-fetched rather than received from the parent's (now paginated,
    // partial) workflow list — mirrors WorkflowPickerModal.tsx's existing
    // independent fetch pattern. Merges both types since this modal's
    // "switch workflow" screen supports any workflow, unlike
    // WorkflowPickerModal which is always scoped to one type.
    const [pickerWorkflows, setPickerWorkflows] = useState<Workflow[]>([]);
    const [pickerLoadedWorkflowId, setPickerLoadedWorkflowId] = useState<
        string | null
    >(null);
    const pickerLoading =
        workflow !== null && pickerLoadedWorkflowId !== workflow.id;

    useEffect(() => {
        if (!workflow) return;
        let cancelled = false;
        listWorkflows()
            .then((workflows) => {
                if (cancelled) return;
                setPickerWorkflows(workflows);
                const fullSelected = workflows.find((candidate) => candidate.id === workflow.id);
                if (fullSelected) setSelected(fullSelected);
            })
            .catch(() => {
                if (!cancelled) setPickerWorkflows([]);
            })
            .finally(() => {
                if (!cancelled) setPickerLoadedWorkflowId(workflow.id);
            });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [workflow?.id]);

    // Configure screen state
    const [inProject, setInProject] = useState(false);
    const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
    const [selectedDocuments, setSelectedDocuments] = useState<Document[]>([]);
    const [assistantPrompt, setAssistantPrompt] = useState("");
    const [saving, setSaving] = useState(false);
    const [selectedModel, setSelectedModel] = useState("");
    const [noModelsWarning, setNoModelsWarning] =
        useState<NoModelsReason | null>(null);
    const { profile, loading: profileLoading, apiKeysDegraded } =
        useUserProfile();
    const apiKeys = apiKeysDegraded ? undefined : profile?.apiKeys;

    const router = useRouter();
    const { saveChat, setNewChatMessages } = useChatHistoryContext();
    const {
        loading: dirLoading,
        projects,
        loadProjectLevel,
        loadedProjectLevels,
        loadingProjectLevels,
        projectDocumentsHasMoreByLevel,
        loadMoreProjectDocuments,
    } = useDirectoryData(
        screen === "details" || screen === "documents",
        "projects",
    );

    useEffect(() => {
        if (workflow) {
            setSelected(
                pickerWorkflows.find(
                    (candidate) => candidate.id === workflow.id,
                ) ?? workflow,
            );
            setScreen(skipSelect ? "details" : "select");
            setListSearch("");
        } else {
            setSelected(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [workflow?.id]);

    useEffect(() => {
        const activeWorkflow = selected ?? workflow;
        if (
            screen !== "details" ||
            activeWorkflow?.metadata.type !== "tabular" ||
            !profile?.tabularModel
        ) {
            return;
        }
        const defaultModel = profile.tabularModel;
        const router = (["openrouter", "vercel", "opencode-go"] as const).find(
            (slug) => defaultModel.startsWith(`${slug}/`),
        );
        const routerSelections: Record<RouterSlug, string[]> = {
            openrouter: profile.openRouterModels,
            vercel: profile.vercelModels,
            "opencode-go": profile.openCodeGoModels,
        };
        const routerSelectionValid =
            !router ||
            routerSelections[router].includes(
                defaultModel.slice(router.length + 1),
            );
        if (
            routerSelectionValid &&
            (!apiKeys || isModelAvailable(defaultModel, apiKeys))
        ) {
            setSelectedModel((current) => current || defaultModel);
        }
    }, [apiKeys, profile, screen, selected, workflow]);

    // Reset configure state on back
    useEffect(() => {
        if (screen === "select") {
            resetConfigureState();
        }
    }, [screen]);

    function resetConfigureState() {
        setInProject(false);
        setSelectedProjectId(null);
        setSelectedDocuments([]);
        setAssistantPrompt("");
        setSelectedModel("");
        setNoModelsWarning(null);
    }

    function handleClose() {
        setSelected(null);
        setScreen("select");
        resetConfigureState();
        onClose();
    }

    if (!workflow) return null;
    const wf = selected ?? workflow;

    // ---------------------------------------------------------------------------
    // Handlers
    // ---------------------------------------------------------------------------
    async function handleStartChat() {
        setSaving(true);
        try {
            const projectId = inProject ? selectedProjectId! : undefined;
            // A project chat inherits the caller's role on the project, so
            // the optimistic sidebar row must carry that role rather than
            // assume the creator owns it. The picker rows already carry the
            // server-computed role; absent one the context falls back to
            // editor, which is the minimum this action required anyway.
            const projectRow = projectId
                ? projects.find((candidate) => candidate.id === projectId)
                : undefined;
            const chatId = await saveChat(
                projectId,
                projectRow ? roleFrom(projectRow) : null,
            );
            if (!chatId) return;
            const files = selectedDocuments.map((document) => ({
                filename: document.filename,
                document_id: document.id,
                ...(document.current_version_id
                    ? { version_id: document.current_version_id }
                    : {}),
                ...(document.active_version_number != null
                    ? { version_number: document.active_version_number }
                    : {}),
            }));
            const content = assistantPrompt.trim()
                ? `implement workflow\n${assistantPrompt.trim()}`
                : "implement workflow";
            setNewChatMessages([
                {
                    role: "user",
                    content,
                    files: files.length > 0 ? files : undefined,
                    workflow: { id: wf.id, title: wf.metadata.title },
                },
            ]);
            handleClose();
            router.push(projectId ? `/projects/${projectId}/assistant/chat/${chatId}` : `/assistant/chat/${chatId}`);
        } finally {
            setSaving(false);
        }
    }

    async function handleCreateReview() {
        if (!selectedModel) return;
        const docIds = selectedDocuments.map((document) => document.id);
        const projectId = inProject ? selectedProjectId! : undefined;

        setSaving(true);
        try {
            const review = await createTabularReview({
                title: wf.metadata.title,
                document_ids: docIds,
                columns_config: wf.columns_config || [],
                workflow_id: wf.is_system ? undefined : wf.id,
                project_id: projectId,
                model: selectedModel,
            });
            handleClose();
            router.push(
                projectId ? `/projects/${projectId}/tabular-reviews/${review.id}` : `/tabular-reviews/${review.id}`,
            );
        } finally {
            setSaving(false);
        }
    }

    const selectedProject = projects.find((p) => p.id === selectedProjectId);
    const projectDocs = selectedProject?.documents ?? [];
    const projectOptions = projects.map((project) => ({
        value: project.id,
        label: project.name + (project.cm_number ? ` (#${project.cm_number})` : ""),
    }));
    const location = inProject ? "project" : "workspace";
    const locationOptions =
        wf.metadata.type === "assistant"
            ? [
                  { value: "workspace" as const, label: "Assistant" },
                  { value: "project" as const, label: "Project assistant" },
              ]
            : [
                  { value: "workspace" as const, label: "Tabular reviews" },
                  {
                      value: "project" as const,
                      label: "Project tabular reviews",
                  },
              ];

    const breadcrumbs =
        screen === "select"
            ? ["Workflows", "Select workflow"]
            : [
                  <button
                      key="workflows"
                      type="button"
                      onClick={() => setScreen("select")}
                      className="transition-colors hover:text-gray-700"
                  >
                      Workflows
                  </button>,
                  wf.metadata.title,
                  wf.metadata.type === "assistant" ? "New Chat" : "New Review",
                  screen === "details" ? "Details" : "Attach Documents",
              ];

    const selectPageAction = () => {
        router.push(workflowDetailPath(wf));
        handleClose();
    };

    // ---------------------------------------------------------------------------
    // Render
    // ---------------------------------------------------------------------------
    return (
        <Modal
            open={!!workflow}
            onClose={handleClose}
            size={screen === "select" ? "xl" : "lg"}
            breadcrumbs={breadcrumbs}
            secondaryAction={
                screen === "select"
                    ? {
                          label: "Edit",
                          onClick: selectPageAction,
                      }
                    : screen === "details"
                      ? {
                            label: "Back",
                            onClick: () => setScreen("select"),
                            disabled: saving,
                        }
                      : {
                            label: "Back",
                            onClick: () => setScreen("details"),
                            disabled: saving,
                        }
            }
            primaryAction={
                screen === "select"
                    ? {
                          label: "Use",
                          onClick: () => setScreen("details"),
                      }
                    : screen === "details"
                      ? {
                            label: "Next",
                            onClick: () => setScreen("documents"),
                            disabled:
                                saving ||
                                (wf.metadata.type === "tabular" &&
                                    !selectedModel) ||
                                (inProject &&
                                    (!selectedProjectId ||
                                        !loadedProjectLevels.has(`${selectedProjectId}:root`) ||
                                        loadingProjectLevels.has(`${selectedProjectId}:root`))),
                        }
                      : wf.metadata.type === "assistant"
                        ? {
                              label: saving ? "Starting…" : "Start Chat",
                              onClick: handleStartChat,
                              disabled: saving || (inProject && !selectedProjectId),
                          }
                        : {
                              label: saving ? "Creating…" : "Create Review",
                              onClick: handleCreateReview,
                              disabled:
                                  saving ||
                                  !selectedModel ||
                                  selectedDocuments.length === 0 ||
                                  (inProject && !selectedProjectId),
                          }
            }
            cancelAction={false}
        >
            {/* ── SELECT SCREEN ── */}
            {screen === "select" && (
                <WorkflowPickerContent
                    workflows={pickerWorkflows}
                    selected={wf}
                    onSelect={(next) => {
                        if (next) setSelected(next);
                    }}
                    search={listSearch}
                    onSearchChange={setListSearch}
                    workflowType="all"
                    loading={pickerLoading}
                    previewLoading={pickerLoading}
                    previewMode="auto"
                    showTypeIcon
                    allowClearPreview={false}
                />
            )}

            {/* ── DETAILS SCREEN ── */}
            {screen === "details" && (
                <div className="flex min-h-0 flex-1 flex-col">
                    <SelectedWorkflowSummary workflow={wf} />

                    <div className="space-y-6">
                        <div>
                            <FieldLabel as="p">Use in</FieldLabel>
                            <ModalSegmentedToggle
                                value={location}
                                onChange={(value) => {
                                    setInProject(value === "project");
                                    setSelectedProjectId(null);
                                    setSelectedDocuments([]);
                                }}
                                options={locationOptions}
                            />
                        </div>

                        {inProject && (
                            <div>
                                <FieldLabel htmlFor="workflow-project">Project</FieldLabel>
                                <ModalSelect
                                    id="workflow-project"
                                    value={selectedProjectId ?? ""}
                                    options={projectOptions}
                                    onChange={(value) => {
                                        setSelectedProjectId(value || null);
                                        setSelectedDocuments([]);
                                        if (value) {
                                            void loadProjectLevel(value, null);
                                        }
                                    }}
                                    placeholder={
                                        dirLoading
                                            ? "Loading projects..."
                                            : projects.length
                                              ? "Select project..."
                                              : "No projects found"
                                    }
                                    disabled={dirLoading || projects.length === 0}
                                />
                            </div>
                        )}

                        {wf.metadata.type === "assistant" && (
                            <div>
                                <FieldLabel htmlFor="workflow-additional-message">
                                    Additional message
                                </FieldLabel>
                                <ModalTextarea
                                    id="workflow-additional-message"
                                    value={assistantPrompt}
                                    onChange={(e) => setAssistantPrompt(e.target.value)}
                                    placeholder="Add any additional instructions..."
                                    rows={4}
                                />
                            </div>
                        )}

                        {wf.metadata.type === "tabular" && (
                            <div>
                                <FieldLabel as="p">Model</FieldLabel>
                                <ModelToggle
                                    value={selectedModel}
                                    onChange={setSelectedModel}
                                    apiKeys={apiKeys}
                                    apiKeysLoading={profileLoading && !profile}
                                    openRouterModels={
                                        profile?.openRouterModels
                                    }
                                    vercelModels={profile?.vercelModels}
                                    openCodeGoModels={
                                        profile?.openCodeGoModels
                                    }
                                    onNoModelsClick={setNoModelsWarning}
                                />
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* ── DOCUMENTS SCREEN ── */}
            {screen === "documents" && (
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                    <div className="flex min-h-0 flex-1 flex-col">
                        <FileDirectory
                            documents={inProject ? projectDocs : undefined}
                            folders={inProject ? selectedProject?.folders : undefined}
                            selectedDocuments={selectedDocuments}
                            onChange={setSelectedDocuments}
                            showTabs={!inProject}
                            onExpandFolder={
                                inProject && selectedProjectId
                                    ? (folderId) => loadProjectLevel(selectedProjectId, folderId)
                                    : undefined
                            }
                            documentsHasMoreByFolder={
                                inProject && selectedProjectId
                                    ? Object.fromEntries(
                                          Object.entries(projectDocumentsHasMoreByLevel).flatMap(([key, value]) => {
                                              const prefix = `${selectedProjectId}:`;
                                              return key.startsWith(prefix) ? [[key.slice(prefix.length), value]] : [];
                                          }),
                                      )
                                    : undefined
                            }
                            loadingFolderIds={
                                inProject && selectedProjectId
                                    ? new Set(
                                          [...loadingProjectLevels]
                                              .filter(
                                                  (key) =>
                                                      key.startsWith(`${selectedProjectId}:`) &&
                                                      !key.startsWith("more:"),
                                              )
                                              .map((key) => key.slice(selectedProjectId.length + 1)),
                                      )
                                    : undefined
                            }
                            loadedFolderIds={
                                inProject && selectedProjectId
                                    ? new Set(
                                          [...loadedProjectLevels]
                                              .filter((key) => key.startsWith(`${selectedProjectId}:`))
                                              .map((key) => key.slice(selectedProjectId.length + 1)),
                                      )
                                    : undefined
                            }
                            loadingMoreFolderIds={
                                inProject && selectedProjectId
                                    ? new Set(
                                          [...loadingProjectLevels]
                                              .filter((key) => key.startsWith(`more:${selectedProjectId}:`))
                                              .map((key) => key.slice(`more:${selectedProjectId}:`.length)),
                                      )
                                    : undefined
                            }
                            onLoadMoreFolderDocuments={
                                inProject && selectedProjectId
                                    ? (folderId) => loadMoreProjectDocuments(selectedProjectId, folderId)
                                    : undefined
                            }
                            rootDocumentsHasMore={
                                inProject && selectedProjectId
                                    ? !!projectDocumentsHasMoreByLevel[`${selectedProjectId}:root`]
                                    : false
                            }
                            loadingMoreRootDocuments={
                                !!(
                                    inProject &&
                                    selectedProjectId &&
                                    loadingProjectLevels.has(`more:${selectedProjectId}:root`)
                                )
                            }
                            onLoadMoreRootDocuments={
                                inProject && selectedProjectId
                                    ? () => loadMoreProjectDocuments(selectedProjectId, null)
                                    : undefined
                            }
                        />
                    </div>
                </div>
            )}
            <NoModelsWarningPopup
                reason={noModelsWarning}
                onClose={() => setNoModelsWarning(null)}
            />
        </Modal>
    );
}
