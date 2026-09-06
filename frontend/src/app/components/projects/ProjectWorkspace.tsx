"use client";

import {
    createContext,
    type ReactNode,
    use,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { useRouter, useSelectedLayoutSegments } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import {
    createTabularReview,
    deleteProject,
    getProject,
    getProjectAccess,
    getProjectPeople,
    grantProjectAccess,
    listProjectChats,
    revokeProjectAccess,
    setProjectMemoryEnabled,
    updateProject,
    type ProjectGrant,
} from "@/app/lib/mikeApi";
import type {
    Chat,
    ColumnConfig,
    Folder as ProjectFolder,
    Project,
} from "@/app/components/shared/types";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";
import { NewTRModal } from "@/app/components/tabular/NewTRModal";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import {
    PermissionDeniedPopup,
    type AccessContact,
} from "@/app/components/popups/PermissionDeniedPopup";
import { AccessModal } from "@/app/components/modals/AccessModal";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import {
    type Capability,
    type ProjectRole,
    can,
    roleFromLoaded,
} from "@/app/lib/permissions";
import { ProjectDetailsModal } from "./ProjectDetailsModal";
import { ProjectMemoryModal } from "./ProjectMemoryModal";
import {
    ProjectPageHeader,
    type ProjectWorkspaceSection,
} from "./ProjectPageParts";

/**
 * A denied action: the sentence for the popup plus which role the action is
 * reserved for. A plain string means the strictest tier, admin.
 *
 * The third shape is for rules that are not rungs on the ladder at all — the
 * server asks "did you create this row?", which no role can answer for you.
 * Those carry their own sentence, and deliberately offer nobody to ask,
 * because there is nobody who could grant it.
 */
export type OwnerGate =
    | string
    | { action: string; requiredRole: "owner" | "editor" }
    | { title?: string; message: string };

/**
 * Turn a gate into `PermissionDeniedPopup` props, so every surface renders
 * the same gate the same way instead of re-deriving `requiredRole` inline.
 */
export function permissionDeniedProps(
    gate: OwnerGate | null,
    contacts?: AccessContact[] | null,
) {
    if (gate && typeof gate === "object" && "message" in gate) {
        return {
            open: true,
            title: gate.title,
            message: gate.message,
            contacts: null,
        };
    }
    return {
        open: !!gate,
        action: typeof gate === "string" ? gate : gate?.action,
        requiredRole:
            typeof gate === "string" ? ("owner" as const) : gate?.requiredRole,
        contacts,
    };
}

type ProjectWorkspaceValue = {
    projectId: string;
    project: Project | null;
    setProject: React.Dispatch<React.SetStateAction<Project | null>>;
    folders: ProjectFolder[];
    setFolders: React.Dispatch<React.SetStateAction<ProjectFolder[]>>;
    projectLoading: boolean;
    activeSection: ProjectWorkspaceSection;
    search: string;
    setSearch: (search: string) => void;
    projectChats: Chat[] | null;
    setProjectChats: React.Dispatch<React.SetStateAction<Chat[] | null>>;
    projectChatsLoading: boolean;
    ensureProjectChats: () => Promise<Chat[]>;
    prefetchProjectSections: () => void;
    creatingChat: boolean;
    creatingReview: boolean;
    createChat: () => Promise<void>;
    openNewReview: () => void;
    setDocumentUploadHeaderAction: (
        kind: "savedFiles" | "uploadFiles" | "uploadFolder",
        action: (() => void) | null,
    ) => void;
    setDocumentFolderBreadcrumbs: React.Dispatch<
        React.SetStateAction<Array<{ label: string; onClick: () => void }>>
    >;
    setOwnerOnlyAction: React.Dispatch<React.SetStateAction<OwnerGate | null>>;
    /**
     * The caller's role on this project, or `null` while the project row is
     * still in flight — an explicit "not known yet", never a guess. Surfaces
     * that render an affordance should disable it while this is null rather
     * than assume either answer.
     */
    accessRole: ProjectRole | null;
    /**
     * Capability check against the caller's role — mirror of the server.
     * Answers `false` while the role is unknown, so a gated affordance is
     * closed until the server has told us it may open.
     */
    canDo: (capability: Capability) => boolean;
};

const ProjectWorkspaceContext =
    createContext<ProjectWorkspaceValue | null>(null);

export function useProjectWorkspace() {
    const value = useContext(ProjectWorkspaceContext);
    if (!value) {
        throw new Error(
            "useProjectWorkspace must be used inside ProjectWorkspaceProvider",
        );
    }
    return value;
}

export function useProjectWorkspaceOptional() {
    return useContext(ProjectWorkspaceContext);
}

function activeSectionFromSegments(
    segments: string[],
): ProjectWorkspaceSection {
    if (segments[0] === "assistant") return "assistant";
    if (segments[0] === "tabular-reviews") return "reviews";
    return "documents";
}

function shouldShowWorkspaceShell(segments: string[]) {
    if (segments.length === 0) return true;
    if (segments.length === 2 && segments[0] === "folders") return true;
    if (segments.length !== 1) return false;
    return segments[0] === "assistant" || segments[0] === "tabular-reviews";
}

export function ProjectWorkspaceProvider({
    projectId,
    children,
}: {
    projectId: string;
    children: ReactNode;
}) {
    const [project, setProject] = useState<Project | null>(null);
    const [folders, setFolders] = useState<ProjectFolder[]>([]);
    const [projectLoading, setProjectLoading] = useState(true);
    const [searchBySection, setSearchBySection] = useState<
        Record<ProjectWorkspaceSection, string>
    >({ documents: "", assistant: "", reviews: "" });
    const [projectChats, setProjectChats] = useState<Chat[] | null>(null);
    const [projectChatsLoading, setProjectChatsLoading] = useState(false);
    const [accessModalOpen, setAccessModalOpen] = useState(false);
    // Direct access grants, loaded only when the share dialog is opened: every
    // project page would otherwise pay for a roster nobody looked at.
    const [grants, setGrants] = useState<ProjectGrant[] | null>(null);
    const [projectDetailsOpen, setProjectDetailsOpen] = useState(false);
    const [projectMemoryOpen, setProjectMemoryOpen] = useState(false);
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<OwnerGate | null>(
        null,
    );
    const [deleteProjectConfirmOpen, setDeleteProjectConfirmOpen] =
        useState(false);
    const [deleteProjectStatus, setDeleteProjectStatus] = useState<
        "idle" | "deleting" | "deleted"
    >("idle");
    const [newTRModalOpen, setNewTRModalOpen] = useState(false);
    const [creatingChat, setCreatingChat] = useState(false);
    const [creatingReview, setCreatingReview] = useState(false);
    const [documentUploadActions, setDocumentUploadActions] = useState<{
        savedFiles: (() => void) | null;
        uploadFiles: (() => void) | null;
        uploadFolder: (() => void) | null;
    }>({ savedFiles: null, uploadFiles: null, uploadFolder: null });
    const [documentFolderBreadcrumbs, setDocumentFolderBreadcrumbs] = useState<
        Array<{ label: string; onClick: () => void }>
    >([]);
    const segments = useSelectedLayoutSegments();
    const activeSection = activeSectionFromSegments(segments);
    const showShell = shouldShowWorkspaceShell(segments);
    const router = useRouter();
    const { user } = useAuth();
    const { profile } = useUserProfile();
    const { saveChat } = useChatHistoryContext();
    const projectChatsPromiseRef = useRef<Promise<Chat[]> | null>(null);

    useEffect(() => {
        // A new projectId is a new answer to "who am I here?". This provider
        // lives in the [id] layout, which the App Router keeps mounted across
        // dynamic-param navigation — so without this reset the PREVIOUS
        // project's row, and therefore its role, stays live for the whole
        // fetch window. An admin of project A navigating into project B they
        // can only view kept admin affordances (Delete included) until B's
        // row arrived: `roleKnown` was true, so nothing was disabled and
        // `denyUnlessLoading` never suppressed a thing. Unknown-while-loading
        // only protects anyone if loading actually starts from unknown.
        setProject(null);
        setFolders([]);
        setProjectChats(null);
        setProjectChatsLoading(false);
        setDocumentFolderBreadcrumbs([]);
        projectChatsPromiseRef.current = null;
    }, [projectId]);

    const setDocumentUploadHeaderAction = useCallback(
        (
            kind: "savedFiles" | "uploadFiles" | "uploadFolder",
            action: (() => void) | null,
        ) => {
            setDocumentUploadActions((current) => ({
                ...current,
                [kind]: action,
            }));
        },
        [],
    );

    const openProjectRoot = useCallback(() => {
        router.push(`/projects/${projectId}`);
    }, [projectId, router]);

    useEffect(() => {
        if (!showShell) {
            setProjectLoading(false);
            return;
        }
        let cancelled = false;
        setProjectLoading(true);
        getProject(projectId)
            .then((loaded) => {
                if (cancelled) return;
                setProject(loaded);
                setFolders(loaded.folders ?? []);
            })
            .catch((error) => {
                console.error("[project workspace] failed to load project", error);
                if (!cancelled) {
                    setProject(null);
                    setFolders([]);
                }
            })
            .finally(() => {
                if (!cancelled) setProjectLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [projectId, showShell]);

    const search = searchBySection[activeSection];
    const setSearch = useCallback(
        (value: string) =>
            setSearchBySection((prev) => ({
                ...prev,
                [activeSection]: value,
            })),
        [activeSection],
    );

    const ensureProjectChats = useCallback(() => {
        if (projectChats) return Promise.resolve(projectChats);
        if (projectChatsPromiseRef.current) return projectChatsPromiseRef.current;

        setProjectChatsLoading(true);
        const promise = listProjectChats(projectId)
            .then((loaded) => {
                setProjectChats(loaded);
                return loaded;
            })
            .catch((error) => {
                console.error("[project assistant] failed to load", error);
                setProjectChats([]);
                return [];
            })
            .finally(() => {
                projectChatsPromiseRef.current = null;
                setProjectChatsLoading(false);
            });
        projectChatsPromiseRef.current = promise;
        return promise;
    }, [projectChats, projectId]);

    // The memory dialog owns its own reads and writes; this keeps the loaded
    // project row (and the details dialog's toggle) agreeing with them.
    const syncProjectMemoryEnabled = useCallback((enabled: boolean) => {
        setProject((current) =>
            current ? { ...current, memory_enabled: enabled } : current,
        );
    }, []);

    const prefetchProjectSections = useCallback(() => {
        void ensureProjectChats();
    }, [ensureProjectChats]);

    // Role derived from the loaded project. Until it arrives the role is
    // *unknown* — not "admin", which is what this used to assume so the shell
    // would not flash disabled controls. Assuming the top of the ladder while
    // waiting means every gate stands open during the window in which we know
    // least, and a viewer who clicks Delete in that window gets a confirmation
    // dialog for an action the server will refuse. Unknown is its own answer:
    // `canDo` says no, affordances stay disabled, and no refusal popup accuses
    // the user of lacking a role we have not looked up yet.
    const accessRole: ProjectRole | null = roleFromLoaded(project);
    const roleKnown = accessRole !== null;
    const canDo = useCallback(
        (capability: Capability) => can(accessRole, capability),
        [accessRole],
    );
    /**
     * Refuse an action, explaining only when we can. While the role is
     * unknown the caller is not told "only an admin can do this" — we do not
     * know that they are not one — the click simply does nothing, because the
     * control that produced it is disabled anyway.
     */
    const denyUnlessLoading = useCallback(
        (gate: OwnerGate) => {
            if (roleKnown) setOwnerOnlyAction(gate);
        },
        [roleKnown],
    );

    const refreshGrants = useCallback(async () => {
        try {
            const access = await getProjectAccess(projectId);
            setGrants(access.grants);
        } catch (error) {
            console.error("[project workspace] failed to load access", error);
            setGrants([]);
        }
    }, [projectId]);

    useEffect(() => {
        setGrants(null);
    }, [projectId]);

    useEffect(() => {
        // The grant list is the management surface and the server now only
        // serves it at access.manage — the Access modal's role pickers, its
        // one consumer, render only at that tier anyway. Below admin the
        // modal shows the /people roster, so there is nothing to fetch and
        // no point collecting a 403 on every open.
        if (accessModalOpen && grants === null && canDo("access.manage"))
            void refreshGrants();
    }, [accessModalOpen, grants, refreshGrants, canDo]);

    const createChat = useCallback(async () => {
        // Creating a chat in a project is member-tier server-side; without
        // this gate an org viewer's click fails with a silent 404.
        if (!canDo("content.edit")) {
            denyUnlessLoading({
                action: "start a chat in this project",
                requiredRole: "editor",
            });
            return;
        }
        setCreatingChat(true);
        try {
            const id = await saveChat(projectId);
            if (id) {
                const now = new Date().toISOString();
                setProjectChats((prev) =>
                    prev
                        ? [
                              {
                                  id,
                                  project_id: projectId,
                                  user_id: user?.id ?? "",
                                  creator_display_name:
                                      profile?.displayName ?? null,
                                  title: null,
                                  created_at: now,
                                  // The row the server would have served for
                                  // a chat we just created: its creator is
                                  // its admin. Without these the client's
                                  // `roleFrom` falls back to viewer — fail
                                  // closed, correct as a default and wrong
                                  // here — and the author could not rename or
                                  // delete their own new chat until reload.
                                  is_owner: true,
                                  access_role: "owner",
                              },
                              ...prev,
                          ]
                        : prev,
                );
                router.push(`/projects/${projectId}/assistant/chat/${id}`);
            }
        } finally {
            setCreatingChat(false);
        }
    }, [
        canDo,
        denyUnlessLoading,
        profile?.displayName,
        projectId,
        router,
        saveChat,
        user?.id,
    ]);

    const openNewReview = useCallback(() => {
        // Creating a review is member-tier server-side (POST /tabular-review
        // gates on content.edit) — stop viewers before the modal, not after
        // an unexplained failed submit.
        if (!canDo("content.edit")) {
            denyUnlessLoading({
                action: "create a tabular review",
                requiredRole: "editor",
            });
            return;
        }
        setNewTRModalOpen(true);
    }, [canDo, denyUnlessLoading]);

    async function handleCreateReview(
        title: string,
        _projectId: string | undefined,
        documentIds: string[] | undefined,
        columnsConfig: ColumnConfig[] | null | undefined,
        documentGrouping: "document" | "folder" | undefined,
        model: string,
        _accessAssignments: {
            email: string;
            role: import("@/app/lib/mikeApi").AccessAssignmentRole;
        }[],
    ) {
        // Project-owned reviews inherit their project's organization and
        // access exactly, so modal-level standalone assignments are ignored.
        void _accessAssignments;
        setCreatingReview(true);
        try {
            const readyDocs =
                project?.documents?.filter((d) => d.status === "ready") ?? [];
            const review = await createTabularReview({
                title: title || undefined,
                document_ids: documentIds ?? readyDocs.map((d) => d.id),
                columns_config: columnsConfig ?? [],
                document_grouping: documentGrouping,
                model,
                project_id: projectId,
            });
            router.push(`/projects/${projectId}/tabular-reviews/${review.id}`);
        } finally {
            setCreatingReview(false);
        }
    }

    async function handleProjectDetailsSave(values: {
        name: string;
        cmNumber: string;
        practice: string;
    }) {
        if (!canDo("access.manage")) {
            denyUnlessLoading({
                action: "edit project details",
                requiredRole: "owner",
            });
            return;
        }
        const name = values.name.trim();
        const cmNumber = values.cmNumber.trim();
        const practice = values.practice.trim();
        if (!name) return;
        const updated = await updateProject(projectId, {
            name,
            cm_number: cmNumber,
            practice: practice || null,
        });
        setProject((prev) =>
            prev
                ? {
                      ...prev,
                      name: updated.name,
                      cm_number: updated.cm_number,
                      practice: updated.practice,
                  }
                : updated,
        );
    }

    async function handleProjectMemoryEnabledChange(enabled: boolean) {
        if (!canDo("access.manage")) {
            denyUnlessLoading({
                action: "manage project memory",
                requiredRole: "owner",
            });
            return;
        }
        const memory = await setProjectMemoryEnabled(projectId, enabled);
        syncProjectMemoryEnabled(memory.enabled);
    }

    function requestProjectDelete() {
        if (!canDo("container.delete")) {
            denyUnlessLoading("delete this project");
            return;
        }
        setDeleteProjectStatus("idle");
        setDeleteProjectConfirmOpen(true);
    }

    async function confirmProjectDelete() {
        if (deleteProjectStatus === "deleting") return;
        setDeleteProjectStatus("deleting");
        try {
            await deleteProject(projectId);
            setDeleteProjectStatus("deleted");
            window.setTimeout(() => router.push("/projects"), 500);
        } catch (error) {
            console.error("deleteProject failed", error);
            setDeleteProjectStatus("idle");
        }
    }

    const value = useMemo<ProjectWorkspaceValue>(
        () => ({
            projectId,
            project,
            setProject,
            folders,
            setFolders,
            projectLoading,
            activeSection,
            search,
            setSearch,
            projectChats,
            setProjectChats,
            projectChatsLoading,
            ensureProjectChats,
            prefetchProjectSections,
            creatingChat,
            creatingReview,
            createChat,
            openNewReview,
            setDocumentUploadHeaderAction,
            setDocumentFolderBreadcrumbs,
            setOwnerOnlyAction,
            accessRole,
            canDo,
        }),
        [
            projectId,
            project,
            folders,
            projectLoading,
            activeSection,
            search,
            setSearch,
            projectChats,
            projectChatsLoading,
            ensureProjectChats,
            prefetchProjectSections,
            creatingChat,
            creatingReview,
            createChat,
            openNewReview,
            setDocumentUploadHeaderAction,
            accessRole,
            canDo,
        ],
    );

    if (!showShell) {
        return (
            <ProjectWorkspaceContext.Provider value={value}>
                {children}
            </ProjectWorkspaceContext.Provider>
        );
    }

    return (
        <ProjectWorkspaceContext.Provider value={value}>
            <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
                <ProjectPageHeader
                    project={project}
                    search={search}
                    activeSection={activeSection}
                    creatingChat={creatingChat}
                    creatingReview={creatingReview}
                    canManageProject={canDo("access.manage")}
                    roleKnown={roleKnown}
                    onBackToProjects={() => router.push("/projects")}
                    onProjectRoot={openProjectRoot}
                    onOpenDetails={() => setProjectDetailsOpen(true)}
                    onOpenMemory={() => setProjectMemoryOpen(true)}
                    onDeleteProject={requestProjectDelete}
                    onSearchChange={setSearch}
                    onOpenAccess={() => setAccessModalOpen(true)}
                    onNewChat={() => void createChat()}
                    onNewReview={openNewReview}
                    onSavedFiles={documentUploadActions.savedFiles}
                    onUploadFiles={documentUploadActions.uploadFiles}
                    onUploadFolder={documentUploadActions.uploadFolder}
                    documentFolderBreadcrumbs={documentFolderBreadcrumbs}
                />

                {children}

                <NewTRModal
                    open={newTRModalOpen}
                    onClose={() => setNewTRModalOpen(false)}
                    onAdd={handleCreateReview}
                    projectId={projectId}
                    projectDocs={
                        project?.documents?.filter(
                            (d) => d.status === "ready",
                        ) ?? []
                    }
                    projectFolders={folders}
                    projectName={project?.name}
                    projectCmNumber={project?.cm_number}
                />

                <PermissionDeniedPopup
                    {...permissionDeniedProps(
                        ownerOnlyAction,
                        project?.admin_contacts,
                    )}
                    onClose={() => setOwnerOnlyAction(null)}
                />

                <ProjectMemoryModal
                    key={projectId}
                    open={projectMemoryOpen}
                    onClose={() => setProjectMemoryOpen(false)}
                    projectId={projectId}
                    projectName={project?.name ?? null}
                    projectLoading={projectLoading}
                    canEdit={canDo("content.edit")}
                    canManage={canDo("access.manage")}
                    onMemoryEnabledChange={syncProjectMemoryEnabled}
                />

                <ProjectDetailsModal
                    open={projectDetailsOpen}
                    project={project}
                    canEdit={canDo("access.manage")}
                    onClose={() => setProjectDetailsOpen(false)}
                    onSave={handleProjectDetailsSave}
                    onMemoryEnabledChange={
                        handleProjectMemoryEnabledChange
                    }
                    onShareProject={() => {
                        setProjectDetailsOpen(false);
                        setAccessModalOpen(true);
                    }}
                />

                <ConfirmPopup
                    open={deleteProjectConfirmOpen}
                    title="Delete project?"
                    message="This will permanently delete the project and its related documents, chats, and tabular reviews."
                    confirmLabel="Delete"
                    confirmVariant="danger"
                    confirmStatus={
                        deleteProjectStatus === "deleting"
                            ? "loading"
                            : deleteProjectStatus === "deleted"
                              ? "complete"
                              : "idle"
                    }
                    cancelLabel="Cancel"
                    onCancel={() => {
                        if (deleteProjectStatus === "deleting") return;
                        setDeleteProjectConfirmOpen(false);
                        setDeleteProjectStatus("idle");
                    }}
                    onConfirm={() => void confirmProjectDelete()}
                />

                {project && (
                    <AccessModal
                        open={accessModalOpen}
                        onClose={() => setAccessModalOpen(false)}
                        resource={project}
                        fetchAccess={getProjectPeople}
                        currentUserEmail={user?.email ?? null}
                        breadcrumb={[
                            "Projects",
                            project.name +
                                (project.cm_number
                                    ? ` (${project.cm_number})`
                                    : ""),
                            "Access",
                        ]}
                        access={{
                            grants: grants ?? [],
                            orgId: project.org_id ?? null,
                            ownerLabel: "Project owners",
                            canManage: canDo("access.manage"),
                            onGrant: async (email, role) => {
                                await grantProjectAccess(
                                    projectId,
                                    email,
                                    role,
                                );
                                await refreshGrants();
                            },
                            onRevoke: async (email) => {
                                await revokeProjectAccess(projectId, email);
                                await refreshGrants();
                            },
                        }}
                    />
                )}
            </div>
        </ProjectWorkspaceContext.Provider>
    );
}

export function ProjectSectionToolbar({
    actions,
    backAction,
}: {
    actions?: ReactNode;
    backAction?: (() => void) | null;
}) {
    const { activeSection, projectId } = useProjectWorkspace();
    const router = useRouter();

    return (
        <TableToolbar
            items={
                backAction
                    ? []
                    : [
                          { id: "documents", label: "Documents" },
                          { id: "assistant", label: "Chats" },
                          { id: "reviews", label: "Tabular Reviews" },
                      ]
            }
            active={activeSection}
            onChange={(next) => {
                const href =
                    next === "assistant"
                        ? `/projects/${projectId}/assistant`
                        : next === "reviews"
                          ? `/projects/${projectId}/tabular-reviews`
                          : `/projects/${projectId}`;
                router.push(href);
            }}
            leading={
                backAction ? (
                    <TabPillButton onClick={backAction}>
                        <ChevronLeft className="h-3.5 w-3.5" />
                        Back
                    </TabPillButton>
                ) : undefined
            }
            actions={actions}
        />
    );
}

export function ProjectWorkspaceLayout({
    params,
    children,
}: {
    params: Promise<{ id: string }>;
    children: ReactNode;
}) {
    const { id } = use(params);
    return (
        <ProjectWorkspaceProvider projectId={id}>
            {children}
        </ProjectWorkspaceProvider>
    );
}
