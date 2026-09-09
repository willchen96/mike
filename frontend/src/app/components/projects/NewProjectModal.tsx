"use client";

import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import {
    type Org,
    UploadBatchError,
    addDocumentToProject,
    createProject,
    failedUploadMessage,
    grantProjectAccess,
    listOrgs,
    uploadProjectDocuments,
} from "@/app/lib/mikeApi";
import { FileDirectory } from "../shared/FileDirectory";
import type { Document, Project } from "../shared/types";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { Modal } from "../modals/Modal";
import { FieldLabel, FormTextInput } from "../ui/form-field";
import { ModalSelect } from "../modals/ModalSelect";
import { ProjectPracticeField } from "./ProjectPracticeField";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { createSecureUuid } from "@/shared/lib/secureUuid";
import {
    CreateAccessStep,
    type PendingDirectGrant,
    type PendingOrgOverride,
} from "../modals/CreateAccessStep";

const PERSONAL_WORKSPACE = "__personal__";

interface Props {
    open: boolean;
    /**
     * Dismissal. `createdWithoutHandover` is true when the project exists but
     * a later step failed, so it never reached `onCreated` — the caller has to
     * refetch or the new project stays invisible until a reload.
     */
    onClose: (createdWithoutHandover?: boolean) => void;
    onCreated: (project: Project) => void;
}

export function NewProjectModal({ open, onClose, onCreated }: Props) {
    const [step, setStep] = useState<"details" | "access" | "documents">(
        "details",
    );
    const [name, setName] = useState("");
    const [cmNumber, setCmNumber] = useState("");
    const [practice, setPractice] = useState("");
    const [sharedUsers, setSharedUsers] = useState<PendingDirectGrant[]>([]);
    const [orgOverrides, setOrgOverrides] = useState<PendingOrgOverride[]>([]);
    const [orgs, setOrgs] = useState<Org[]>([]);
    const [orgId, setOrgId] = useState<string>(PERSONAL_WORKSPACE);
    const [selectedDocuments, setSelectedDocuments] = useState<Document[]>([]);
    const [pendingFiles, setPendingFiles] = useState<File[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [orgLoadError, setOrgLoadError] = useState("");
    // A project created with only some of its files attached. The modal holds
    // it until the user has read which files are missing.
    const [pendingProject, setPendingProject] = useState<Project | null>(null);
    // Mirrors `createdProjectRef` for rendering: a ref does not re-render, and
    // the wizard's Back button has to retire the moment the project is real.
    const [projectExists, setProjectExists] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const practiceEditedRef = useRef(false);
    // The project is created before its grants are written and its documents
    // are attached. Remember it so a retry after either kind of failure
    // reuses the project the user already has instead of creating a second
    // one.
    const createdProjectRef = useRef<Project | null>(null);
    // Attachment work already done against that project. A retry after a
    // failed step must not re-upload a file or re-link a document that landed
    // on the first attempt, or the project ends up with duplicates.
    //
    // Keyed by the File itself, not by its name. A name is neither unique nor
    // stable: two files called `contract.pdf` from different folders are two
    // uploads, and the server trims the name it stores, so ` notes.docx `
    // came back as `notes.docx`, never matched the pending file, and was
    // uploaded again on every retry. The identity of the object the user
    // picked is the only thing that answers "have I already sent this one?".
    const uploadedFilesRef = useRef<Set<File>>(new Set());
    // The id each file is uploaded under, so an outcome can be traced back to
    // the File that produced it even when two of them share a name.
    const uploadClientIdsRef = useRef<Map<File, string>>(new Map());
    const linkedDocumentIdsRef = useRef<Set<string>>(new Set());
    const { user } = useAuth();
    const { profile } = useUserProfile();
    const preferredPractice =
        profile?.practiceAreas.find((area) => area.trim())?.trim() ?? "";
    const ownEmail = user?.email?.trim().toLowerCase() ?? null;
    const formId = "new-project-modal-form";

    // Load the caller's organizations so a project can be created inside a
    // firm instead of the caller's private workspace. Every row is a real
    // organization now — there is no hidden personal one to filter out.
    // The selector remains visible even when the caller has no organizations.
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setOrgLoadError("");
        listOrgs()
            .then((rows) => {
                if (!cancelled) setOrgs(rows);
            })
            .catch((err: unknown) => {
                // Silently showing only "No organization" would look like the
                // caller belongs to no firm, so say the list failed instead.
                if (!cancelled)
                    setOrgLoadError(
                        userFacingApiError(
                            err,
                            "Your organizations could not be loaded.",
                        ),
                    );
            });
        return () => {
            cancelled = true;
        };
    }, [open]);

    useEffect(() => {
        if (!open) {
            practiceEditedRef.current = false;
            return;
        }
        if (!preferredPractice || practiceEditedRef.current) return;
        setPractice(preferredPractice);
    }, [open, preferredPractice]);

    if (!open) return null;

    function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
        const files = Array.from(e.target.files ?? []);
        e.target.value = "";
        if (!files.length) return;
        // Deduplicated by identity, not by name. The old name test silently
        // dropped the second of two files called `contract.pdf` — a normal
        // thing to attach from two different folders — and the user was never
        // told one of their picks had not been taken.
        setPendingFiles((prev) => [
            ...prev,
            ...files.filter((file) => !prev.includes(file)),
        ]);
    }

    /** A stable per-file upload id, so outcomes map back to their File. */
    function uploadClientId(file: File): string {
        const existing = uploadClientIdsRef.current.get(file);
        if (existing) return existing;
        const clientId = createSecureUuid();
        uploadClientIdsRef.current.set(file, clientId);
        return clientId;
    }

    function finishCreation(project: Project) {
        onCreated(project);
        resetForm();
        onClose();
    }

    function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        if (!name.trim()) return;
        if (step === "details") {
            setStep("access");
            return;
        }
        if (step === "access") {
            setStep("documents");
        }
    }

    async function createProjectFromDocuments() {
        if (!name.trim() || loading || step !== "documents") return;
        if (pendingProject) {
            finishCreation(pendingProject);
            return;
        }
        setLoading(true);
        setError("");
        try {
            // Create, then grant each recipient through the role-aware access
            // endpoint, which also supports recipients without an account.
            const project =
                createdProjectRef.current ??
                (await createProject(
                    name.trim(),
                    cmNumber.trim() || undefined,
                    practice.trim() && practice.trim() !== "Other"
                        ? practice.trim()
                        : undefined,
                    orgId !== PERSONAL_WORKSPACE ? orgId : undefined,
                ));
            createdProjectRef.current = project;
            setProjectExists(true);

            // Grants run before the attachment work: a refusal here stops the
            // submit, and anything already uploaded or linked would otherwise
            // have to be redone on the retry — which duplicated documents.
            //
            // Sequential: these are a handful of addresses, and one refusal
            // should be reported with its own message rather than lost in a
            // race. The endpoint upserts, so a retry after a partial failure
            // is safe.
            const recipients = (
                orgId === PERSONAL_WORKSPACE ? sharedUsers : orgOverrides
            ).filter((entry) => !ownEmail || entry.email !== ownEmail);
            const grantFailures: { email: string; detail: string }[] = [];
            for (const entry of recipients) {
                try {
                    await grantProjectAccess(
                        project.id,
                        entry.email,
                        entry.role,
                    );
                } catch (err: unknown) {
                    grantFailures.push({
                        email: entry.email,
                        detail: userFacingApiError(err, "the request failed"),
                    });
                }
            }
            if (grantFailures.length > 0) {
                // The project exists, so say so — and stay open rather than
                // navigating away from the only place that knows the sharing
                // did not happen. Pressing Create again retries the grants
                // against the same project.
                // Say what happened to the documents too. The submit stops
                // here, so nothing the user attached has been sent yet — and
                // an error that mentions only the sharing reads as though the
                // files went in, which is the opposite of the truth.
                const stillPending =
                    selectedDocuments.filter(
                        (document) =>
                            !linkedDocumentIdsRef.current.has(document.id),
                    ).length +
                    pendingFiles.filter(
                        (file) => !uploadedFilesRef.current.has(file),
                    ).length;
                setError(
                    `Project created, but access was not granted to ${grantFailures
                        .map((failure) => failure.email)
                        .join(", ")}: ${grantFailures[0].detail}${
                        stillPending > 0
                            ? ` The ${stillPending} selected ${
                                  stillPending === 1 ? "file is" : "files are"
                              } still pending and will be attached when you try again.`
                            : ""
                    }`,
                );
                // Stay open on THIS dialog: createdProjectRef holds the
                // project, so pressing Create again retries only the grants.
                return;
            }

            // Only documents this modal has not already linked: a retry after
            // a later failure must not add the same document twice.
            const documentsToLink = selectedDocuments.filter(
                (document) => !linkedDocumentIdsRef.current.has(document.id),
            );
            const linkResults = await Promise.all(
                documentsToLink.map((document) =>
                    addDocumentToProject(project.id, document.id).then(
                        () => true,
                        () => false,
                    ),
                ),
            );
            documentsToLink.forEach((document, index) => {
                if (linkResults[index])
                    linkedDocumentIdsRef.current.add(document.id);
            });
            const failedLinkNames = documentsToLink
                .filter((_, index) => !linkResults[index])
                .map((document) => document.filename);

            // Same for uploads, tracked by File identity through the client id
            // each one is sent under — the outcome's `filename` is the
            // server's trimmed version and cannot be trusted to match.
            const filesToUpload = pendingFiles.filter(
                (file) => !uploadedFilesRef.current.has(file),
            );
            const uploadInputs = filesToUpload.map((file) => ({
                file,
                clientId: uploadClientId(file),
            }));
            const fileByClientId = new Map(
                uploadInputs.map((input) => [input.clientId, input.file]),
            );
            const recordCompletedUploads = (
                outcomes: { clientId: string; status: string }[],
            ) => {
                for (const outcome of outcomes) {
                    const file = fileByClientId.get(outcome.clientId);
                    if (outcome.status === "completed" && file)
                        uploadedFilesRef.current.add(file);
                }
            };
            let uploadFailure: string | null = null;
            if (uploadInputs.length > 0) {
                try {
                    const outcomes = await uploadProjectDocuments(
                        project.id,
                        uploadInputs,
                    );
                    recordCompletedUploads(outcomes);
                    if (
                        outcomes.some(
                            (outcome) => outcome.status !== "completed",
                        )
                    ) {
                        uploadFailure = failedUploadMessage(outcomes);
                    }
                } catch (uploadError) {
                    // Aborts, session-creation failures, and batch validation
                    // still throw; everything else comes back as outcomes.
                    if (uploadError instanceof UploadBatchError) {
                        recordCompletedUploads(uploadError.outcomes);
                    }
                    uploadFailure =
                        uploadError instanceof UploadBatchError
                            ? failedUploadMessage(uploadError.outcomes)
                            : userFacingApiError(
                                  uploadError,
                                  "The attached files could not be uploaded. Please try again.",
                              );
                }
            }

            // Counted across attempts, not just this one, so a retry reports
            // the project's real document count.
            const attachedCount =
                linkedDocumentIdsRef.current.size +
                uploadedFilesRef.current.size;
            const requestedCount =
                selectedDocuments.length + pendingFiles.length;
            const failureMessage = [
                uploadFailure,
                failedLinkNames.length > 0
                    ? `${failedLinkNames.join(", ")} could not be added to the project.`
                    : null,
            ]
                .filter(Boolean)
                .join(" ");

            // POST /projects returns a bare row with no role fields, and
            // the list's fail-closed roleFrom() reads "no role fields" as
            // viewer — so the creator had no row menu, no Edit details and no
            // Delete on the project they just made until a refetch. This
            // row's standing is not unknown: the caller IS the creator, and a
            // creator derives Owner by definition. The same stamp the optimistic
            // chat row gets in ChatHistoryContext, for the same reason.
            const stamped = {
                ...project,
                is_owner: true,
                access_role: "owner" as const,
                access_scope:
                    orgId !== PERSONAL_WORKSPACE
                        ? ("organization" as const)
                        : recipients.length > 0
                          ? ("shared" as const)
                          : ("private" as const),
                organization_name:
                    orgs.find((org) => org.id === orgId)?.name ?? null,
                ...(orgId === PERSONAL_WORKSPACE && recipients.length > 0
                    ? { direct_grant_count: recipients.length }
                    : {}),
            };

            if (failureMessage) {
                setError(failureMessage);
                // Nothing the user attached made it in: stay put so the primary
                // action retries the attachments against the same project,
                // instead of closing on a project with no documents.
                if (attachedCount === 0 && requestedCount > 0) return;
                // Partial success: the project is real, so let the user read
                // which files are missing before the modal hands it over.
                setPendingProject({
                    ...stamped,
                    document_count: attachedCount,
                });
                return;
            }

            finishCreation({ ...stamped, document_count: attachedCount });
        } catch (err: unknown) {
            setError(userFacingApiError(err, "Failed to create project"));
        } finally {
            setLoading(false);
        }
    }

    function resetForm() {
        createdProjectRef.current = null;
        setProjectExists(false);
        uploadedFilesRef.current = new Set();
        uploadClientIdsRef.current = new Map();
        linkedDocumentIdsRef.current = new Set();
        setPendingProject(null);
        setStep("details");
        setName("");
        setCmNumber("");
        setPractice("");
        practiceEditedRef.current = false;
        setSharedUsers([]);
        setOrgOverrides([]);
        setSelectedDocuments([]);
        setPendingFiles([]);
        setOrgId(PERSONAL_WORKSPACE);
        setError("");
    }

    function handleClose() {
        // Escape and the backdrop reach this too: dismissing a create that is
        // still in flight would leave the outcome unreportable.
        if (loading) return;
        // The project exists but never reached onCreated, so the caller's list
        // does not have it. Say so on the way out instead of leaving the row
        // invisible until a reload.
        const createdWithoutHandover = createdProjectRef.current !== null;
        resetForm();
        onClose(createdWithoutHandover);
    }

    return (
        <Modal
            open={open}
            onClose={handleClose}
            breadcrumbs={[
                "Projects",
                "New project",
                step === "details"
                    ? "Details"
                    : step === "access"
                      ? orgId === PERSONAL_WORKSPACE
                          ? "Access"
                          : "Organisational Access"
                      : "Add Documents",
            ]}
            secondaryAction={
                step === "documents"
                    ? {
                          label: `Upload${pendingFiles.length > 0 ? ` (${pendingFiles.length})` : ""}`,
                          icon: <Upload className="h-3.5 w-3.5" />,
                          onClick: () => fileInputRef.current?.click(),
                          disabled: loading,
                      }
                    : step === "access"
                      ? {
                            label: "Back",
                            type: "button",
                            onClick: () => setStep("details"),
                            disabled: loading,
                        }
                      : undefined
            }
            cancelAction={
                step === "documents"
                    ? {
                          label: "Back",
                          onClick: () => setStep("access"),
                          // Once the project EXISTS, going back is a lie: the
                          // retry reuses `createdProjectRef`, so a switch from
                          // Personal to an organization on the second attempt
                          // left the project where it was first created and
                          // applied the new organization's overrides to it.
                          // The earlier steps no longer describe anything that
                          // can still be changed here.
                          disabled: loading || projectExists,
                          title: projectExists
                              ? "The project has been created — its details and access can be changed from the project itself."
                              : undefined,
                      }
                    : step === "access"
                      ? {
                            label: "Skip",
                            type: "button",
                            onClick: () => {
                                setSharedUsers([]);
                                setOrgOverrides([]);
                                setStep("documents");
                            },
                            disabled: loading,
                        }
                      : undefined
            }
            primaryAction={
                step === "details"
                    ? {
                          label: "Next",
                          type: "button",
                          onClick: () => setStep("access"),
                          disabled: !name.trim() || loading,
                      }
                    : step === "access"
                      ? {
                            label: "Next",
                            type: "button",
                            onClick: () => setStep("documents"),
                            disabled: loading,
                        }
                      : {
                            label: loading
                                ? "Creating…"
                                : pendingProject
                                  ? "Continue"
                                  : "Create project",
                            type: "button",
                            onClick: () => void createProjectFromDocuments(),
                            disabled: !name.trim() || loading,
                        }
            }
        >
            <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileChange}
            />
            <form
                id={formId}
                onSubmit={handleSubmit}
                className="flex flex-col flex-1 min-h-0"
            >
                {step === "details" ? (
                    <div className="space-y-6">
                        <div>
                            <FieldLabel htmlFor="new-project-name">
                                Project name
                            </FieldLabel>
                            <FormTextInput
                                id="new-project-name"
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="Add project name"
                                variant="minimal"
                                autoFocus
                            />
                        </div>

                        <div>
                            <FieldLabel htmlFor="new-project-cm-number">
                                CM number
                            </FieldLabel>
                            <FormTextInput
                                id="new-project-cm-number"
                                type="text"
                                value={cmNumber}
                                onChange={(e) => setCmNumber(e.target.value)}
                                placeholder="Add a CM number..."
                                variant="minimal"
                                className="text-xl text-gray-600"
                            />
                        </div>

                        <div>
                            <FieldLabel htmlFor="new-project-practice">
                                Practice
                            </FieldLabel>
                            <ProjectPracticeField
                                id="new-project-practice"
                                value={practice}
                                onChange={(value) => {
                                    practiceEditedRef.current = true;
                                    setPractice(value);
                                }}
                            />
                        </div>

                        <div>
                            <FieldLabel htmlFor="new-project-org">
                                Share across Organisation
                            </FieldLabel>
                            <ModalSelect
                                id="new-project-org"
                                value={orgId}
                                onChange={(value) => {
                                    setOrgId(value);
                                    setSharedUsers([]);
                                    setOrgOverrides([]);
                                }}
                                options={[
                                    {
                                        value: PERSONAL_WORKSPACE,
                                        label: "No organization",
                                    },
                                    ...orgs.map((org) => ({
                                        value: org.id,
                                        label: org.name,
                                    })),
                                ]}
                            />
                            {orgLoadError && (
                                <p className="mt-2 text-sm text-red-500">
                                    {orgLoadError}
                                </p>
                            )}
                        </div>
                    </div>
                ) : step === "access" ? (
                    <CreateAccessStep
                        orgId={orgId === PERSONAL_WORKSPACE ? null : orgId}
                        organizationName={
                            orgs.find((org) => org.id === orgId)?.name ?? null
                        }
                        currentUserEmail={user?.email ?? null}
                        currentUserId={user?.id ?? null}
                        directGrants={sharedUsers}
                        onDirectGrantsChange={setSharedUsers}
                        orgOverrides={orgOverrides}
                        onOrgOverridesChange={setOrgOverrides}
                        ownerLabel="Project owners"
                    />
                ) : (
                    <div className="flex min-h-0 flex-1 flex-col">
                        <FileDirectory
                            selectedDocuments={selectedDocuments}
                            onChange={setSelectedDocuments}
                            showTabs
                        />
                    </div>
                )}

                {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
            </form>
        </Modal>
    );
}
