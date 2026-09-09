"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Upload } from "lucide-react";
import type { Document, Folder, Project, Workflow } from "../shared/types";
import {
    UploadBatchError,
    failedUploadMessage,
    getProject,
    listWorkflows,
    uploadProjectDocuments,
    uploadStandaloneDocuments,
} from "@/app/lib/mikeApi";
import type { AccessAssignmentRole } from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { FileDirectory } from "../shared/FileDirectory";
import { Modal } from "../modals/Modal";
import { ModalSelect } from "../modals/ModalSelect";
import { FieldLabel, FormTextInput } from "../ui/form-field";
import { ToggleSwitch } from "@/app/components/ui/toggle-switch";
import {
    ModelToggle,
    type NoModelsReason,
    type RouterSlug,
} from "../assistant/ModelToggle";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { isModelAvailable } from "@/app/lib/modelAvailability";
import { NoModelsWarningPopup } from "../popups/NoModelsWarningPopup";
import { useAuth } from "@/app/contexts/AuthContext";
import {
    CreateAccessStep,
    type PendingDirectGrant,
} from "../modals/CreateAccessStep";

const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
    if (isDev) console.log(...args);
};
const TABULAR_DIRECTORY_TABS = ["files", "projects"] as const;

interface Props {
    open: boolean;
    onClose: () => void;
    /**
     * Creates the review. Resolving with a string means the review itself was
     * created but part of the request was not honoured — the dialog stays open
     * and shows that message, and pressing Create again retries the remainder
     * against the same review rather than making a second one.
     */
    onAdd: (
        title: string,
        projectId: string | undefined,
        documentIds: string[] | undefined,
        columnsConfig: Workflow["columns_config"] | undefined,
        documentGrouping: "document" | "folder" | undefined,
        model: string,
        accessAssignments: { email: string; role: AccessAssignmentRole }[],
    ) => Promise<string | void> | void;
    projects?: Project[];
    /** When provided, skip the project/directory picker and show only these docs */
    projectDocs?: Document[];
    projectFolders?: Folder[];
    projectId?: string;
    projectName?: string;
    projectCmNumber?: string | null;
}

export function NewTRModal({
    open,
    onClose,
    onAdd,
    projects = [],
    projectDocs: fixedProjectDocs,
    projectFolders: fixedProjectFolders,
    projectId,
    projectName,
    projectCmNumber,
}: Props) {
    const isProjectMode = projectId !== undefined;
    const [step, setStep] = useState<"details" | "access" | "documents">(
        "details",
    );
    const [title, setTitle] = useState("");
    const [underProject, setUnderProject] = useState(false);
    const [selectedProjectId, setSelectedProjectId] = useState("");
    const [directGrants, setDirectGrants] = useState<PendingDirectGrant[]>([]);
    const [selectedModel, setSelectedModel] = useState("");
    const [noModelsWarning, setNoModelsWarning] =
        useState<NoModelsReason | null>(null);
    const { profile, loading: profileLoading, apiKeysDegraded } =
        useUserProfile();
    const { user } = useAuth();
    const apiKeys = apiKeysDegraded ? undefined : profile?.apiKeys;

    // Project-scoped docs (when underProject is true and no fixedProjectDocs)
    const [projectDocs, setProjectDocs] = useState<Document[]>([]);
    const [projectFolders, setProjectFolders] = useState<Folder[]>([]);
    const [loadingDocs, setLoadingDocs] = useState(false);

    const [extraStandaloneDocs, setExtraStandaloneDocs] = useState<Document[]>(
        [],
    );
    const [selectedDocuments, setSelectedDocuments] = useState<Document[]>([]);
    const [groupBySubfolder, setGroupBySubfolder] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [creating, setCreating] = useState(false);
    // The review already exists, because a first attempt created it and then
    // failed on the grants. The page holds that row and the retry reuses it,
    // so the earlier steps no longer describe anything this dialog can still
    // change: switching Personal → a project on the second attempt left the
    // review where it was created and applied the new scope's assignments to
    // it. Back retires once this is true.
    const [reviewExists, setReviewExists] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const creatingRef = useRef(false);

    // Workflow templates
    const [workflows, setWorkflows] = useState<Workflow[]>([]);
    const [loadingWorkflows, setLoadingWorkflows] = useState(false);
    const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(
        null,
    );
    const formId = "new-tabular-review-modal-form";

    useEffect(() => {
        if (!open) return;

        setLoadingWorkflows(true);
        listWorkflows("tabular")
            .then((workflows) => {
                devLog("[workflows/ui:tabular-review-modal] loaded", {
                    workflowCount: workflows.length,
                    systemCount: workflows.filter(
                        (workflow) => workflow.is_system,
                    ).length,
                    sample: workflows.slice(0, 5).map((workflow) => ({
                        id: workflow.id,
                        title: workflow.metadata.title,
                        type: workflow.metadata.type,
                        user_id: workflow.user_id,
                        is_system: workflow.is_system,
                        is_owner: workflow.is_owner,
                    })),
                });
                setWorkflows(workflows);
            })
            .catch((error) => {
                devLog("[workflows/ui:tabular-review-modal] failed", error);
                setWorkflows([]);
            })
            .finally(() => setLoadingWorkflows(false));

        if (isProjectMode) {
            const readyProjectDocuments = fixedProjectDocs ?? [];
            setProjectDocs(readyProjectDocuments);
            setSelectedDocuments(readyProjectDocuments);
        }
    }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (!open || !profile?.tabularModel) return;
        const defaultModel = profile.tabularModel;
        const router = (["openrouter", "vercel", "opencode-go"] as const).find(
            (slug) => defaultModel.startsWith(`${slug}/`),
        );
        const selectedByRouter: Record<RouterSlug, string[]> = {
            openrouter: profile.openRouterModels,
            vercel: profile.vercelModels,
            "opencode-go": profile.openCodeGoModels,
        };
        const routerSelectionValid =
            !router ||
            selectedByRouter[router].includes(
                defaultModel.slice(router.length + 1),
            );
        const providerAvailable =
            !apiKeys || isModelAvailable(defaultModel, apiKeys);
        if (routerSelectionValid && providerAvailable) {
            setSelectedModel((current) => current || defaultModel);
        }
    }, [apiKeys, open, profile]);

    if (!open) return null;

    // Dismissal — Escape, the backdrop and the close button all arrive here.
    // A create in flight owns the dialog: leaving now would strand the only
    // account of what happened to it. The success path calls `handleClose`
    // directly, which is why the guard lives here and not there.
    function handleDismiss() {
        if (creatingRef.current) return;
        handleClose();
    }

    function handleClose() {
        setStep("details");
        setReviewExists(false);
        setTitle("");
        setUnderProject(false);
        setSelectedProjectId("");
        setDirectGrants([]);
        setSelectedModel("");
        setNoModelsWarning(null);
        setProjectDocs([]);
        setProjectFolders([]);
        setExtraStandaloneDocs([]);
        setSelectedDocuments([]);
        setGroupBySubfolder(false);
        setSelectedWorkflowId(null);
        setUploadError(null);
        onClose();
    }

    function submitterValue(e: React.FormEvent<HTMLFormElement>) {
        return (
            (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null
        )?.value;
    }

    async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        if (!title.trim()) return;
        if (!selectedModel) return;
        if (underProject && !selectedProjectId) return;
        if (step === "details") {
            setStep("access");
            return;
        }
        if (step === "access" || submitterValue(e) !== "create-review") {
            setStep("documents");
            return;
        }
        if (creatingRef.current) return;
        creatingRef.current = true;
        setCreating(true);
        setUploadError(null);
        const selectedWorkflow = workflows.find(
            (w) => w.id === selectedWorkflowId,
        );
        const effectiveProjectId = isProjectMode
            ? projectId
            : underProject
              ? selectedProjectId
              : undefined;
        const assignments = effectiveProjectId ? [] : directGrants;
        try {
            const partialFailure = await onAdd(
                title.trim(),
                effectiveProjectId,
                selectedDocuments.length > 0
                    ? selectedDocuments.map((document) => document.id)
                    : undefined,
                selectedWorkflow?.columns_config ?? undefined,
                groupBySubfolder ? "folder" : "document",
                selectedModel,
                assignments,
            );
            if (partialFailure) {
                // The review exists. Report what did not happen and stay open;
                // closing here would hide the only account of it, and the
                // generic create failure would be a lie.
                setUploadError(partialFailure);
                setReviewExists(true);
                return;
            }
            handleClose();
        } catch (error) {
            setUploadError(
                userFacingApiError(error, "Could not create the review."),
            );
        } finally {
            creatingRef.current = false;
            setCreating(false);
        }
    }

    async function handleSelectProject(projectId: string) {
        setSelectedProjectId(projectId);
        setProjectDocs([]);
        setProjectFolders([]);
        setSelectedDocuments([]);
        setLoadingDocs(true);
        try {
            const proj = await getProject(projectId);
            setDirectGrants([]);
            const docs = (proj.documents ?? []).filter(
                (d) => d.status === "ready",
            );
            setProjectDocs(docs);
            setProjectFolders(proj.folders ?? []);
            setSelectedDocuments(docs);
        } finally {
            setLoadingDocs(false);
        }
    }

    async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
        const files = Array.from(e.target.files ?? []);
        if (!files.length) return;
        setUploading(true);
        setUploadError(null);
        try {
            const uploadProjectId = isProjectMode
                ? projectId
                : underProject
                  ? selectedProjectId
                  : undefined;
            const outcomes = uploadProjectId
                ? await uploadProjectDocuments(
                      uploadProjectId,
                      files.map((file) => ({ file })),
                  )
                : await uploadStandaloneDocuments(
                      files.map((file) => ({ file })),
                  );
            const uploaded = outcomes.flatMap((outcome) =>
                outcome.status === "completed" && outcome.result
                    ? [outcome.result]
                    : [],
            );
            if (uploadProjectId) {
                setProjectDocs((prev) => [...uploaded, ...prev]);
            } else {
                setExtraStandaloneDocs((prev) => [...uploaded, ...prev]);
            }
            setSelectedDocuments((prev) => [
                ...prev,
                ...uploaded.filter(
                    (document) =>
                        !prev.some((selected) => selected.id === document.id),
                ),
            ]);
            // Files that never became documents cannot be attached to the
            // review, so say which ones instead of leaving the picker looking
            // as though the upload simply produced nothing.
            if (uploaded.length < outcomes.length) {
                setUploadError(failedUploadMessage(outcomes));
            }
        } catch (err) {
            console.error("Upload failed:", err);
            setUploadError(
                err instanceof UploadBatchError
                    ? failedUploadMessage(err.outcomes)
                    : userFacingApiError(
                          err,
                          "The selected files could not be uploaded. Please try again.",
                      ),
            );
        } finally {
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    }

    const workflowOptions = [
        {
            value: "",
            label: loadingWorkflows
                ? "Loading templates..."
                : "No template - start from scratch",
        },
        ...workflows.map((workflow) => ({
            value: workflow.id,
            label: workflow.metadata.title,
        })),
    ];
    const projectOptions = projects.length
        ? projects.map((project) => ({
              value: project.id,
              label:
                  project.name +
                  (project.cm_number ? ` (#${project.cm_number})` : ""),
          }))
        : [{ value: "", label: "No projects found" }];

    // What to show in the directory depends on mode and toggle state
    const directoryDocuments = isProjectMode
        ? projectDocs
        : underProject
          ? projectDocs
          : extraStandaloneDocs;
    const directoryFolders = isProjectMode
        ? (fixedProjectFolders ?? [])
        : underProject
          ? projectFolders
          : [];
    const directoryLoading = isProjectMode
        ? false
        : underProject
          ? loadingDocs
          : false;
    const showDirectory = isProjectMode || !underProject || !!selectedProjectId;
    const breadcrumbs =
        isProjectMode && projectName
            ? [
                  "Projects",
                  `${projectName}${projectCmNumber ? ` (#${projectCmNumber})` : ""}`,
                  "New Tabular Review",
              ]
            : ["Tabular Reviews", "New Tabular Review"];

    return (
        <Modal
            open={open}
            onClose={handleDismiss}
            breadcrumbs={[
                ...breadcrumbs,
                step === "details"
                    ? "Details"
                    : step === "access"
                      ? "Access"
                      : "Add Documents",
            ]}
            secondaryAction={
                step === "documents"
                    ? {
                          label: uploading ? "Uploading..." : "Upload",
                          icon: uploading ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                              <Upload className="h-3.5 w-3.5" />
                          ),
                          onClick: () => fileInputRef.current?.click(),
                          disabled: uploading,
                      }
                    : step === "access"
                      ? {
                            label: "Back",
                            type: "button",
                            onClick: () => setStep("details"),
                            disabled: uploading,
                        }
                      : undefined
            }
            cancelAction={
                step === "documents"
                    ? {
                          label: "Back",
                          onClick: () => setStep("access"),
                          disabled: uploading || reviewExists,
                          title: reviewExists
                              ? "The review has been created — its details and access can be changed from the review itself."
                              : undefined,
                      }
                    : step === "access"
                      ? {
                            label: "Skip",
                            type: "button",
                            onClick: () => {
                                setDirectGrants([]);
                                setStep("documents");
                            },
                            disabled: uploading,
                        }
                    : undefined
            }
            primaryAction={
                step === "details"
                    ? {
                          label: "Next",
                          type: "button",
                          onClick: () => setStep("access"),
                          disabled:
                              !title.trim() ||
                              (underProject && !selectedProjectId) ||
                              !selectedModel,
                      }
                    : step === "access"
                      ? {
                            label: "Next",
                            type: "button",
                            onClick: (event) => {
                                // The same footer node becomes the submit button
                                // on the next render. Cancel this click's native
                                // default action before changing its type.
                                event.preventDefault();
                                setStep("documents");
                            },
                            disabled: uploading,
                        }
                      : {
                          label: creating ? "Creating..." : "Create",
                          type: "submit",
                          form: formId,
                          name: "modalAction",
                          value: "create-review",
                          disabled:
                              !title.trim() ||
                              (underProject && !selectedProjectId) ||
                              !selectedModel ||
                              creating,
                      }
            }
        >
            <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx,.doc,.xlsx,.xlsm,.xls,.pptx,.ppt"
                multiple
                className="hidden"
                onChange={handleUpload}
            />
            <form
                id={formId}
                onSubmit={handleSubmit}
                className="flex flex-col min-h-0 flex-1"
            >
                {step === "details" ? (
                    <div className="space-y-6">
                        <div>
                            <FieldLabel htmlFor="new-tr-title">
                                Review name
                            </FieldLabel>
                            <FormTextInput
                                id="new-tr-title"
                                type="text"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                placeholder="Review name"
                                variant="minimal"
                                className="placeholder:text-gray-400"
                                autoFocus
                            />
                        </div>

                        <div>
                            <FieldLabel as="p">Model</FieldLabel>
                            <ModelToggle
                                value={selectedModel}
                                onChange={setSelectedModel}
                                apiKeys={apiKeys}
                                apiKeysLoading={profileLoading && !profile}
                                openRouterModels={profile?.openRouterModels}
                                vercelModels={profile?.vercelModels}
                                openCodeGoModels={profile?.openCodeGoModels}
                                onNoModelsClick={setNoModelsWarning}
                                modalInput
                            />
                        </div>

                        {/* Workflow template */}
                        <div>
                            <FieldLabel as="p">Workflow template</FieldLabel>
                            <ModalSelect
                                id="new-tr-workflow-template"
                                value={selectedWorkflowId ?? ""}
                                options={workflowOptions}
                                onChange={(value) =>
                                    setSelectedWorkflowId(value || null)
                                }
                                disabled={loadingWorkflows}
                            />
                        </div>

                        {/* Create under a project toggle */}
                        {!isProjectMode && (
                            <div className="space-y-3">
                                <FieldLabel as="p">Project</FieldLabel>
                                <ToggleSwitch
                                    checked={underProject}
                                    onCheckedChange={(next) => {
                                        setUnderProject(next);
                                        if (!next) {
                                            setSelectedProjectId("");
                                            setProjectDocs([]);
                                            setProjectFolders([]);
                                            setSelectedDocuments([]);
                                        }
                                    }}
                                >
                                    Create under a project
                                </ToggleSwitch>

                                {underProject && (
                                    <ModalSelect
                                        id="new-tr-project"
                                        value={selectedProjectId}
                                        options={projectOptions}
                                        onChange={(value) => {
                                            if (value) {
                                                void handleSelectProject(value);
                                            }
                                        }}
                                        placeholder="Select project..."
                                        disabled={projects.length === 0}
                                    />
                                )}
                            </div>
                        )}

                        <div>
                            <FieldLabel as="p">Document grouping</FieldLabel>
                            <ToggleSwitch
                                checked={groupBySubfolder}
                                onCheckedChange={setGroupBySubfolder}
                            >
                                Treat documents in the same folder as one review
                                row
                            </ToggleSwitch>
                        </div>
                    </div>
                ) : step === "access" ? (
                    <CreateAccessStep
                        orgId={null}
                        currentUserEmail={user?.email ?? null}
                        currentUserId={user?.id ?? null}
                        directGrants={directGrants}
                        onDirectGrantsChange={setDirectGrants}
                        inheritedFromProject={isProjectMode || underProject}
                        ownerLabel="Review owners"
                    />
                ) : (
                    <div className="flex min-h-0 flex-1 flex-col">
                        {showDirectory && (
                            <FileDirectory
                                documents={directoryDocuments}
                                folders={directoryFolders}
                                loading={directoryLoading}
                                selectedDocuments={selectedDocuments}
                                onChange={setSelectedDocuments}
                                showTabs={!isProjectMode && !underProject}
                                tabs={TABULAR_DIRECTORY_TABS}
                            />
                        )}
                        {uploadError && (
                            <p
                                role="alert"
                                className="mt-3 text-sm text-red-500"
                            >
                                {uploadError}
                            </p>
                        )}
                    </div>
                )}
            </form>
            <NoModelsWarningPopup
                reason={noModelsWarning}
                onClose={() => setNoModelsWarning(null)}
            />
        </Modal>
    );
}
