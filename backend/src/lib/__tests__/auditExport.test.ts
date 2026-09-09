import { describe, it, expect } from "vitest";
import {
    AUDIT_EXPORT_LIMIT,
    buildAuditCsv,
    parseQuery,
    queryEvents,
} from "../auditExport";

// Chainable Supabase double: no accessible projects, and one fixed page of
// audit rows for the export query. Enough to exercise CSV assembly.
function makeDb(events: Record<string, unknown>[], error?: { message: string }) {
    const ranges: [number, number][] = [];
    function builder() {
        const b: Record<string, unknown> = {
            select: () => b,
            or: () => b,
            eq: () => b,
            // The project scope resolves through lib/access now, which also
            // composes .is()/.in() and .maybeSingle(). Every table still
            // answers "no rows", so the caller sees no accessible projects.
            is: () => b,
            in: () => b,
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
            ilike: () => b,
            gte: () => b,
            lte: () => b,
            contains: () => b,
            order: () => b,
            range: (from: number, to: number) => {
                ranges.push([from, to]);
                return Promise.resolve({
                    data: error ? null : events,
                    error: error ?? null,
                    count: events.length,
                });
            },
            then: (resolve: (v: unknown) => unknown) =>
                Promise.resolve({ data: [], error: null }).then(resolve),
        };
        return b;
    }
    return { db: { from: () => builder() } as never, ranges };
}

const QUERY = parseQuery({}, AUDIT_EXPORT_LIMIT);
const query = QUERY.ok ? QUERY.query : (undefined as never);

describe("buildAuditCsv", () => {
    // Display names are not resolved for the export (queryEvents is called
    // with resolveDisplayNames=false), so the "user" column is the email.
    it("emits the header and one row per event", async () => {
        const { db } = makeDb([
            {
                created_at: "2026-08-10T08:30:00.000Z",
                user_email: "lawyer@example.com",
                action: "document.edited",
                status: "completed",
                title: "Share purchase agreement",
                surface: "project",
                project_id: "p1",
                model: "gpt-5",
            },
        ]);
        const csv = await buildAuditCsv(db, "u1", "u1@example.com", query);
        expect(csv.split("\n")).toEqual([
            "created_at,user,action,status,title,application,project_id,model",
            "2026-08-10T08:30:00.000Z,lawyer@example.com,document.edited,completed,Share purchase agreement,project,p1,gpt-5",
        ]);
    });

    it("neutralizes spreadsheet formulas smuggled in through a title", async () => {
        const { db } = makeDb([
            { title: '=HYPERLINK("http://evil","click")', user_email: "a@b.test" },
        ]);
        const csv = await buildAuditCsv(db, "u1", undefined, query);
        // Leading single quote forces Excel/Sheets to treat it as literal text.
        expect(csv).toContain('"\'=HYPERLINK(""http://evil"",""click"")"');
    });

    it("always reads page 1 — the export is one flat window", async () => {
        const { db, ranges } = makeDb([]);
        await buildAuditCsv(db, "u1", undefined, { ...query, page: 7 });
        // The accessible-project scan pages from 0 as well; what matters is
        // that the EVENTS read is one flat window and nothing starts later.
        expect(ranges).toContainEqual([0, AUDIT_EXPORT_LIMIT - 1]);
        expect(ranges.every(([from]) => from === 0)).toBe(true);
    });

    it("throws on a query error so the export job retries", async () => {
        const dbError = { message: "connection reset", code: "57P01" };
        const { db } = makeDb([], dbError);
        // The original PostgrestError rides along as `cause` so the sync route
        // can log code/details/hint instead of just the message.
        await expect(buildAuditCsv(db, "u1", undefined, query)).rejects.toThrow(
            expect.objectContaining({
                message: "connection reset",
                cause: dbError,
            }),
        );
    });
});

// Table-aware double for the display-name path: `projects` (nothing shared),
// `audit_events` (one fixed page) and `user_profiles` (the name lookup).
function makeProfileDb(
    events: Record<string, unknown>[],
    profiles: Record<string, unknown>[],
) {
    let profilesQueried = false;
    function from() {
        const b: Record<string, unknown> = {
            select: () => b,
            or: () => b,
            eq: () => b,
            // See makeDb: the project scope's .is() chain runs first and
            // finds nothing, so only the profile lookup below matters here.
            is: () => b,
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
            ilike: () => b,
            gte: () => b,
            lte: () => b,
            contains: () => b,
            order: () => b,
            in: (column: string) => {
                // Only the profile lookup filters on user_id; every other
                // `.in()` (project ids for the events read) keeps chaining.
                if (column !== "user_id") return b;
                profilesQueried = true;
                return Promise.resolve({ data: profiles, error: null });
            },
            range: () =>
                Promise.resolve({
                    data: events,
                    error: null,
                    count: events.length,
                }),
            then: (resolve: (v: unknown) => unknown) =>
                Promise.resolve({ data: [], error: null }).then(resolve),
        };
        return b;
    }
    return {
        db: { from } as never,
        wasProfileLookupRun: () => profilesQueried,
    };
}

describe("queryEvents display names", () => {
    const events = [
        { id: "e1", user_id: "u1", user_email: "lawyer@example.com" },
        { id: "e2", user_id: "u2", user_email: "other@example.com" },
    ];

    it("attaches a trimmed display name and drops the raw user_id", async () => {
        const { db } = makeProfileDb(events, [
            { user_id: "u1", display_name: "  Ada Lovelace  " },
        ]);
        const { data } = await queryEvents(db, "u1", undefined, query);
        expect(data).toEqual([
            {
                id: "e1",
                user_email: "lawyer@example.com",
                user_display_name: "Ada Lovelace",
            },
            // No profile row for u2, so the JSON listing gets an explicit null
            // and the client falls back to the email.
            {
                id: "e2",
                user_email: "other@example.com",
                user_display_name: null,
            },
        ]);
    });

    it("skips the profile lookup when display names are not requested", async () => {
        const { db, wasProfileLookupRun } = makeProfileDb(events, [
            { user_id: "u1", display_name: "Ada Lovelace" },
        ]);
        const { data } = await queryEvents(db, "u1", undefined, query, false);
        expect(wasProfileLookupRun()).toBe(false);
        expect(data?.map((e) => e.user_display_name)).toEqual([null, null]);
    });
});

describe("audit CSV user column", () => {
    // The export deliberately skips display-name resolution, so the "user"
    // column is the email even when the author has a profile name. Both the
    // sync GET /audit/export route and the async "audit-csv" export job render
    // through buildAuditCsv, so pinning this here pins both.
    it("falls back to the email and never resolves profile names", async () => {
        const { db, wasProfileLookupRun } = makeProfileDb(
            [
                {
                    created_at: "2026-08-10T08:30:00.000Z",
                    user_id: "u1",
                    user_email: "lawyer@example.com",
                    action: "document.edited",
                    status: "completed",
                    title: "Share purchase agreement",
                    surface: "project",
                    project_id: "p1",
                    model: "gpt-5",
                },
            ],
            [{ user_id: "u1", display_name: "Ada Lovelace" }],
        );
        const csv = await buildAuditCsv(db, "u1", undefined, query);
        expect(wasProfileLookupRun()).toBe(false);
        expect(csv.split("\n")).toEqual([
            "created_at,user,action,status,title,application,project_id,model",
            "2026-08-10T08:30:00.000Z,lawyer@example.com,document.edited,completed,Share purchase agreement,project,p1,gpt-5",
        ]);
    });
});
