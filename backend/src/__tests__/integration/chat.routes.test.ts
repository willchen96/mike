import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

// #383's model-selection describes grew this file past the chat limiter's
// 30-requests-per-window budget, so the last describe began answering 429
// before any permission check ran. Hoisted so it precedes app.ts's limiter
// construction; scoped to tests — production reads its own env.
vi.hoisted(() => {
    process.env.RATE_LIMIT_CHAT_MAX = "1000";
});

// Hoisted mock fn so the vi.mock factory below (which is itself hoisted above
// the imports) can reference it. Lets each test drive the stream outcome.
const { runLLMStream, dbInserts, dbUpdates, dbControl } = vi.hoisted(() => ({
    runLLMStream: vi.fn(),
    dbInserts: [] as { table: string; value: unknown }[],
    dbUpdates: [] as {
        table: string;
        value: unknown;
        filters: { column: string; value: unknown }[];
    }[],
    dbControl: {
        failAssistantReservation: false,
        terminalUpdateFailures: 0,
        terminalUpdateAttempts: 0,
        terminalUpdateGate: null as Promise<void> | null,
        wordChatMissing: false,
        // When set, selects on chat_messages resolve against these rows with
        // the eq/not/order/limit chain genuinely applied (a mini query
        // engine), so tests can prove which assistant row a query picks.
        assistantMessageRows: null as Record<string, unknown>[] | null,
    },
}));

// A permissive, chainable Supabase stub. Every query-builder method returns the
// same object (so arbitrary chains work), the object is awaitable (thenable),
// and the terminal single()/maybeSingle() resolve to a chat row. The chat
// routes only read `.id`/`.title` and check `.error`, so this is enough to let
// a request flow through chat creation and message inserts without real IO.
function makeQuery(table: string) {
    let result: { data: unknown; error: { message: string } | null } = {
        data: {
            id: "chat-1",
            title: null,
            user_id: "u1",
            project_id: null,
        },
        error: null,
    };
    const q: Record<string, unknown> = {};
    let activeUpdate:
        | {
              table: string;
              value: unknown;
              filters: { column: string; value: unknown }[];
          }
        | undefined;
    const chain = [
        "delete",
        "upsert",
        "neq",
        "in",
        "is",
        "or",
        "lt",
        "gt",
        "gte",
        "lte",
        "filter",
        "range",
        "contains",
    ];
    for (const m of chain) q[m] = vi.fn(() => q);
    // Select-chain state, applied against dbControl.assistantMessageRows when
    // the query resolves (see q.then below).
    let didSelect = false;
    const selectState = {
        filters: [] as { column: string; op: string; value: unknown }[],
        order: null as { column: string; ascending: boolean } | null,
        limit: null as number | null,
    };
    q.select = vi.fn(() => {
        didSelect = true;
        return q;
    });
    q.not = vi.fn((column: string, operator: string, value: unknown) => {
        selectState.filters.push({ column, op: `not-${operator}`, value });
        return q;
    });
    q.order = vi.fn((column: string, opts?: { ascending?: boolean }) => {
        selectState.order = { column, ascending: opts?.ascending !== false };
        return q;
    });
    q.limit = vi.fn((count: number) => {
        selectState.limit = count;
        return q;
    });
    q.insert = vi.fn((value: unknown) => {
        dbInserts.push({ table, value });
        if (
            dbControl.failAssistantReservation &&
            table === "chat_messages" &&
            (value as { role?: unknown }).role === "assistant"
        ) {
            result = {
                data: null,
                error: { message: "assistant reservation failed" },
            };
        }
        return q;
    });
    q.update = vi.fn((value: unknown) => {
        activeUpdate = { table, value, filters: [] };
        dbUpdates.push(activeUpdate);
        return q;
    });
    q.eq = vi.fn((column: string, value: unknown) => {
        if (activeUpdate) activeUpdate.filters.push({ column, value });
        else selectState.filters.push({ column, op: "eq", value });
        return q;
    });
    q.single = vi.fn(() => Promise.resolve(result));
    q.maybeSingle = vi.fn(() =>
        Promise.resolve(
            table === "word_chats" && dbControl.wordChatMissing
                ? { data: null, error: null }
                : result,
        ),
    );
    q.then = (
        resolve: (v: unknown) => unknown,
        reject?: (e: unknown) => unknown,
    ) => {
        const resolveQuery = async () => {
            if (activeUpdate?.table === "chat_messages") {
                dbControl.terminalUpdateAttempts += 1;
                if (dbControl.terminalUpdateGate) {
                    await dbControl.terminalUpdateGate;
                }
                if (
                    dbControl.terminalUpdateAttempts <=
                    dbControl.terminalUpdateFailures
                ) {
                    return {
                        data: null,
                        error: {
                            message: `terminal update failed (attempt ${dbControl.terminalUpdateAttempts})`,
                        },
                    };
                }
            }
            if (
                !activeUpdate &&
                didSelect &&
                table === "chat_messages" &&
                dbControl.assistantMessageRows
            ) {
                let rows = [...dbControl.assistantMessageRows];
                for (const f of selectState.filters) {
                    if (f.op === "eq") {
                        rows = rows.filter((row) => row[f.column] === f.value);
                    } else if (f.op === "not-is" && f.value === null) {
                        rows = rows.filter((row) => row[f.column] !== null);
                    }
                }
                if (selectState.order) {
                    const { column, ascending } = selectState.order;
                    rows = [...rows].sort(
                        (a, b) =>
                            String(a[column]).localeCompare(String(b[column])) *
                            (ascending ? 1 : -1),
                    );
                }
                if (selectState.limit != null) {
                    rows = rows.slice(0, selectState.limit);
                }
                return { data: rows, error: null };
            }
            return result;
        };
        return resolveQuery().then(resolve, reject);
    };
    return q;
}

function mockSupabase() {
    return {
        from: vi.fn((table: string) => makeQuery(table)),
        rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
        auth: {
            getUser: () =>
                Promise.resolve({ data: { user: { id: "u1" } }, error: null }),
        },
    };
}

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => mockSupabase()),
}));

// Authenticate every request as user "u1" without exercising the real Supabase
// JWT path. requireMfaIfEnrolled must be exported too — userRouter (mounted by
// the app) imports it at module load.
vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = "u1";
        res.locals.userEmail = "u1@test.local";
        next();
    },
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));

// Keep the real error helpers (the failure-path test relies on genuine
// isAbortError + AssistantStreamError behavior) but stub the functions that
// would otherwise hit the DB or the LLM.
vi.mock("../../lib/chat", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../lib/chat")>();
    return {
        ...actual,
        buildDocContext: vi.fn(async () => ({
            docIndex: {},
            docStore: new Map(),
        })),
        enrichWithPriorEvents: vi.fn(async (messages: unknown) => messages),
        buildWorkflowStore: vi.fn(async () => new Map()),
        buildMessages: vi.fn(() => []),
        runLLMStream: (...args: unknown[]) => runLLMStream(...args),
    };
});

vi.mock("../../lib/userSettings", () => ({
    getUserModelSettings: vi.fn(async () => ({
        legal_research_us: false,
        title_model: "test-model",
        tabular_model: "test-model",
        last_selected_chat_model: null,
        last_selected_reasoning_level: null,
        api_keys: { gemini: "test-key" },
        personalisation: {
            displayName: "Ada",
            organisation: "Acme LLP",
            jurisdiction: "Singapore",
            practiceSetting: "private_practice",
            professionalTitle: "Partner",
            practiceAreas: ["Litigation"],
        },
    })),
    persistLastSelectedChatModel: vi.fn(async () => null),
    persistLastSelectedReasoningLevel: vi.fn(async () => null),
    getUserApiKeys: vi.fn(async () => ({})),
}));

// generate-title calls completeText; stub it so the success-path tests don't
// reach a real LLM. Everything else in lib/llm stays real.
vi.mock("../../lib/llm", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../lib/llm")>();
    return {
        ...actual,
        completeText: vi.fn(async () => "Generated Title"),
    };
});

import { app } from "../../app";
import { createServerSupabase } from "../../lib/supabase";

const VALID_BODY = {
    messages: [{ role: "user", content: "hello" }],
    model: "gemini-3-flash-preview",
};

function findAssistantReservation() {
    return dbInserts.find(
        ({ table, value }) =>
            table === "chat_messages" &&
            (value as { role?: unknown }).role === "assistant",
    );
}

function findAssistantUpdate() {
    return dbUpdates.find(({ table }) => table === "chat_messages");
}

describe("POST /chat — streaming endpoint", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbInserts.length = 0;
        dbUpdates.length = 0;
        dbControl.failAssistantReservation = false;
        dbControl.terminalUpdateFailures = 0;
        dbControl.terminalUpdateAttempts = 0;
        dbControl.terminalUpdateGate = null;
        dbControl.wordChatMissing = false;
        dbControl.assistantMessageRows = null;
        runLLMStream.mockResolvedValue({
            fullText: "hi there",
            events: [],
            citations: [],
        });
    });

    it("streams SSE with a chat_id event on the happy path", async () => {
        const chatLib = await import("../../lib/chat");
        let reservationExistedBeforeStreaming = false;
        runLLMStream.mockImplementation(async () => {
            reservationExistedBeforeStreaming = !!findAssistantReservation();
            return {
                fullText: "hi there",
                events: [{ type: "content", text: "hi there" }],
                citations: [],
            };
        });

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send(VALID_BODY);

        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toContain("text/event-stream");
        expect(res.text).toContain('"type":"chat_id"');
        expect(res.text).toContain('"type":"chat_title"');
        expect(runLLMStream).toHaveBeenCalledTimes(1);
        expect(runLLMStream).toHaveBeenCalledWith(
            expect.objectContaining({ emitDone: false }),
        );
        const systemPromptExtra = vi.mocked(chatLib.buildMessages).mock
            .calls[0]?.[2] as string;
        expect(systemPromptExtra).toContain("USER PERSONALISATION");
        expect(systemPromptExtra).toContain('"title": "Partner"');
        expect(systemPromptExtra).toContain(
            '"professional_setting": "Private practice"',
        );

        const metadata = JSON.parse(
            res.text
                .split("\n")
                .find((line) => line.includes('"type":"chat_id"'))!
                .replace(/^data:\s*/, ""),
        ) as { chatId: string; assistantMessageId: string };
        const assistantInsert = findAssistantReservation();
        const assistantUpdate = findAssistantUpdate();
        expect(reservationExistedBeforeStreaming).toBe(true);
        expect(metadata.assistantMessageId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        expect(assistantInsert?.value).toMatchObject({
            id: metadata.assistantMessageId,
            chat_id: metadata.chatId,
            role: "assistant",
            content: null,
            citations: null,
        });
        expect(assistantUpdate?.value).toMatchObject({
            content: [{ type: "content", text: "hi there" }],
            citations: null,
        });
        expect(assistantUpdate?.filters).toEqual(
            expect.arrayContaining([
                { column: "id", value: metadata.assistantMessageId },
                { column: "chat_id", value: metadata.chatId },
            ]),
        );
    });

    it("rejects a chat without an explicit model before streaming", async () => {
        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({ messages: VALID_BODY.messages });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            code: "model_required",
            detail: "Select a model before sending a message.",
        });
        expect(runLLMStream).not.toHaveBeenCalled();
    });

    it("uses the profile last-selected model when a new chat omits model", async () => {
        const userSettings = await import("../../lib/userSettings");
        vi.mocked(userSettings.getUserModelSettings).mockResolvedValueOnce({
            legal_research_us: false,
            title_model: null,
            tabular_model: null,
            last_selected_chat_model: "gpt-5.6-luna",
            api_keys: { openai: "test-key" },
        });

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({ messages: VALID_BODY.messages });

        expect(res.status).toBe(200);
        expect(runLLMStream).toHaveBeenCalledWith(
            expect.objectContaining({ model: "gpt-5.6-luna" }),
        );
        expect(dbInserts).toContainEqual({
            table: "chats",
            value: expect.objectContaining({ model: "gpt-5.6-luna" }),
        });
        expect(
            userSettings.persistLastSelectedChatModel,
        ).not.toHaveBeenCalled();
    });

    it("surfaces an empty upstream completion as a visible retry error", async () => {
        // Some providers end the stream cleanly but produce no content.
        // Silence reads as a hung composer, so the route emits an explicit,
        // safe-to-display error event before closing the stream.
        runLLMStream.mockResolvedValue({
            fullText: "",
            events: [],
            citations: [],
        });

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send(VALID_BODY);

        expect(res.status).toBe(200);
        expect(res.text).toContain('"type":"error"');
        expect(res.text).toContain("empty response");
        expect(res.text).toContain('"safe_to_display":true');
        expect(res.text).toContain("[DONE]");
    });

    it("stores cloud Word chats only in the document-scoped Word tables", async () => {
        const chatLib = await import("../../lib/chat");
        const res = await request(app)
            .post("/word-chat")
            .set("Authorization", "Bearer test")
            .send({
                messages: [{ role: "user", content: "Visible prompt" }],
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
                document_name: "Contract.docx",
                storage: "cloud",
                document_context: "GOVERNED BY DELAWARE LAW",
                model: "gemini-3-flash-preview",
            });

        expect(res.status).toBe(200);
        expect(dbInserts.some(({ table }) => table === "chats")).toBe(false);
        expect(dbInserts.some(({ table }) => table === "chat_messages")).toBe(
            false,
        );
        expect(dbInserts).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    table: "word_chats",
                    value: expect.objectContaining({
                        user_id: "u1",
                        word_document_id: "chat-1",
                    }),
                }),
                expect.objectContaining({
                    table: "word_chat_messages",
                    value: expect.objectContaining({
                        role: "user",
                        content: "Visible prompt",
                    }),
                }),
                expect.objectContaining({
                    table: "word_chat_messages",
                    value: expect.objectContaining({ role: "assistant" }),
                }),
            ]),
        );
        const call = vi.mocked(chatLib.buildMessages).mock.calls[0];
        const docAvailability = call[1] as {
            doc_id: string;
            filename: string;
        }[];
        const systemPromptExtra = call[2] as string;
        const streamArgs = runLLMStream.mock.calls[0]?.[0] as {
            docStore: Map<
                string,
                {
                    filename: string;
                    inline_text?: string;
                }
            >;
        };
        expect(systemPromptExtra).toContain("running inside Microsoft Word");
        expect(systemPromptExtra).toContain("USER PERSONALISATION");
        expect(systemPromptExtra).toContain('"jurisdiction": "Singapore"');
        expect(systemPromptExtra).toContain(
            '\"deleted_text\":\"exact text copied from the active Word document\"',
        );
        expect(systemPromptExtra).not.toContain("GOVERNED BY DELAWARE LAW");
        expect(docAvailability).toContainEqual({
            doc_id: "active-word-document",
            filename: "Contract.docx",
        });
        expect(streamArgs.docStore.get("active-word-document")).toMatchObject({
            filename: "Contract.docx",
            inline_text: "GOVERNED BY DELAWARE LAW",
        });
        expect(
            dbInserts.find(
                ({ table, value }) =>
                    table === "word_chat_messages" &&
                    (value as { role?: unknown }).role === "user",
            )?.value,
        ).toMatchObject({ content: "Visible prompt" });
        expect(runLLMStream).toHaveBeenCalledWith(
            expect.objectContaining({ includeAskInputs: false }),
        );
    });

    it.each([
        [{ messages: VALID_BODY.messages }, "document_id must be a UUID"],
        [
            {
                ...VALID_BODY,
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
                document_name: "   ",
            },
            "document_name must be a non-empty string",
        ],
        [
            {
                ...VALID_BODY,
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
                storage: "weird",
            },
            'storage must be "cloud" or "local"',
        ],
        [
            {
                ...VALID_BODY,
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
                chat_id: "not-a-uuid",
            },
            "chat_id must be a UUID",
        ],
    ])(
        "rejects invalid Word-chat input before streaming",
        async (body, detail) => {
            const res = await request(app)
                .post("/word-chat")
                .set("Authorization", "Bearer test")
                .send(body);

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe(detail);
            expect(runLLMStream).not.toHaveBeenCalled();
            expect(dbInserts).toEqual([]);
        },
    );

    it("rejects a Word chat without an explicit model before creating storage", async () => {
        const res = await request(app)
            .post("/word-chat")
            .set("Authorization", "Bearer test")
            .send({
                messages: VALID_BODY.messages,
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
                storage: "cloud",
            });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe("model_required");
        expect(dbInserts).toEqual([]);
        expect(runLLMStream).not.toHaveBeenCalled();
    });

    it("uses the shared last-selected model for a local Word chat", async () => {
        const userSettings = await import("../../lib/userSettings");
        vi.mocked(userSettings.getUserModelSettings).mockResolvedValueOnce({
            legal_research_us: false,
            title_model: null,
            tabular_model: null,
            last_selected_chat_model: "gpt-5.6-luna",
            api_keys: { openai: "test-key" },
        });

        const res = await request(app)
            .post("/word-chat")
            .set("Authorization", "Bearer test")
            .send({
                messages: VALID_BODY.messages,
                storage: "local",
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
            });

        expect(res.status).toBe(200);
        expect(runLLMStream).toHaveBeenCalledWith(
            expect.objectContaining({ model: "gpt-5.6-luna" }),
        );
    });

    it("rejects a resumed Word chat outside the scoped document and user", async () => {
        dbControl.wordChatMissing = true;

        const res = await request(app)
            .post("/word-chat")
            .set("Authorization", "Bearer test")
            .send({
                ...VALID_BODY,
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
                chat_id: "96fdeaa1-af40-475e-9834-703004783f21",
                storage: "cloud",
            });

        expect(res.status).toBe(404);
        expect(res.body.detail).toBe("Chat not found");
        expect(runLLMStream).not.toHaveBeenCalled();
        expect(
            dbInserts.some(({ table }) => table === "word_chat_messages"),
        ).toBe(false);
    });

    it("streams local Word chats without inserting any chat rows", async () => {
        const res = await request(app)
            .post("/word-chat")
            .set("Authorization", "Bearer test")
            .send({
                ...VALID_BODY,
                chat_id: "96fdeaa1-af40-475e-9834-703004783f21",
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
                storage: "local",
            });

        expect(res.status).toBe(200);
        expect(res.text).toContain(
            '"chatId":"96fdeaa1-af40-475e-9834-703004783f21"',
        );
        // No chat row, no message row: local storage means the transcript
        // never reaches the server. The audit job below is the one permitted
        // write — it records THAT a Word turn happened, deliberately without
        // the prompt text (see the title it carries).
        expect(dbInserts.map(({ table }) => table)).toEqual(["db_jobs"]);
        const auditJob = dbInserts[0].value as {
            kind: string;
            payload: { base: { surface: string; title: string | null } };
        };
        expect(auditJob.kind).toBe("audit.chat_turn");
        expect(auditJob.payload.base.surface).toBe("word");
        expect(auditJob.payload.base.title).not.toContain("hello");
        expect(dbUpdates).toEqual([]);
        expect(runLLMStream).toHaveBeenCalledTimes(1);
    });

    it("does not finish the SSE response until the terminal assistant update succeeds", async () => {
        let releaseTerminalUpdate!: () => void;
        dbControl.terminalUpdateGate = new Promise<void>((resolve) => {
            releaseTerminalUpdate = resolve;
        });

        let requestSettled = false;
        const responsePromise = request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send(VALID_BODY)
            .then((response) => {
                requestSettled = true;
                return response;
            });

        await vi.waitFor(() => {
            expect(dbControl.terminalUpdateAttempts).toBe(1);
        });
        expect(runLLMStream).toHaveBeenCalledWith(
            expect.objectContaining({ emitDone: false }),
        );
        expect(requestSettled).toBe(false);

        releaseTerminalUpdate();
        const res = await responsePromise;

        expect(requestSettled).toBe(true);
        expect(res.text).toContain("data: [DONE]");
        expect(res.text).not.toContain(
            "The response was generated but could not be saved",
        );
    });

    it("retries a failed terminal assistant update up to success", async () => {
        dbControl.terminalUpdateFailures = 2;

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send(VALID_BODY);

        expect(res.status).toBe(200);
        expect(dbControl.terminalUpdateAttempts).toBe(3);
        expect(
            dbUpdates.filter(({ table }) => table === "chat_messages"),
        ).toHaveLength(3);
        expect(res.text).toContain("data: [DONE]");
        expect(res.text).not.toContain(
            "The response was generated but could not be saved",
        );
    });

    it("reports a terminal persistence failure before ending the SSE stream", async () => {
        dbControl.terminalUpdateFailures = 3;
        const errorSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send(VALID_BODY);

        expect(res.status).toBe(200);
        expect(dbControl.terminalUpdateAttempts).toBe(3);
        expect(
            dbUpdates.filter(({ table }) => table === "chat_messages"),
        ).toHaveLength(3);

        const errorIndex = res.text.indexOf(
            "The response was generated but could not be saved",
        );
        const doneIndex = res.text.indexOf("data: [DONE]");
        expect(errorIndex).toBeGreaterThanOrEqual(0);
        expect(doneIndex).toBeGreaterThan(errorIndex);
        expect(errorSpy).toHaveBeenCalledWith(
            "[chat/stream] failed to save assistant response",
            expect.objectContaining({
                message: "terminal update failed (attempt 3)",
            }),
        );
        errorSpy.mockRestore();
    });

    it("fails before advertising SSE metadata when the assistant row cannot be reserved", async () => {
        dbControl.failAssistantReservation = true;
        const errorSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send(VALID_BODY);

        expect(res.status).toBe(500);
        expect(res.headers["content-type"]).not.toContain("text/event-stream");
        expect(res.body.detail).toBe("Something went wrong. Please try again.");
        expect(res.text).not.toContain('"type":"chat_id"');
        expect(findAssistantReservation()).toBeDefined();
        expect(runLLMStream).not.toHaveBeenCalled();
        expect(findAssistantUpdate()).toBeUndefined();
        expect(errorSpy).toHaveBeenCalledWith(
            "[chat/stream] failed to reserve assistant message",
            expect.objectContaining({
                message: "assistant reservation failed",
            }),
        );
        errorSpy.mockRestore();
    });

    it("surfaces a stream failure as an in-stream error event, not an HTTP error", async () => {
        runLLMStream.mockRejectedValue(new Error("upstream LLM failure"));

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send(VALID_BODY);

        // Headers were already flushed (200) before the stream threw, so the
        // failure surfaces as an in-stream error event + [DONE].
        expect(res.status).toBe(200);
        expect(res.text).toContain('"type":"error"');
        expect(res.text).toContain("[DONE]");

        const metadata = JSON.parse(
            res.text
                .split("\n")
                .find((line) => line.includes('"type":"chat_id"'))!
                .replace(/^data:\s*/, ""),
        ) as { assistantMessageId: string };
        const assistantInsert = findAssistantReservation();
        const assistantUpdate = findAssistantUpdate();
        expect(assistantInsert?.value).toMatchObject({
            id: metadata.assistantMessageId,
            role: "assistant",
        });
        expect(assistantUpdate?.filters).toContainEqual({
            column: "id",
            value: metadata.assistantMessageId,
        });
        expect(assistantUpdate?.value).toMatchObject({
            content: [
                expect.objectContaining({
                    type: "error",
                    message:
                        "The response could not be completed. Please try again.",
                }),
            ],
        });
    });

    it("uses the streamed assistant message id when persisting a cancelled partial response", async () => {
        const { AssistantStreamAbortError } = await import("../../lib/chat");
        runLLMStream.mockRejectedValue(
            new AssistantStreamAbortError("partial", [
                { type: "content", text: "partial" },
            ]),
        );

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send(VALID_BODY);

        expect(res.status).toBe(200);
        const metadata = JSON.parse(
            res.text
                .split("\n")
                .find((line) => line.includes('"type":"chat_id"'))!
                .replace(/^data:\s*/, ""),
        ) as { assistantMessageId: string };
        const assistantInsert = findAssistantReservation();
        const assistantUpdate = findAssistantUpdate();
        expect(assistantInsert?.value).toMatchObject({
            id: metadata.assistantMessageId,
            role: "assistant",
        });
        expect(assistantUpdate?.filters).toContainEqual({
            column: "id",
            value: metadata.assistantMessageId,
        });
        expect(assistantUpdate?.value).toMatchObject({
            content: expect.arrayContaining([
                { type: "content", text: "partial" },
                { type: "content", text: "Cancelled by user." },
            ]),
        });
    });

    it("does not allocate or insert a new assistant message for an ask-input continuation", async () => {
        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({
                ...VALID_BODY,
                chat_id: "chat-1",
                ask_inputs_response: {
                    responses: [
                        {
                            id: "choice-1",
                            kind: "choice",
                            question: "Continue?",
                            answer: "Yes",
                        },
                    ],
                },
            });

        expect(res.status).toBe(200);
        const metadata = JSON.parse(
            res.text
                .split("\n")
                .find((line) => line.includes('"type":"chat_id"'))!
                .replace(/^data:\s*/, ""),
        ) as Record<string, unknown>;
        expect(metadata).not.toHaveProperty("assistantMessageId");
        expect(
            dbInserts.filter(
                ({ table, value }) =>
                    table === "chat_messages" &&
                    (value as { role?: unknown }).role === "assistant",
            ),
        ).toEqual([]);
    });

    it("appends ask-input responses to the real last assistant message, skipping a null-content reservation", async () => {
        // A stream that died before its save path (or a concurrently
        // streaming POST) leaves the newest assistant row as an empty
        // reservation. The continuation must attach the user's answers to
        // the older, real message that actually asked the question.
        dbControl.assistantMessageRows = [
            {
                id: "assistant-real",
                chat_id: "chat-1",
                role: "assistant",
                content: [{ type: "ask_inputs", items: [] }],
                citations: null,
                created_at: "2026-01-01T00:00:00Z",
            },
            {
                id: "assistant-reservation",
                chat_id: "chat-1",
                role: "assistant",
                content: null,
                citations: null,
                created_at: "2026-01-01T00:05:00Z",
            },
        ];

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({
                ...VALID_BODY,
                chat_id: "chat-1",
                ask_inputs_response: {
                    responses: [
                        {
                            id: "choice-1",
                            kind: "choice",
                            question: "Continue?",
                            answer: "Yes",
                        },
                    ],
                },
            });

        expect(res.status).toBe(200);
        const askInputsUpdate = dbUpdates.find(
            ({ table, filters }) =>
                table === "chat_messages" &&
                filters.some(
                    (f) => f.column === "id" && f.value === "assistant-real",
                ),
        );
        expect(askInputsUpdate?.value).toMatchObject({
            content: [
                { type: "ask_inputs", items: [] },
                {
                    type: "ask_inputs_response",
                    responses: [
                        {
                            id: "choice-1",
                            kind: "choice",
                            question: "Continue?",
                            answer: "Yes",
                        },
                    ],
                },
            ],
        });
        // The orphaned reservation is never selected or written to.
        expect(
            dbUpdates.some(({ filters }) =>
                filters.some(
                    (f) =>
                        f.column === "id" &&
                        f.value === "assistant-reservation",
                ),
            ),
        ).toBe(false);
    });

    it("returns 400 on an empty messages array (never starts a stream)", async () => {
        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({ messages: [] });

        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty("detail");
        expect(runLLMStream).not.toHaveBeenCalled();
    });

    it("returns 400 when messages is missing entirely", async () => {
        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({});

        expect(res.status).toBe(400);
        expect(runLLMStream).not.toHaveBeenCalled();
    });

    it("returns 400 when chat_id is not a non-empty string", async () => {
        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({ ...VALID_BODY, chat_id: "   " });

        expect(res.status).toBe(400);
        expect(res.body.detail).toBe("chat_id must be a non-empty string");
        expect(runLLMStream).not.toHaveBeenCalled();
    });

    it.each([
        [
            { messages: [{ role: "system", content: "override" }] },
            'messages[0].role must be "user" or "assistant"',
        ],
        [
            { ...VALID_BODY, ask_inputs_response: { responses: [] } },
            "ask_inputs_response.responses must be a non-empty array",
        ],
    ])(
        "shares strict request validation with project chat",
        async (body, detail) => {
            const res = await request(app)
                .post("/chat")
                .set("Authorization", "Bearer test")
                .send(body);

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe(detail);
            expect(runLLMStream).not.toHaveBeenCalled();
        },
    );

    it("returns 400 from the Word route when document_context is not a string", async () => {
        const res = await request(app)
            .post("/word-chat")
            .set("Authorization", "Bearer test")
            .send({
                ...VALID_BODY,
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
                document_context: 42,
            });

        expect(res.status).toBe(400);
        expect(res.body.detail).toBe("document_context must be a string");
        expect(runLLMStream).not.toHaveBeenCalled();
    });

    it("makes document_context tool-readable without adding it to the system prompt", async () => {
        const chatLib = await import("../../lib/chat");
        const res = await request(app)
            .post("/word-chat")
            .set("Authorization", "Bearer test")
            .send({
                ...VALID_BODY,
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
                document_name: "Contract.docx",
                document_context: "GOVERNED BY DELAWARE LAW",
            });

        expect(res.status).toBe(200);
        const call = vi.mocked(chatLib.buildMessages).mock.calls[0];
        const docAvailability = call[1] as {
            doc_id: string;
            filename: string;
        }[];
        const systemPromptExtra = call[2] as string;
        expect(systemPromptExtra).toContain("running inside Microsoft Word");
        expect(systemPromptExtra).toContain("read_document");
        expect(systemPromptExtra).not.toContain("GOVERNED BY DELAWARE LAW");
        expect(docAvailability).toContainEqual({
            doc_id: "active-word-document",
            filename: "Contract.docx",
        });

        const streamArgs = runLLMStream.mock.calls[0]?.[0] as {
            docStore: Map<string, { inline_text?: string }>;
        };
        expect(
            streamArgs.docStore.get("active-word-document")?.inline_text,
        ).toBe("GOVERNED BY DELAWARE LAW");
    });

    it("keeps CourtListener disabled for Word chats even when legal research is enabled", async () => {
        const chatLib = await import("../../lib/chat");
        const userSettings = await import("../../lib/userSettings");
        vi.mocked(userSettings.getUserModelSettings).mockResolvedValueOnce({
            title_model: "test-model",
            tabular_model: "test-model",
            last_selected_chat_model: null,
            legal_research_us: true,
            api_keys: {
                gemini: "test-key",
                courtlistener: "configured-but-unused",
            },
        });

        const res = await request(app)
            .post("/word-chat")
            .set("Authorization", "Bearer test")
            .send({
                ...VALID_BODY,
                document_id: "6f783e59-35c4-4ddc-896a-94aa4d05a767",
                document_context: "Contract text",
            });

        expect(res.status).toBe(200);
        const buildMessagesCall = vi.mocked(chatLib.buildMessages).mock
            .calls[0];
        expect(buildMessagesCall[4]).toBe(false);
        expect(buildMessagesCall[6]).toBe("replace");
        expect(runLLMStream).toHaveBeenCalledWith(
            expect.objectContaining({ includeResearchTools: false }),
        );
        const streamArgs = runLLMStream.mock.calls[0]?.[0] as {
            apiKeys?: { courtlistener?: string };
        };
        expect(streamArgs.apiKeys?.courtlistener).toBeUndefined();
    });
});

describe("PATCH /chat/:chatId", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbUpdates.length = 0;
    });

    it("returns 400 when no supported update is provided", async () => {
        const res = await request(app)
            .patch("/chat/chat-1")
            .set("Authorization", "Bearer test")
            .send({});

        expect(res.status).toBe(400);
        expect(res.body.detail).toBe(
            "title, model or reasoningLevel is required",
        );
    });

    it("updates the chat and profile when a model is selected", async () => {
        const userSettings = await import("../../lib/userSettings");
        const res = await request(app)
            .patch("/chat/chat-1")
            .set("Authorization", "Bearer test")
            .send({ model: "gemini-3-flash-preview" });

        expect(res.status).toBe(200);
        expect(dbUpdates).toContainEqual({
            table: "chats",
            value: { model: "gemini-3-flash-preview" },
            filters: [{ column: "id", value: "chat-1" }],
        });
        expect(userSettings.persistLastSelectedChatModel).toHaveBeenCalledWith(
            "u1",
            "gemini-3-flash-preview",
            expect.anything(),
        );
    });

    it("updates the chat and profile when reasoning is selected", async () => {
        const userSettings = await import("../../lib/userSettings");
        const res = await request(app)
            .patch("/chat/chat-1")
            .set("Authorization", "Bearer test")
            .send({ reasoningLevel: "xhigh" });

        expect(res.status).toBe(200);
        expect(dbUpdates).toContainEqual({
            table: "chats",
            value: { reasoning_level: "xhigh" },
            filters: [{ column: "id", value: "chat-1" }],
        });
        expect(
            userSettings.persistLastSelectedReasoningLevel,
        ).toHaveBeenCalledWith("u1", "xhigh", expect.anything());
    });
});

describe("PATCH /word-chat/:chatId/model", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbUpdates.length = 0;
        dbControl.wordChatMissing = false;
    });

    it("updates a cloud Word chat and the profile on selection", async () => {
        const userSettings = await import("../../lib/userSettings");
        const chatId = "6f783e59-35c4-4ddc-896a-94aa4d05a768";
        const documentId = "6f783e59-35c4-4ddc-896a-94aa4d05a767";
        const res = await request(app)
            .patch(`/word-chat/${chatId}/model`)
            .query({ document_id: documentId })
            .set("Authorization", "Bearer test")
            .send({ model: "gemini-3-flash-preview" });

        expect(res.status).toBe(200);
        expect(dbUpdates).toContainEqual({
            table: "word_chats",
            value: expect.objectContaining({
                model: "gemini-3-flash-preview",
            }),
            filters: [
                { column: "id", value: chatId },
                { column: "user_id", value: "u1" },
            ],
        });
        expect(userSettings.persistLastSelectedChatModel).toHaveBeenCalledWith(
            "u1",
            "gemini-3-flash-preview",
            expect.anything(),
        );
    });

    // Shape validation, not coercion. `String(req.body.title)` accepted every
    // one of these: `{}` was stored as the literal chat title
    // "[object Object]". The retired sharing shape is rejected explicitly.
    // caller was told the field they sent was missing.
    it.each([
        [{ title: { text: "hi" } }, "title must be a string"],
        [{ title: 42 }, "title must be a string"],
        [{ title: true }, "title must be a string"],
        [
            { shared_with: "someone@example.com" },
            "shared_with is no longer supported; use the chat access endpoints.",
        ],
        [
            { shared_with: { "0": "someone@example.com" } },
            "shared_with is no longer supported; use the chat access endpoints.",
        ],
        [
            { shared_with: ["someone@example.com", 42] },
            "shared_with is no longer supported; use the chat access endpoints.",
        ],
    ])("returns 400 for a malformed body: %j", async (body, detail) => {
        const res = await request(app)
            .patch("/chat/chat-1")
            .set("Authorization", "Bearer test")
            .send(body);

        expect(res.status).toBe(400);
        expect(res.body.detail).toBe(detail);
    });
});

// ---------------------------------------------------------------------------
// Org RBAC on chat writes.
//
// Scenario: chat "chat-1" lives in project "proj-1", created by "colleague-1",
// inside org "org-1". The authenticated caller is "u1" (see the auth mock).
// A table-aware supabase stub lets us vary how u1 reaches the project: a
// direct 'viewer' grant (may read, must not write), or org membership, which
// inherits project member and may write. The security property under test:
// POST /chat with an existing chat_id and POST /chat/:chatId/generate-title
// are WRITES and must require content.edit, while GET /chat/:chatId stays a
// read open to viewers.
//
// The same stub backs the sharing routes (PATCH/DELETE/people): it records
// every update/delete with its filters, so a test can prove the write was
// scoped by chat id alone (no user_id filter) rather than only that it
// returned 200.
// ---------------------------------------------------------------------------

type RbacWrite = {
    table: string;
    op: "update" | "delete";
    value?: unknown;
    filters: { column: string; value: unknown }[];
};
const rbacWrites: RbacWrite[] = [];
const rbacRpcCalls: { fn: string; args: unknown }[] = [];

function tableQuery(
    seed: Record<string, unknown> | Record<string, unknown>[] | null,
    table = "unknown",
    // When set, a write against this table fails the way a real outage does:
    // an error object rather than an empty result set. The two must not
    // produce the same HTTP answer.
    writeError: string | null = null,
) {
    const rows = Array.isArray(seed) ? seed : seed ? [seed] : [];
    const q: Record<string, unknown> = {};
    const chain = [
        "select", "insert", "upsert",
        "neq", "is", "not", "or", "lt", "gt", "gte", "lte",
        "filter", "order", "limit", "range", "contains",
    ];
    for (const m of chain) q[m] = vi.fn(() => q);
    // A write in flight collects its own filters; before that, eq/in narrow
    // the seeded rows. Filters naming a column the seed rows don't carry are
    // ignored, keeping the stub as permissive as the rest of this file.
    let write: RbacWrite | undefined;
    const selectFilters: { column: string; match: (v: unknown) => boolean }[] =
        [];
    const selected = () =>
        rows.filter((row) =>
            selectFilters.every(
                ({ column, match }) => !(column in row) || match(row[column]),
            ),
        );
    q.update = vi.fn((value: unknown) => {
        write = { table, op: "update", value, filters: [] };
        rbacWrites.push(write);
        return q;
    });
    q.delete = vi.fn(() => {
        write = { table, op: "delete", filters: [] };
        rbacWrites.push(write);
        return q;
    });
    q.eq = vi.fn((column: string, value: unknown) => {
        if (write) write.filters.push({ column, value });
        else
            selectFilters.push({ column, match: (actual) => actual === value });
        return q;
    });
    q.in = vi.fn((column: string, values: unknown[]) => {
        if (!write)
            selectFilters.push({
                column,
                match: (actual) => values.includes(actual),
            });
        return q;
    });
    // An update ... .select().single() echoes the row as it would look after
    // the write, which is what PATCH /chat/:chatId returns to the client.
    const first = () =>
        write?.op === "update"
            ? { ...(rows[0] ?? {}), ...(write.value as Record<string, unknown>) }
            : (selected()[0] ?? null);
    const outcome = () =>
        write && writeError
            ? { data: null, error: { message: writeError } }
            : { data: first(), error: null };
    q.single = vi.fn(() => Promise.resolve(outcome()));
    q.maybeSingle = vi.fn(() => Promise.resolve(outcome()));
    q.then = (
        resolve: (v: unknown) => unknown,
        reject?: (e: unknown) => unknown,
    ) =>
        Promise.resolve(
            write && writeError
                ? { data: null, error: { message: writeError } }
                : { data: write ? rows : selected(), error: null },
        ).then(resolve, reject);
    return q;
}

function makeRbacDb(
    orgRole: "admin" | "member" | null,
    chatUserId = "colleague-1",
    overrides: {
        grantRole?: "owner" | "editor" | "viewer" | null;
        chatGrantRole?: "owner" | "editor" | "viewer" | null;
        chatGrants?: Record<string, unknown>[];
        chat?: Record<string, unknown>;
        project?: Record<string, unknown>;
        orgMembers?: Record<string, unknown>[];
        profiles?: Record<string, unknown>[];
        chatWriteError?: string;
    } = {},
) {
    return {
        from: vi.fn((table: string) => {
            if (table === "chats")
                return tableQuery(
                    {
                        id: "chat-1",
                        title: "Existing chat",
                        user_id: chatUserId,
                        project_id: "proj-1",
                        org_id: "org-1",
                        ...overrides.chat,
                    },
                    table,
                    overrides.chatWriteError ?? null,
                );
            if (table === "projects")
                return tableQuery(
                    {
                        id: "proj-1",
                        user_id: "colleague-1",
                        org_id: "org-1",
                        ...overrides.project,
                    },
                    table,
                );
            if (table === "org_members")
                return tableQuery(
                    overrides.orgMembers ??
                        (orgRole
                            ? [
                                  {
                                      org_id: "org-1",
                                      user_id: "u1",
                                      role: orgRole,
                                  },
                              ]
                            : []),
                    table,
                );
            if (table === "project_access_grants")
                return tableQuery(
                    overrides.grantRole ? { role: overrides.grantRole } : null,
                    table,
                );
            if (table === "chat_access_grants")
                return tableQuery(
                    overrides.chatGrants ??
                        (overrides.chatGrantRole
                            ? [
                                  {
                                      id: "cg-1",
                                      chat_id: "chat-1",
                                      email: "u1@test.local",
                                      role: overrides.chatGrantRole,
                                      created_by: "colleague-1",
                                      created_at: "2026-09-02T00:00:00Z",
                                      updated_at: "2026-09-02T00:00:00Z",
                                  },
                              ]
                            : []),
                    table,
                );
            if (table === "user_profiles")
                return tableQuery(overrides.profiles ?? [], table);
            return tableQuery(null, table);
        }),
        rpc: vi.fn((fn: string, args: unknown) => {
            rbacRpcCalls.push({ fn, args });
            return Promise.resolve({ data: [], error: null });
        }),
        auth: {
            getUser: () =>
                Promise.resolve({ data: { user: { id: "u1" } }, error: null }),
        },
    };
}

// // #383 resolves an effective model before any chat write; the default
// settings stub (no last-selected model, gemini-only key) cannot resolve
// one, which would fail these permission tests with a 429 that has
// nothing to do with permissions. Seed a resolvable selection per test.
async function seedResolvableModel() {
    const userSettings = await import("../../lib/userSettings");
    vi.mocked(userSettings.getUserModelSettings).mockResolvedValueOnce({
        legal_research_us: false,
        title_model: null,
        tabular_model: null,
        last_selected_chat_model: "gpt-5.6-luna",
        api_keys: { openai: "test-key" },
    });
}

describe("chat writes are gated on content.edit (org RBAC)", () => {
    const mockedCreate = vi.mocked(createServerSupabase);


    beforeEach(() => {
        vi.clearAllMocks();
        runLLMStream.mockResolvedValue({
            fullText: "hi there",
            events: [],
            citations: [],
        });
    });

    afterEach(() => {
        // Restore the permissive default stub for the other describe blocks.
        mockedCreate.mockImplementation(() => mockSupabase() as never);
    });

    it("403s a personal-project Viewer POSTing to an existing chat", async () => {
        mockedCreate.mockImplementation(
            () => makeRbacDb(null, "colleague-1", {
                grantRole: "viewer",
                project: { org_id: null },
                chat: { org_id: null },
            }) as never,
        );

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({ ...VALID_BODY, chat_id: "chat-1" });

        expect(res.status).toBe(403);
        expect(res.body).toHaveProperty("detail");
        expect(runLLMStream).not.toHaveBeenCalled();
    });

    it("403s a personal-project Viewer calling generate-title", async () => {
        mockedCreate.mockImplementation(
            () => makeRbacDb(null, "colleague-1", {
                grantRole: "viewer",
                project: { org_id: null },
                chat: { org_id: null },
            }) as never,
        );

        const res = await request(app)
            .post("/chat/chat-1/generate-title")
            .set("Authorization", "Bearer test")
            .send({ message: "hello there" });

        expect(res.status).toBe(403);
        expect(res.body).toHaveProperty("detail");
    });

    // A Viewer can open the project, so answering "Project not found" told
    // them their matter had vanished. The refusal has to say it is one.
    it("403s a project Viewer creating a chat in that project", async () => {
        mockedCreate.mockImplementation(
            () =>
                makeRbacDb(null, "colleague-1", {
                    grantRole: "viewer",
                    project: { org_id: null },
                    chat: { org_id: null },
                }) as never,
        );

        const res = await request(app)
            .post("/chat/create")
            .set("Authorization", "Bearer test")
            .send({ project_id: "proj-1" });

        expect(res.status).toBe(403);
        expect(res.body.detail).toBe(
            "You do not have permission to write in this project.",
        );
    });

    it("keeps 404 when the project is invisible to the caller", async () => {
        mockedCreate.mockImplementation(
            () =>
                makeRbacDb(null, "colleague-1", {
                    grantRole: null,
                    project: { org_id: null },
                    chat: { org_id: null },
                }) as never,
        );

        const res = await request(app)
            .post("/chat/create")
            .set("Authorization", "Bearer test")
            .send({ project_id: "proj-1" });

        expect(res.status).toBe(404);
        expect(res.body.detail).toBe("Project not found");
    });

    it("does not elevate a project chat's creator above project access", async () => {
        mockedCreate.mockImplementation(() => makeRbacDb(null, "u1") as never);

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({ ...VALID_BODY, chat_id: "chat-1" });

        expect(res.status).toBe(404);
        expect(runLLMStream).not.toHaveBeenCalled();
    });

    it("still lets an org admin POST to a colleague's chat", async () => {
        mockedCreate.mockImplementation(() => makeRbacDb("admin") as never);

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({ ...VALID_BODY, chat_id: "chat-1" });

        expect(res.status).toBe(200);
        expect(runLLMStream).toHaveBeenCalledTimes(1);
    });

    it("still lets an org admin generate a title", async () => {
        await seedResolvableModel();
        mockedCreate.mockImplementation(() => makeRbacDb("admin") as never);

        const res = await request(app)
            .post("/chat/chat-1/generate-title")
            .set("Authorization", "Bearer test")
            .send({ message: "hello there" });

        expect(res.status).toBe(200);
        expect(res.body.title).toBe("Generated Title");
    });

    // The update's error used to be ignored, so a failed write still
    // answered 200 with the new title: the sidebar renamed the chat and the
    // next reload silently put the old name back.
    it("reports a failed title write instead of answering 200", async () => {
        await seedResolvableModel();
        mockedCreate.mockImplementation(
            () =>
                makeRbacDb("admin", "colleague-1", {
                    chatWriteError: "title update failed",
                }) as never,
        );

        const res = await request(app)
            .post("/chat/chat-1/generate-title")
            .set("Authorization", "Bearer test")
            .send({ message: "hello there" });

        expect(res.status).toBe(500);
        expect(res.body.detail).toBe("Something went wrong. Please try again.");
    });

    it("still lets a project viewer GET the chat (reads stay project.view)", async () => {
        mockedCreate.mockImplementation(
            () =>
                makeRbacDb(null, "colleague-1", {
                    grantRole: "viewer",
                    project: { org_id: null },
                    chat: { org_id: null },
                }) as never,
        );

        const res = await request(app)
            .get("/chat/chat-1")
            .set("Authorization", "Bearer test");

        expect(res.status).toBe(200);
        expect(res.body.chat).toMatchObject({ id: "chat-1" });
    });

    // The tools that WRITE documents (edit_document, replicate_document, the
    // generate_* family) persist into the chat's project, so they are judged
    // against the caller's PROJECT role — a direct chat grant must not
    // buy standing in the container. Same partition as
    // POST /projects/:projectId/chat.
    const mutationFlag = () =>
        (runLLMStream.mock.calls[0]?.[0] as { allowDocumentMutation: boolean })
            .allowDocumentMutation;

    it("rejects a project Viewer despite an incompatible child chat grant", async () => {
        mockedCreate.mockImplementation(
            () =>
                makeRbacDb(null, "colleague-1", {
                    grantRole: "viewer",
                    chatGrantRole: "editor",
                    project: { org_id: null },
                    chat: { org_id: null },
                }) as never,
        );

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({ ...VALID_BODY, chat_id: "chat-1" });

        expect(res.status).toBe(403);
        expect(runLLMStream).not.toHaveBeenCalled();
    });

    it("offers them to a project member, unchanged", async () => {
        mockedCreate.mockImplementation(() => makeRbacDb("member") as never);

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({ ...VALID_BODY, chat_id: "chat-1" });

        expect(res.status).toBe(200);
        expect(mutationFlag()).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Chat sharing, deletion and the people roster.
//
// Same fixture as above, now exercising the routes chats gained with the
// role-aware permission schema. The ladder under test: title edits are
// content.edit (member+), grants are access.manage (admin only), and
// deleting the chat is container.delete (admin only) — so a member who may
// rename the chat must not be able to re-share or erase it.
// ---------------------------------------------------------------------------
describe("chat grants, deletion and roster", () => {
    const mockedCreate = vi.mocked(createServerSupabase);

    beforeEach(() => {
        vi.clearAllMocks();
        rbacWrites.length = 0;
        rbacRpcCalls.length = 0;
    });

    afterEach(() => {
        mockedCreate.mockImplementation(() => mockSupabase() as never);
    });

    const chatWrites = (op: "update" | "delete") =>
        rbacWrites.filter((w) => w.table === "chats" && w.op === op);

    it("lets an org admin rename a colleague's chat", async () => {
        mockedCreate.mockImplementation(() => makeRbacDb("admin") as never);

        const res = await request(app)
            .patch("/chat/chat-1")
            .set("Authorization", "Bearer test")
            .send({ title: "  Renamed  " });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ id: "chat-1", title: "Renamed" });
        const [update] = chatWrites("update");
        expect(update?.value).toEqual({ title: "Renamed" });
        // Scoped by chat id ALONE. With the old `.eq("user_id", userId)`
        // filter still in place this write would match zero rows and the
        // admin's rename would silently vanish.
        expect(update?.filters).toEqual([{ column: "id", value: "chat-1" }]);
    });

    it("reports a failed rename as a server error, not as a missing chat", async () => {
        // Authorization already passed, so the row is there and the caller
        // may write it: a database failure at this point is ours. Answering
        // "404 Chat not found" would tell the client the thread is gone and
        // have it drop the chat from the sidebar over a transient outage.
        mockedCreate.mockImplementation(
            () =>
                makeRbacDb("admin", "colleague-1", {
                    chatWriteError: "connection terminated unexpectedly",
                }) as never,
        );

        const res = await request(app)
            .patch("/chat/chat-1")
            .set("Authorization", "Bearer test")
            .send({ title: "Renamed" });

        expect(res.status).toBe(500);
        expect(res.body.detail).not.toBe("Chat not found");
        // Never the raw driver message — sendInternalError redacts.
        expect(JSON.stringify(res.body)).not.toContain(
            "connection terminated",
        );
    });

    it("403s a project viewer renaming a colleague's chat", async () => {
        mockedCreate.mockImplementation(
            () =>
                makeRbacDb(null, "colleague-1", {
                    grantRole: "viewer",
                    project: { org_id: null },
                    chat: { org_id: null },
                }) as never,
        );

        const res = await request(app)
            .patch("/chat/chat-1")
            .set("Authorization", "Bearer test")
            .send({ title: "Renamed" });

        expect(res.status).toBe(403);
        expect(res.body.detail).toBe(
            "You do not have permission to modify this chat",
        );
        expect(chatWrites("update")).toEqual([]);
    });

    it("lets an owner assign a normalized direct role grant", async () => {
        mockedCreate.mockImplementation(
            () =>
                makeRbacDb(null, "u1", {
                    chat: { project_id: null, org_id: null },
                    profiles: [
                        {
                            user_id: "u1",
                            email: "u1@test.local",
                            display_name: "Current user",
                        },
                        {
                            user_id: "mate",
                            email: "mate@example.com",
                            display_name: "Mate",
                        },
                    ],
                    chatGrants: [
                        {
                            id: "cg-mate",
                            chat_id: "chat-1",
                            email: "mate@example.com",
                            role: "viewer",
                            created_by: "u1",
                            created_at: "2026-09-02T00:00:00Z",
                            updated_at: "2026-09-02T00:00:00Z",
                        },
                    ],
                }) as never,
        );

        const res = await request(app)
            .post("/chat/chat-1/access")
            .set("Authorization", "Bearer test")
            .send({ email: " Mate@Example.com ", role: "viewer" });

        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
            email: "mate@example.com",
            role: "viewer",
        });
    });

    it("400s when a direct grant targets an unknown user", async () => {
        mockedCreate.mockImplementation(
            () =>
                makeRbacDb(null, "u1", {
                    chat: { project_id: null, org_id: null },
                    profiles: [
                        {
                            user_id: "u1",
                            email: "u1@test.local",
                            display_name: "Current user",
                        },
                    ],
                }) as never,
        );

        const res = await request(app)
            .post("/chat/chat-1/access")
            .set("Authorization", "Bearer test")
            .send({ email: "future@example.com", role: "viewer" });

        expect(res.status).toBe(400);
        expect(res.body.detail).toBe(
            "future@example.com does not belong to a Mike user.",
        );
    });

    // The creator's email now comes from one filtered row instead of a scan
    // of every profile in the deployment; this pins that the row it reads is
    // still the right one, since the "creator already has access" refusal is
    // the only thing that email decides.
    it("400s when a grant targets the chat creator's own email", async () => {
        mockedCreate.mockImplementation(
            () =>
                makeRbacDb(null, "colleague-1", {
                    chat: { project_id: null, org_id: null },
                    chatGrantRole: "owner",
                    profiles: [
                        {
                            user_id: "decoy",
                            email: "decoy@example.com",
                            display_name: "Decoy",
                        },
                        {
                            user_id: "colleague-1",
                            email: "colleague@example.com",
                            display_name: "Creator",
                        },
                    ],
                }) as never,
        );

        const res = await request(app)
            .post("/chat/chat-1/access")
            .set("Authorization", "Bearer test")
            .send({ email: "Colleague@Example.com", role: "viewer" });

        expect(res.status).toBe(400);
        expect(res.body.detail).toBe(
            "The chat creator already has owner access",
        );
    });

    it("500s when the creator's profile read fails, without writing a grant", async () => {
        // A FAILED READ IS NOT "the creator has no email". Swallowing the
        // error sent `creatorEmail: null` into upsertContentGrant — and that
        // email is the only thing standing between the creator and a guest
        // grant on their own chat. So a transient database fault quietly
        // created exactly the row the check exists to prevent.
        const grantWrites: string[] = [];
        mockedCreate.mockImplementation(() => {
            const db = makeRbacDb(null, "colleague-1", {
                chat: { project_id: null, org_id: null },
                chatGrantRole: "owner",
                profiles: [
                    {
                        user_id: "colleague-1",
                        email: "colleague@example.com",
                        display_name: "Creator",
                    },
                ],
            });
            const originalFrom = db.from;
            db.from = vi.fn((table: string) => {
                if (table === "user_profiles") {
                    // ONLY the creator lookup fails — it is the read keyed by
                    // `user_id`. Every other profile read (the one that
                    // resolves the RECIPIENT's account) still works, so the
                    // request cannot fall into a 500 for some other reason.
                    const profiles = [
                        {
                            user_id: "colleague-1",
                            email: "colleague@example.com",
                            display_name: "Creator",
                        },
                        {
                            user_id: "mate",
                            email: "mate@example.com",
                            display_name: "Mate",
                        },
                    ];
                    const filters: Record<string, unknown> = {};
                    const q: Record<string, unknown> = {};
                    for (const method of ["select", "is", "order", "limit"])
                        q[method] = () => q;
                    q.eq = (column: string, value: unknown) => {
                        filters[column] = value;
                        return q;
                    };
                    q.in = (column: string, values: unknown[]) => {
                        filters[column] = values;
                        return q;
                    };
                    const settle = () =>
                        "user_id" in filters
                            ? {
                                  data: null,
                                  error: { message: "connection reset" },
                              }
                            : {
                                  data: profiles.filter((row) =>
                                      Object.entries(filters).every(
                                          ([column, value]) =>
                                              Array.isArray(value)
                                                  ? value.includes(
                                                        row[
                                                            column as keyof typeof row
                                                        ],
                                                    )
                                                  : row[
                                                        column as keyof typeof row
                                                    ] === value,
                                      ),
                                  ),
                                  error: null,
                              };
                    q.maybeSingle = () => {
                        const { data, error } = settle();
                        return Promise.resolve({
                            data: data?.[0] ?? null,
                            error,
                        });
                    };
                    q.single = q.maybeSingle;
                    q.then = (resolve: (v: unknown) => unknown) =>
                        Promise.resolve(settle()).then(resolve);
                    return q;
                }
                const query = originalFrom(table) as Record<string, unknown>;
                if (table === "chat_access_grants")
                    for (const method of ["upsert", "insert"] as const) {
                        const original = query[method] as (
                            ...args: unknown[]
                        ) => unknown;
                        query[method] = (...args: unknown[]) => {
                            grantWrites.push(method);
                            return original(...args);
                        };
                    }
                return query;
            }) as never;
            return db as never;
        });

        const res = await request(app)
            .post("/chat/chat-1/access")
            .set("Authorization", "Bearer test")
            .send({ email: "mate@example.com", role: "viewer" });

        expect.soft(res.status).toBe(500);
        expect.soft(res.body.detail).toBe(
            "Something went wrong. Please try again.",
        );
        // The internal message never reaches the client...
        expect.soft(JSON.stringify(res.body)).not.toContain("connection reset");
        // ...and nothing was written.
        expect.soft(grantWrites).toEqual([]);
    });

    it("403s a directly granted member trying to manage grants", async () => {
        mockedCreate.mockImplementation(
            () =>
                makeRbacDb(null, "colleague-1", {
                    chat: { project_id: null, org_id: null },
                    chatGrantRole: "editor",
                }) as never,
        );

        const res = await request(app)
            .post("/chat/chat-1/access")
            .set("Authorization", "Bearer test")
            .send({ email: "mate@example.com", role: "editor" });

        expect(res.status).toBe(403);
        expect(res.body.detail).toBe(
            "Only a chat owner can change who has access.",
        );
    });

    it("400s when sharing a chat with yourself", async () => {
        mockedCreate.mockImplementation(
            () =>
                makeRbacDb(null, "u1", {
                    chat: { project_id: null, org_id: null },
                }) as never,
        );

        const res = await request(app)
            .post("/chat/chat-1/access")
            .set("Authorization", "Bearer test")
            .send({ email: "U1@Test.Local", role: "editor" });

        expect(res.status).toBe(400);
        expect(res.body.detail).toBe("You cannot share a chat with yourself.");
    });

    it("400s when the grant role is invalid", async () => {
        mockedCreate.mockImplementation(
            () =>
                makeRbacDb(null, "u1", {
                    chat: { project_id: null, org_id: null },
                }) as never,
        );

        const res = await request(app)
            .post("/chat/chat-1/access")
            .set("Authorization", "Bearer test")
            .send({ email: "ghost@example.com", role: "manager" });

        expect(res.status).toBe(400);
        expect(res.body.detail).toBe(
            "role must be owner, editor or viewer",
        );
    });

    it("lets the chat's creator delete their chat (204)", async () => {
        mockedCreate.mockImplementation(
            () =>
                makeRbacDb(null, "u1", {
                    chat: { project_id: null, org_id: null },
                }) as never,
        );

        const res = await request(app)
            .delete("/chat/chat-1")
            .set("Authorization", "Bearer test");

        expect(res.status).toBe(204);
        expect(chatWrites("delete")[0]?.filters).toEqual([
            { column: "id", value: "chat-1" },
        ]);
    });

    it("403s an org member deleting a colleague's chat", async () => {
        // container.delete is the admin rung: a member may write in the chat
        // and rename it, but erasing a colleague's container is not theirs.
        mockedCreate.mockImplementation(() => makeRbacDb("member") as never);

        const res = await request(app)
            .delete("/chat/chat-1")
            .set("Authorization", "Bearer test");

        expect(res.status).toBe(403);
        expect(res.body.detail).toBe(
            "You do not have permission to delete this chat",
        );
        expect(chatWrites("delete")).toEqual([]);
    });

    it("lets an org admin delete a colleague's chat in the org's project", async () => {
        // The other side of that rung: an org admin inherits project admin,
        // and someone who could delete the whole project outright is not
        // meaningfully restrained from deleting one chat inside it.
        mockedCreate.mockImplementation(() => makeRbacDb("admin") as never);

        const res = await request(app)
            .delete("/chat/chat-1")
            .set("Authorization", "Bearer test");

        expect(res.status).toBe(204);
        expect(chatWrites("delete")[0]?.filters).toEqual([
            { column: "id", value: "chat-1" },
        ]);
    });

    it("404s a delete from someone with no access at all", async () => {
        mockedCreate.mockImplementation(() => makeRbacDb(null) as never);

        const res = await request(app)
            .delete("/chat/chat-1")
            .set("Authorization", "Bearer test");

        expect(res.status).toBe(404);
        expect(res.body.detail).toBe("Chat not found");
        expect(chatWrites("delete")).toEqual([]);
    });

    it("reports the caller's derived role on GET /chat/:chatId", async () => {
        mockedCreate.mockImplementation(
            () =>
                makeRbacDb(null, "colleague-1", {
                    grantRole: "viewer",
                    project: { org_id: null },
                    chat: { org_id: null },
                }) as never,
        );

        const viewer = await request(app)
            .get("/chat/chat-1")
            .set("Authorization", "Bearer test");

        expect(viewer.status).toBe(200);
        expect(viewer.body.access_role).toBe("viewer");
        expect(viewer.body.is_owner).toBe(false);
        expect(viewer.body.messages).toEqual([]);

        mockedCreate.mockImplementation(() => makeRbacDb("member") as never);

        const member = await request(app)
            .get("/chat/chat-1")
            .set("Authorization", "Bearer test");

        expect(member.status).toBe(200);
        expect(member.body.access_role).toBe("editor");
        expect(member.body.is_owner).toBe(false);

        mockedCreate.mockImplementation(
            () =>
                makeRbacDb(null, "u1", {
                    chat: { project_id: null, org_id: null },
                }) as never,
        );

        const creator = await request(app)
            .get("/chat/chat-1")
            .set("Authorization", "Bearer test");

        expect(creator.status).toBe(200);
        // The creator is always Owner; is_owner separately records provenance.
        expect(creator.body.access_role).toBe("owner");
        expect(creator.body.is_owner).toBe(true);
    });

    it("returns the creator and direct-grant roster from GET /chat/:chatId/people", async () => {
        mockedCreate.mockImplementation(
            () =>
                makeRbacDb(null, "colleague-1", {
                    chat: { project_id: null, org_id: null },
                    chatGrants: [
                        {
                            id: "cg-current",
                            chat_id: "chat-1",
                            email: "u1@test.local",
                            role: "editor",
                            created_by: "colleague-1",
                            created_at: "2026-09-02T00:00:00Z",
                            updated_at: "2026-09-02T00:00:00Z",
                        },
                        {
                            id: "cg-mate",
                            chat_id: "chat-1",
                            email: "mate@example.com",
                            role: "viewer",
                            created_by: "colleague-1",
                            created_at: "2026-09-02T00:00:00Z",
                            updated_at: "2026-09-02T00:00:00Z",
                        },
                    ],
                    profiles: [
                        {
                            user_id: "u1",
                            email: "u1@test.local",
                            display_name: "Current User",
                        },
                        {
                            user_id: "colleague-1",
                            email: "colleague@example.com",
                            display_name: "Colleague One",
                        },
                        {
                            user_id: "mate-1",
                            email: "mate@example.com",
                            display_name: "Mate",
                        },
                    ],
                }) as never,
        );

        const res = await request(app)
            .get("/chat/chat-1/people")
            .set("Authorization", "Bearer test");

        expect(res.status).toBe(200);
        expect(res.body.owner).toEqual({
            user_id: "colleague-1",
            email: "colleague@example.com",
            display_name: "Colleague One",
            role: "owner",
        });
        expect(res.body.members).toEqual([
            {
                user_id: "u1",
                email: "u1@test.local",
                display_name: "Current User",
                role: "editor",
            },
            {
                user_id: "mate-1",
                email: "mate@example.com",
                display_name: "Mate",
                role: "viewer",
            },
        ]);
    });

    it("404s the people roster for a caller with no access", async () => {
        mockedCreate.mockImplementation(() => makeRbacDb(null) as never);

        const res = await request(app)
            .get("/chat/chat-1/people")
            .set("Authorization", "Bearer test");

        expect(res.status).toBe(404);
        expect(res.body.detail).toBe("Chat not found");
    });

    it("passes the caller's normalized email to get_chats_overview", async () => {
        // The RPC's direct-grant arm compares against a lowercased email.
        mockedCreate.mockImplementation(() => makeRbacDb("member") as never);

        const res = await request(app)
            .get("/chat")
            .set("Authorization", "Bearer test");

        expect(res.status).toBe(200);
        expect(rbacRpcCalls).toEqual([
            {
                fn: "get_chats_overview",
                args: {
                    p_user_id: "u1",
                    p_user_email: "u1@test.local",
                    p_limit: null,
                    p_offset: 0,
                },
            },
        ]);
    });

    describe("a standalone chat directly granted to the caller", () => {
        // No project at all — access exists only through the chat grant. The
        // member tier may read and write the
        // content, but never re-share or delete the container.
        const directShare = () =>
            makeRbacDb(null, "colleague-1", {
                chat: {
                    project_id: null,
                    org_id: null,
                },
                chatGrantRole: "editor",
            }) as never;

        it("reads as a member", async () => {
            mockedCreate.mockImplementation(directShare);

            const res = await request(app)
                .get("/chat/chat-1")
                .set("Authorization", "Bearer test");

            expect(res.status).toBe(200);
            expect(res.body.access_role).toBe("editor");
            expect(res.body.is_owner).toBe(false);
        });

        it("may generate a title (content.edit)", async () => {
            await seedResolvableModel();
            mockedCreate.mockImplementation(directShare);

            const res = await request(app)
                .post("/chat/chat-1/generate-title")
                .set("Authorization", "Bearer test")
                .send({ message: "hello there" });

            expect(res.status).toBe(200);
            expect(res.body.title).toBe("Generated Title");
        });

        it("may not delete the chat (container.delete)", async () => {
            mockedCreate.mockImplementation(directShare);

            const res = await request(app)
                .delete("/chat/chat-1")
                .set("Authorization", "Bearer test");

            expect(res.status).toBe(403);
            expect(res.body.detail).toBe(
                "You do not have permission to delete this chat",
            );
            expect(chatWrites("delete")).toEqual([]);
        });
    });
});
