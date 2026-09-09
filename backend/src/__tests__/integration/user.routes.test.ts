import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// Hoisted mock fns we reconfigure per-test. These cover the three security
// surfaces this suite baselines:
//   - the MFA route guard (requireMfaIfEnrolled)
//   - the API-key crypto boundary (userApiKeys)
//   - the destructive data export / deletion helpers (userDataExport /
//     userDataCleanup)
// Each is a vi.fn so we can both reconfigure behaviour and assert call args.
// ---------------------------------------------------------------------------
const {
    requireMfaIfEnrolled,
    getUserApiKeyStatus,
    saveUserApiKey,
    hasEnvApiKey,
    normalizeApiKeyProvider,
    deleteAllUserChats,
    deleteAllUserTabularReviews,
    deleteUserAccountData,
    deleteUserProjects,
    listOrgsBlockingAccountDeletion,
    buildUserAccountExport,
    buildUserChatsExport,
    buildUserTabularReviewsExport,
    supabaseRpc,
    adminSignOut,
    adminDeleteUser,
    dbJobsEnabled,
} = vi.hoisted(() => ({
    requireMfaIfEnrolled: vi.fn(),
    getUserApiKeyStatus: vi.fn(),
    saveUserApiKey: vi.fn(),
    hasEnvApiKey: vi.fn(),
    normalizeApiKeyProvider: vi.fn(),
    deleteAllUserChats: vi.fn(),
    deleteAllUserTabularReviews: vi.fn(),
    deleteUserAccountData: vi.fn(),
    deleteUserProjects: vi.fn(),
    listOrgsBlockingAccountDeletion: vi.fn(),
    buildUserAccountExport: vi.fn(),
    buildUserChatsExport: vi.fn(),
    buildUserTabularReviewsExport: vi.fn(),
    supabaseRpc: vi.fn(),
    adminSignOut: vi.fn(),
    adminDeleteUser: vi.fn(),
    dbJobsEnabled: vi.fn(() => true),
}));

// ---------------------------------------------------------------------------
// Configurable Supabase stub. The only route in this suite that reaches the
// DB directly is GET /user/profile (via loadProfile → selectProfile). Tests
// seed `supabaseState.tables.user_profiles`; terminal query ops resolve to the
// per-table result and auth.admin methods are stubbed where routes call them.
// ---------------------------------------------------------------------------
type QueryResult = { data: unknown; error: unknown };

// A table entry may be a queue of results: each query consumes the next one,
// and the last repeats. Lets tests drive the selectProfile fallback cascade
// (first select fails with 42703, the retry succeeds).
let supabaseState: {
    tables: Record<string, QueryResult | QueryResult[]>;
    updates: Record<string, unknown[]>;
    inserts: Record<string, unknown[]>;
    adminGetUserById: QueryResult;
    adminDeleteUser: { error: unknown };
};

function resetSupabaseState() {
    supabaseState = {
        tables: {},
        updates: {},
        inserts: {},
        adminGetUserById: {
            data: { user: { id: "u1", factors: [] } },
            error: null,
        },
        adminDeleteUser: { error: null },
    };
}
resetSupabaseState();

function resultForTable(table: string): QueryResult {
    const entry = supabaseState.tables[table];
    if (Array.isArray(entry)) {
        return entry.length > 1
            ? (entry.shift() as QueryResult)
            : (entry[0] ?? { data: null, error: null });
    }
    return entry ?? { data: null, error: null };
}

function makeQuery(table: string) {
    const q: Record<string, unknown> = {};
    const chain = [
        "select",
        "update",
        "delete",
        "upsert",
        "insert",
        "eq",
        "neq",
        "in",
        "is",
        "or",
        "not",
        "lt",
        "gt",
        "gte",
        "lte",
        "filter",
        "order",
        "limit",
        "range",
        "contains",
    ];
    for (const m of chain) q[m] = vi.fn(() => q);
    // Record update payloads so tests can assert what a route WROTE (the
    // per-table result stub only models what queries return).
    q.update = vi.fn((payload: unknown) => {
        (supabaseState.updates[table] ??= []).push(payload);
        return q;
    });
    q.insert = vi.fn((payload: unknown) => {
        (supabaseState.inserts[table] ??= []).push(payload);
        return q;
    });
    q.single = vi.fn(() => Promise.resolve(resultForTable(table)));
    q.maybeSingle = vi.fn(() => Promise.resolve(resultForTable(table)));
    q.then = (
        resolve: (v: unknown) => unknown,
        reject?: (e: unknown) => unknown,
    ) => Promise.resolve(resultForTable(table)).then(resolve, reject);
    return q;
}

function mockSupabase() {
    return {
        from: vi.fn((table: string) => makeQuery(table)),
        rpc: (...args: unknown[]) => supabaseRpc(...args),
        auth: {
            getUser: () =>
                Promise.resolve({ data: { user: { id: "u1" } }, error: null }),
            admin: {
                getUserById: vi.fn(() =>
                    Promise.resolve(supabaseState.adminGetUserById),
                ),
                deleteUser: (...a: unknown[]) => adminDeleteUser(...a),
                signOut: (...a: unknown[]) => adminSignOut(...a),
            },
        },
    };
}

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => mockSupabase()),
}));

// The DB-queue runner's enabled flag is what the account-delete and export
// routes branch on; keep the rest of the module real.
vi.mock("../../lib/dbq/runner", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, dbJobsEnabled: () => dbJobsEnabled() };
});

// requireAuth always authenticates u1. requireMfaIfEnrolled is a reconfigurable
// guard so we can drive both the satisfied (next()) and rejected
// (403 mfa_verification_required) paths.
vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = "u1";
        res.locals.userEmail = "u1@test.local";
        res.locals.token = "test-token";
        next();
    },
    requireMfaIfEnrolled: (req: unknown, res: unknown, next: () => void) =>
        requireMfaIfEnrolled(req, res, next),
}));

// API-key crypto boundary: the route must funnel writes through saveUserApiKey
// (which encrypts) and never echo plaintext — getUserApiKeyStatus returns
// presence-only booleans. getUserApiKeys must be exported too — lib/userSettings
// imports it at module load.
vi.mock("../../lib/userApiKeys", () => ({
    getUserApiKeyStatus: (...args: unknown[]) => getUserApiKeyStatus(...args),
    saveUserApiKey: (...args: unknown[]) => saveUserApiKey(...args),
    hasEnvApiKey: (...args: unknown[]) => hasEnvApiKey(...args),
    normalizeApiKeyProvider: (...args: unknown[]) =>
        normalizeApiKeyProvider(...args),
    getUserApiKeys: vi.fn(async () => ({})),
}));

vi.mock("../../lib/userDataCleanup", () => ({
    deleteAllUserChats: (...args: unknown[]) => deleteAllUserChats(...args),
    deleteAllUserTabularReviews: (...args: unknown[]) =>
        deleteAllUserTabularReviews(...args),
    deleteUserAccountData: (...args: unknown[]) =>
        deleteUserAccountData(...args),
    deleteUserProjects: (...args: unknown[]) => deleteUserProjects(...args),
    listOrgsBlockingAccountDeletion: (...args: unknown[]) =>
        listOrgsBlockingAccountDeletion(...args),
}));

vi.mock("../../lib/userDataExport", () => ({
    buildUserAccountExport: (...args: unknown[]) =>
        buildUserAccountExport(...args),
    buildUserChatsExport: (...args: unknown[]) => buildUserChatsExport(...args),
    buildUserTabularReviewsExport: (...args: unknown[]) =>
        buildUserTabularReviewsExport(...args),
    userExportFilename: (kind: string, userId: string) =>
        `mike-${kind}-export-${userId.slice(0, 8)}.json`,
}));

import { app } from "../../app";

const AUTH = ["Authorization", "Bearer test"] as const;

// A complete user_profiles row with credits_reset_date in the future so the
// monthly-reset branch in loadProfile is not triggered.
function profileRow(overrides: Record<string, unknown> = {}) {
    return {
        display_name: "Ada",
        organisation: "Acme",
        jurisdiction: "Singapore",
        practice_setting: "private_practice",
        professional_title: "Partner",
        practice_areas: ["Corporate and M&A"],
        onboarding_version: 1,
        password_set_at: null,
        message_credits_used: 3,
        credits_reset_date: "2999-01-01T00:00:00.000Z",
        tier: "Pro",
        title_model: null,
        tabular_model: "gemini-3-flash-preview",
        last_selected_chat_model: null,
        mfa_on_login: false,
        legal_research_us: true,
        quick_actions_visible: true,
        dark_mode: false,
        transparent_tables: true,
        ...overrides,
    };
}

const STATUS = { claude: true, openai: false, gemini: false, sources: {} };

// The exact 403 body the web client's MFA gate consumes (mirrors the real
// requireMfaIfEnrolled). Used by tests that simulate an unsatisfied factor.
function rejectMfa(_req: unknown, res: any) {
    res.status(403).json({
        code: "mfa_verification_required",
        detail: "MFA verification required",
    });
}

describe("user.routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetSupabaseState();
        // Default: MFA satisfied (guard passes through).
        requireMfaIfEnrolled.mockImplementation(
            (_req: unknown, _res: unknown, next: () => void) => next(),
        );
        adminDeleteUser.mockImplementation(() =>
            Promise.resolve(supabaseState.adminDeleteUser),
        );
        adminSignOut.mockResolvedValue({ data: null, error: null });
        dbJobsEnabled.mockReturnValue(true);
        getUserApiKeyStatus.mockResolvedValue(STATUS);
        saveUserApiKey.mockResolvedValue(undefined);
        hasEnvApiKey.mockReturnValue(false);
        normalizeApiKeyProvider.mockImplementation((v: string) =>
            ["claude", "openai", "gemini", "openrouter", "vercel"].includes(v)
                ? v
                : null,
        );
        deleteAllUserChats.mockResolvedValue(undefined);
        deleteAllUserTabularReviews.mockResolvedValue(undefined);
        deleteUserAccountData.mockResolvedValue(undefined);
        deleteUserProjects.mockResolvedValue(undefined);
        listOrgsBlockingAccountDeletion.mockResolvedValue([]);
        buildUserAccountExport.mockResolvedValue({ account: "data" });
        buildUserChatsExport.mockResolvedValue({ chats: "data" });
        buildUserTabularReviewsExport.mockResolvedValue({ reviews: "data" });
        supabaseRpc.mockResolvedValue({ data: null, error: null });
    });

    // ── GET /user/profile (MFA bootstrap path) ────────────────────────────
    describe("GET /user/profile", () => {
        it("returns the serialized profile plus apiKeyStatus", async () => {
            supabaseState.tables.user_profiles = {
                data: profileRow(),
                error: null,
            };
            supabaseState.tables.user_router_models = {
                data: [
                    { model_id: "anthropic/claude-sonnet-4.5" },
                    { model_id: "openai/gpt-5.4" },
                ],
                error: null,
            };

            const res = await request(app)
                .get("/user/profile")
                .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                displayName: "Ada",
                organisation: "Acme",
                jurisdiction: "Singapore",
                practiceSetting: "private_practice",
                professionalTitle: "Partner",
                practiceAreas: ["Corporate and M&A"],
                onboardingComplete: true,
                onboardingVersion: 1,
                passwordSet: false,
                messageCreditsUsed: 3,
                tier: "Pro",
                legalResearchUs: true,
                quickActionsVisible: true,
                mfaOnLogin: false,
                transparentTables: true,
                openRouterModels: [
                    "anthropic/claude-sonnet-4.5",
                    "openai/gpt-5.4",
                ],
                apiKeyStatus: STATUS,
            });
            // Presence-only key status — never plaintext.
            expect(JSON.stringify(res.body)).not.toContain("sk-");
        });

        it("is NOT guarded by requireMfaIfEnrolled (bootstrap route)", async () => {
            // Even if the MFA factor were unsatisfied, profile must remain
            // reachable so the client can render the verification gate.
            requireMfaIfEnrolled.mockImplementation(rejectMfa);
            supabaseState.tables.user_profiles = {
                data: profileRow(),
                error: null,
            };

            const res = await request(app)
                .get("/user/profile")
                .set(...AUTH);

            expect(res.status).toBe(200);
            expect(requireMfaIfEnrolled).not.toHaveBeenCalled();
        });

        it("defaults to transparent tables before the appearance migration", async () => {
            const preMigrationRow = profileRow();
            delete (preMigrationRow as Record<string, unknown>)
                .transparent_tables;
            supabaseState.tables.user_profiles = [
                {
                    data: null,
                    error: {
                        code: "42703",
                        message:
                            "column user_profiles.transparent_tables does not exist",
                    },
                },
                {
                    data: null,
                    error: {
                        code: "42703",
                        message:
                            "column user_profiles.last_selected_reasoning_level does not exist",
                    },
                },
                { data: preMigrationRow, error: null },
            ];

            const res = await request(app)
                .get("/user/profile")
                .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body.transparentTables).toBe(true);
            expect(res.body.darkMode).toBe(false);
        });

        it("keeps saved preferences on a database without the onboarding migration", async () => {
            // Replicated live (PR #365 review): with the 20260821 columns
            // dropped, the profile select failed on "jurisdiction", skipped
            // every fallback tier, and silently reset legal_research_us and
            // quick_actions_visible to defaults. The retry tier must preserve
            // the user's saved values and report legacy-exempt onboarding.
            const preMigrationRow = {
                display_name: "Ada",
                organisation: "Acme",
                message_credits_used: 3,
                credits_reset_date: "2999-01-01T00:00:00.000Z",
                tier: "Pro",
                title_model: null,
                tabular_model: "gemini-3-flash-preview",
                mfa_on_login: false,
                legal_research_us: false,
                quick_actions_visible: false,
            };
            supabaseState.tables.user_profiles = [
                {
                    data: null,
                    error: {
                        code: "42703",
                        message:
                            "column user_profiles.jurisdiction does not exist",
                    },
                },
                { data: preMigrationRow, error: null },
            ];

            const res = await request(app)
                .get("/user/profile")
                .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                legalResearchUs: false,
                quickActionsVisible: false,
                onboardingComplete: true,
                onboardingVersion: 0,
                passwordSet: false,
                jurisdiction: null,
                practiceAreas: [],
            });
        });

        it("keeps live onboarding columns when only migration 02 is missing", async () => {
            // password_set_at (20260821_02) missing must NOT drop the
            // migration-01 columns that DO exist — otherwise a new user on
            // such a database would report onboardingComplete: true and
            // skip onboarding entirely.
            const migration01Row = profileRow({ onboarding_version: null });
            delete (migration01Row as Record<string, unknown>).password_set_at;
            supabaseState.tables.user_profiles = [
                {
                    data: null,
                    error: {
                        code: "42703",
                        message:
                            "column user_profiles.password_set_at does not exist",
                    },
                },
                { data: migration01Row, error: null },
            ];

            const res = await request(app)
                .get("/user/profile")
                .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                jurisdiction: "Singapore",
                practiceAreas: ["Corporate and M&A"],
                onboardingComplete: false,
                onboardingVersion: null,
                passwordSet: false,
            });
        });

        it("returns 500 with detail when the profile load errors", async () => {
            supabaseState.tables.user_profiles = {
                data: null,
                error: { message: "db down" },
            };

            const res = await request(app)
                .get("/user/profile")
                .set(...AUTH);

            expect(res.status).toBe(500);
            expect(res.body.detail).toBe("Something went wrong. Please try again.");
        });
    });

    // ── PATCH /user/profile (appearance preference) ───────────────────────
    describe("PATCH /user/profile appearance", () => {
        it("persists and returns the dark mode preference", async () => {
            supabaseState.tables.user_profiles = {
                data: profileRow({ dark_mode: true }),
                error: null,
            };

            const res = await request(app)
                .patch("/user/profile")
                .set(...AUTH)
                .send({ darkMode: true });

            expect(res.status).toBe(200);
            expect(res.body.darkMode).toBe(true);
        });

        it("rejects a non-boolean darkMode", async () => {
            const res = await request(app)
                .patch("/user/profile")
                .set(...AUTH)
                .send({ darkMode: "yes" });

            expect(res.status).toBe(400);
            expect(res.body.detail).toMatch(/darkMode must be a boolean/);
        });

        it("persists and returns the transparent tables preference", async () => {
            supabaseState.tables.user_profiles = {
                data: profileRow({ transparent_tables: false }),
                error: null,
            };

            const res = await request(app)
                .patch("/user/profile")
                .set(...AUTH)
                .send({ transparentTables: false });

            expect(res.status).toBe(200);
            expect(res.body.transparentTables).toBe(false);
            expect(supabaseState.updates.user_profiles).toContainEqual(
                expect.objectContaining({ transparent_tables: false }),
            );
        });

        it("rejects a non-boolean transparentTables value", async () => {
            const res = await request(app)
                .patch("/user/profile")
                .set(...AUTH)
                .send({ transparentTables: "yes" });

            expect(res.status).toBe(400);
            expect(res.body.detail).toMatch(
                /transparentTables must be a boolean/,
            );
        });
    });

    // ── POST /user/profile (bootstrap upsert) ─────────────────────────────
    describe("POST /user/profile", () => {
        it("ensures the profile row and returns ok", async () => {
            const res = await request(app)
                .post("/user/profile")
                .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ ok: true });
            expect(requireMfaIfEnrolled).not.toHaveBeenCalled();
        });
    });

    // ── GET /user/api-keys (presence without plaintext) ───────────────────
    describe("GET /user/api-keys", () => {
        it("returns the boolean key-status map", async () => {
            const res = await request(app)
                .get("/user/api-keys")
                .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toEqual(STATUS);
            expect(getUserApiKeyStatus).toHaveBeenCalledWith(
                "u1",
                expect.anything(),
            );
        });
    });

    // ── PUT /user/api-keys/:provider (crypto + MFA guard) ─────────────────
    describe("PUT /user/api-keys/:provider", () => {
        it("stores the key via the encryption helper and returns status", async () => {
            const res = await request(app)
                .put("/user/api-keys/claude")
                .set(...AUTH)
                .send({ api_key: "sk-secret-value" });

            expect(res.status).toBe(200);
            expect(res.body).toEqual(STATUS);
            // The plaintext key must go through saveUserApiKey (the encryption
            // boundary), keyed by provider + value, never persisted by the route.
            expect(saveUserApiKey).toHaveBeenCalledWith(
                "u1",
                "claude",
                "sk-secret-value",
                expect.anything(),
            );
        });

        it("deletes the key when api_key is omitted (null value)", async () => {
            const res = await request(app)
                .put("/user/api-keys/openai")
                .set(...AUTH)
                .send({});

            expect(res.status).toBe(200);
            expect(saveUserApiKey).toHaveBeenCalledWith(
                "u1",
                "openai",
                null,
                expect.anything(),
            );
        });

        it("returns 400 for an unsupported provider", async () => {
            const res = await request(app)
                .put("/user/api-keys/bogus")
                .set(...AUTH)
                .send({ api_key: "x" });

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe("Unsupported provider");
            expect(saveUserApiKey).not.toHaveBeenCalled();
        });

        it("returns 409 when the provider is configured by the server env", async () => {
            hasEnvApiKey.mockReturnValue(true);

            const res = await request(app)
                .put("/user/api-keys/claude")
                .set(...AUTH)
                .send({ api_key: "sk-x" });

            expect(res.status).toBe(409);
            expect(saveUserApiKey).not.toHaveBeenCalled();
        });

        it("returns 500 when saving the key throws", async () => {
            saveUserApiKey.mockRejectedValue(new Error("kms unavailable"));

            const res = await request(app)
                .put("/user/api-keys/claude")
                .set(...AUTH)
                .send({ api_key: "sk-x" });

            expect(res.status).toBe(500);
            expect(res.body.detail).toBe("Something went wrong. Please try again.");
        });

        it("is rejected with 403 mfa_verification_required when MFA is unsatisfied", async () => {
            requireMfaIfEnrolled.mockImplementation(rejectMfa);

            const res = await request(app)
                .put("/user/api-keys/claude")
                .set(...AUTH)
                .send({ api_key: "sk-x" });

            expect(res.status).toBe(403);
            expect(res.body).toEqual({
                code: "mfa_verification_required",
                detail: "MFA verification required",
            });
            // Guarded: the crypto path is never reached.
            expect(saveUserApiKey).not.toHaveBeenCalled();
        });
    });

    describe("PATCH /user/profile", () => {
        it("persists the last-selected model from the initial chat view", async () => {
            supabaseState.tables.user_profiles = {
                data: profileRow({
                    last_selected_chat_model: "gpt-5.6-sol",
                }),
                error: null,
            };

            const res = await request(app)
                .patch("/user/profile")
                .set(...AUTH)
                .send({ lastSelectedChatModel: "gpt-5.6-sol" });

            expect(res.status).toBe(200);
            expect(supabaseState.updates.user_profiles).toContainEqual(
                expect.objectContaining({
                    last_selected_chat_model: "gpt-5.6-sol",
                }),
            );
            expect(res.body.lastSelectedChatModel).toBe("gpt-5.6-sol");
        });

        it("persists OpenRouter selections through the router-neutral table function", async () => {
            supabaseState.tables.user_profiles = {
                data: profileRow(),
                error: null,
            };

            const res = await request(app)
                .patch("/user/profile")
                .set(...AUTH)
                .send({
                    openRouterModels: [
                        "anthropic/claude-sonnet-4.5",
                        "openai/gpt-5.4",
                    ],
                });

            expect(res.status).toBe(200);
            expect(supabaseRpc).toHaveBeenCalledWith(
                "replace_user_router_models",
                {
                    target_user_id: "u1",
                    target_router: "openrouter",
                    target_model_ids: [
                        "anthropic/claude-sonnet-4.5",
                        "openai/gpt-5.4",
                    ],
                },
            );
        });

        it("persists Vercel selections through the router-neutral table function", async () => {
            supabaseState.tables.user_profiles = {
                data: profileRow(),
                error: null,
            };

            const res = await request(app)
                .patch("/user/profile")
                .set(...AUTH)
                .send({ vercelModels: ["openai/gpt-5.4"] });

            expect(res.status).toBe(200);
            expect(supabaseRpc).toHaveBeenCalledWith(
                "replace_user_router_models",
                {
                    target_user_id: "u1",
                    target_router: "vercel",
                    target_model_ids: ["openai/gpt-5.4"],
                },
            );
        });

        it("rejects a non-boolean Quick Actions visibility preference", async () => {
            const res = await request(app)
                .patch("/user/profile")
                .set(...AUTH)
                .send({ quickActionsVisible: "yes" });

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe(
                "quickActionsVisible must be a boolean",
            );
        });

        it("allows personalisation fields to be cleared", async () => {
            supabaseState.tables.user_profiles = {
                data: profileRow(),
                error: null,
            };

            const res = await request(app)
                .patch("/user/profile")
                .set(...AUTH)
                .send({
                    jurisdiction: null,
                    practiceSetting: null,
                    professionalTitle: null,
                    practiceAreas: [],
                });

            expect(res.status).toBe(200);
        });

        // display_name and organisation are injected into every chat's
        // system prompt, so their size must be bounded like the other
        // personalisation fields. Truncation (not rejection) mirrors
        // handle_new_user's left(..., 200) and keeps any over-long value
        // written before the cap editable rather than stuck.
        it.each([
            ["displayName", "display_name"],
            ["organisation", "organisation"],
        ] as const)(
            "truncates %s to 200 characters",
            async (field, column) => {
                supabaseState.tables.user_profiles = {
                    data: profileRow(),
                    error: null,
                };

                const res = await request(app)
                    .patch("/user/profile")
                    .set(...AUTH)
                    .send({ [field]: "x".repeat(250) });

                expect(res.status).toBe(200);
                const written = supabaseState.updates.user_profiles?.at(-1) as
                    | Record<string, unknown>
                    | undefined;
                expect(written?.[column]).toBe("x".repeat(200));
            },
        );
    });

    describe("POST /user/onboarding", () => {
        it("accepts a jurisdiction and normalized practice areas", async () => {
            supabaseState.tables.user_profiles = {
                data: profileRow({ onboarding_version: null }),
                error: null,
            };

            const res = await request(app)
                .post("/user/onboarding")
                .set(...AUTH)
                .send({
                    jurisdiction: " Singapore ",
                    practiceSetting: "private_practice",
                    professionalTitle: "Senior Associate",
                    practiceAreas: [" Corporate and M&A ", "Litigation"],
                });

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                displayName: "Ada",
                jurisdiction: "Singapore",
                practiceSetting: "private_practice",
                professionalTitle: "Partner",
                practiceAreas: ["Corporate and M&A"],
                onboardingComplete: false,
                onboardingVersion: null,
            });
        });

        it("treats onboarding version 0 as legacy-exempt", async () => {
            supabaseState.tables.user_profiles = {
                data: profileRow({ onboarding_version: 0 }),
                error: null,
            };

            const res = await request(app)
                .get("/user/profile")
                .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                onboardingVersion: 0,
                onboardingComplete: true,
            });
        });

        it("allows users to skip all personalisation fields", async () => {
            supabaseState.tables.user_profiles = {
                data: profileRow({ onboarding_version: null }),
                error: null,
            };

            const res = await request(app)
                .post("/user/onboarding")
                .set(...AUTH)
                .send({ practiceAreas: [] });

            expect(res.status).toBe(200);
        });

        it("rejects an invalid jurisdiction when one is supplied", async () => {
            const res = await request(app)
                .post("/user/onboarding")
                .set(...AUTH)
                .send({ jurisdiction: "" });

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe("Select a valid jurisdiction of practice");
        });

        it("requires a valid professional setting", async () => {
            const res = await request(app)
                .post("/user/onboarding")
                .set(...AUTH)
                .send({
                    jurisdiction: "Singapore",
                    practiceSetting: "law_firm",
                    practiceAreas: ["Litigation"],
                });

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe(
                "Select a valid professional setting",
            );
        });

        it("allows onboarding completion without a display name", async () => {
            supabaseState.tables.user_profiles = {
                data: profileRow({ display_name: null }),
                error: null,
            };

            const res = await request(app)
                .post("/user/onboarding")
                .set(...AUTH)
                .send({
                    jurisdiction: "Singapore",
                    practiceSetting: "in_house",
                    practiceAreas: ["Litigation"],
                });

            expect(res.status).toBe(200);
        });
    });

    describe("POST /user/security/password-set", () => {
        it("records and returns verified password capability", async () => {
            supabaseState.tables.user_profiles = {
                data: profileRow({
                    password_set_at: "2026-08-21T12:00:00.000Z",
                }),
                error: null,
            };
            supabaseRpc.mockResolvedValue({
                data: "2026-08-21T12:00:00.000Z",
                error: null,
            });

            const res = await request(app)
                .post("/user/security/password-set")
                .set(...AUTH)
                .send({});

            expect(res.status).toBe(200);
            expect(res.body.passwordSet).toBe(true);
            expect(supabaseRpc).toHaveBeenCalledWith(
                "sync_user_password_set",
                { p_user_id: "u1" },
            );
        });

        it("rejects the marker when Supabase has no password", async () => {
            supabaseState.tables.user_profiles = {
                data: profileRow(),
                error: null,
            };
            supabaseRpc.mockResolvedValue({ data: null, error: null });

            const res = await request(app)
                .post("/user/security/password-set")
                .set(...AUTH)
                .send({});

            expect(res.status).toBe(409);
        });
    });

    // ── Data export endpoints (MFA-guarded, attachment headers) ───────────
    describe("data export endpoints", () => {
        it("GET /user/export returns the account export as a JSON attachment", async () => {
            const res = await request(app)
                .get("/user/export")
                .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ account: "data" });
            expect(res.headers["content-type"]).toContain("application/json");
            expect(res.headers["content-disposition"]).toContain("attachment");
            expect(res.headers["content-disposition"]).toContain(
                "mike-account-export-u1.json",
            );
            expect(buildUserAccountExport).toHaveBeenCalledWith(
                expect.anything(),
                "u1",
                "u1@test.local",
            );
        });

        it("GET /user/chats/export returns the chats export", async () => {
            const res = await request(app)
                .get("/user/chats/export")
                .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ chats: "data" });
            expect(res.headers["content-disposition"]).toContain(
                "mike-chats-export-u1.json",
            );
            expect(buildUserChatsExport).toHaveBeenCalledTimes(1);
        });

        it("GET /user/tabular-reviews/export returns the reviews export", async () => {
            const res = await request(app)
                .get("/user/tabular-reviews/export")
                .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ reviews: "data" });
            expect(res.headers["content-disposition"]).toContain(
                "mike-tabular-reviews-export-u1.json",
            );
            expect(buildUserTabularReviewsExport).toHaveBeenCalledTimes(1);
        });

        it("GET /user/export returns 500 when the builder throws", async () => {
            buildUserAccountExport.mockRejectedValue(new Error("export boom"));

            const res = await request(app)
                .get("/user/export")
                .set(...AUTH);

            expect(res.status).toBe(500);
            expect(res.body.detail).toBe("Something went wrong. Please try again.");
        });

        it("GET /user/export is rejected when MFA is unsatisfied", async () => {
            requireMfaIfEnrolled.mockImplementation(rejectMfa);

            const res = await request(app)
                .get("/user/export")
                .set(...AUTH);

            expect(res.status).toBe(403);
            expect(res.body.code).toBe("mfa_verification_required");
            expect(buildUserAccountExport).not.toHaveBeenCalled();
        });
    });

    // ── Data deletion endpoints (MFA-guarded, cleanup helpers) ────────────
    describe("data deletion endpoints", () => {
        it("DELETE /user/chats invokes deleteAllUserChats and returns 204", async () => {
            const res = await request(app)
                .delete("/user/chats")
                .set(...AUTH);

            expect(res.status).toBe(204);
            expect(deleteAllUserChats).toHaveBeenCalledWith(
                expect.anything(),
                "u1",
            );
        });

        it("DELETE /user/projects invokes deleteUserProjects and returns 204", async () => {
            const res = await request(app)
                .delete("/user/projects")
                .set(...AUTH);

            expect(res.status).toBe(204);
            expect(deleteUserProjects).toHaveBeenCalledWith(
                expect.anything(),
                "u1",
            );
        });

        it("DELETE /user/tabular-reviews invokes the cleanup helper and returns 204", async () => {
            const res = await request(app)
                .delete("/user/tabular-reviews")
                .set(...AUTH);

            expect(res.status).toBe(204);
            expect(deleteAllUserTabularReviews).toHaveBeenCalledWith(
                expect.anything(),
                "u1",
            );
        });

        // ERASURE ORDERING. documents.user_id references auth.users ON DELETE
        // CASCADE (and document_versions cascades from documents), so deleting
        // the auth user is what destroys the rows recording where the account's
        // files live. It must therefore happen LAST — inside the job, after the
        // cascade — never in this request.
        it("DELETE /user/account schedules the cascade and does NOT delete the auth user yet", async () => {
            supabaseState.tables.db_jobs = {
                data: { id: "job-1" },
                error: null,
            };

            const res = await request(app)
                .delete("/user/account")
                .set(...AUTH);

            expect(res.status).toBe(204);
            // Durable job queued...
            const jobInserts = (supabaseState.inserts.db_jobs ?? []) as Record<
                string,
                unknown
            >[];
            expect(jobInserts).toHaveLength(1);
            expect(jobInserts[0]).toMatchObject({ kind: "account.delete" });
            // ...auth user still present, so the cascade can still read the
            // storage paths it is about to delete.
            expect(adminDeleteUser).not.toHaveBeenCalled();
            // Sessions are revoked immediately all the same: the account is
            // unusable from the moment this returns.
            expect(adminSignOut).toHaveBeenCalledWith("test-token", "global");
        });

        // SOLE-ADMIN REFUSAL. Deleting this account would either hand the
        // organization to an arbitrary successor or strand it with no members
        // at all, so the product refuses and names the organizations.
        it("DELETE /user/account returns 409 for the sole admin of a live org", async () => {
            listOrgsBlockingAccountDeletion.mockResolvedValue([
                { org_id: "o1", name: "Org A", reason: "members" },
                { org_id: "o2", name: "Org B", reason: "content" },
            ]);

            const res = await request(app)
                .delete("/user/account")
                .set(...AUTH);

            expect(res.status).toBe(409);
            expect(res.body.code).toBe("org_successor_required");
            expect(res.body.detail).toBe(
                "You are the only admin of Org A. Make another member an admin, or delete the organization, before deleting your account. You are the only admin of Org B, which still owns content. Delete or move the organization's projects, workflows, documents and reviews, or delete the organization, before deleting your account.",
            );
            expect(res.body.organizations).toEqual([
                { org_id: "o1", name: "Org A", reason: "members" },
                { org_id: "o2", name: "Org B", reason: "content" },
            ]);
            // Nothing was scheduled, nothing was revoked, nothing was
            // destroyed — the user is still signed in and can appoint an
            // admin. The old behaviour answered 204, revoked the session and
            // then failed the job forever.
            expect(supabaseState.inserts.db_jobs ?? []).toHaveLength(0);
            expect(adminSignOut).not.toHaveBeenCalled();
            expect(deleteUserAccountData).not.toHaveBeenCalled();
        });

        it("DELETE /user/account refuses the inline path for a sole admin too", async () => {
            // The no-runner fallback runs the cascade synchronously, so the
            // check must gate it as well.
            dbJobsEnabled.mockReturnValue(false);
            listOrgsBlockingAccountDeletion.mockResolvedValue([
                { org_id: "o1", name: "Org A", reason: "members" },
            ]);

            const res = await request(app)
                .delete("/user/account")
                .set(...AUTH);

            expect(res.status).toBe(409);
            expect(deleteUserAccountData).not.toHaveBeenCalled();
            expect(adminDeleteUser).not.toHaveBeenCalled();
        });

        it("DELETE /user/account runs inline when no runner will drain the queue", async () => {
            dbJobsEnabled.mockReturnValue(false);

            const res = await request(app)
                .delete("/user/account")
                .set(...AUTH);

            expect(res.status).toBe(204);
            // Data first, auth last — main's ordering, done synchronously.
            expect(deleteUserAccountData).toHaveBeenCalledWith(
                expect.anything(),
                "u1",
                "u1@test.local",
            );
            expect(supabaseState.inserts.db_jobs ?? []).toHaveLength(0);
        });

        it("DELETE /user/account returns 500 when the inline auth-user delete errors", async () => {
            dbJobsEnabled.mockReturnValue(false);
            supabaseState.adminDeleteUser = { error: { message: "auth boom" } };

            const res = await request(app)
                .delete("/user/account")
                .set(...AUTH);

            expect(res.status).toBe(500);
            expect(res.body.detail).toBe("Something went wrong. Please try again.");
        });

        it("DELETE /user/account returns 500 when the cascade cannot be scheduled", async () => {
            // Nothing has been destroyed yet, so the request is cleanly
            // retriable — it must not answer 204.
            supabaseState.tables.db_jobs = {
                data: null,
                error: { code: "08006", message: "connection lost" },
            };

            const res = await request(app)
                .delete("/user/account")
                .set(...AUTH);

            expect(res.status).toBe(500);
            expect(deleteUserAccountData).not.toHaveBeenCalled();
            expect(adminSignOut).not.toHaveBeenCalled();
        });

        it("DELETE /user/chats returns 500 when cleanup throws", async () => {
            deleteAllUserChats.mockRejectedValue(new Error("cascade failed"));

            const res = await request(app)
                .delete("/user/chats")
                .set(...AUTH);

            expect(res.status).toBe(500);
            expect(res.body.detail).toBe("Something went wrong. Please try again.");
        });

        it("DELETE /user/account is rejected when MFA is unsatisfied (no cleanup)", async () => {
            requireMfaIfEnrolled.mockImplementation(rejectMfa);

            const res = await request(app)
                .delete("/user/account")
                .set(...AUTH);

            expect(res.status).toBe(403);
            expect(res.body.code).toBe("mfa_verification_required");
            expect(deleteUserAccountData).not.toHaveBeenCalled();
        });
    });

    // ── PATCH /user/security/mfa-login (factor-gated, MFA-guarded) ────────
    describe("PATCH /user/security/mfa-login", () => {
        it("returns 400 when enabling without a verified TOTP factor", async () => {
            supabaseState.adminGetUserById = {
                data: { user: { id: "u1", factors: [] } },
                error: null,
            };

            const res = await request(app)
                .patch("/user/security/mfa-login")
                .set(...AUTH)
                .send({ enabled: true });

            expect(res.status).toBe(400);
            expect(res.body.detail).toContain("authenticator app");
        });

        it("enables MFA-on-login when a verified TOTP factor exists", async () => {
            supabaseState.adminGetUserById = {
                data: {
                    user: {
                        id: "u1",
                        factors: [{ factor_type: "totp", status: "verified" }],
                    },
                },
                error: null,
            };
            supabaseState.tables.user_profiles = {
                data: profileRow({ mfa_on_login: true }),
                error: null,
            };

            const res = await request(app)
                .patch("/user/security/mfa-login")
                .set(...AUTH)
                .send({ enabled: true });

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ mfaOnLogin: true });
        });

        it("returns 400 on a non-boolean enabled field", async () => {
            const res = await request(app)
                .patch("/user/security/mfa-login")
                .set(...AUTH)
                .send({ enabled: "yes" });

            expect(res.status).toBe(400);
        });

        it("is rejected with 403 when MFA is unsatisfied", async () => {
            requireMfaIfEnrolled.mockImplementation(rejectMfa);

            const res = await request(app)
                .patch("/user/security/mfa-login")
                .set(...AUTH)
                .send({ enabled: false });

            expect(res.status).toBe(403);
            expect(res.body.code).toBe("mfa_verification_required");
        });
    });
});
