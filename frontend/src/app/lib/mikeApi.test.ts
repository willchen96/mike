import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantEvent, Chat } from "@/app/components/shared/types";

import {
    MikeApiError,
    addDocumentToProject,
    clearTabularCells,
    completeUserOnboarding,
    copyDocumentVersionFromDocument,
    copyDocumentsToWorkflowAssets,
    createChat,
    createQuickAction,
    createLibraryFolder,
    createMcpConnector,
    createProject,
    createProjectFolder,
    createTabularReview,
    createWorkflow,
    deleteAccount,
    deleteAllChats,
    deleteAllProjects,
    deleteAllTabularReviews,
    deleteChat,
    deleteDocument,
    deleteDocumentVersion,
    deleteLibraryFolder,
    deleteMcpConnector,
    deleteProject,
    deleteProjectFolder,
    deleteTabularChat,
    deleteTabularReview,
    deleteWorkflow,
    deleteWorkflowAsset,
    deleteWorkflowShare,
    disconnectGoogleDrive,
    downloadDocumentsZip,
    downloadUserExport,
    exportAccountData,
    exportAuditHistory,
    exportChatData,
    exportTabularReviewsData,
    generateChatTitle,
    generateTabularColumnPrompt,
    getApiKeyStatus,
    getChatAccess,
    getChat,
    getChatPeople,
    getAuditHistory,
    getPanelDocument,
    getDocument,
    getDocumentUrl,
    getLibrary,
    getLibraryLevels,
    getLibraryFilterOptions,
    getLibraryFolderChildren,
    getLibraryFolderPath,
    getGoogleDriveStatus,
    getMcpConnector,
    getOllamaModels,
    getOpenCodeGoModels,
    getOpenRouterModels,
    getVercelModels,
    getProject,
    getProjectDirectoryLevel,
    getProjectFilterOptions,
    getProjectPeople,
    getTabularChatMessages,
    getTabularChats,
    getTabularReview,
    getTabularReviewAccess,
    getTabularReviewPeople,
    getUserExportStatus,
    getUserProfile,
    getWorkflow,
    getWorkflowPeople,
    getWorkflowAddon,
    getWorkflowFilterOptions,
    hideWorkflow,
    isMfaRequiredError,
    acceptOrgInvitation,
    cancelOrgInvitation,
    createOrg,
    createOrgInvitation,
    deleteOrg,
    declineOrgInvitation,
    getOrg,
    getProjectAccess,
    grantProjectAccess,
    grantChatAccess,
    grantTabularReviewAccess,
    listChats,
    listMyOrgInvitations,
    listOrgInvitations,
    listOrgMembers,
    listOrgResources,
    listOrgs,
    removeOrgMember,
    resendOrgInvitation,
    revokeProjectAccess,
    revokeChatAccess,
    revokeTabularReviewAccess,
    updateOrgMember,
    updateOrg,
    listDocumentVersions,
    listHiddenWorkflows,
    listLibraryDocumentIds,
    listMcpConnectors,
    listProjectChats,
    listProjectIds,
    listProjectSummaries,
    listProjects,
    listProjectsPage,
    listStandaloneDocuments,
    listSystemWorkflows,
    listTabularReviewIds,
    listTabularReviews,
    listWorkflowIds,
    listWorkflowAddons,
    listWorkflowAssets,
    listWorkflowShares,
    listWorkflows,
    listWorkflowsPage,
    lookupUserByEmail,
    mapTRMessages,
    workflowAddonAssetDisplayUrl,
    moveDocumentToFolder,
    moveLibraryDocument,
    moveLibraryFolder,
    moveSubfolderToFolder,
    openSourceWorkflow,
    refreshMcpConnectorTools,
    regenerateTabularCell,
    renameChat,
    renameDocumentVersion,
    renameLibraryDocument,
    renameLibraryFolder,
    renameProjectDocument,
    renameProjectFolder,
    renameTabularChat,
    resolveLibraryFolderPath,
    resolveProjectFolderPath,
    resolveDocumentEdit,
    saveApiKey,
    bulkDeleteLibraryDocuments,
    searchProjectDirectory,
    searchLibraryDocuments,
    setMcpToolEnabled,
    shareWorkflow,
    startGoogleDriveOAuth,
    startMcpConnectorOAuth,
    startUserExport,
    streamChat,
    streamProjectChat,
    streamTabularChat,
    streamTabularGeneration,
    streamTabularGenerationResume,
    syncUserPasswordSet,
    tabularChatSelectionKey,
    parseTabularChatSelectionKey,
    unhideWorkflow,
    updateMcpConnector,
    updateProject,
    updateChatModel,
    updateChatReasoningLevel,
    updateLastSelectedChatSettings,
    updateTabularChatModel,
    updateTabularChatReasoningLevel,
    updateTabularReview,
    updateUserMfaOnLogin,
    updateUserProfile,
    updateWorkflow,
    updateQuickAction,
    deleteQuickAction,
    importWorkflowAddon,
    listQuickActions,
} from "./mikeApi";

const fetchMock = vi.fn();

const jsonResponse = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
        ...init,
    });

/** Build a Response whose body is a real ReadableStream of the given chunks. */
const streamResponse = (chunks: string[]) => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
        },
    });
    return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
    });
};

const readAll = async (response: Response) => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
};

const lastFetchCall = () => {
    const call = fetchMock.mock.calls.at(-1);
    if (!call) throw new Error("fetch was not called");
    return { url: call[0] as string, init: call[1] as RequestInit };
};

beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe("MikeApiError / isMfaRequiredError", () => {
    it("carries status and code, defaulting code to null", () => {
        const withCode = new MikeApiError({
            message: "nope",
            status: 403,
            code: "mfa_verification_required",
        });
        expect(withCode.name).toBe("MikeApiError");
        expect(withCode.status).toBe(403);
        expect(withCode.code).toBe("mfa_verification_required");

        const withoutCode = new MikeApiError({ message: "nope", status: 500 });
        expect(withoutCode.code).toBeNull();
    });

    it("recognizes exactly the 403 + mfa_verification_required combination", () => {
        expect(
            isMfaRequiredError(
                new MikeApiError({
                    message: "x",
                    status: 403,
                    code: "mfa_verification_required",
                }),
            ),
        ).toBe(true);
        expect(
            isMfaRequiredError(
                new MikeApiError({ message: "x", status: 403, code: "other" }),
            ),
        ).toBe(false);
        expect(
            isMfaRequiredError(
                new MikeApiError({
                    message: "x",
                    status: 401,
                    code: "mfa_verification_required",
                }),
            ),
        ).toBe(false);
        expect(isMfaRequiredError(new Error("plain"))).toBe(false);
    });
});

describe("apiRequest plumbing (via thin wrappers)", () => {
    it("uses the cookie-authenticated gateway and JSON accept header", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ tier: "free" }));

        const profile = await getUserProfile();

        expect(profile).toEqual({ tier: "free" });
        const { url, init } = lastFetchCall();
        expect(url).toBe("/api/user/profile");
        expect(init.cache).toBe("no-store");
        expect(init.headers).toMatchObject({
            Accept: "application/json",
        });
        expect(init.credentials).toBe("include");
    });

    it("never attaches an Authorization header", async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));

        await listProjects();

        const { init } = lastFetchCall();
        expect(
            (init.headers as Record<string, string>).Authorization,
        ).toBeUndefined();
        expect(init.credentials).toBe("include");
    });

    it("appends ?include=documents when requested", async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));

        await listProjects({ includeDocuments: true });

        expect(lastFetchCall().url).toBe("/api/projects?include=documents");
    });

    // Regression guard: legacy tabular-review project pickers call
    // listProjects() with no
    // arguments and need every project back. The backend route decides
    // whether to paginate purely by checking whether pagination-related
    // query params are present at all — if listProjects() ever started
    // sending one, those callers would silently start seeing a truncated
    // list instead of an error.
    it("sends no query string at all, so the backend never paginates it", async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));

        await listProjects();

        expect(lastFetchCall().url).toBe("/api/projects");
    });

    it("returns undefined for 204 responses", async () => {
        fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

        await expect(deleteAllChats()).resolves.toBeUndefined();
        expect(lastFetchCall().init.method).toBe("DELETE");
    });

    it("returns undefined when content-length is 0", async () => {
        fetchMock.mockResolvedValue(
            new Response(null, {
                status: 200,
                headers: { "content-length": "0" },
            }),
        );

        await expect(deleteAllChats()).resolves.toBeUndefined();
    });

    it("maps a JSON error body to a MikeApiError with code and detail", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse(
                { detail: "MFA required", code: "mfa_verification_required" },
                { status: 403 },
            ),
        );

        const error = await getUserProfile().catch((e: unknown) => e);

        expect(error).toBeInstanceOf(MikeApiError);
        const apiError = error as MikeApiError;
        expect(apiError.status).toBe(403);
        expect(apiError.code).toBe("mfa_verification_required");
        expect(apiError.message).toBe("MFA required");
        expect(isMfaRequiredError(apiError)).toBe(true);
    });

    it("falls back to a generic message when detail is not a string", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ detail: { nested: true } }, { status: 500 }),
        );

        await expect(getUserProfile()).rejects.toMatchObject({
            status: 500,
            code: null,
            message: "Something went wrong. Please try again.",
        });
    });

    it("labels a 4xx with its status when the detail is unusable", async () => {
        // The non-5xx sibling of the test above: a client error whose detail
        // is not a usable string gets the status-labelled fallback, never the
        // internal-error copy reserved for 5xx.
        fetchMock.mockResolvedValue(
            jsonResponse({ detail: { nested: true } }, { status: 404 }),
        );

        await expect(getUserProfile()).rejects.toMatchObject({
            status: 404,
            code: null,
            message: "API error: 404",
        });
    });

    it("discards raw JSON details from 5xx responses and keeps the request ID", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse(
                {
                    code: "internal_error",
                    detail: "schema cache exposed an internal function name",
                    request_id: "req-public-123",
                },
                { status: 500 },
            ),
        );

        await expect(getUserProfile()).rejects.toMatchObject({
            status: 500,
            code: "internal_error",
            requestId: "req-public-123",
            message: "Something went wrong. Please try again.",
        });
    });

    it("does not expose non-JSON server error responses", async () => {
        fetchMock.mockResolvedValue(
            new Response("upstream exploded", { status: 502 }),
        );

        await expect(getUserProfile()).rejects.toMatchObject({
            status: 502,
            message: "Something went wrong. Please try again.",
        });
    });

    it("synthesizes a message when the error body is empty", async () => {
        fetchMock.mockResolvedValue(new Response("", { status: 503 }));

        await expect(getUserProfile()).rejects.toMatchObject({
            status: 503,
            message: "Something went wrong. Please try again.",
        });
    });

    it("encodes query parameters (lookupUserByEmail, listChats)", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ exists: false }));
        await lookupUserByEmail("a+b@example.com");
        expect(lastFetchCall().url).toBe(
            "/api/user/lookup?email=a%2Bb%40example.com",
        );

        fetchMock.mockResolvedValue(jsonResponse([]));
        await listChats({ limit: 5, offset: 10 });
        expect(lastFetchCall().url).toBe("/api/chat?limit=5&offset=10");
    });
});

describe("blob requests (exportAccountData)", () => {
    it("returns the blob and the filename from content-disposition", async () => {
        fetchMock.mockResolvedValue(
            new Response("zip-bytes", {
                status: 200,
                headers: {
                    "content-disposition": 'attachment; filename="export.zip"',
                },
            }),
        );

        const { blob, filename } = await exportAccountData();

        expect(filename).toBe("export.zip");
        expect(await blob.text()).toBe("zip-bytes");
    });

    it("parses unquoted filenames and returns null when absent", async () => {
        fetchMock.mockResolvedValue(
            new Response("x", {
                status: 200,
                headers: {
                    "content-disposition": "attachment; filename=data.zip",
                },
            }),
        );
        expect((await exportAccountData()).filename).toBe("data.zip");

        fetchMock.mockResolvedValue(new Response("x", { status: 200 }));
        expect((await exportAccountData()).filename).toBeNull();
    });

    it("throws a MikeApiError on failure", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ detail: "not allowed" }, { status: 403 }),
        );

        await expect(exportAccountData()).rejects.toMatchObject({
            status: 403,
            message: "not allowed",
        });
    });
});

describe("audit history", () => {
    it("serializes server-side filters, sorting, pagination, and the abort signal", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ events: [], total: 0, page: 3, pageSize: 50 }),
        );
        const controller = new AbortController();

        await getAuditHistory(
            {
                q: "agreement",
                action: "document.edited",
                status: "completed",
                surface: "project",
                from: "2026-08-01",
                to: "2026-08-12",
                sortBy: "title",
                sortDirection: "asc",
                page: 3,
            },
            controller.signal,
        );

        const { url, init } = lastFetchCall();
        expect(url).toBe(
            "/api/audit?q=agreement&action=document.edited&status=completed&surface=project&from=2026-08-01&to=2026-08-12&sort_by=title&sort_dir=asc&page=3",
        );
        expect(init.signal).toBe(controller.signal);
    });

    it("exports with the same active filters and server-side sort", async () => {
        fetchMock.mockResolvedValue(
            new Response("history", {
                status: 200,
                headers: {
                    "content-disposition": 'attachment; filename="history.csv"',
                },
            }),
        );

        const result = await exportAuditHistory({
            q: "agreement",
            action: "document.edited",
            status: "failed",
            surface: "assistant",
            from: "2026-07-01",
            to: "2026-07-31",
            sortBy: "created_at",
            sortDirection: "desc",
        });

        expect(lastFetchCall().url).toBe(
            "/api/audit/export?q=agreement&action=document.edited&status=failed&surface=assistant&from=2026-07-01&to=2026-07-31&sort_by=created_at&sort_dir=desc",
        );
        expect(result.filename).toBe("history.csv");
        expect(await result.blob.text()).toBe("history");
    });

    it("omits every optional audit parameter when no filters are active", async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({ events: [], total: 0, page: 1, pageSize: 50 }),
        );

        await getAuditHistory({});
        expect(lastFetchCall().url).toBe("/api/audit?");

        fetchMock.mockResolvedValueOnce(
            new Response("history", { status: 200 }),
        );

        await exportAuditHistory({});
        expect(lastFetchCall().url).toBe("/api/audit/export?");
    });
});

describe("downloadDocumentsZip", () => {
    it("POSTs the document ids and returns the blob", async () => {
        fetchMock.mockResolvedValue(new Response("zip", { status: 200 }));

        const blob = await downloadDocumentsZip(["d1", "d2"]);

        expect(await blob.text()).toBe("zip");
        const { url, init } = lastFetchCall();
        expect(url).toBe("/api/single-documents/download-zip");
        expect(JSON.parse(init.body as string)).toEqual({
            document_ids: ["d1", "d2"],
            folder_ids: [],
        });
    });

    it("POSTs folder ids for recursive downloads", async () => {
        fetchMock.mockResolvedValue(new Response("zip", { status: 200 }));

        await downloadDocumentsZip(["d1"], ["folder-1"]);

        expect(JSON.parse(lastFetchCall().init.body as string)).toEqual({
            document_ids: ["d1"],
            folder_ids: ["folder-1"],
        });
    });

    it("does not expose a non-JSON error response", async () => {
        fetchMock.mockResolvedValue(new Response("bad ids", { status: 400 }));

        await expect(downloadDocumentsZip(["x"])).rejects.toThrow(
            "The request could not be completed. Please try again.",
        );
    });
});

describe("getChat message mapping", () => {
    const chat: Chat = {
        id: "c1",
        project_id: null,
        user_id: "u1",
        title: "T",
        created_at: "2026-01-01",
    };

    it("maps user messages, keeping files and workflow", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({
                chat,
                messages: [
                    {
                        id: "m1",
                        chat_id: "c1",
                        role: "user",
                        content: "hello",
                        files: [
                            {
                                filename: "a.pdf",
                                document_id: "d1",
                                version_id: "v2",
                                version_number: 2,
                            },
                        ],
                        workflow: { id: "w1", title: "NDA review" },
                        created_at: "2026-01-01",
                    },
                    {
                        id: "m2",
                        chat_id: "c1",
                        role: "user",
                        content: null,
                        created_at: "2026-01-01",
                    },
                ],
            }),
        );

        const { messages } = await getChat("c1");

        expect(messages[0]).toEqual({
            id: "m1",
            role: "user",
            content: "hello",
            files: [
                {
                    filename: "a.pdf",
                    document_id: "d1",
                    version_id: "v2",
                    version_number: 2,
                },
            ],
            workflow: { id: "w1", title: "NDA review" },
        });
        // Non-string user content degrades to an empty string.
        expect(messages[1].content).toBe("");
    });

    it("joins assistant content events into content and preserves events", async () => {
        const events: AssistantEvent[] = [
            { type: "reasoning", text: "thinking" },
            { type: "content", text: "Part one. " },
            { type: "doc_read", filename: "a.pdf" },
            { type: "content", text: "Part two." },
        ];
        fetchMock.mockResolvedValue(
            jsonResponse({
                chat,
                messages: [
                    {
                        id: "m1",
                        chat_id: "c1",
                        role: "assistant",
                        content: events,
                        citations: [{ ref: 1 }],
                        created_at: "2026-01-01",
                    },
                ],
            }),
        );

        const { messages } = await getChat("c1");

        expect(messages[0].content).toBe("Part one. Part two.");
        expect(messages[0].events).toEqual(events);
        expect(messages[0].citations).toEqual([{ ref: 1 }]);
    });

    it("maps a legacy string assistant body to empty content without events", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({
                chat,
                messages: [
                    {
                        id: "m1",
                        chat_id: "c1",
                        role: "assistant",
                        content: "plain string",
                        created_at: "2026-01-01",
                    },
                ],
            }),
        );

        const { messages } = await getChat("c1");

        expect(messages[0].content).toBe("");
        expect(messages[0].events).toBeUndefined();
    });
});

describe("mapTRMessages", () => {
    it("maps user and assistant rows including annotations", () => {
        const events: AssistantEvent[] = [{ type: "content", text: "Answer" }];
        const mapped = mapTRMessages([
            {
                id: "m1",
                chat_id: "c1",
                role: "user",
                content: "question",
                created_at: "2026-01-01",
            },
            {
                id: "m2",
                chat_id: "c1",
                role: "assistant",
                content: events,
                annotations: [
                    {
                        type: "tabular_citation",
                        ref: 1,
                        col_index: 0,
                        row_index: 2,
                        col_name: "Term",
                        doc_name: "a.pdf",
                        quote: "12 months",
                    },
                ],
                created_at: "2026-01-01",
            },
        ]);

        expect(mapped).toEqual([
            { role: "user", content: "question" },
            {
                role: "assistant",
                content: "Answer",
                events,
                annotations: [
                    {
                        type: "tabular_citation",
                        ref: 1,
                        col_index: 0,
                        row_index: 2,
                        col_name: "Term",
                        doc_name: "a.pdf",
                        quote: "12 months",
                    },
                ],
            },
        ]);
    });

    it("degrades non-array assistant content to an empty string", () => {
        const mapped = mapTRMessages([
            {
                id: "m1",
                chat_id: "c1",
                role: "assistant",
                content: "legacy",
                created_at: "2026-01-01",
            },
        ]);
        expect(mapped[0]).toEqual({
            role: "assistant",
            content: "",
            events: undefined,
            annotations: undefined,
        });
    });
});

// ---------------------------------------------------------------------------
// Streaming endpoints. These are the frontend half of the SSE contract: the
// backend answers these POSTs with `data: <json>\n\n` server-sent-event lines,
// and these functions must hand the raw streaming Response through untouched
// so the consumer (useAssistantChat and the tabular loops) can parse it
// incrementally. Parsing itself is covered in
// src/app/hooks/useAssistantChat.sse.test.ts.
// ---------------------------------------------------------------------------

describe("streamChat", () => {
    it("POSTs with the SSE accept header and forwards the signal outside the body", async () => {
        fetchMock.mockResolvedValue(streamResponse([]));
        const controller = new AbortController();

        await streamChat({
            messages: [{ role: "user", content: "hi" }],
            chat_id: "c1",
            model: "gemini-3-flash-preview",
            signal: controller.signal,
        });

        const { url, init } = lastFetchCall();
        expect(url).toBe("/api/chat");
        expect(init.method).toBe("POST");
        expect(init.headers).toMatchObject({
            "Content-Type": "application/json",
            Accept: "text/event-stream",
        });
        expect(init.signal).toBe(controller.signal);
        // The abort signal must not leak into the JSON payload.
        expect(JSON.parse(init.body as string)).toEqual({
            messages: [{ role: "user", content: "hi" }],
            chat_id: "c1",
            model: "gemini-3-flash-preview",
        });
    });

    it("returns the streaming Response body unconsumed", async () => {
        const chunks = [
            'data: {"type":"content_delta","text":"Hel',
            'lo"}\n\n',
        ];
        fetchMock.mockResolvedValue(streamResponse(chunks));

        const response = await streamChat({
            messages: [{ role: "user", content: "hi" }],
        });

        expect(response.bodyUsed).toBe(false);
        expect(await readAll(response)).toBe(chunks.join(""));
    });
});

describe("streamProjectChat", () => {
    it("targets the project chat route and strips projectId/signal from the body", async () => {
        fetchMock.mockResolvedValue(streamResponse([]));
        const controller = new AbortController();

        await streamProjectChat({
            projectId: "p1",
            messages: [{ role: "user", content: "hi" }],
            displayed_doc: { filename: "a.pdf", document_id: "d1" },
            signal: controller.signal,
        });

        const { url, init } = lastFetchCall();
        expect(url).toBe("/api/projects/p1/chat");
        expect(init.signal).toBe(controller.signal);
        expect(JSON.parse(init.body as string)).toEqual({
            messages: [{ role: "user", content: "hi" }],
            displayed_doc: { filename: "a.pdf", document_id: "d1" },
        });
    });
});

describe("streamTabularChat", () => {
    it("maps independent chat settings and context into the payload", async () => {
        fetchMock.mockResolvedValue(streamResponse([]));

        await streamTabularChat(
            "r1",
            [{ role: "user", content: "summarize" }],
            null,
            undefined,
            { reviewTitle: "Leases", projectName: null },
            "openai-gpt-5.2",
            "low",
        );

        const { url, init } = lastFetchCall();
        expect(url).toBe("/api/tabular-review/r1/chat");
        expect(JSON.parse(init.body as string)).toEqual({
            messages: [{ role: "user", content: "summarize" }],
            review_title: "Leases",
            model: "openai-gpt-5.2",
            reasoning: "low",
        });
    });
});

describe("streamTabularGeneration", () => {
    it("POSTs to the generate route with auth and an abort signal", async () => {
        fetchMock.mockResolvedValue(streamResponse([]));
        const controller = new AbortController();

        await streamTabularGeneration(
            "r1",
            "2026-08-22T10:00:00.000Z",
            controller.signal,
        );

        const { url, init } = lastFetchCall();
        expect(url).toBe("/api/tabular-review/r1/generate");
        expect(init.method).toBe("POST");
        expect(init.headers).toEqual({
            "Content-Type": "application/json",
        });
        expect(JSON.parse(init.body as string)).toEqual({
            expected_updated_at: "2026-08-22T10:00:00.000Z",
        });
        expect(init.signal).toBe(controller.signal);
    });
});

describe("streamTabularGenerationResume", () => {
    it("GETs the resumable stream view (no body, no lease taken)", async () => {
        fetchMock.mockResolvedValue(streamResponse([]));
        const controller = new AbortController();

        await streamTabularGenerationResume("r1", controller.signal);

        const { url, init } = lastFetchCall();
        expect(url).toBe("/api/tabular-review/r1/generate/stream");
        // A GET with no expected_updated_at: resuming observes a run, it never
        // starts one, so it cannot 409 review_running/review_stale.
        expect(init.method).toBeUndefined();
        expect(init.body).toBeUndefined();
        expect(init.signal).toBe(controller.signal);
    });

    it("passes no signal when the caller has none to forward", async () => {
        fetchMock.mockResolvedValue(streamResponse([]));

        await streamTabularGenerationResume("r1");

        expect(lastFetchCall().init.signal).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Tabular review listing. This is the query-building half of the paginated
// review list (PR #263 db-pagination + PR #274 folder grouping): the backend
// scopes, sorts, and pages entirely off these params, so a silently dropped
// or misnamed param means the UI shows the wrong rows, not an error.
// ---------------------------------------------------------------------------

describe("listTabularReviews", () => {
    it("requests the bare collection when no filters are given", async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));

        await listTabularReviews();

        const { url, init } = lastFetchCall();
        // No stray "?" — the backend treats /tabular-review and
        // /tabular-review? the same, but the cache key would differ.
        expect(url).toBe("/api/tabular-review");
        expect(init.signal).toBeUndefined();
    });

    it("serializes every pagination knob and forwards the abort signal", async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));
        const controller = new AbortController();

        await listTabularReviews("p1", {
            limit: 25,
            offset: 50,
            search: "lease agreements",
            sortKey: "updated_at",
            sortDirection: "desc",
            scope: "standalone",
            signal: controller.signal,
        });

        const { url, init } = lastFetchCall();
        expect(url).toBe(
            "/api/tabular-review" +
                "?project_id=p1&limit=25&offset=50&search=lease+agreements" +
                "&sort_key=updated_at&sort_direction=desc&scope=standalone",
        );
        // The signal lets the list screen cancel a stale page when the user
        // types a new search before the previous one resolves.
        expect(init.signal).toBe(controller.signal);
    });

    it('omits the scope param for "all" — the backend default', async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));

        await listTabularReviews(undefined, { scope: "all", limit: 10 });

        expect(lastFetchCall().url).toBe("/api/tabular-review?limit=10");
    });
});

describe("listTabularReviewIds", () => {
    it("requests the bare id list when no filters are given", async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));

        await listTabularReviewIds();

        expect(lastFetchCall().url).toBe("/api/tabular-review/ids");
    });

    it("scopes ids by project, search, and scope so select-all matches the visible filter", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse([{ id: "r1", user_id: "u1" }]),
        );
        const controller = new AbortController();

        const ids = await listTabularReviewIds("p1", {
            search: "nda",
            scope: "in-project",
            signal: controller.signal,
        });

        expect(ids).toEqual([{ id: "r1", user_id: "u1" }]);
        const { url, init } = lastFetchCall();
        // Select-all-then-delete deletes whatever this returns; if the query
        // here is broader than the list query, users delete unseen reviews.
        expect(url).toBe(
            "/api/tabular-review/ids?project_id=p1&search=nda&scope=in-project",
        );
        expect(init.signal).toBe(controller.signal);
    });

    it('omits the scope param for "all"', async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));

        await listTabularReviewIds(undefined, { scope: "all" });

        expect(lastFetchCall().url).toBe("/api/tabular-review/ids");
    });
});

describe("listProjectsPage", () => {
    it("requests the bare collection when no filters are given", async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));

        await listProjectsPage();

        const { url, init } = lastFetchCall();
        expect(url).toBe("/api/projects");
        expect(init.signal).toBeUndefined();
    });

    it("serializes every pagination knob and forwards the abort signal", async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));
        const controller = new AbortController();

        await listProjectsPage({
            limit: 30,
            offset: 60,
            search: "acquisitions",
            sortKey: "files",
            sortDirection: "desc",
            scope: "mine",
            practice: "Litigation",
            ownerUserId: "user-2",
            signal: controller.signal,
        });

        const { url, init } = lastFetchCall();
        expect(url).toBe(
            "/api/projects" +
                "?limit=30&offset=60&search=acquisitions" +
                "&sort_key=files&sort_direction=desc&scope=mine" +
                "&practice=Litigation&owner_user_id=user-2",
        );
        expect(init.signal).toBe(controller.signal);
    });

    it('omits the scope param for "all" — the backend default', async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));

        await listProjectsPage({ scope: "all", limit: 10 });

        expect(lastFetchCall().url).toBe("/api/projects?limit=10");
    });

    it("serializes the project visibility scopes", async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));

        await listProjectsPage({ scope: "collaborative", limit: 10 });
        expect(lastFetchCall().url).toBe(
            "/api/projects?limit=10&scope=collaborative",
        );

        fetchMock.mockResolvedValue(jsonResponse([]));
        await listProjectsPage({ scope: "private", limit: 10 });
        expect(lastFetchCall().url).toBe(
            "/api/projects?limit=10&scope=private",
        );
    });
});

describe("listProjectSummaries", () => {
    it("uses the projects collection with the summary view", async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));

        await listProjectSummaries({ limit: 11, offset: 10 });

        expect(lastFetchCall().url).toBe(
            "/api/projects?limit=11&offset=10&view=summary",
        );
    });

    it("omits pagination parameters when they are not requested", async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));

        await listProjectSummaries();

        expect(lastFetchCall().url).toBe("/api/projects?view=summary");
    });
});

describe("searchProjectDirectory", () => {
    it("uses the projects collection directory-search view", async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));
        const controller = new AbortController();

        await searchProjectDirectory({
            search: "agreement",
            limit: 51,
            offset: 10,
            signal: controller.signal,
        });

        const { url, init } = lastFetchCall();
        expect(url).toBe(
            "/api/projects?view=directory-search&search=agreement&limit=51&offset=10",
        );
        expect(init.signal).toBe(controller.signal);
    });
});

describe("getProjectDirectoryLevel", () => {
    it("serializes a folder level, pagination, and abort signal", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({
                documents: [],
                folders: [],
                documentsHasMore: false,
            }),
        );
        const controller = new AbortController();

        await getProjectDirectoryLevel("p1", {
            parentFolderId: "folder-1",
            limit: 50,
            offset: 100,
            signal: controller.signal,
        });

        const { url, init } = lastFetchCall();
        expect(url).toBe(
            "/api/projects/p1/directory?parent_folder_id=folder-1&limit=50&offset=100",
        );
        expect(init.signal).toBe(controller.signal);
    });

    it("requests the root level without optional query parameters", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({
                documents: [],
                folders: [],
                documentsHasMore: false,
            }),
        );

        await getProjectDirectoryLevel("p1");

        expect(lastFetchCall().url).toBe("/api/projects/p1/directory");
    });
});

describe("listProjectIds", () => {
    it("requests the bare id list when no filters are given", async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));

        await listProjectIds();

        expect(lastFetchCall().url).toBe("/api/projects/ids");
    });

    it("scopes ids by search, scope, practice, and owner so select-all matches the visible filter", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse([{ id: "p1", user_id: "u1" }]),
        );
        const controller = new AbortController();

        const ids = await listProjectIds({
            search: "nda",
            scope: "mine",
            practice: "Litigation",
            ownerUserId: "user-2",
            signal: controller.signal,
        });

        expect(ids).toEqual([{ id: "p1", user_id: "u1" }]);
        const { url, init } = lastFetchCall();
        // Select-all-then-delete deletes whatever this returns; if the query
        // here is broader than the list query, users delete unseen projects.
        expect(url).toBe(
            "/api/projects/ids?search=nda&scope=mine" +
                "&practice=Litigation&owner_user_id=user-2",
        );
        expect(init.signal).toBe(controller.signal);
    });

    it('omits the scope param for "all"', async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));

        await listProjectIds({ scope: "all" });

        expect(lastFetchCall().url).toBe("/api/projects/ids");
    });
});

describe("getProjectFilterOptions", () => {
    it("loads lightweight project facets and forwards cancellation", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ practices: ["Litigation"], owners: [] }),
        );
        const controller = new AbortController();

        await getProjectFilterOptions(controller.signal);

        const { url, init } = lastFetchCall();
        expect(url).toBe("/api/projects/filter-options");
        expect(init.signal).toBe(controller.signal);
    });
});

describe("listWorkflows", () => {
    it("sends only the type param, never a pagination knob", async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));

        await listWorkflows("assistant");

        expect(lastFetchCall().url).toBe("/api/workflows?type=assistant");
    });

    it("requests the unfiltered collection when type is omitted", async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));

        await listWorkflows();

        expect(lastFetchCall().url).toBe("/api/workflows");
    });
});

describe("listWorkflowsPage", () => {
    it("requests the bare collection when no filters are given", async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));

        await listWorkflowsPage();

        const { url, init } = lastFetchCall();
        expect(url).toBe("/api/workflows");
        expect(init.signal).toBeUndefined();
    });

    it("serializes every pagination knob and forwards the abort signal", async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));
        const controller = new AbortController();

        await listWorkflowsPage({
            limit: 30,
            offset: 60,
            search: "nda",
            sortKey: "name",
            sortDirection: "desc",
            scope: "owned",
            type: "assistant",
            practice: "Litigation",
            language: "English",
            jurisdiction: "NSW",
            signal: controller.signal,
        });

        const { url, init } = lastFetchCall();
        expect(url).toBe(
            "/api/workflows" +
                "?type=assistant&limit=30&offset=60&search=nda" +
                "&sort_key=name&sort_direction=desc&scope=owned" +
                "&practice=Litigation&language=English&jurisdiction=NSW",
        );
        expect(init.signal).toBe(controller.signal);
    });

    it('omits the scope param for "all" — the backend default', async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));

        await listWorkflowsPage({ scope: "all", limit: 10 });

        expect(lastFetchCall().url).toBe("/api/workflows?limit=10");
    });
});

describe("listWorkflowIds", () => {
    it("requests the bare id list when no filters are given", async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));

        await listWorkflowIds();

        expect(lastFetchCall().url).toBe("/api/workflows/ids");
    });

    it("scopes ids by every active filter so select-all matches the visible list", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse([{ id: "w1", user_id: "u1" }]),
        );

        const ids = await listWorkflowIds({
            search: "nda",
            scope: "owned",
            type: "tabular",
            practice: "Litigation",
            language: "English",
            jurisdiction: "NSW",
        });

        expect(ids).toEqual([{ id: "w1", user_id: "u1" }]);
        expect(lastFetchCall().url).toBe(
            "/api/workflows/ids?type=tabular&search=nda" +
                "&scope=owned&practice=Litigation&language=English&jurisdiction=NSW",
        );
    });
});

describe("listSystemWorkflows", () => {
    it("requests the unfiltered system list when no type is given", async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));

        await listSystemWorkflows();

        expect(lastFetchCall().url).toBe("/api/workflows/system");
    });

    it("appends the type filter when given", async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));

        await listSystemWorkflows("tabular");

        expect(lastFetchCall().url).toBe("/api/workflows/system?type=tabular");
    });
});

describe("getWorkflowFilterOptions", () => {
    it("scopes workflow facets by type and ownership", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ practices: [], languages: [], jurisdictions: [] }),
        );
        const controller = new AbortController();

        await getWorkflowFilterOptions({
            type: "assistant",
            scope: "shared",
            signal: controller.signal,
        });

        const { url, init } = lastFetchCall();
        expect(url).toBe(
            "/api/workflows/filter-options?type=assistant&scope=shared",
        );
        expect(init.signal).toBe(controller.signal);
    });

    it("requests unfiltered facets when options are omitted", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ practices: [], languages: [], jurisdictions: [] }),
        );

        await getWorkflowFilterOptions();

        const { url, init } = lastFetchCall();
        expect(url).toBe("/api/workflows/filter-options");
        expect(init.signal).toBeUndefined();
    });
});

describe("Library search", () => {
    it("sends every server-side query option and returns flat results", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ documents: [{ id: "d1" }], documentsHasMore: true }),
        );
        const controller = new AbortController();

        const result = await searchLibraryDocuments("templates", {
            limit: 50,
            offset: 100,
            search: "agreement",
            fileType: "docx",
            sortKey: "updated",
            sortDirection: "desc",
            signal: controller.signal,
        });

        expect(result.documentsHasMore).toBe(true);
        const { url, init } = lastFetchCall();
        expect(url).toBe(
            "/api/library/templates?view=search&limit=50&offset=100" +
                "&search=agreement&file_type=docx&sort_key=updated&sort_direction=desc",
        );
        expect(init.signal).toBe(controller.signal);
    });

    it("supports a search view with no optional filters", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ documents: [], documentsHasMore: false }),
        );

        await searchLibraryDocuments("files", {});

        expect(lastFetchCall().url).toBe("/api/library/files?view=search");
    });

    it("loads multiple open directory levels in one request", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ levels: [] }));

        await getLibraryLevels("templates", [
            { parentId: null, limit: 50 },
            { parentId: "folder-1", limit: 100 },
        ]);

        const { url, init } = lastFetchCall();
        expect(url).toBe("/api/library/templates/levels");
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body as string)).toEqual({
            levels: [
                { parentId: null, limit: 50 },
                { parentId: "folder-1", limit: 100 },
            ],
        });
    });

    it("loads another page of one Library folder", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({
                documents: [],
                folders: [],
                documentsHasMore: false,
            }),
        );

        await getLibraryFolderChildren("files", "folder-1", { offset: 50 });

        expect(lastFetchCall().url).toBe(
            "/api/library/files?parent_folder_id=folder-1&offset=50",
        );
    });

    it("loads filtered Library IDs and forwards the abort signal", async () => {
        fetchMock.mockResolvedValue(jsonResponse(["d1"]));
        const controller = new AbortController();

        await listLibraryDocumentIds("templates", {
            search: "agreement",
            fileType: "docx",
            signal: controller.signal,
        });

        const { url, init } = lastFetchCall();
        expect(url).toBe(
            "/api/library/templates/ids?search=agreement&file_type=docx",
        );
        expect(init.signal).toBe(controller.signal);
    });

    it("loads all Library IDs without optional filters", async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));

        await listLibraryDocumentIds("files");

        expect(lastFetchCall().url).toBe("/api/library/files/ids");
    });

    it("bulk deletes Library documents", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ deletedIds: ["d1", "d2"] }));

        const result = await bulkDeleteLibraryDocuments("files", ["d1", "d2"]);

        const { url, init } = lastFetchCall();
        expect(result).toEqual({ deletedIds: ["d1", "d2"] });
        expect(url).toBe("/api/library/files/documents/bulk-delete");
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body as string)).toEqual({ ids: ["d1", "d2"] });
    });

    it("loads the complete file-type facet list", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ fileTypes: ["docx", "pdf"] }),
        );

        await getLibraryFilterOptions("files");

        expect(lastFetchCall().url).toBe("/api/library/files/filter-options");
    });
});

describe("tabular review CRUD", () => {
    it("createTabularReview posts the folder grouping mode through unchanged", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ id: "r1" }));

        await createTabularReview({
            title: "Leases",
            document_ids: ["d1", "d2"],
            columns_config: [{ index: 0, name: "Term", prompt: "Find term" }],
            project_id: "p1",
            document_grouping: "folder",
            model: "gpt-5.6-terra",
        });

        const { url, init } = lastFetchCall();
        expect(url).toBe("/api/tabular-review");
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body as string)).toEqual({
            title: "Leases",
            document_ids: ["d1", "d2"],
            columns_config: [{ index: 0, name: "Term", prompt: "Find term" }],
            project_id: "p1",
            document_grouping: "folder",
            model: "gpt-5.6-terra",
        });
    });

    it("updateTabularReview PATCHes partial payloads without inventing fields", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ id: "r1" }));

        await updateTabularReview("r1", { document_grouping: "document" });

        const { url, init } = lastFetchCall();
        expect(url).toBe("/api/tabular-review/r1");
        expect(init.method).toBe("PATCH");
        expect(JSON.parse(init.body as string)).toEqual({
            document_grouping: "document",
        });
    });

    it("deleteTabularReview issues DELETE on the review resource", async () => {
        fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

        await deleteTabularReview("r1");

        const { url, init } = lastFetchCall();
        expect(url).toBe("/api/tabular-review/r1");
        expect(init.method).toBe("DELETE");
    });

    it("generateTabularColumnPrompt forwards title and optional hints", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ prompt: "p", source: "preset" }),
        );

        const result = await generateTabularColumnPrompt("Termination", {
            format: "date",
            documentName: "lease.pdf",
            tags: ["real-estate"],
        });

        expect(result.source).toBe("preset");
        const { url, init } = lastFetchCall();
        expect(url).toBe("/api/tabular-review/prompt");
        expect(JSON.parse(init.body as string)).toEqual({
            title: "Termination",
            format: "date",
            documentName: "lease.pdf",
            tags: ["real-estate"],
        });
    });
});

describe("tabular review chats", () => {
    it("round-trips tabular chat selection keys", () => {
        const key = tabularChatSelectionKey("r1", "c1");
        expect(parseTabularChatSelectionKey(key)).toEqual({
            reviewId: "r1",
            chatId: "c1",
        });
        expect(parseTabularChatSelectionKey("ordinary-chat-id")).toBeNull();
        expect(
            parseTabularChatSelectionKey("tabular-review-chat:r1:"),
        ).toBeNull();
    });

    it("rejects prefixed keys missing either half", () => {
        // A prefixed key must carry both a review id and a chat id: an empty
        // review id puts the separator first, an empty chat id puts it last,
        // and both must parse to null rather than a half-empty selection.
        expect(
            parseTabularChatSelectionKey(tabularChatSelectionKey("", "c1")),
        ).toBeNull();
        expect(
            parseTabularChatSelectionKey(tabularChatSelectionKey("r1", "")),
        ).toBeNull();
    });

    it("lists chats and fetches messages from the nested routes", async () => {
        fetchMock.mockImplementation(() => Promise.resolve(jsonResponse([])));

        await getTabularChats("r1");
        expect(lastFetchCall().url).toBe("/api/tabular-review/r1/chats");

        await getTabularChatMessages("r1", "c1");
        expect(lastFetchCall().url).toBe(
            "/api/tabular-review/r1/chats/c1/messages",
        );
    });

    it("renames via PATCH and deletes via DELETE on the chat resource", async () => {
        fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

        await renameTabularChat("r1", "c1", "New title");
        let { url, init } = lastFetchCall();
        expect(url).toBe("/api/tabular-review/r1/chats/c1");
        expect(init.method).toBe("PATCH");
        expect(JSON.parse(init.body as string)).toEqual({ title: "New title" });

        await deleteTabularChat("r1", "c1");
        ({ url, init } = lastFetchCall());
        expect(url).toBe("/api/tabular-review/r1/chats/c1");
        expect(init.method).toBe("DELETE");
    });

    it("persists tabular chat model and reasoning selections", async () => {
        fetchMock.mockImplementation(() =>
            Promise.resolve(
                jsonResponse({
                    id: "c1",
                    title: null,
                    model: "openai-gpt-5.2",
                    reasoning_level: "medium",
                }),
            ),
        );

        await updateTabularChatModel("r1", "c1", "openai-gpt-5.2");
        let { url, init } = lastFetchCall();
        expect(url).toBe("/api/tabular-review/r1/chats/c1");
        expect(init.keepalive).toBe(true);
        expect(JSON.parse(init.body as string)).toEqual({
            model: "openai-gpt-5.2",
        });

        await updateTabularChatReasoningLevel("r1", "c1", "medium");
        ({ url, init } = lastFetchCall());
        expect(url).toBe("/api/tabular-review/r1/chats/c1");
        expect(init.keepalive).toBe(true);
        expect(JSON.parse(init.body as string)).toEqual({
            reasoningLevel: "medium",
        });
    });

    it("includes chat_id but omits absent context in streamTabularChat", async () => {
        fetchMock.mockResolvedValue(streamResponse([]));

        await streamTabularChat("r1", [{ role: "user", content: "q" }], "c9");

        expect(JSON.parse(lastFetchCall().init.body as string)).toEqual({
            messages: [{ role: "user", content: "q" }],
            chat_id: "c9",
        });
    });
});

describe("tabular cell operations", () => {
    it("regenerateTabularCell posts the row/column address with snake_case keys", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ summary: "s", flag: "green", reasoning: "r" }),
        );

        const cell = await regenerateTabularCell("r1", "row-1", 2);

        expect(cell).toEqual({ summary: "s", flag: "green", reasoning: "r" });
        const { url, init } = lastFetchCall();
        expect(url).toBe("/api/tabular-review/r1/regenerate-cell");
        expect(JSON.parse(init.body as string)).toEqual({
            row_id: "row-1",
            column_index: 2,
        });
    });

    it("clearTabularCells posts the row ids to clear", async () => {
        fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

        await clearTabularCells("r1", ["row-1", "row-2"]);

        const { url, init } = lastFetchCall();
        expect(url).toBe("/api/tabular-review/r1/clear-cells");
        expect(JSON.parse(init.body as string)).toEqual({
            row_ids: ["row-1", "row-2"],
        });
    });
});

describe("query and payload defaults", () => {
    it("getDocumentUrl appends version_id only when a version is requested", async () => {
        fetchMock.mockImplementation(() =>
            Promise.resolve(
                jsonResponse({ url: "u", filename: "f", version_id: null }),
            ),
        );

        await getDocumentUrl("d1");
        expect(lastFetchCall().url).toBe("/api/single-documents/d1/url");

        await getDocumentUrl("d1", "v 1");
        expect(lastFetchCall().url).toBe(
            "/api/single-documents/d1/url?version_id=v%201",
        );
    });

    it("createChat defaults to an empty JSON object body", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ id: "c1" }));

        await createChat();
        expect(lastFetchCall().init.body).toBe("{}");
        fetchMock.mockResolvedValue(jsonResponse({ id: "c2" }));

        await createChat({ project_id: "p1" });
        expect(JSON.parse(lastFetchCall().init.body as string)).toEqual({
            project_id: "p1",
        });
    });

    it("listChats without options hits the bare /chat route", async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));

        await listChats();

        expect(lastFetchCall().url).toBe("/api/chat");
    });

    it("folder creation defaults parent_folder_id to null, not undefined", async () => {
        fetchMock.mockImplementation(() =>
            Promise.resolve(jsonResponse({ id: "f1" })),
        );

        await createProjectFolder("p1", "Discovery");
        // null must survive JSON.stringify (undefined would drop the key and
        // the backend would reject the payload).
        expect(JSON.parse(lastFetchCall().init.body as string)).toEqual({
            name: "Discovery",
            parent_folder_id: null,
        });

        await createLibraryFolder("files", "Precedents", "parent-1");
        expect(JSON.parse(lastFetchCall().init.body as string)).toEqual({
            name: "Precedents",
            parent_folder_id: "parent-1",
        });

        await createLibraryFolder("files", "Root folder");
        expect(JSON.parse(lastFetchCall().init.body as string)).toEqual({
            name: "Root folder",
            parent_folder_id: null,
        });
    });

    it("resolves project and library upload paths with conflict choices", async () => {
        fetchMock.mockImplementation(() =>
            Promise.resolve(
                jsonResponse({
                    conflict: false,
                    folder_id: "f1",
                    resolved_name: "NDAs (2)",
                    folders: [],
                }),
            ),
        );

        await resolveProjectFolderPath("p1", ["NDAs"], null, "rename");
        let call = lastFetchCall();
        expect(call.url).toBe("/api/projects/p1/folder-paths/resolve");
        expect(JSON.parse(call.init.body as string)).toEqual({
            segments: ["NDAs"],
            base_folder_id: null,
            conflict_resolution: "rename",
        });

        await resolveLibraryFolderPath(
            "templates",
            ["Executed", "2026"],
            "parent-1",
            "reuse",
        );
        call = lastFetchCall();
        expect(call.url).toBe("/api/library/templates/folder-paths/resolve");
        expect(JSON.parse(call.init.body as string)).toEqual({
            segments: ["Executed", "2026"],
            base_folder_id: "parent-1",
            conflict_resolution: "reuse",
        });
    });

    it("downloadDocumentsZip synthesizes a message when the error body is empty", async () => {
        fetchMock.mockResolvedValue(new Response("", { status: 500 }));

        await expect(downloadDocumentsZip(["d1"])).rejects.toThrow(
            "Something went wrong. Please try again.",
        );
    });

    it("mapTRMessages degrades a null user body to an empty string", () => {
        const mapped = mapTRMessages([
            {
                id: "m1",
                chat_id: "c1",
                role: "user",
                content: null,
                created_at: "2026-01-01",
            },
        ]);
        expect(mapped).toEqual([{ role: "user", content: "" }]);
    });
});

// ---------------------------------------------------------------------------
// Workflows. The slash-command menu (PR #280) is fed by listWorkflows, and
// hide/unhide controls which ones it offers — a wrong route here silently
// empties the menu rather than erroring.
// ---------------------------------------------------------------------------

describe("workflow endpoints", () => {
    it("listWorkflows filters by type via the query string", async () => {
        fetchMock.mockResolvedValue(jsonResponse([]));

        await listWorkflows("assistant");

        expect(lastFetchCall().url).toBe("/api/workflows?type=assistant");
    });

    it("hide/unhide/list use the hidden-workflows routes with matching methods", async () => {
        fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

        await hideWorkflow("w1");
        let { url, init } = lastFetchCall();
        expect(url).toBe("/api/workflows/hidden");
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body as string)).toEqual({ workflow_id: "w1" });

        await unhideWorkflow("w1");
        ({ url, init } = lastFetchCall());
        expect(url).toBe("/api/workflows/hidden/w1");
        expect(init.method).toBe("DELETE");

        fetchMock.mockResolvedValue(jsonResponse(["w2"]));
        await expect(listHiddenWorkflows()).resolves.toEqual(["w2"]);
        expect(lastFetchCall().url).toBe("/api/workflows/hidden");
    });
});

// ---------------------------------------------------------------------------
// Thin endpoint wrappers. Each is a one-liner over apiRequest, so the only
// things that can break are the route, the HTTP method, and the payload
// shape — a wrong route or a camelCase key that should be snake_case fails
// silently in TypeScript and only surfaces as a runtime 404/422. Assert
// exactly those three things for every wrapper.
// ---------------------------------------------------------------------------

describe("thin endpoint wrappers", () => {
    type WrapperCase = {
        name: string;
        call: () => Promise<unknown>;
        url: string;
        method?: string; // defaults to GET (fetch's default when unset)
        body?: unknown; // absent means the request must not carry a body
    };

    const cases: WrapperCase[] = [
        // Account & profile
        {
            name: "createProject",
            call: () =>
                createProject("Acme v. Zenith", "CM-42", "litigation"),
            url: "/projects",
            method: "POST",
            body: {
                name: "Acme v. Zenith",
                cm_number: "CM-42",
                practice: "litigation",
            },
        },
        {
            name: "deleteAccount",
            call: () => deleteAccount(),
            url: "/user/account",
            method: "DELETE",
        },
        {
            name: "deleteAllProjects",
            call: () => deleteAllProjects(),
            url: "/user/projects",
            method: "DELETE",
        },
        {
            name: "deleteAllTabularReviews",
            call: () => deleteAllTabularReviews(),
            url: "/user/tabular-reviews",
            method: "DELETE",
        },
        {
            name: "updateUserProfile",
            call: () =>
                updateUserProfile({ displayName: "Amal", titleModel: "m1" }),
            url: "/user/profile",
            method: "PATCH",
            body: { displayName: "Amal", titleModel: "m1" },
        },
        {
            name: "completeUserOnboarding (defaults)",
            call: () => completeUserOnboarding(),
            url: "/user/onboarding",
            method: "POST",
            body: {},
        },
        {
            name: "completeUserOnboarding (personalisation)",
            call: () =>
                completeUserOnboarding({
                    jurisdiction: "Singapore",
                    practiceAreas: ["Litigation"],
                }),
            url: "/user/onboarding",
            method: "POST",
            body: {
                jurisdiction: "Singapore",
                practiceAreas: ["Litigation"],
            },
        },
        {
            name: "syncUserPasswordSet",
            call: () => syncUserPasswordSet(),
            url: "/user/security/password-set",
            method: "POST",
        },
        {
            name: "updateUserMfaOnLogin",
            call: () => updateUserMfaOnLogin(true),
            url: "/user/security/mfa-login",
            method: "PATCH",
            body: { enabled: true },
        },
        {
            name: "getApiKeyStatus",
            call: () => getApiKeyStatus(),
            url: "/user/api-keys",
        },
        {
            name: "saveApiKey",
            call: () => saveApiKey("claude", "sk-ant-1"),
            url: "/user/api-keys/claude",
            method: "PUT",
            body: { api_key: "sk-ant-1" },
        },
        {
            // null is the delete-my-key signal and must survive
            // JSON.stringify rather than dropping the field.
            name: "saveApiKey (clear)",
            call: () => saveApiKey("openai", null),
            url: "/user/api-keys/openai",
            method: "PUT",
            body: { api_key: null },
        },
        // MCP connectors
        {
            name: "listMcpConnectors",
            call: () => listMcpConnectors(),
            url: "/user/mcp-connectors",
        },
        {
            name: "getMcpConnector",
            call: () => getMcpConnector("m1"),
            url: "/user/mcp-connectors/m1",
        },
        {
            name: "createMcpConnector",
            call: () =>
                createMcpConnector({
                    name: "Drive",
                    serverUrl: "https://mcp.example/mcp/v1",
                    bearerToken: "tok",
                }),
            url: "/user/mcp-connectors",
            method: "POST",
            body: {
                name: "Drive",
                serverUrl: "https://mcp.example/mcp/v1",
                bearerToken: "tok",
            },
        },
        {
            name: "updateMcpConnector",
            call: () => updateMcpConnector("m1", { enabled: false }),
            url: "/user/mcp-connectors/m1",
            method: "PATCH",
            body: { enabled: false },
        },
        {
            name: "deleteMcpConnector",
            call: () => deleteMcpConnector("m1"),
            url: "/user/mcp-connectors/m1",
            method: "DELETE",
        },
        {
            name: "refreshMcpConnectorTools",
            call: () => refreshMcpConnectorTools("m1"),
            url: "/user/mcp-connectors/m1/refresh-tools",
            method: "POST",
        },
        {
            name: "startMcpConnectorOAuth",
            call: () => startMcpConnectorOAuth("m1"),
            url: "/user/mcp-connectors/m1/oauth/start",
            method: "POST",
        },
        {
            name: "setMcpToolEnabled",
            call: () => setMcpToolEnabled("m1", "t1", true),
            url: "/user/mcp-connectors/m1/tools/t1",
            method: "PATCH",
            body: { enabled: true },
        },
        // Native Google Drive. Unlike the MCP connectors above these are
        // first-party endpoints under /user/integrations, and the three verbs
        // share one path — so the route/method pairing is what keeps
        // "check status" from accidentally becoming "revoke my tokens".
        {
            name: "getGoogleDriveStatus",
            call: () => getGoogleDriveStatus(),
            url: "/user/integrations/google-drive",
        },
        {
            name: "startGoogleDriveOAuth",
            call: () => startGoogleDriveOAuth(),
            url: "/user/integrations/google-drive/oauth/start",
            method: "POST",
        },
        {
            name: "disconnectGoogleDrive",
            call: () => disconnectGoogleDrive(),
            url: "/user/integrations/google-drive",
            method: "DELETE",
        },
        // Projects
        {
            name: "getProject",
            call: () => getProject("p1"),
            url: "/projects/p1",
        },
        {
            name: "updateProject",
            call: () =>
                updateProject("p1", { name: "Renamed", practice: null }),
            url: "/projects/p1",
            method: "PATCH",
            body: { name: "Renamed", practice: null },
        },
        {
            name: "deleteProject",
            call: () => deleteProject("p1"),
            url: "/projects/p1",
            method: "DELETE",
        },
        {
            name: "getProjectPeople",
            call: () => getProjectPeople("p1"),
            url: "/projects/p1/people",
        },
        {
            name: "listProjectChats",
            call: () => listProjectChats("p1"),
            url: "/projects/p1/chats",
        },
        // Project folders & documents
        {
            name: "renameProjectFolder",
            call: () => renameProjectFolder("p1", "f1", "Discovery"),
            url: "/projects/p1/folders/f1",
            method: "PATCH",
            body: { name: "Discovery" },
        },
        {
            name: "deleteProjectFolder",
            call: () => deleteProjectFolder("p1", "f1"),
            url: "/projects/p1/folders/f1",
            method: "DELETE",
        },
        {
            // Moving to the root sends an explicit null parent, on the same
            // PATCH route as rename — only the body distinguishes them.
            name: "moveSubfolderToFolder",
            call: () => moveSubfolderToFolder("p1", "f1", null),
            url: "/projects/p1/folders/f1",
            method: "PATCH",
            body: { parent_folder_id: null },
        },
        {
            name: "moveDocumentToFolder",
            call: () => moveDocumentToFolder("p1", "d1", "f2"),
            url: "/projects/p1/documents/d1/folder",
            method: "PATCH",
            body: { folder_id: "f2" },
        },
        {
            name: "renameProjectDocument",
            call: () => renameProjectDocument("p1", "d1", "renamed.pdf"),
            url: "/projects/p1/documents/d1",
            method: "PATCH",
            body: { filename: "renamed.pdf" },
        },
        {
            name: "addDocumentToProject",
            call: () => addDocumentToProject("p1", "d1"),
            url: "/projects/p1/documents/d1",
            method: "POST",
        },
        // Library
        {
            name: "getLibrary",
            call: () => getLibrary("templates"),
            url: "/library/templates",
        },
        {
            name: "getLibraryFolderChildren",
            call: () => getLibraryFolderChildren("files", "f1"),
            url: "/library/files?parent_folder_id=f1",
        },
        {
            name: "getLibraryFolderPath",
            call: () => getLibraryFolderPath("templates", "f2"),
            url: "/library/templates/folders/f2",
        },
        {
            name: "getLibrary with pagination",
            call: () => getLibrary("files", { limit: 50, offset: 100 }),
            url: "/library/files?limit=50&offset=100",
        },
        {
            name: "getLibraryFolderChildren with pagination",
            call: () => getLibraryFolderChildren("files", "f1", { limit: 50 }),
            url: "/library/files?parent_folder_id=f1&limit=50",
        },
        {
            name: "renameLibraryFolder",
            call: () => renameLibraryFolder("files", "f1", "Precedents"),
            url: "/library/files/folders/f1",
            method: "PATCH",
            body: { name: "Precedents" },
        },
        {
            name: "deleteLibraryFolder",
            call: () => deleteLibraryFolder("files", "f1"),
            url: "/library/files/folders/f1",
            method: "DELETE",
        },
        {
            name: "moveLibraryFolder",
            call: () => moveLibraryFolder("templates", "f1", "parent-1"),
            url: "/library/templates/folders/f1",
            method: "PATCH",
            body: { parent_folder_id: "parent-1" },
        },
        {
            name: "moveLibraryDocument",
            call: () => moveLibraryDocument("files", "d1", null),
            url: "/library/files/documents/d1/folder",
            method: "PATCH",
            body: { folder_id: null },
        },
        {
            name: "renameLibraryDocument",
            call: () => renameLibraryDocument("files", "d1", "renamed.docx"),
            url: "/library/files/documents/d1",
            method: "PATCH",
            body: { filename: "renamed.docx" },
        },
        // Async (durable) exports. `params` is optional: the filtered exports
        // send it, the whole-account ones must omit the key entirely so the
        // backend's discriminated payload stays valid.
        {
            name: "startUserExport (with params)",
            call: () =>
                startUserExport("audit-csv", {
                    q: "agreement",
                    sort_dir: "desc",
                }),
            url: "/user/exports",
            method: "POST",
            body: {
                type: "audit-csv",
                params: { q: "agreement", sort_dir: "desc" },
            },
        },
        {
            name: "startUserExport (params omitted)",
            call: () => startUserExport("account"),
            url: "/user/exports",
            method: "POST",
            body: { type: "account" },
        },
        {
            // Export ids come back from the API, so encode them the same way
            // every other path segment is encoded.
            name: "getUserExportStatus",
            call: () => getUserExportStatus("exp/1"),
            url: "/user/exports/exp%2F1",
        },
        // Standalone documents & versions
        {
            name: "listStandaloneDocuments",
            call: () => listStandaloneDocuments(),
            url: "/single-documents",
        },
        {
            name: "getDocument",
            call: () => getDocument("d1"),
            url: "/single-documents/d1",
        },
        {
            name: "deleteDocument",
            call: () => deleteDocument("d1"),
            url: "/single-documents/d1",
            method: "DELETE",
        },
        {
            name: "resolveDocumentEdit",
            call: () => resolveDocumentEdit("doc/1", "edit/1", "accept"),
            url: "/single-documents/doc%2F1/edits/edit%2F1/accept",
            method: "POST",
        },
        {
            name: "listDocumentVersions",
            call: () => listDocumentVersions("d1"),
            url: "/single-documents/d1/versions",
        },
        {
            name: "copyDocumentVersionFromDocument",
            call: () =>
                copyDocumentVersionFromDocument("d1", "src-1", "copy.pdf"),
            url: "/single-documents/d1/versions/from-document",
            method: "POST",
            body: { source_document_id: "src-1", filename: "copy.pdf" },
        },
        {
            // null clears the per-version name so the document name shows.
            name: "renameDocumentVersion",
            call: () => renameDocumentVersion("d1", "v1", null),
            url: "/single-documents/d1/versions/v1",
            method: "PATCH",
            body: { filename: null },
        },
        {
            name: "deleteDocumentVersion",
            call: () => deleteDocumentVersion("d1", "v1"),
            url: "/single-documents/d1/versions/v1",
            method: "DELETE",
        },
        // Chat
        {
            name: "renameChat",
            call: () => renameChat("c1", "New title"),
            url: "/chat/c1",
            method: "PATCH",
            body: { title: "New title" },
        },
        {
            name: "updateChatModel",
            call: () => updateChatModel("c1", "gpt-5.6-sol"),
            url: "/chat/c1",
            method: "PATCH",
            body: { model: "gpt-5.6-sol" },
        },
        {
            name: "updateChatReasoningLevel",
            call: () => updateChatReasoningLevel("c1", "xhigh"),
            url: "/chat/c1",
            method: "PATCH",
            body: { reasoningLevel: "xhigh" },
        },
        {
            name: "updateLastSelectedChatSettings",
            call: () =>
                updateLastSelectedChatSettings({
                    lastSelectedChatModel: "gpt-5.6-sol",
                    lastSelectedReasoningLevel: "high",
                }),
            url: "/user/profile",
            method: "PATCH",
            body: {
                lastSelectedChatModel: "gpt-5.6-sol",
                lastSelectedReasoningLevel: "high",
            },
        },
        {
            name: "deleteChat",
            call: () => deleteChat("c1"),
            url: "/chat/c1",
            method: "DELETE",
        },
        {
            name: "generateChatTitle",
            call: () =>
                generateChatTitle("c1", "first message", "gpt-5.6-terra"),
            url: "/chat/c1/generate-title",
            method: "POST",
            body: { message: "first message", model: "gpt-5.6-terra" },
        },
        {
            name: "getChatPeople",
            call: () => getChatPeople("c1"),
            url: "/chat/c1/people",
        },
        {
            name: "getChatAccess",
            call: () => getChatAccess("c1"),
            url: "/chat/c1/access",
        },
        {
            name: "grantChatAccess",
            call: () => grantChatAccess("c1", "reader@example.com", "viewer"),
            url: "/chat/c1/access",
            method: "POST",
            body: { email: "reader@example.com", role: "viewer" },
        },
        {
            name: "revokeChatAccess",
            call: () => revokeChatAccess("c1", "a+b@example.com"),
            url: "/chat/c1/access/a%2Bb%40example.com",
            method: "DELETE",
        },
        // Tabular review
        {
            name: "getTabularReview",
            call: () => getTabularReview("r1"),
            url: "/tabular-review/r1",
        },
        {
            name: "getTabularReviewPeople",
            call: () => getTabularReviewPeople("r1"),
            url: "/tabular-review/r1/people",
        },
        {
            name: "getTabularReviewAccess",
            call: () => getTabularReviewAccess("r1"),
            url: "/tabular-review/r1/access",
        },
        {
            name: "grantTabularReviewAccess",
            call: () =>
                grantTabularReviewAccess("r1", "reviewer@example.com", "viewer"),
            url: "/tabular-review/r1/access",
            method: "POST",
            body: { email: "reviewer@example.com", role: "viewer" },
        },
        {
            name: "revokeTabularReviewAccess",
            call: () => revokeTabularReviewAccess("r1", "a+b@example.com"),
            url: "/tabular-review/r1/access/a%2Bb%40example.com",
            method: "DELETE",
        },
        // Workflows
        {
            name: "getWorkflow",
            call: () => getWorkflow("w1"),
            url: "/workflows/w1",
        },
        {
            name: "createWorkflow",
            call: () =>
                createWorkflow({
                    metadata: { title: "NDA review", type: "assistant" },
                    skill_md: "# Steps",
                }),
            url: "/workflows",
            method: "POST",
            body: {
                metadata: { title: "NDA review", type: "assistant" },
                skill_md: "# Steps",
            },
        },
        {
            name: "updateWorkflow",
            call: () =>
                updateWorkflow("w1", { metadata: { title: "Renamed" } }),
            url: "/workflows/w1",
            method: "PATCH",
            body: { metadata: { title: "Renamed" } },
        },
        {
            name: "deleteWorkflow",
            call: () => deleteWorkflow("w1"),
            url: "/workflows/w1",
            method: "DELETE",
        },
        {
            name: "openSourceWorkflow",
            call: () =>
                openSourceWorkflow("w1", {
                    contributor_mode: "named",
                    contributor: {
                        name: "Amal",
                        organisation: null,
                        role: null,
                        linkedin: null,
                    },
                }),
            url: "/workflows/w1/open-source",
            method: "POST",
            body: {
                contributor_mode: "named",
                contributor: {
                    name: "Amal",
                    organisation: null,
                    role: null,
                    linkedin: null,
                },
            },
        },
        {
            name: "shareWorkflow",
            call: () =>
                shareWorkflow("w1", { emails: ["a@b.c"], role: "viewer" }),
            url: "/workflows/w1/share",
            method: "POST",
            body: { emails: ["a@b.c"], role: "viewer" },
        },
        {
            name: "listWorkflowShares",
            call: () => listWorkflowShares("w1"),
            url: "/workflows/w1/shares",
        },
        {
            name: "getWorkflowPeople",
            call: () => getWorkflowPeople("w1"),
            url: "/workflows/w1/people",
        },
        {
            name: "deleteWorkflowShare",
            call: () => deleteWorkflowShare("w1", "s1"),
            url: "/workflows/w1/shares/s1",
            method: "DELETE",
        },
        {
            name: "listQuickActions",
            call: () => listQuickActions(),
            url: "/quick-actions?surface=app",
        },
        {
            name: "createQuickAction",
            call: () =>
                createQuickAction({
                    workflow_id: "w1",
                    name: "Review agreement",
                    prompt: "Review this",
                    document_upload: true,
                    surface: "app",
                    enabled: true,
                    sort_order: 4,
                }),
            url: "/quick-actions",
            method: "POST",
            body: {
                workflow_id: "w1",
                name: "Review agreement",
                prompt: "Review this",
                document_upload: true,
                surface: "app",
                enabled: true,
                sort_order: 4,
            },
        },
        {
            name: "updateQuickAction",
            call: () =>
                updateQuickAction("qa1", {
                    workflow_id: "w2",
                    name: "Proofread agreement",
                    prompt: "Proofread this",
                    document_upload: true,
                    enabled: false,
                    sort_order: 3,
                }),
            url: "/quick-actions/qa1",
            method: "PATCH",
            body: {
                workflow_id: "w2",
                name: "Proofread agreement",
                prompt: "Proofread this",
                document_upload: true,
                enabled: false,
                sort_order: 3,
            },
        },
        {
            name: "deleteQuickAction",
            call: () => deleteQuickAction("qa1"),
            url: "/quick-actions/qa1",
            method: "DELETE",
        },
        {
            name: "listWorkflowAddons",
            call: () => listWorkflowAddons(),
            url: "/workflow-addons",
        },
        {
            name: "getWorkflowAddon",
            call: () => getWorkflowAddon("addon-1"),
            url: "/workflow-addons/addon-1",
        },
        {
            name: "importWorkflowAddon",
            call: () => importWorkflowAddon("addon-1"),
            url: "/workflow-addons/addon-1/import",
            method: "POST",
        },
        {
            name: "listWorkflowAssets",
            call: () => listWorkflowAssets("w1"),
            url: "/workflows/w1/assets",
        },
        {
            name: "copyDocumentsToWorkflowAssets",
            call: () =>
                copyDocumentsToWorkflowAssets("w1", ["document-1", "document-2"]),
            url: "/workflows/w1/assets/from-documents",
            method: "POST",
            body: { document_ids: ["document-1", "document-2"] },
        },
        {
            name: "deleteWorkflowAsset",
            call: () => deleteWorkflowAsset("w1", "asset-1"),
            url: "/workflows/w1/assets/asset-1",
            method: "DELETE",
        },
        // Organizations (multi-tenant RBAC)
        {
            // The org-scoped variant of project creation: org_id must survive
            // serialization so the server can stamp the tenant.
            name: "createProject (into an org)",
            call: () =>
                createProject("Firm matter", undefined, undefined, "org-1"),
            url: "/projects",
            method: "POST",
            body: { name: "Firm matter", org_id: "org-1" },
        },
        {
            name: "listOrgs",
            call: () => listOrgs(),
            url: "/orgs",
        },
        {
            name: "createOrg",
            call: () => createOrg("Smith & Jones LLP"),
            url: "/orgs",
            method: "POST",
            body: { name: "Smith & Jones LLP" },
        },
        {
            name: "getOrg",
            call: () => getOrg("org-1"),
            url: "/orgs/org-1",
        },
        {
            name: "updateOrg",
            call: () => updateOrg("org-1", "Renamed LLP"),
            url: "/orgs/org-1",
            method: "PATCH",
            body: { name: "Renamed LLP" },
        },
        {
            name: "deleteOrg",
            call: () => deleteOrg("org-1"),
            url: "/orgs/org-1",
            method: "DELETE",
        },
        {
            name: "listOrgResources",
            call: () => listOrgResources("org-1"),
            url: "/orgs/org-1/resources",
        },
        {
            name: "listOrgMembers",
            call: () => listOrgMembers("org-1"),
            url: "/orgs/org-1/members",
        },
        {
            name: "updateOrgMember",
            call: () => updateOrgMember("org-1", "user-2", "admin"),
            url: "/orgs/org-1/members/user-2",
            method: "PATCH",
            body: { role: "admin" },
        },
        {
            name: "removeOrgMember",
            call: () => removeOrgMember("org-1", "user-2"),
            url: "/orgs/org-1/members/user-2",
            method: "DELETE",
        },
        // Invitations — the only way a membership row is ever created.
        {
            name: "createOrgInvitation",
            call: () =>
                createOrgInvitation("org-1", "counsel@firm.example", "member"),
            url: "/orgs/org-1/invitations",
            method: "POST",
            body: { email: "counsel@firm.example", role: "member" },
        },
        {
            name: "listOrgInvitations",
            call: () => listOrgInvitations("org-1"),
            url: "/orgs/org-1/invitations",
        },
        {
            name: "cancelOrgInvitation",
            call: () => cancelOrgInvitation("org-1", "inv-1"),
            url: "/orgs/org-1/invitations/inv-1",
            method: "DELETE",
        },
        {
            name: "resendOrgInvitation",
            call: () => resendOrgInvitation("org-1", "inv-1"),
            url: "/orgs/org-1/invitations/inv-1/resend",
            method: "POST",
        },
        {
            // The recipient's side hangs off /user: they are not a member of
            // the organization yet, so no org-scoped route could authorize
            // them.
            name: "listMyOrgInvitations",
            call: () => listMyOrgInvitations(),
            url: "/user/invitations",
        },
        {
            name: "acceptOrgInvitation",
            call: () => acceptOrgInvitation("inv-1"),
            url: "/user/invitations/inv-1/accept",
            method: "POST",
        },
        {
            name: "declineOrgInvitation",
            call: () => declineOrgInvitation("inv-1"),
            url: "/user/invitations/inv-1/decline",
            method: "POST",
        },
        // Per-recipient project access grants.
        {
            name: "getProjectAccess",
            call: () => getProjectAccess("p1"),
            url: "/projects/p1/access",
        },
        {
            name: "grantProjectAccess",
            call: () =>
                grantProjectAccess("p1", "counsel@outside.example", "viewer"),
            url: "/projects/p1/access",
            method: "POST",
            body: { email: "counsel@outside.example", role: "viewer" },
        },
        {
            // The email is a path segment, so it has to survive encoding.
            name: "revokeProjectAccess",
            call: () => revokeProjectAccess("p1", "counsel+eu@outside.example"),
            url: "/projects/p1/access/counsel%2Beu%40outside.example",
            method: "DELETE",
        },
    ];

    it.each(cases)(
        "$name → $method $url",
        async ({ call, url, method, body }) => {
            fetchMock.mockResolvedValue(jsonResponse({}));

            await call();

            const { url: actualUrl, init } = lastFetchCall();
            expect(actualUrl).toBe(`/api${url}`);
            expect(init.method ?? "GET").toBe(method ?? "GET");
            if (body !== undefined) {
                expect(JSON.parse(init.body as string)).toEqual(body);
                expect(init.headers).toMatchObject({
                    "Content-Type": "application/json",
                });
            } else {
                expect(init.body).toBeUndefined();
            }
            expect(init.credentials).toBe("include");
        },
    );
});

// ---------------------------------------------------------------------------
// Wrappers with response mapping — the ones the table above can't cover
// because they unwrap an envelope or hit the blob path.
// ---------------------------------------------------------------------------

describe("unwrapping and blob wrappers", () => {
    it("builds an encoded workflow add-on asset display URL", () => {
        expect(workflowAddonAssetDisplayUrl("workflow/1", "asset 1")).toBe(
            "/api/workflow-addons/workflow%2F1/assets/asset%201/display",
        );
    });

    it("getOllamaModels unwraps the models envelope", async () => {
        const models = [
            { id: "ollama/llama3.2", label: "Llama 3.2", group: "Local" },
        ];
        fetchMock.mockResolvedValue(jsonResponse({ models }));

        await expect(getOllamaModels()).resolves.toEqual(models);
        expect(lastFetchCall().url).toBe("/api/models/ollama");
    });

    it.each([
        ["OpenRouter", getOpenRouterModels, "/models/openrouter"],
        ["Vercel AI Gateway", getVercelModels, "/models/vercel"],
        ["OpenCode Go", getOpenCodeGoModels, "/models/opencode-go"],
    ])("loads the %s model catalog", async (_label, load, path) => {
        const models = [{ id: "openai/gpt-5.4", label: "GPT-5.4" }];
        fetchMock.mockResolvedValue(jsonResponse({ models }));

        await expect(load()).resolves.toEqual(models);
        expect(lastFetchCall().url).toBe(`/api${path}`);
    });

    it("getPanelDocument fetches a normalized document by opaque ID", async () => {
        const document = {
            document_id: "case:123",
            title: "Example v Example, 123 U.S. 456",
            type: "case",
            metadata: [],
            quotes: [],
        };
        fetchMock.mockResolvedValue(jsonResponse(document));

        await expect(getPanelDocument("case:123")).resolves.toEqual(document);
        const { url, init } = lastFetchCall();
        expect(url).toBe("/api/documents/case%3A123");
        expect(init.method).toBeUndefined();
    });

    it("coalesces concurrent panel-document hydration requests", async () => {
        const document = {
            document_id: "case:456",
            title: "Concurrent case",
            type: "case",
            metadata: [],
            quotes: [],
        };
        let resolveResponse: ((response: Response) => void) | undefined;
        fetchMock.mockImplementation(
            () =>
                new Promise<Response>((resolve) => {
                    resolveResponse = resolve;
                }),
        );

        const first = getPanelDocument("case:456");
        const second = getPanelDocument("case:456");
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

        resolveResponse?.(jsonResponse(document));
        await expect(Promise.all([first, second])).resolves.toEqual([
            document,
            document,
        ]);
    });

    it("rejects invalid panel documents and permits a later retry", async () => {
        fetchMock
            .mockResolvedValueOnce(
                jsonResponse({ document_id: "case:invalid", title: "Broken" }),
            )
            .mockResolvedValueOnce(
                jsonResponse({
                    document_id: "case:invalid",
                    title: "Recovered",
                    type: "case",
                    metadata: [],
                    quotes: [],
                }),
            );

        await expect(getPanelDocument("case:invalid")).rejects.toThrow(
            "Invalid source document response",
        );
        await expect(getPanelDocument("case:invalid")).resolves.toMatchObject({
            title: "Recovered",
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("exportChatData and exportTabularReviewsData hit their export routes", async () => {
        fetchMock.mockImplementation(() =>
            Promise.resolve(
                new Response("bytes", {
                    status: 200,
                    headers: {
                        "content-disposition": 'attachment; filename="x.zip"',
                    },
                }),
            ),
        );

        const chats = await exportChatData();
        expect(lastFetchCall().url).toBe("/api/user/chats/export");
        expect(chats.filename).toBe("x.zip");
        expect(await chats.blob.text()).toBe("bytes");

        await exportTabularReviewsData();
        expect(lastFetchCall().url).toBe("/api/user/tabular-reviews/export");
    });

    it("downloadUserExport streams the finished artifact by encoded id", async () => {
        fetchMock.mockResolvedValue(
            new Response("csv-bytes", {
                status: 200,
                headers: {
                    "content-disposition":
                        'attachment; filename="history.csv"',
                },
            }),
        );

        const { blob, filename } = await downloadUserExport("exp/1");

        expect(lastFetchCall().url).toBe("/api/user/exports/exp%2F1/download");
        expect(filename).toBe("history.csv");
        expect(await blob.text()).toBe("csv-bytes");
    });
});
