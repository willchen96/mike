/**
 * Mike API client — all browser requests use the same-origin `/api` gateway.
 * Authentication is carried only by the backend-managed HttpOnly cookie.
 */

import { isPanelDocument } from "@/app/components/shared/types";
import { authenticatedFetch } from "@/app/lib/authEvents";
import {
    UploadBatchError,
    createControlRequestRetryPolicy,
    failedUploadMessage,
    firstUploadResult,
    uploadFilesWithSessionCore,
    type UploadOutcome,
    type UploadProgress,
    type UploadProgressStatus,
    type UploadSessionInput,
    type UploadSessionPurpose,
} from "@/shared/api/uploadSessionClient";
// The role vocabulary is defined once, next to the capability matrix that
// gives it meaning, and re-exported here so API consumers do not need two
// imports to describe one row.
import type {
    OrgRole,
    OrganizationAccessOverride,
    ProjectRole,
} from "@/app/lib/permissions";

export type { OrgRole, ProjectRole };
export type AccessAssignmentRole = OrganizationAccessOverride;
import type {
    AskInputResponseItem,
    AssistantEvent,
    Chat,
    ChatDetailOut,
    Citation,
    Document,
    Folder,
    LibraryFolder,
    Message,
    MessageFile,
    PanelDocument,
    OpenSourceWorkflowContributorMode,
    OpenSourceWorkflowResponse,
    Project,
    QuickAction,
    Workflow,
    WorkflowAddon,
    WorkflowContributor,
    TabularReview,
    TabularReviewDetailOut,
} from "@/app/components/shared/types";

export { UploadBatchError };
export { failedUploadMessage };
export type {
    UploadOutcome,
    UploadProgress,
    UploadProgressStatus,
    UploadSessionInput,
};

type AskInputsResponsePayload = {
    responses: AskInputResponseItem[];
};

// Server-side shape before mapping
interface ServerMessage {
    id: string;
    chat_id: string;
    role: "user" | "assistant";
    content: string | AssistantEvent[] | null;
    files?: MessageFile[] | null;
    workflow?: { id: string; title: string } | null;
    citations?: Citation[] | null;
    created_at: string;
}
interface ServerChatDetailOut {
    chat: Chat;
    /** The caller's standing on this chat, served alongside the row. */
    is_owner?: boolean;
    access_role?: "owner" | "editor" | "viewer";
    messages: ServerMessage[];
}

export const API_BASE = "/api";
const apiFetch: typeof fetch = authenticatedFetch;
const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
    if (isDev) console.log(...args);
};

export class MikeApiError extends Error {
    status: number;
    code: string | null;
    requestId: string | null;

    constructor(args: {
        message: string;
        status: number;
        code?: string | null;
        requestId?: string | null;
    }) {
        super(args.message);
        this.name = "MikeApiError";
        this.status = args.status;
        this.code = args.code ?? null;
        this.requestId = args.requestId ?? null;
    }
}

export const INTERNAL_ERROR_MESSAGE = "Something went wrong. Please try again.";
export const MALFORMED_ERROR_RESPONSE_MESSAGE =
    "The request could not be completed. Please try again.";

export function isMfaRequiredError(error: unknown) {
    return (
        error instanceof MikeApiError &&
        error.status === 403 &&
        error.code === "mfa_verification_required"
    );
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
    const { headers: initHeaders, ...restInit } = init ?? {};
    const response = await apiFetch(`${API_BASE}${path}`, {
        cache: "no-store",
        ...restInit,
        headers: {
            Accept: "application/json",
            ...(initHeaders as Record<string, string> | undefined),
        },
    });

    if (!response.ok) {
        throw await toApiError(response, path);
    }

    if (
        response.status === 204 ||
        response.headers.get("content-length") === "0"
    ) {
        return undefined as T;
    }

    return (await response.json()) as T;
}

/**
 * Every upload entry point takes the same options bag so a caller can watch
 * progress and cancel the batch (an unmounting screen, a "stop" control)
 * without reaching past the API layer.
 */
export type UploadRequestOptions<T> = {
    onProgress?: (progress: UploadProgress<T>) => void;
    signal?: AbortSignal;
};

export async function uploadFilesWithSession<T>(args: {
    purpose: UploadSessionPurpose;
    destination: Record<string, unknown>;
    files: UploadSessionInput[];
    signal?: AbortSignal;
    onProgress?: (progress: UploadProgress<T>) => void;
}): Promise<UploadOutcome<T>[]> {
    return uploadFilesWithSessionCore<T>({
        ...args,
        transport: {
            apiRequest,
            fetchStorage: (...fetchArgs) => fetch(...fetchArgs),
            shouldRetryControlRequest: createControlRequestRetryPolicy(
                (error) =>
                    error instanceof MikeApiError
                        ? { status: error.status, code: error.code }
                        : null,
            ),
        },
    });
}

async function apiBlobRequest(path: string): Promise<{
    blob: Blob;
    filename: string | null;
}> {
    const response = await apiFetch(`${API_BASE}${path}`, {
        cache: "no-store",
        headers: {
            Accept: "application/json",
        },
    });

    if (!response.ok) {
        throw await toApiError(response, path);
    }

    const disposition = response.headers.get("content-disposition") ?? "";
    const filenameMatch = disposition.match(/filename="?([^";]+)"?/i);
    return {
        blob: await response.blob(),
        filename: filenameMatch?.[1] ?? null,
    };
}

async function toApiError(response: Response, path: string) {
    const text = await response.text();
    try {
        const parsed = JSON.parse(text) as {
            detail?: unknown;
            code?: unknown;
            request_id?: unknown;
        };
        const requestId =
            typeof parsed.request_id === "string"
                ? parsed.request_id
                : response.headers.get("x-request-id");
        devLog("[mike-api] non-ok response", {
            path,
            status: response.status,
            code: parsed.code,
            requestId,
        });
        return new MikeApiError({
            status: response.status,
            code: typeof parsed.code === "string" ? parsed.code : null,
            requestId,
            message:
                response.status >= 500
                    ? INTERNAL_ERROR_MESSAGE
                    : typeof parsed.detail === "string" && parsed.detail
                      ? parsed.detail
                      : `API error: ${response.status}`,
        });
    } catch {
        devLog("[mike-api] non-ok non-json response", {
            path,
            status: response.status,
            requestId: response.headers.get("x-request-id"),
        });
        return new MikeApiError({
            status: response.status,
            requestId: response.headers.get("x-request-id"),
            message:
                response.status >= 500
                    ? INTERNAL_ERROR_MESSAGE
                    : MALFORMED_ERROR_RESPONSE_MESSAGE,
        });
    }
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function listProjects(options?: {
    includeDocuments?: boolean;
}): Promise<Project[]> {
    const query = options?.includeDocuments ? "?include=documents" : "";
    return apiRequest<Project[]>(`/projects${query}`);
}

// Paginated overview sibling of listProjects(), used by ProjectsOverview.tsx.
// Deliberately a separate function, not an overload of listProjects — the
// backend route decides whether to paginate based on whether any of these
// query params are present at all, so listProjects() must keep sending none
// of them (legacy project pickers still need the full unpaginated list).
export async function listProjectsPage(pagination?: {
    limit?: number;
    offset?: number;
    search?: string;
    sortKey?: string;
    sortDirection?: "asc" | "desc";
    scope?: "all" | "mine" | "shared" | "collaborative" | "private";
    practice?: string;
    ownerUserId?: string;
    signal?: AbortSignal;
}): Promise<Project[]> {
    const params = new URLSearchParams();
    if (pagination?.limit) params.set("limit", String(pagination.limit));
    if (pagination?.offset) params.set("offset", String(pagination.offset));
    if (pagination?.search) params.set("search", pagination.search);
    if (pagination?.sortKey) params.set("sort_key", pagination.sortKey);
    if (pagination?.sortDirection)
        params.set("sort_direction", pagination.sortDirection);
    if (pagination?.scope && pagination.scope !== "all")
        params.set("scope", pagination.scope);
    if (pagination?.practice) params.set("practice", pagination.practice);
    if (pagination?.ownerUserId)
        params.set("owner_user_id", pagination.ownerUserId);

    const qs = params.toString() ? `?${params.toString()}` : "";
    return apiRequest<Project[]>(`/projects${qs}`, {
        signal: pagination?.signal,
    });
}

export async function listProjectSummaries(pagination?: {
    limit?: number;
    offset?: number;
    signal?: AbortSignal;
}): Promise<Project[]> {
    const params = new URLSearchParams();
    if (pagination?.limit != null)
        params.set("limit", String(pagination.limit));
    if (pagination?.offset != null)
        params.set("offset", String(pagination.offset));
    params.set("view", "summary");
    return apiRequest<Project[]>(`/projects?${params.toString()}`, {
        signal: pagination?.signal,
    });
}

export interface ProjectDirectoryLevel {
    documents: Document[];
    folders: Folder[];
    documentsHasMore: boolean;
}

export async function getProjectDirectoryLevel(
    projectId: string,
    options?: {
        parentFolderId?: string | null;
        limit?: number;
        offset?: number;
        signal?: AbortSignal;
    },
): Promise<ProjectDirectoryLevel> {
    const params = new URLSearchParams();
    if (options?.parentFolderId)
        params.set("parent_folder_id", options.parentFolderId);
    if (options?.limit != null) params.set("limit", String(options.limit));
    if (options?.offset != null) params.set("offset", String(options.offset));
    const query = params.toString();
    return apiRequest<ProjectDirectoryLevel>(
        `/projects/${projectId}/directory${query ? `?${query}` : ""}`,
        {
            signal: options?.signal,
        },
    );
}

export async function searchProjectDirectory(options: {
    search: string;
    limit?: number;
    offset?: number;
    signal?: AbortSignal;
}): Promise<Project[]> {
    const params = new URLSearchParams({
        view: "directory-search",
        search: options.search,
    });
    if (options.limit != null) params.set("limit", String(options.limit));
    if (options.offset != null) params.set("offset", String(options.offset));
    return apiRequest<Project[]>(`/projects?${params}`, {
        signal: options.signal,
    });
}

export async function listProjectIds(options?: {
    search?: string;
    scope?: "all" | "mine" | "shared" | "collaborative" | "private";
    practice?: string;
    ownerUserId?: string;
    signal?: AbortSignal;
}): Promise<{ id: string; user_id: string }[]> {
    const params = new URLSearchParams();
    if (options?.search) params.set("search", options.search);
    if (options?.scope && options.scope !== "all")
        params.set("scope", options.scope);
    if (options?.practice) params.set("practice", options.practice);
    if (options?.ownerUserId) params.set("owner_user_id", options.ownerUserId);

    const qs = params.toString() ? `?${params.toString()}` : "";
    return apiRequest<{ id: string; user_id: string }[]>(`/projects/ids${qs}`, {
        signal: options?.signal,
    });
}

export interface ProjectFilterOptions {
    practices: string[];
    owners: { value: string; label: string }[];
}

export async function getProjectFilterOptions(
    signal?: AbortSignal,
): Promise<ProjectFilterOptions> {
    return apiRequest<ProjectFilterOptions>("/projects/filter-options", {
        signal,
    });
}

export async function createProject(
    name: string,
    cm_number?: string,
    practice?: string,
    org_id?: string,
): Promise<Project> {
    return apiRequest<Project>("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, cm_number, practice, org_id }),
    });
}

export async function deleteAccount(): Promise<void> {
    return apiRequest<void>("/user/account", { method: "DELETE" });
}

export async function deleteAllChats(): Promise<void> {
    return apiRequest<void>("/user/chats", { method: "DELETE" });
}

export async function deleteAllProjects(): Promise<void> {
    return apiRequest<void>("/user/projects", { method: "DELETE" });
}

export async function deleteAllTabularReviews(): Promise<void> {
    return apiRequest<void>("/user/tabular-reviews", { method: "DELETE" });
}

export async function exportAccountData(): Promise<{
    blob: Blob;
    filename: string | null;
}> {
    return apiBlobRequest("/user/export");
}

export async function exportChatData(): Promise<{
    blob: Blob;
    filename: string | null;
}> {
    return apiBlobRequest("/user/chats/export");
}

export async function exportTabularReviewsData(): Promise<{
    blob: Blob;
    filename: string | null;
}> {
    return apiBlobRequest("/user/tabular-reviews/export");
}

// --- Async (durable) exports -----------------------------------------------
// POST schedules a backend job that builds the export off the request thread;
// the status endpoint is polled until "done"; the download endpoint streams
// the artifact. Unlike the legacy GET exports above, a large export can
// neither time out the request nor die with a closed tab, and a re-click
// while one is building dedupes onto the running job.

export type UserExportType =
    | "account"
    | "chats"
    | "tabular-reviews"
    | "audit-csv"
    | "documents-zip";

export type UserExportStatus =
    | { status: "pending" }
    | { status: "failed" }
    | { status: "done"; filename: string | null };

/**
 * `params` carries the inputs of the filtered exports — the History CSV's
 * filter values (wire names: q/action/status/surface/from/to/sort_by/sort_dir)
 * and documents-zip's `document_ids`. The backend re-validates them and 400s
 * on anything it would have rejected on the synchronous route.
 */
export async function startUserExport(
    type: UserExportType,
    params?: Record<string, unknown>,
): Promise<{ export_id: string }> {
    return apiRequest<{ export_id: string }>("/user/exports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params ? { type, params } : { type }),
    });
}

export async function getUserExportStatus(
    exportId: string,
): Promise<UserExportStatus> {
    return apiRequest<UserExportStatus>(
        `/user/exports/${encodeURIComponent(exportId)}`,
    );
}

export async function downloadUserExport(exportId: string): Promise<{
    blob: Blob;
    filename: string | null;
}> {
    return apiBlobRequest(
        `/user/exports/${encodeURIComponent(exportId)}/download`,
    );
}

export type PracticeSetting =
    "private_practice" | "in_house" | "not_practising";

export type ProfessionalTitle =
    | "Partner"
    | "Senior Associate"
    | "Associate"
    | "Law Clerk"
    | "Counsel"
    | "General Counsel"
    | "Legal Counsel"
    | "Other";

export interface PersonalisationDetails {
    jurisdiction?: string | null;
    practiceSetting?: PracticeSetting | null;
    professionalTitle?: ProfessionalTitle | null;
    practiceAreas?: string[];}

export interface UserProfile {
    displayName: string | null;
    organisation: string | null;
    jurisdiction: string | null;
    practiceSetting: PracticeSetting | null;
    professionalTitle: ProfessionalTitle | null;
    practiceAreas: string[];
    onboardingVersion: number | null;
    onboardingComplete: boolean;
    passwordSet: boolean;
    messageCreditsUsed: number;
    creditsResetDate: string;
    creditsRemaining: number;
    tier: string;
    titleModel: string | null;
    tabularModel: string | null;
    lastSelectedChatModel: string | null;
    lastSelectedReasoningLevel: NonNullable<Message["reasoning"]>;
    mfaOnLogin: boolean;
    legalResearchUs: boolean;
    quickActionsVisible: boolean;
    darkMode: boolean;
    transparentTables: boolean;
    openRouterModels: string[];
    vercelModels: string[];
    openCodeGoModels: string[];
    apiKeyStatus: ApiKeyStatus;
}

export interface UserLookupResult {
    exists: boolean;
    email: string;
    display_name: string | null;
}

// ---------------------------------------------------------------------------
// Audit history
// ---------------------------------------------------------------------------

export interface AuditEvent {
    id: string;
    created_at: string;
    user_display_name: string | null;
    user_email: string | null;
    action: string;
    status: string;
    title: string | null;
    surface: string | null;
    project_id: string | null;
    chat_id: string | null;
    document_id: string | null;
    review_id: string | null;
    model: string | null;
    detail: Record<string, unknown> | null;
}

export async function getAuditHistory(
    params: {
        q?: string;
        action?: string;
        status?: string;
        surface?: string;
        from?: string;
        to?: string;
        sortBy?: "created_at" | "user_email" | "title" | "model";
        sortDirection?: "asc" | "desc";
        page?: number;
    },
    signal?: AbortSignal,
): Promise<{
    events: AuditEvent[];
    total: number;
    page: number;
    pageSize: number;
}> {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.action) qs.set("action", params.action);
    if (params.status) qs.set("status", params.status);
    if (params.surface) qs.set("surface", params.surface);
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    if (params.sortBy) qs.set("sort_by", params.sortBy);
    if (params.sortDirection) qs.set("sort_dir", params.sortDirection);
    if (params.page) qs.set("page", String(params.page));
    return apiRequest(`/audit?${qs.toString()}`, { signal });
}

export async function exportAuditHistory(params: {
    q?: string;
    action?: string;
    status?: string;
    surface?: string;
    from?: string;
    to?: string;
    sortBy?: "created_at" | "user_email" | "title" | "model";
    sortDirection?: "asc" | "desc";
}): Promise<{ blob: Blob; filename: string | null }> {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.action) qs.set("action", params.action);
    if (params.status) qs.set("status", params.status);
    if (params.surface) qs.set("surface", params.surface);
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    if (params.sortBy) qs.set("sort_by", params.sortBy);
    if (params.sortDirection) qs.set("sort_dir", params.sortDirection);
    return apiBlobRequest(`/audit/export?${qs.toString()}`);
}

export async function getUserProfile(): Promise<UserProfile> {
    return apiRequest<UserProfile>("/user/profile");
}

export async function lookupUserByEmail(
    email: string,
): Promise<UserLookupResult> {
    return apiRequest<UserLookupResult>(
        `/user/lookup?email=${encodeURIComponent(email)}`,
    );
}

export async function updateUserProfile(payload: {
    displayName?: string | null;
    organisation?: string | null;
    jurisdiction?: string | null;
    practiceSetting?: PracticeSetting | null;
    professionalTitle?: ProfessionalTitle | null;
    practiceAreas?: string[];
    titleModel?: string | null;
    tabularModel?: string | null;
    lastSelectedChatModel?: string | null;
    lastSelectedReasoningLevel?: NonNullable<Message["reasoning"]>;
    legalResearchUs?: boolean;
    quickActionsVisible?: boolean;
    darkMode?: boolean;
    transparentTables?: boolean;
    openRouterModels?: string[];
    vercelModels?: string[];
    openCodeGoModels?: string[];
}): Promise<UserProfile> {
    return apiRequest<UserProfile>("/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function completeUserOnboarding(
    payload: PersonalisationDetails = {},
): Promise<UserProfile> {
    return apiRequest<UserProfile>("/user/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function syncUserPasswordSet(): Promise<UserProfile> {
    return apiRequest<UserProfile>("/user/security/password-set", {
        method: "POST",
    });
}

export async function updateUserMfaOnLogin(
    enabled: boolean,
): Promise<UserProfile> {
    return apiRequest<UserProfile>("/user/security/mfa-login", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
    });
}

export type ApiKeyProvider =
    | "claude"
    | "gemini"
    | "openai"
    | "openrouter"
    | "vercel"
    | "opencode-go"
    | "courtlistener";
export type ApiKeySource = "user" | "env" | null;
export type ApiKeyState = Record<
    ApiKeyProvider,
    {
        configured: boolean;
        source: ApiKeySource;
    }
>;

export type ApiKeyStatus = Record<ApiKeyProvider, boolean> & {
    sources?: Partial<Record<ApiKeyProvider, ApiKeySource>>;
};

export async function getApiKeyStatus(): Promise<ApiKeyStatus> {
    return apiRequest<ApiKeyStatus>("/user/api-keys");
}

export interface OllamaModelOption {
    id: string;
    label: string;
    group: "Local";
}

export interface RouterCatalogModel {
    id: string;
    label: string;
    pricing?: {
        input?: string;
        output?: string;
        variesByProvider?: boolean;
        tiered?: boolean;
    };
}

export async function getOllamaModels(): Promise<OllamaModelOption[]> {
    const { models } = await apiRequest<{ models: OllamaModelOption[] }>(
        "/models/ollama",
    );
    return models;
}

export async function getOpenRouterModels(): Promise<RouterCatalogModel[]> {
    const { models } = await apiRequest<{ models: RouterCatalogModel[] }>(
        "/models/openrouter",
    );
    return models;
}

export async function getVercelModels(): Promise<RouterCatalogModel[]> {
    const { models } = await apiRequest<{ models: RouterCatalogModel[] }>(
        "/models/vercel",
    );
    return models;
}

export async function getOpenCodeGoModels(): Promise<RouterCatalogModel[]> {
    const { models } = await apiRequest<{ models: RouterCatalogModel[] }>(
        "/models/opencode-go",
    );
    return models;
}

export async function saveApiKey(
    provider: ApiKeyProvider,
    apiKey: string | null,
): Promise<ApiKeyStatus> {
    return apiRequest<ApiKeyStatus>(`/user/api-keys/${provider}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey }),
    });
}

export interface McpToolSummary {
    id: string;
    toolName: string;
    openaiToolName: string;
    title: string | null;
    description: string | null;
    enabled: boolean;
    readOnly: boolean;
    destructive: boolean;
    requiresConfirmation: boolean;
    lastSeenAt: string;
}

export interface McpConnectorSummary {
    id: string;
    name: string;
    transport: "streamable_http";
    serverUrl: string;
    authType: "none" | "bearer" | "oauth";
    enabled: boolean;
    hasAuthConfig: boolean;
    customHeaderKeys: string[];
    oauthConnected: boolean;
    toolPolicy: Record<string, unknown>;
    tools: McpToolSummary[];
    toolCount: number;
    createdAt: string;
    updatedAt: string;
}

export async function listMcpConnectors(): Promise<McpConnectorSummary[]> {
    return apiRequest<McpConnectorSummary[]>("/user/mcp-connectors");
}

export async function getMcpConnector(
    connectorId: string,
): Promise<McpConnectorSummary> {
    return apiRequest<McpConnectorSummary>(
        `/user/mcp-connectors/${connectorId}`,
    );
}

export async function createMcpConnector(payload: {
    name: string;
    serverUrl: string;
    bearerToken?: string | null;
    headers?: Record<string, string>;
}): Promise<McpConnectorSummary> {
    return apiRequest<McpConnectorSummary>("/user/mcp-connectors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function updateMcpConnector(
    connectorId: string,
    payload: {
        name?: string;
        serverUrl?: string;
        enabled?: boolean;
        bearerToken?: string | null;
        headers?: Record<string, string>;
    },
): Promise<McpConnectorSummary> {
    return apiRequest<McpConnectorSummary>(
        `/user/mcp-connectors/${connectorId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        },
    );
}

export async function deleteMcpConnector(connectorId: string): Promise<void> {
    return apiRequest<void>(`/user/mcp-connectors/${connectorId}`, {
        method: "DELETE",
    });
}

export async function refreshMcpConnectorTools(
    connectorId: string,
): Promise<McpConnectorSummary> {
    return apiRequest<McpConnectorSummary>(
        `/user/mcp-connectors/${connectorId}/refresh-tools`,
        { method: "POST" },
    );
}

export async function startMcpConnectorOAuth(connectorId: string): Promise<{
    authorizationUrl: string | null;
    alreadyAuthorized: boolean;
    callbackOrigin: string;
}> {
    return apiRequest<{
        authorizationUrl: string | null;
        alreadyAuthorized: boolean;
        callbackOrigin: string;
    }>(`/user/mcp-connectors/${connectorId}/oauth/start`, { method: "POST" });
}

export async function setMcpToolEnabled(
    connectorId: string,
    toolId: string,
    enabled: boolean,
): Promise<McpConnectorSummary> {
    return apiRequest<McpConnectorSummary>(
        `/user/mcp-connectors/${connectorId}/tools/${toolId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled }),
        },
    );
}

/**
 * Error code the backend attaches when a connector cannot start because the
 * deployment is missing operator-side setup (an OAuth client for a provider
 * with no dynamic registration). Its `detail` is repo-authored setup text
 * safe to show verbatim — unlike every other connector failure, which the
 * backend sanitizes to a fixed string.
 */
export const CONNECTOR_SETUP_REQUIRED_CODE = "connector_setup_required";

export function isConnectorSetupError(error: unknown): error is MikeApiError {
    return (
        error instanceof MikeApiError &&
        error.code === CONNECTOR_SETUP_REQUIRED_CODE
    );
}

export async function getProject(projectId: string): Promise<Project> {
    return apiRequest<Project>(`/projects/${projectId}`);
}

export async function updateProject(
    projectId: string,
    payload: {
        name?: string;
        cm_number?: string;
        practice?: string | null;
    },
): Promise<Project> {
    return apiRequest<Project>(`/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function deleteProject(projectId: string): Promise<void> {
    await apiRequest(`/projects/${projectId}`, { method: "DELETE" });
}

/**
 * Someone who can administer a resource, with an address to reach them.
 * `source` says how they got there: the creator, a direct Owner grant, or
 * being an Admin of the owning organization.
 */
export interface ProjectContact {
    user_id: string | null;
    email: string | null;
    display_name: string | null;
    source: "creator" | "grant" | "organization";
}

export interface ProjectPeople {
    scope?: "direct" | "organization" | "project";
    inherited_from_project_id?: string;
    /**
     * The creator. Null is legitimate: an organization's project outlives the
     * account that opened it, and the org's admins administer it from then on.
     */
    owner: {
        user_id: string;
        email: string | null;
        display_name: string | null;
        role?: ProjectRole;
    } | null;
    /** Direct recipients and their grant roles. */
    members: {
        user_id?: string | null;
        email: string;
        display_name: string | null;
        role?: AccessAssignmentRole;
    }[];
    admin_contacts?: ProjectContact[];
}

export async function getProjectPeople(
    projectId: string,
): Promise<ProjectPeople> {
    return apiRequest<ProjectPeople>(`/projects/${projectId}/people`);
}

// ---------------------------------------------------------------------------
// Project access grants
// ---------------------------------------------------------------------------
//
// One row per recipient, each carrying its own project role. This replaces the
// roleless `shared_with` email array. Direct grants belong only to personal
// resources; organization resources use organization-member overrides.

export interface ProjectGrant {
    id?: string;
    project_id?: string;
    user_id?: string;
    email: string;
    role: AccessAssignmentRole;
    created_by?: string | null;
    created_at?: string;
    updated_at?: string;
}

export interface ContentAccessGrant {
    id?: string;
    user_id?: string;
    email: string;
    role: AccessAssignmentRole;
    created_by?: string | null;
    created_at?: string;
    updated_at?: string;
    chat_id?: string;
    tabular_review_id?: string;
}

export interface ContentAccess {
    scope: "direct" | "project";
    inherited_from_project_id?: string;
    org_id: string | null;
    access_role: ProjectRole;
    grants: ContentAccessGrant[];
}

export interface ProjectAccess {
    scope: "direct" | "organization";
    org_id: string | null;
    /** The caller's own role, so the dialog knows whether to offer controls. */
    access_role: ProjectRole;
    grants: ProjectGrant[];
}

export async function getProjectAccess(
    projectId: string,
): Promise<ProjectAccess> {
    return apiRequest<ProjectAccess>(`/projects/${projectId}/access`);
}

/** Create or re-role one recipient (the endpoint upserts, so both are POST). */
export async function grantProjectAccess(
    projectId: string,
    email: string,
    role: AccessAssignmentRole,
): Promise<ProjectGrant> {
    return apiRequest<ProjectGrant>(`/projects/${projectId}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role }),
    });
}

export async function revokeProjectAccess(
    projectId: string,
    email: string,
): Promise<void> {
    await apiRequest(
        `/projects/${projectId}/access/${encodeURIComponent(email)}`,
        { method: "DELETE" },
    );
}

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

export interface Org {
    id: string;
    name: string;
    created_by: string | null;
    created_at?: string;
    updated_at?: string;
    /** The caller's role in this org. */
    role: OrgRole;
    /** Accepted roster size, so a card can say "N members" without a fetch. */
    member_count?: number;
}

/**
 * Bare org_members row, as mutation endpoints return it (PATCH /members/:id
 * responds with the updated row — no profile enrichment).
 */
export interface OrgMemberRow {
    id: string;
    user_id: string;
    role: OrgRole;
    created_at?: string;
}

/** Roster row from GET /members: the bare row plus mirrored profile fields. */
export interface OrgMember extends OrgMemberRow {
    email: string | null;
    display_name: string | null;
}

/**
 * An invitation. Membership is only ever created by accepting one of these —
 * there is no endpoint that drops somebody into an organization full of
 * confidential material without their consent.
 *
 * `status` is reported lazily: a pending row past `expires_at` comes back as
 * "expired" without anything having written to it.
 */
export type OrgInvitationStatus =
    | "pending"
    | "accepted"
    | "declined"
    | "cancelled"
    | "expired";

export interface OrgInvitation {
    id: string;
    org_id: string;
    email: string;
    role: OrgRole;
    invited_by: string | null;
    status: OrgInvitationStatus;
    expires_at: string;
    created_at: string;
    accepted_at: string | null;
    declined_at: string | null;
    cancelled_at: string | null;
    /** Admin roster only. */
    invited_by_email?: string | null;
    /** Recipient list only — the recipient is not a member yet, so they
     *  cannot look the organization's name up any other way. */
    org_name?: string | null;
}

export async function listOrgs(): Promise<Org[]> {
    return apiRequest<Org[]>("/orgs");
}

export async function createOrg(name: string): Promise<Org> {
    return apiRequest<Org>("/orgs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
    });
}

export async function getOrg(orgId: string): Promise<Org> {
    return apiRequest<Org>(`/orgs/${orgId}`);
}

export async function updateOrg(orgId: string, name: string): Promise<Org> {
    return apiRequest<Org>(`/orgs/${orgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
    });
}

export async function deleteOrg(orgId: string): Promise<void> {
    await apiRequest(`/orgs/${orgId}`, { method: "DELETE" });
}

export interface OrgResources {
    projects: Project[];
    workflows: {
        id: string;
        user_id: string | null;
        org_id: string;
        title: string | null;
        type: "assistant" | "tabular";
        practice: string | null;
        created_at: string;
    }[];
}

export async function listOrgResources(orgId: string): Promise<OrgResources> {
    return apiRequest<OrgResources>(`/orgs/${orgId}/resources`);
}

export async function listOrgMembers(orgId: string): Promise<OrgMember[]> {
    return apiRequest<OrgMember[]>(`/orgs/${orgId}/members`);
}

export async function updateOrgMember(
    orgId: string,
    userId: string,
    role: OrgRole,
): Promise<OrgMemberRow> {
    return apiRequest<OrgMemberRow>(`/orgs/${orgId}/members/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
    });
}

export async function removeOrgMember(
    orgId: string,
    userId: string,
): Promise<void> {
    await apiRequest(`/orgs/${orgId}/members/${userId}`, {
        method: "DELETE",
    });
}

// --- Invitations: the admin's side ---------------------------------------

export async function listOrgInvitations(
    orgId: string,
): Promise<OrgInvitation[]> {
    return apiRequest<OrgInvitation[]>(`/orgs/${orgId}/invitations`);
}

export async function createOrgInvitation(
    orgId: string,
    email: string,
    role: OrgRole,
): Promise<OrgInvitation> {
    return apiRequest<OrgInvitation>(`/orgs/${orgId}/invitations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role }),
    });
}

export async function cancelOrgInvitation(
    orgId: string,
    invitationId: string,
): Promise<void> {
    await apiRequest(`/orgs/${orgId}/invitations/${invitationId}`, {
        method: "DELETE",
    });
}

export async function resendOrgInvitation(
    orgId: string,
    invitationId: string,
): Promise<OrgInvitation> {
    return apiRequest<OrgInvitation>(
        `/orgs/${orgId}/invitations/${invitationId}/resend`,
        { method: "POST" },
    );
}

// --- Invitations: the recipient's side ------------------------------------
//
// These hang off /user, not /orgs: the caller is not a member yet, so an
// org-scoped route would have to answer "which org?" before it could answer
// "are you allowed to know?". Matching is by the account's email, which is
// what lets an invitation sent before signup be claimed once the account
// exists.

export async function listMyOrgInvitations(): Promise<OrgInvitation[]> {
    return apiRequest<OrgInvitation[]>("/user/invitations");
}

export async function acceptOrgInvitation(
    invitationId: string,
): Promise<{ org_id: string; role: OrgRole }> {
    return apiRequest<{ org_id: string; role: OrgRole }>(
        `/user/invitations/${invitationId}/accept`,
        { method: "POST" },
    );
}

export async function declineOrgInvitation(
    invitationId: string,
): Promise<void> {
    await apiRequest(`/user/invitations/${invitationId}/decline`, {
        method: "POST",
    });
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export type FolderConflictResolution = "error" | "reuse" | "rename";

export type FolderPathResolution<TFolder> =
    | {
          conflict: true;
          folder_name: string;
          existing_folder_id: string;
          suggested_name: string;
      }
    | {
          conflict: false;
          folder_id: string;
          resolved_name: string;
          folders: TFolder[];
      };

export async function resolveProjectFolderPath(
    projectId: string,
    segments: string[],
    baseFolderId: string | null,
    conflictResolution: FolderConflictResolution = "error",
): Promise<FolderPathResolution<Folder>> {
    return apiRequest<FolderPathResolution<Folder>>(
        `/projects/${projectId}/folder-paths/resolve`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                segments,
                base_folder_id: baseFolderId,
                conflict_resolution: conflictResolution,
            }),
        },
    );
}

export async function createProjectFolder(
    projectId: string,
    name: string,
    parentFolderId?: string | null,
): Promise<Folder> {
    return apiRequest<Folder>(`/projects/${projectId}/folders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name,
            parent_folder_id: parentFolderId ?? null,
        }),
    });
}

export async function renameProjectFolder(
    projectId: string,
    folderId: string,
    name: string,
): Promise<Folder> {
    return apiRequest<Folder>(`/projects/${projectId}/folders/${folderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
    });
}

export async function deleteProjectFolder(
    projectId: string,
    folderId: string,
): Promise<void> {
    await apiRequest(`/projects/${projectId}/folders/${folderId}`, {
        method: "DELETE",
    });
}

export async function moveSubfolderToFolder(
    projectId: string,
    folderId: string,
    parentFolderId: string | null,
): Promise<Folder> {
    return apiRequest<Folder>(`/projects/${projectId}/folders/${folderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parent_folder_id: parentFolderId }),
    });
}

export async function moveDocumentToFolder(
    projectId: string,
    documentId: string,
    folderId: string | null,
): Promise<Document> {
    return apiRequest<Document>(
        `/projects/${projectId}/documents/${documentId}/folder`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folder_id: folderId }),
        },
    );
}

export async function renameProjectDocument(
    projectId: string,
    documentId: string,
    filename: string,
): Promise<Document> {
    return apiRequest<Document>(
        `/projects/${projectId}/documents/${documentId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename }),
        },
    );
}

export type LibraryKind = "files" | "templates";

export interface LibraryCollection {
    documents: Document[];
    folders: LibraryFolder[];
    documentsHasMore: boolean;
}

export interface LibraryPagination {
    limit?: number;
    offset?: number;
}

export interface LibrarySearchParams extends LibraryPagination {
    search?: string;
    fileType?: string;
    sortKey?: "name" | "type" | "size" | "version" | "created" | "updated";
    sortDirection?: "asc" | "desc";
    signal?: AbortSignal;
}

export interface LibrarySearchResults {
    documents: Document[];
    documentsHasMore: boolean;
}

function libraryPaginationQuery(pagination?: LibraryPagination): string {
    const params = new URLSearchParams();
    if (pagination?.limit != null)
        params.set("limit", String(pagination.limit));
    if (pagination?.offset != null)
        params.set("offset", String(pagination.offset));
    const qs = params.toString();
    return qs ? `?${qs}` : "";
}

export async function getLibrary(
    kind: LibraryKind,
    pagination?: LibraryPagination,
): Promise<LibraryCollection> {
    return apiRequest<LibraryCollection>(
        `/library/${kind}${libraryPaginationQuery(pagination)}`,
    );
}

export async function getLibraryFolderChildren(
    kind: LibraryKind,
    folderId: string,
    pagination?: LibraryPagination,
): Promise<LibraryCollection> {
    const params = new URLSearchParams({ parent_folder_id: folderId });
    if (pagination?.limit != null)
        params.set("limit", String(pagination.limit));
    if (pagination?.offset != null)
        params.set("offset", String(pagination.offset));
    return apiRequest<LibraryCollection>(
        `/library/${kind}?${params.toString()}`,
    );
}

export async function getLibraryFolderPath(
    kind: LibraryKind,
    folderId: string,
): Promise<{ folders: LibraryFolder[] }> {
    return apiRequest<{ folders: LibraryFolder[] }>(
        `/library/${kind}/folders/${folderId}`,
    );
}

export async function getLibraryLevels(
    kind: LibraryKind,
    levels: { parentId: string | null; limit: number }[],
): Promise<{
    levels: Array<LibraryCollection & { parentId: string | null }>;
}> {
    return apiRequest(`/library/${kind}/levels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ levels }),
    });
}

export async function searchLibraryDocuments(
    kind: LibraryKind,
    options: LibrarySearchParams,
): Promise<LibrarySearchResults> {
    const params = new URLSearchParams({ view: "search" });
    if (options.limit != null) params.set("limit", String(options.limit));
    if (options.offset != null) params.set("offset", String(options.offset));
    if (options.search) params.set("search", options.search);
    if (options.fileType) params.set("file_type", options.fileType);
    if (options.sortKey) params.set("sort_key", options.sortKey);
    if (options.sortDirection)
        params.set("sort_direction", options.sortDirection);
    return apiRequest<LibrarySearchResults>(
        `/library/${kind}?${params.toString()}`,
        { signal: options.signal },
    );
}

export async function getLibraryFilterOptions(
    kind: LibraryKind,
): Promise<{ fileTypes: string[] }> {
    return apiRequest<{ fileTypes: string[] }>(
        `/library/${kind}/filter-options`,
    );
}

export async function listLibraryDocumentIds(
    kind: LibraryKind,
    options?: { search?: string; fileType?: string; signal?: AbortSignal },
): Promise<string[]> {
    const params = new URLSearchParams();
    if (options?.search) params.set("search", options.search);
    if (options?.fileType) params.set("file_type", options.fileType);
    const query = params.toString();
    return apiRequest<string[]>(
        `/library/${kind}/ids${query ? `?${query}` : ""}`,
        { signal: options?.signal },
    );
}

export async function bulkDeleteLibraryDocuments(
    kind: LibraryKind,
    ids: string[],
): Promise<{ deletedIds: string[] }> {
    return apiRequest<{ deletedIds: string[] }>(
        `/library/${kind}/documents/bulk-delete`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids }),
        },
    );
}

export async function uploadLibraryDocument(
    kind: LibraryKind,
    file: File,
    folderId?: string | null,
    options?: UploadRequestOptions<Document>,
): Promise<Document> {
    return firstUploadResult(
        await uploadLibraryDocuments(kind, [{ file, folderId }], options),
    );
}

export async function uploadLibraryDocuments(
    kind: LibraryKind,
    files: UploadSessionInput[],
    options?: UploadRequestOptions<Document>,
): Promise<UploadOutcome<Document>[]> {
    return uploadFilesWithSession<Document>({
        purpose: "document_create",
        destination: {
            scope: "library",
            library_kind: kind === "files" ? "file" : "template",
        },
        files,
        onProgress: options?.onProgress,
        signal: options?.signal,
    });
}

export async function createLibraryFolder(
    kind: LibraryKind,
    name: string,
    parentFolderId?: string | null,
): Promise<LibraryFolder> {
    return apiRequest<LibraryFolder>(`/library/${kind}/folders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name,
            parent_folder_id: parentFolderId ?? null,
        }),
    });
}

export async function resolveLibraryFolderPath(
    kind: LibraryKind,
    segments: string[],
    baseFolderId: string | null,
    conflictResolution: FolderConflictResolution = "error",
): Promise<FolderPathResolution<LibraryFolder>> {
    return apiRequest<FolderPathResolution<LibraryFolder>>(
        `/library/${kind}/folder-paths/resolve`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                segments,
                base_folder_id: baseFolderId,
                conflict_resolution: conflictResolution,
            }),
        },
    );
}

export async function renameLibraryFolder(
    kind: LibraryKind,
    folderId: string,
    name: string,
): Promise<LibraryFolder> {
    return apiRequest<LibraryFolder>(`/library/${kind}/folders/${folderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
    });
}

export async function deleteLibraryFolder(
    kind: LibraryKind,
    folderId: string,
): Promise<void> {
    await apiRequest(`/library/${kind}/folders/${folderId}`, {
        method: "DELETE",
    });
}

export async function moveLibraryFolder(
    kind: LibraryKind,
    folderId: string,
    parentFolderId: string | null,
): Promise<LibraryFolder> {
    return apiRequest<LibraryFolder>(`/library/${kind}/folders/${folderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parent_folder_id: parentFolderId }),
    });
}

export async function moveLibraryDocument(
    kind: LibraryKind,
    documentId: string,
    folderId: string | null,
): Promise<Document> {
    return apiRequest<Document>(
        `/library/${kind}/documents/${documentId}/folder`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folder_id: folderId }),
        },
    );
}

export async function renameLibraryDocument(
    kind: LibraryKind,
    documentId: string,
    filename: string,
): Promise<Document> {
    return apiRequest<Document>(`/library/${kind}/documents/${documentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
    });
}

export async function addDocumentToProject(
    projectId: string,
    documentId: string,
): Promise<Document> {
    return apiRequest<Document>(
        `/projects/${projectId}/documents/${documentId}`,
        { method: "POST" },
    );
}

export interface DocumentVersion {
    id: string;
    version_number: number | null;
    source: string;
    created_at: string;
    filename: string | null;
    file_type?: string | null;
    size_bytes?: number | null;
    page_count?: number | null;
    deleted_at?: string | null;
    deleted_by?: string | null;
}

export async function listDocumentVersions(documentId: string): Promise<{
    current_version_id: string | null;
    versions: DocumentVersion[];
}> {
    return apiRequest(`/single-documents/${documentId}/versions`);
}

export async function uploadDocumentVersion(
    documentId: string,
    file: File,
    filename?: string,
    options?: UploadRequestOptions<DocumentVersion>,
): Promise<DocumentVersion> {
    return firstUploadResult(
        await uploadFilesWithSession<DocumentVersion>({
            purpose: "document_version_create",
            destination: { document_id: documentId, filename },
            files: [{ file }],
            onProgress: options?.onProgress,
            signal: options?.signal,
        }),
    );
}

export async function replaceDocumentVersionFile(
    documentId: string,
    versionId: string,
    file: File,
    filename?: string,
    options?: UploadRequestOptions<DocumentVersion>,
): Promise<DocumentVersion> {
    const uploadedFile = filename
        ? new File([file], filename, {
              type: file.type,
              lastModified: file.lastModified,
          })
        : file;
    return firstUploadResult(
        await uploadFilesWithSession<DocumentVersion>({
            purpose: "document_version_replace",
            destination: { document_id: documentId, version_id: versionId },
            files: [{ file: uploadedFile }],
            onProgress: options?.onProgress,
            signal: options?.signal,
        }),
    );
}

export async function copyDocumentVersionFromDocument(
    documentId: string,
    sourceDocumentId: string,
    filename?: string,
): Promise<DocumentVersion> {
    return apiRequest<DocumentVersion>(
        `/single-documents/${documentId}/versions/from-document`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                source_document_id: sourceDocumentId,
                filename,
            }),
        },
    );
}

export async function renameDocumentVersion(
    documentId: string,
    versionId: string,
    filename: string | null,
): Promise<DocumentVersion> {
    return apiRequest<DocumentVersion>(
        `/single-documents/${documentId}/versions/${versionId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename }),
        },
    );
}

export async function deleteDocumentVersion(
    documentId: string,
    versionId: string,
): Promise<{
    deleted_version_id: string;
    current_version_id: string | null;
}> {
    return apiRequest(`/single-documents/${documentId}/versions/${versionId}`, {
        method: "DELETE",
    });
}

export async function uploadProjectDocument(
    projectId: string,
    file: File,
    folderId?: string | null,
    options?: UploadRequestOptions<Document>,
): Promise<Document> {
    return firstUploadResult(
        await uploadProjectDocuments(projectId, [{ file, folderId }], options),
    );
}

export async function uploadProjectDocuments(
    projectId: string,
    files: UploadSessionInput[],
    options?: UploadRequestOptions<Document>,
): Promise<UploadOutcome<Document>[]> {
    return uploadFilesWithSession<Document>({
        purpose: "document_create",
        destination: { scope: "project", project_id: projectId },
        files,
        onProgress: options?.onProgress,
        signal: options?.signal,
    });
}

export async function uploadStandaloneDocument(
    file: File,
    options?: UploadRequestOptions<Document>,
): Promise<Document> {
    return firstUploadResult(await uploadStandaloneDocuments([{ file }], options));
}

export async function uploadStandaloneDocuments(
    files: UploadSessionInput[],
    options?: UploadRequestOptions<Document>,
): Promise<UploadOutcome<Document>[]> {
    return uploadFilesWithSession<Document>({
        purpose: "document_create",
        destination: { scope: "standalone" },
        files,
        onProgress: options?.onProgress,
        signal: options?.signal,
    });
}

export async function listStandaloneDocuments(): Promise<Document[]> {
    return apiRequest<Document[]>("/single-documents");
}

export async function getDocument(documentId: string): Promise<Document> {
    return apiRequest<Document>(`/single-documents/${documentId}`);
}

export async function deleteDocument(documentId: string): Promise<void> {
    await apiRequest(`/single-documents/${documentId}`, { method: "DELETE" });
}

export interface DocumentEditResolution {
    ok: boolean;
    already_resolved?: boolean;
    status?: "accepted" | "rejected";
    version_id: string | null;
    download_url: string | null;
    remaining_pending?: number;
}

export async function resolveDocumentEdit(
    documentId: string,
    editId: string,
    verb: "accept" | "reject",
): Promise<DocumentEditResolution> {
    return apiRequest<DocumentEditResolution>(
        `/single-documents/${encodeURIComponent(documentId)}/edits/${encodeURIComponent(editId)}/${verb}`,
        { method: "POST" },
    );
}

export async function getDocumentUrl(
    documentId: string,
    versionId?: string | null,
): Promise<{ url: string; filename: string; version_id: string | null }> {
    const qs = versionId ? `?version_id=${encodeURIComponent(versionId)}` : "";
    return apiRequest(`/single-documents/${documentId}/url${qs}`);
}

export async function downloadDocumentsZip(
    documentIds: string[],
    folderIds: string[] = [],
): Promise<Blob> {
    const response = await apiFetch(
        `${API_BASE}/single-documents/download-zip`,
        {
            method: "POST",
            cache: "no-store",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                document_ids: documentIds,
                folder_ids: folderIds,
            }),
        },
    );
    if (!response.ok) {
        throw await toApiError(response, "/single-documents/download-zip");
    }
    return response.blob();
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export async function createChat(payload?: {
    project_id?: string;
}): Promise<{ id: string }> {
    return apiRequest<{ id: string }>("/chat/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload ?? {}),
    });
}

export async function listChats(options?: {
    limit?: number;
    offset?: number;
}): Promise<Chat[]> {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.offset) params.set("offset", String(options.offset));
    const query = params.toString();
    return apiRequest<Chat[]>(`/chat${query ? `?${query}` : ""}`);
}

export async function listProjectChats(projectId: string): Promise<Chat[]> {
    return apiRequest<Chat[]>(`/projects/${projectId}/chats`);
}

export async function getChat(chatId: string): Promise<ChatDetailOut> {
    const raw = await apiRequest<ServerChatDetailOut>(`/chat/${chatId}`);
    const messages: Message[] = raw.messages.map((m) => {
        if (m.role === "user") {
            return {
                id: m.id,
                role: "user",
                content: typeof m.content === "string" ? m.content : "",
                files: m.files ?? undefined,
                workflow: m.workflow ?? undefined,
            };
        }
        const events = Array.isArray(m.content)
            ? (m.content as AssistantEvent[])
            : undefined;
        return {
            id: m.id,
            role: "assistant",
            content:
                events
                    ?.filter((e) => e.type === "content")
                    .map((e) => (e as { type: "content"; text: string }).text)
                    .join("") ?? "",
            citations: m.citations ?? undefined,
            events,
        };
    });
    return {
        // Fold the caller's served standing into the row so consumers gate
        // with roleFrom(chat) exactly as list surfaces do. Dropping these
        // fields is how the global chat page ended up handing a project
        // viewer a fully writable composer whose sends 403.
        chat: {
            ...raw.chat,
            is_owner: raw.is_owner,
            access_role: raw.access_role,
        },
        messages,
    };
}

export async function renameChat(chatId: string, title: string): Promise<void> {
    await apiRequest(`/chat/${chatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
    });
}

export async function updateChatModel(
    chatId: string,
    model: string,
): Promise<{ id: string; title: string | null; model: string }> {
    return apiRequest(`/chat/${chatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
        keepalive: true,
    });
}

export async function updateChatReasoningLevel(
    chatId: string,
    reasoningLevel: NonNullable<Message["reasoning"]>,
): Promise<{
    id: string;
    title: string | null;
    model: string;
    reasoning_level: NonNullable<Message["reasoning"]>;
}> {
    return apiRequest(`/chat/${chatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reasoningLevel }),
        keepalive: true,
    });
}

export async function getChatPeople(chatId: string): Promise<ProjectPeople> {
    return apiRequest<ProjectPeople>(`/chat/${chatId}/people`);
}

export async function getChatAccess(chatId: string): Promise<ContentAccess> {
    return apiRequest<ContentAccess>(`/chat/${chatId}/access`);
}

export async function grantChatAccess(
    chatId: string,
    email: string,
    role: AccessAssignmentRole,
): Promise<ContentAccessGrant> {
    return apiRequest<ContentAccessGrant>(`/chat/${chatId}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role }),
    });
}

export async function revokeChatAccess(
    chatId: string,
    email: string,
): Promise<void> {
    await apiRequest(`/chat/${chatId}/access/${encodeURIComponent(email)}`, {
        method: "DELETE",
    });
}

export async function updateLastSelectedChatSettings(payload: {
    lastSelectedChatModel?: string;
    lastSelectedReasoningLevel?: NonNullable<Message["reasoning"]>;
}): Promise<UserProfile> {
    return apiRequest<UserProfile>("/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
    });
}

export async function deleteChat(chatId: string): Promise<void> {
    await apiRequest(`/chat/${chatId}`, { method: "DELETE" });
}

export async function generateChatTitle(
    chatId: string,
    message: string,
    model: string,
): Promise<{ title: string }> {
    return apiRequest<{ title: string }>(`/chat/${chatId}/generate-title`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, model }),
    });
}

const panelDocumentRequests = new Map<string, Promise<PanelDocument>>();

export async function getPanelDocument(
    documentId: string,
): Promise<PanelDocument> {
    let request = panelDocumentRequests.get(documentId);
    if (!request) {
        request = apiRequest<unknown>(
            `/documents/${encodeURIComponent(documentId)}`,
        )
            .then((value) => {
                if (!isPanelDocument(value)) {
                    throw new Error("Invalid source document response");
                }
                return value;
            })
            .finally(() => panelDocumentRequests.delete(documentId));
        panelDocumentRequests.set(documentId, request);
    }
    return request;
}

export async function streamChat(payload: {
    messages: {
        role: string;
        content: string;
        files?: MessageFile[];
        workflow?: { id: string; title: string };
    }[];
    chat_id?: string;
    project_id?: string;
    model?: string;
    reasoning?: Message["reasoning"];
    ask_inputs_response?: AskInputsResponsePayload;
    signal?: AbortSignal;
}): Promise<Response> {
    const { signal, ...body } = payload;
    return apiFetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal,
    });
}

type StreamChatMessage = {
    role: string;
    content: string;
    files?: MessageFile[];
    workflow?: { id: string; title: string };
};

export async function streamProjectChat(payload: {
    projectId: string;
    messages: StreamChatMessage[];
    chat_id?: string;
    model?: string;
    reasoning?: Message["reasoning"];
    displayed_doc?: { filename: string; document_id: string };
    attached_documents?: { filename: string; document_id: string }[];
    ask_inputs_response?: AskInputsResponsePayload;
    signal?: AbortSignal;
}): Promise<Response> {
    const { projectId, signal, ...body } = payload;
    return apiFetch(`${API_BASE}/projects/${projectId}/chat`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal,
    });
}

// ---------------------------------------------------------------------------
// Tabular Review
// ---------------------------------------------------------------------------

export async function listTabularReviews(
    projectId?: string,
    pagination?: {
        limit?: number;
        offset?: number;
        search?: string;
        sortKey?: string;
        sortDirection?: "asc" | "desc";
        scope?: "all" | "in-project" | "standalone";
        signal?: AbortSignal;
    },
): Promise<TabularReview[]> {
    const params = new URLSearchParams();
    if (projectId) params.set("project_id", projectId);
    if (pagination?.limit) params.set("limit", String(pagination.limit));
    if (pagination?.offset) params.set("offset", String(pagination.offset));
    if (pagination?.search) params.set("search", pagination.search);
    if (pagination?.sortKey) params.set("sort_key", pagination.sortKey);
    if (pagination?.sortDirection)
        params.set("sort_direction", pagination.sortDirection);
    if (pagination?.scope && pagination.scope !== "all")
        params.set("scope", pagination.scope);

    const qs = params.toString() ? `?${params.toString()}` : "";
    return apiRequest<TabularReview[]>(`/tabular-review${qs}`, {
        signal: pagination?.signal,
    });
}

export async function listTabularReviewIds(
    projectId?: string,
    options?: {
        search?: string;
        scope?: "all" | "in-project" | "standalone";
        signal?: AbortSignal;
    },
): Promise<{ id: string; user_id: string }[]> {
    const params = new URLSearchParams();
    if (projectId) params.set("project_id", projectId);
    if (options?.search) params.set("search", options.search);
    if (options?.scope && options.scope !== "all")
        params.set("scope", options.scope);

    const qs = params.toString() ? `?${params.toString()}` : "";
    return apiRequest<{ id: string; user_id: string }[]>(
        `/tabular-review/ids${qs}`,
        { signal: options?.signal },
    );
}

export async function createTabularReview(payload: {
    title?: string;
    document_ids: string[];
    columns_config: { index: number; name: string; prompt: string }[];
    workflow_id?: string;
    project_id?: string;
    document_grouping?: "document" | "folder";
    model: string;
}): Promise<TabularReview> {
    return apiRequest<TabularReview>("/tabular-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function getTabularReview(
    reviewId: string,
): Promise<TabularReviewDetailOut> {
    return apiRequest<TabularReviewDetailOut>(`/tabular-review/${reviewId}`);
}

export async function updateTabularReview(
    reviewId: string,
    payload: {
        title?: string;
        columns_config?: { index: number; name: string; prompt: string }[];
        document_ids?: string[];
        project_id?: string | null;
        document_grouping?: "document" | "folder";
        model?: string;
    },
): Promise<TabularReview> {
    return apiRequest<TabularReview>(`/tabular-review/${reviewId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function getTabularReviewPeople(
    reviewId: string,
): Promise<ProjectPeople> {
    return apiRequest<ProjectPeople>(`/tabular-review/${reviewId}/people`);
}

export async function getTabularReviewAccess(
    reviewId: string,
): Promise<ContentAccess> {
    return apiRequest<ContentAccess>(`/tabular-review/${reviewId}/access`);
}

export async function grantTabularReviewAccess(
    reviewId: string,
    email: string,
    role: AccessAssignmentRole,
): Promise<ContentAccessGrant> {
    return apiRequest<ContentAccessGrant>(
        `/tabular-review/${reviewId}/access`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, role }),
        },
    );
}

export async function revokeTabularReviewAccess(
    reviewId: string,
    email: string,
): Promise<void> {
    await apiRequest(
        `/tabular-review/${reviewId}/access/${encodeURIComponent(email)}`,
        { method: "DELETE" },
    );
}

export async function generateTabularColumnPrompt(
    title: string,
    options?: { format?: string; documentName?: string; tags?: string[] },
): Promise<{ prompt: string; source: "preset" | "llm" | "fallback" }> {
    return apiRequest<{
        prompt: string;
        source: "preset" | "llm" | "fallback";
    }>("/tabular-review/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            title,
            format: options?.format,
            documentName: options?.documentName,
            tags: options?.tags,
        }),
    });
}

export async function uploadReviewDocument(
    reviewId: string,
    file: File,
    options?: {
        projectId?: string;
        documentIds?: string[];
        columnsConfig?: { index: number; name: string; prompt: string }[];
    },
): Promise<Document> {
    const uploaded = options?.projectId
        ? await uploadProjectDocument(options.projectId, file)
        : await uploadStandaloneDocument(file);

    await updateTabularReview(reviewId, {
        columns_config: options?.columnsConfig,
        document_ids: [...(options?.documentIds ?? []), uploaded.id],
    });

    return uploaded;
}

export async function deleteTabularReview(reviewId: string): Promise<void> {
    await apiRequest(`/tabular-review/${reviewId}`, { method: "DELETE" });
}

export async function streamTabularGeneration(
    reviewId: string,
    expectedUpdatedAt: string,
    signal?: AbortSignal,
): Promise<Response> {
    return apiFetch(`${API_BASE}/tabular-review/${reviewId}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expected_updated_at: expectedUpdatedAt }),
        signal,
    });
}

/**
 * Reconnect to a generation that is already running (GET, not POST): a pure
 * observer that takes no generation lease and enqueues nothing, so resuming a
 * run can never 409 or restart it. Used when a stream drops mid-run and when
 * the view mounts on a review that is already `is_running`.
 */
export async function streamTabularGenerationResume(
    reviewId: string,
    signal?: AbortSignal,
): Promise<Response> {
    return apiFetch(`${API_BASE}/tabular-review/${reviewId}/generate/stream`, {
        signal: signal ?? undefined,
    });
}

export async function streamTabularChat(
    reviewId: string,
    messages: { role: string; content: string }[],
    chat_id?: string | null,
    signal?: AbortSignal,
    context?: { reviewTitle?: string | null; projectName?: string | null },
    model?: Message["model"],
    reasoning?: Message["reasoning"],
): Promise<Response> {
    return apiFetch(`${API_BASE}/tabular-review/${reviewId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            messages,
            chat_id: chat_id ?? undefined,
            review_title: context?.reviewTitle ?? undefined,
            project_name: context?.projectName ?? undefined,
            model,
            reasoning,
        }),
        signal: signal ?? undefined,
    });
}

export interface TRCitationAnnotation {
    type: "tabular_citation";
    ref: number;
    col_index: number;
    row_index: number;
    col_name: string;
    doc_name: string;
    quote: string;
}

interface RawTRMessage {
    id: string;
    chat_id: string;
    role: "user" | "assistant";
    content: string | AssistantEvent[] | null;
    annotations?: TRCitationAnnotation[] | null;
    created_at: string;
}

export interface TRDisplayMessage {
    role: "user" | "assistant";
    content: string;
    events?: AssistantEvent[];
    annotations?: TRCitationAnnotation[];
}

export interface TRChat {
    id: string;
    title: string | null;
    model: string | null;
    reasoning_level: NonNullable<Message["reasoning"]> | null;
    created_at: string;
    updated_at: string;
}

const TABULAR_CHAT_SELECTION_PREFIX = "tabular-review-chat:";

export function tabularChatSelectionKey(
    reviewId: string,
    chatId: string,
): string {
    return `${TABULAR_CHAT_SELECTION_PREFIX}${reviewId}:${chatId}`;
}

export function parseTabularChatSelectionKey(
    selectionKey: string,
): { reviewId: string; chatId: string } | null {
    if (!selectionKey.startsWith(TABULAR_CHAT_SELECTION_PREFIX)) return null;
    const value = selectionKey.slice(TABULAR_CHAT_SELECTION_PREFIX.length);
    const separatorIndex = value.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex === value.length - 1) return null;
    return {
        reviewId: value.slice(0, separatorIndex),
        chatId: value.slice(separatorIndex + 1),
    };
}

export function mapTRMessages(raw: RawTRMessage[]): TRDisplayMessage[] {
    return raw.map((m) => {
        if (m.role === "user") {
            return {
                role: "user" as const,
                content: typeof m.content === "string" ? m.content : "",
            };
        }
        const events = Array.isArray(m.content)
            ? (m.content as AssistantEvent[])
            : undefined;
        const content =
            events
                ?.filter((e) => e.type === "content")
                .map((e) => (e as { type: "content"; text: string }).text)
                .join("") ?? "";
        return {
            role: "assistant" as const,
            content,
            events,
            annotations: m.annotations ?? undefined,
        };
    });
}

export async function getTabularChats(reviewId: string): Promise<TRChat[]> {
    return apiRequest<TRChat[]>(`/tabular-review/${reviewId}/chats`);
}

export async function getTabularChatMessages(
    reviewId: string,
    chatId: string,
): Promise<RawTRMessage[]> {
    return apiRequest<RawTRMessage[]>(
        `/tabular-review/${reviewId}/chats/${chatId}/messages`,
    );
}

export async function deleteTabularChat(
    reviewId: string,
    chatId: string,
): Promise<void> {
    await apiRequest(`/tabular-review/${reviewId}/chats/${chatId}`, {
        method: "DELETE",
    });
}

export async function renameTabularChat(
    reviewId: string,
    chatId: string,
    title: string,
): Promise<void> {
    await apiRequest(`/tabular-review/${reviewId}/chats/${chatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
    });
}

export async function updateTabularChatModel(
    reviewId: string,
    chatId: string,
    model: string,
): Promise<TRChat> {
    return apiRequest(`/tabular-review/${reviewId}/chats/${chatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
        keepalive: true,
    });
}

export async function updateTabularChatReasoningLevel(
    reviewId: string,
    chatId: string,
    reasoningLevel: NonNullable<Message["reasoning"]>,
): Promise<TRChat> {
    return apiRequest(`/tabular-review/${reviewId}/chats/${chatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reasoningLevel }),
        keepalive: true,
    });
}

export async function regenerateTabularCell(
    reviewId: string,
    rowId: string,
    columnIndex: number,
): Promise<
    | {
          summary: string;
          flag: "green" | "grey" | "yellow" | "red";
          reasoning: string;
      }
    // HTTP 202 — regeneration continues in the background
    | { status: "generating" }
> {
    return apiRequest(`/tabular-review/${reviewId}/regenerate-cell`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            row_id: rowId,
            column_index: columnIndex,
        }),
    });
}

export async function clearTabularCells(
    reviewId: string,
    rowIds: string[],
): Promise<void> {
    await apiRequest(`/tabular-review/${reviewId}/clear-cells`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ row_ids: rowIds }),
    });
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

type WorkflowType = Workflow["metadata"]["type"];

export async function listWorkflows(type?: WorkflowType): Promise<Workflow[]> {
    return apiRequest<Workflow[]>(
        type ? `/workflows?type=${type}` : "/workflows",
    );
}

// Paginated sibling of listWorkflows() used only by WorkflowList.tsx.
// Deliberately a separate function, not an overload — the backend route
// decides whether to paginate based on whether any of these query params
// are present at all, so listWorkflows() must keep sending none of them
// (every other caller — the workflow picker modal, the chat slash-menu
// picker, UseWorkflowModal's own independent fetch — needs the exact legacy
// response shape, system workflows included). Returns DB-backed rows only
// (always is_system: false) — system workflows come from listSystemWorkflows.
export async function listWorkflowsPage(pagination?: {
    limit?: number;
    offset?: number;
    search?: string;
    sortKey?: string;
    sortDirection?: "asc" | "desc";
    scope?: "all" | "owned" | "shared" | "private" | "collaborative";
    type?: WorkflowType;
    practice?: string;
    language?: string;
    jurisdiction?: string;
    signal?: AbortSignal;
}): Promise<Workflow[]> {
    const params = new URLSearchParams();
    if (pagination?.type) params.set("type", pagination.type);
    if (pagination?.limit) params.set("limit", String(pagination.limit));
    if (pagination?.offset) params.set("offset", String(pagination.offset));
    if (pagination?.search) params.set("search", pagination.search);
    if (pagination?.sortKey) params.set("sort_key", pagination.sortKey);
    if (pagination?.sortDirection)
        params.set("sort_direction", pagination.sortDirection);
    if (pagination?.scope && pagination.scope !== "all")
        params.set("scope", pagination.scope);
    if (pagination?.practice) params.set("practice", pagination.practice);
    if (pagination?.language) params.set("language", pagination.language);
    if (pagination?.jurisdiction)
        params.set("jurisdiction", pagination.jurisdiction);

    const qs = params.toString() ? `?${params.toString()}` : "";
    return apiRequest<Workflow[]>(`/workflows${qs}`, {
        signal: pagination?.signal,
    });
}

export async function listWorkflowIds(options?: {
    search?: string;
    scope?: "all" | "owned" | "shared" | "private" | "collaborative";
    type?: WorkflowType;
    practice?: string;
    language?: string;
    jurisdiction?: string;
    signal?: AbortSignal;
}): Promise<{ id: string; user_id: string }[]> {
    const params = new URLSearchParams();
    if (options?.type) params.set("type", options.type);
    if (options?.search) params.set("search", options.search);
    if (options?.scope && options.scope !== "all")
        params.set("scope", options.scope);
    if (options?.practice) params.set("practice", options.practice);
    if (options?.language) params.set("language", options.language);
    if (options?.jurisdiction) params.set("jurisdiction", options.jurisdiction);

    const qs = params.toString() ? `?${params.toString()}` : "";
    return apiRequest<{ id: string; user_id: string }[]>(
        `/workflows/ids${qs}`,
        {
            signal: options?.signal,
        },
    );
}

// Always-unpaginated: the static, code-generated system-workflow list (37
// entries, zero user-data growth). Fetched once by usePaginatedWorkflows and
// kept fully in memory rather than folded into the paginated RPC above.
export async function listSystemWorkflows(
    type?: WorkflowType,
): Promise<Workflow[]> {
    const qs = type ? `?type=${type}` : "";
    return apiRequest<Workflow[]>(`/workflows/system${qs}`);
}

export interface WorkflowFilterOptions {
    practices: string[];
    languages: string[];
    jurisdictions: string[];
}

export async function getWorkflowFilterOptions(options?: {
    type?: WorkflowType;
    scope?: "all" | "owned" | "shared";
    signal?: AbortSignal;
}): Promise<WorkflowFilterOptions> {
    const params = new URLSearchParams();
    if (options?.type) params.set("type", options.type);
    if (options?.scope && options.scope !== "all")
        params.set("scope", options.scope);
    const query = params.toString();
    return apiRequest<WorkflowFilterOptions>(
        `/workflows/filter-options${query ? `?${query}` : ""}`,
        {
            signal: options?.signal,
        },
    );
}

export async function getWorkflow(workflowId: string): Promise<Workflow> {
    return apiRequest<Workflow>(`/workflows/${workflowId}`);
}

export async function createWorkflow(payload: {
    metadata: {
        title: string;
        type: "assistant" | "tabular";
        language?: string | null;
        practice?: string | null;
        jurisdictions?: string[] | null;
    };
    skill_md?: string;
    columns_config?: { index: number; name: string; prompt: string }[];
    org_id?: string;
}): Promise<Workflow> {
    return apiRequest<Workflow>("/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function updateWorkflow(
    workflowId: string,
    payload: {
        metadata?: {
            title?: string;
            language?: string | null;
            practice?: string | null;
            jurisdictions?: string[] | null;
        };
        skill_md?: string;
        columns_config?: { index: number; name: string; prompt: string }[];
    },
): Promise<Workflow> {
    return apiRequest<Workflow>(`/workflows/${workflowId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function deleteWorkflow(workflowId: string): Promise<void> {
    await apiRequest(`/workflows/${workflowId}`, { method: "DELETE" });
}

export async function openSourceWorkflow(
    workflowId: string,
    payload: {
        contributor_mode: OpenSourceWorkflowContributorMode;
        contributor?: WorkflowContributor | null;
    },
): Promise<OpenSourceWorkflowResponse> {
    return apiRequest<OpenSourceWorkflowResponse>(
        `/workflows/${workflowId}/open-source`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        },
    );
}

export async function listHiddenWorkflows(): Promise<string[]> {
    return apiRequest<string[]>("/workflows/hidden");
}

export async function hideWorkflow(workflowId: string): Promise<void> {
    await apiRequest("/workflows/hidden", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow_id: workflowId }),
    });
}

export async function unhideWorkflow(workflowId: string): Promise<void> {
    await apiRequest(`/workflows/hidden/${workflowId}`, { method: "DELETE" });
}

export async function shareWorkflow(
    workflowId: string,
    payload: { emails: string[]; role: AccessAssignmentRole },
): Promise<void> {
    await apiRequest<void>(`/workflows/${workflowId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function listWorkflowShares(workflowId: string): Promise<
    {
        id: string;
        user_id?: string;
        shared_with_email: string;
        display_name?: string | null;
        role: AccessAssignmentRole;
        created_at?: string;
    }[]
> {
    return apiRequest(`/workflows/${workflowId}/shares`);
}

export async function getWorkflowPeople(
    workflowId: string,
): Promise<ProjectPeople> {
    return apiRequest<ProjectPeople>(`/workflows/${workflowId}/people`);
}

export async function deleteWorkflowShare(
    workflowId: string,
    shareId: string,
): Promise<void> {
    await apiRequest(`/workflows/${workflowId}/shares/${shareId}`, {
        method: "DELETE",
    });
}

export async function listQuickActions(
    surface: QuickAction["surface"] = "app",
): Promise<QuickAction[]> {
    return apiRequest<QuickAction[]>(`/quick-actions?surface=${surface}`);
}

export async function createQuickAction(payload: {
    workflow_id: string;
    name: string;
    prompt: string;
    document_upload: boolean;
    surface: QuickAction["surface"];
    enabled?: boolean;
    sort_order?: number;
}): Promise<QuickAction> {
    return apiRequest<QuickAction>("/quick-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function updateQuickAction(
    quickActionId: string,
    payload: Partial<
        Pick<
            QuickAction,
            | "workflow_id"
            | "name"
            | "prompt"
            | "document_upload"
            | "surface"
            | "enabled"
            | "sort_order"
        >
    >,
): Promise<QuickAction> {
    return apiRequest<QuickAction>(`/quick-actions/${quickActionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function deleteQuickAction(quickActionId: string): Promise<void> {
    await apiRequest(`/quick-actions/${quickActionId}`, { method: "DELETE" });
}

export async function listWorkflowAddons(): Promise<WorkflowAddon[]> {
    return apiRequest<WorkflowAddon[]>("/workflow-addons");
}

export async function getWorkflowAddon(
    addonId: string,
): Promise<WorkflowAddon> {
    return apiRequest<WorkflowAddon>(`/workflow-addons/${addonId}`);
}

export async function importWorkflowAddon(addonId: string): Promise<Workflow> {
    return apiRequest<Workflow>(`/workflow-addons/${addonId}/import`, {
        method: "POST",
    });
}

export async function listWorkflowAssets(
    workflowId: string,
): Promise<Document[]> {
    return apiRequest<Document[]>(`/workflows/${workflowId}/assets`);
}

export async function copyDocumentsToWorkflowAssets(
    workflowId: string,
    documentIds: string[],
): Promise<Document[]> {
    return apiRequest<Document[]>(
        `/workflows/${workflowId}/assets/from-documents`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ document_ids: documentIds }),
        },
    );
}

export async function uploadWorkflowAsset(
    workflowId: string,
    file: File,
    options?: UploadRequestOptions<Document>,
): Promise<Document> {
    return firstUploadResult(
        await uploadWorkflowAssets(workflowId, [{ file }], options),
    );
}

export async function uploadWorkflowAssets(
    workflowId: string,
    files: UploadSessionInput[],
    options?: UploadRequestOptions<Document>,
): Promise<UploadOutcome<Document>[]> {
    return uploadFilesWithSession<Document>({
        purpose: "document_create",
        destination: { scope: "workflow", workflow_id: workflowId },
        files,
        onProgress: options?.onProgress,
        signal: options?.signal,
    });
}

export function workflowAddonAssetDisplayUrl(
    addonId: string,
    assetId: string,
): string {
    return `${API_BASE}/workflow-addons/${encodeURIComponent(addonId)}/assets/${encodeURIComponent(assetId)}/display`;
}

export async function deleteWorkflowAsset(
    workflowId: string,
    assetId: string,
): Promise<void> {
    await apiRequest(`/workflows/${workflowId}/assets/${assetId}`, {
        method: "DELETE",
    });
}
