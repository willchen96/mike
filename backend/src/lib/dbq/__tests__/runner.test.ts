import { describe, it, expect, vi } from "vitest";

vi.mock("../../supabase", () => ({ createServerSupabase: vi.fn() }));
vi.mock("../../storage", () => ({ deleteFile: vi.fn() }));

import {
    NonRetryableJobError,
    processClaimedJob,
    retryDelayMs,
    runDbJobTick,
    runDbJobRetentionSweep,
} from "../runner";
import type { DbJob } from "../types";

type Update = {
    table: string;
    payload: Record<string, unknown>;
    id?: string;
    filters: Record<string, unknown>;
};

// Chainable double recording db_jobs updates/deletes; rpc is injectable.
function makeDb(opts?: {
    rpc?: () => Promise<{ data: unknown; error: { message: string } | null }>;
    selectData?: unknown[];
}) {
    const updates: Update[] = [];
    const deletes: Record<string, unknown>[] = [];
    function from(table: string) {
        const state: {
            op: string;
            payload?: Record<string, unknown>;
            filters: Record<string, unknown>;
        } = { op: "select", filters: {} };
        const b: Record<string, unknown> = {
            update(payload: Record<string, unknown>) {
                state.op = "update";
                state.payload = payload;
                return b;
            },
            delete() {
                state.op = "delete";
                return b;
            },
            select() {
                return b;
            },
            eq(col: string, val: unknown) {
                state.filters[col] = val;
                return b;
            },
            neq(col: string, val: unknown) {
                state.filters[`neq:${col}`] = val;
                return b;
            },
            lt(col: string, val: unknown) {
                state.filters[`lt:${col}`] = val;
                return b;
            },
            limit() {
                return b;
            },
            then(onF: (v: unknown) => unknown) {
                if (state.op === "update")
                    updates.push({
                        table,
                        payload: state.payload!,
                        id: state.filters.id as string,
                        filters: { ...state.filters },
                    });
                if (state.op === "delete")
                    deletes.push({ table, ...state.filters });
                const value =
                    state.op === "select"
                        ? { data: opts?.selectData ?? [], error: null }
                        : { data: null, error: null };
                return Promise.resolve(value).then(onF);
            },
        };
        return b;
    }
    return {
        updates,
        deletes,
        from,
        rpc:
            opts?.rpc ??
            (async () => ({ data: [], error: null })),
    };
}

const JOB = (over: Partial<DbJob> = {}): DbJob => ({
    id: "job-1",
    kind: "test.kind",
    payload: {},
    status: "running",
    attempts: 1,
    max_attempts: 3,
    run_at: "2026-08-21T00:00:00Z",
    claimed_at: "2026-08-21T00:00:01Z",
    finished_at: null,
    last_error: null,
    dedupe_key: null,
    result: null,
    created_at: "2026-08-21T00:00:00Z",
    ...over,
});

describe("retryDelayMs", () => {
    it("backs off exponentially and caps at 30 minutes", () => {
        expect(retryDelayMs(1)).toBe(30_000);
        expect(retryDelayMs(2)).toBe(90_000);
        expect(retryDelayMs(3)).toBe(270_000);
        expect(retryDelayMs(10)).toBe(30 * 60 * 1000);
    });
});

describe("processClaimedJob fencing", () => {
    // A stale 'running' job is reclaimed by design (that IS crash recovery),
    // so two runners can hold the same row — and the "dead" one may not be
    // dead, just paused. Addressing a terminal write by id alone lets that
    // zombie mark `done` a job that is running right now, or drag a finished
    // job back to `pending` and run it a second time. `claimed_at` + `attempts`
    // name one specific claim, so only the current claimant can finalize.
    const FENCE = {
        id: "job-1",
        status: "running",
        attempts: 1,
        claimed_at: "2026-08-21T00:00:01Z",
    };

    it("fences the done write to this claim", async () => {
        const db = makeDb();
        await processClaimedJob(
            db as never,
            { "test.kind": async () => undefined },
            JOB(),
        );
        expect(db.updates[0].filters).toEqual(FENCE);
    });

    it("fences the retry write to this claim", async () => {
        const db = makeDb();
        await processClaimedJob(
            db as never,
            {
                "test.kind": async () => {
                    throw new Error("transient");
                },
            },
            JOB({ attempts: 1, max_attempts: 3 }),
        );
        expect(db.updates[0].payload.status).toBe("pending");
        expect(db.updates[0].filters).toEqual(FENCE);
    });

    it("fences the permanent-failure write to this claim", async () => {
        const db = makeDb();
        await processClaimedJob(
            db as never,
            {
                "test.kind": async () => {
                    throw new Error("fatal");
                },
            },
            JOB({ attempts: 3, max_attempts: 3 }),
        );
        expect(db.updates[0].payload.status).toBe("failed");
        expect(db.updates[0].filters).toEqual({ ...FENCE, attempts: 3 });
    });

    it("fails a NonRetryableJobError immediately, with attempts left", async () => {
        // A job the domain REFUSES is not a job the network flaked on.
        // Account deletion for the only admin of a live organization will be
        // refused identically on every one of its 20 attempts; retrying it
        // for hours buries the reason and leaves the user's request in limbo.
        const db = makeDb();
        await processClaimedJob(
            db as never,
            {
                "test.kind": async () => {
                    throw new NonRetryableJobError("refused by the domain");
                },
            },
            JOB({ attempts: 1, max_attempts: 20 }),
        );
        expect(db.updates[0].payload.status).toBe("failed");
        expect(db.updates[0].payload.last_error).toBe("refused by the domain");
        expect(db.updates[0].payload.finished_at).toBeTruthy();
        expect(db.updates[0].filters).toEqual(FENCE);
    });

    it("fences the unknown-kind write to this claim", async () => {
        const db = makeDb();
        await processClaimedJob(db as never, {}, JOB());
        expect(db.updates[0].payload.status).toBe("failed");
        expect(db.updates[0].filters).toEqual(FENCE);
    });
});

describe("processClaimedJob", () => {
    it("marks a successful job done and persists the handler's result", async () => {
        const db = makeDb();
        await processClaimedJob(
            db as never,
            { "test.kind": async () => ({ out: 42 }) },
            JOB(),
        );
        expect(db.updates).toHaveLength(1);
        expect(db.updates[0].payload).toMatchObject({
            status: "done",
            result: { out: 42 },
        });
        expect(db.updates[0].id).toBe("job-1");
    });

    it("reschedules a failed job with backoff while attempts remain", async () => {
        const db = makeDb();
        await processClaimedJob(
            db as never,
            {
                "test.kind": async () => {
                    throw new Error("transient");
                },
            },
            JOB({ attempts: 1, max_attempts: 3 }),
        );
        const [u] = db.updates;
        expect(u.payload.status).toBe("pending");
        expect(u.payload.last_error).toContain("transient");
        const runAt = new Date(u.payload.run_at as string).getTime();
        // First retry waits ~30s.
        expect(runAt - Date.now()).toBeGreaterThan(25_000);
        expect(runAt - Date.now()).toBeLessThan(35_000);
    });

    it("fails terminally once attempts are exhausted", async () => {
        const db = makeDb();
        await processClaimedJob(
            db as never,
            {
                "test.kind": async () => {
                    throw new Error("still broken");
                },
            },
            JOB({ attempts: 3, max_attempts: 3 }),
        );
        expect(db.updates[0].payload).toMatchObject({ status: "failed" });
    });

    it("fails an unknown kind immediately — retrying cannot fix it", async () => {
        const db = makeDb();
        await processClaimedJob(db as never, {}, JOB({ kind: "nope" }));
        expect(db.updates[0].payload).toMatchObject({ status: "failed" });
        expect(db.updates[0].payload.last_error).toContain("unknown job kind");
    });
});

describe("runDbJobTick", () => {
    it("survives a claim failure (e.g. migration not applied) without throwing", async () => {
        const db = makeDb({
            rpc: async () => ({
                data: null,
                error: { message: "relation db_jobs does not exist" },
            }),
        });
        await expect(runDbJobTick(db as never, {})).resolves.toBe(0);
    });

    it("processes every claimed job even when one handler rejects unexpectedly", async () => {
        const jobs = [JOB({ id: "a" }), JOB({ id: "b" })];
        const db = makeDb({ rpc: async () => ({ data: jobs, error: null }) });
        const seen: string[] = [];
        await runDbJobTick(db as never, {
            "test.kind": async (_db, job) => {
                seen.push(job.id);
                if (job.id === "a") throw new Error("boom");
            },
        });
        expect(seen.sort()).toEqual(["a", "b"]);
    });
});

describe("runDbJobRetentionSweep", () => {
    it("deletes an expired export's storage object BEFORE dropping its row", async () => {
        const order: string[] = [];
        const db = makeDb({
            selectData: [
                { id: "e1", result: { storage_path: "exports/u/e1.json" } },
            ],
        });
        const origThen = db.deletes;
        await runDbJobRetentionSweep(db as never, {
            deleteStoredFile: async (path) => {
                order.push(`file:${path}`);
            },
        });
        expect(order).toEqual(["file:exports/u/e1.json"]);
        expect(origThen.some((d) => d.id === "e1")).toBe(true);
    });

    it("keeps the row when the artifact delete fails, so the next sweep retries", async () => {
        const db = makeDb({
            selectData: [
                { id: "e1", result: { storage_path: "exports/u/e1.json" } },
            ],
        });
        await runDbJobRetentionSweep(db as never, {
            deleteStoredFile: async () => {
                throw new Error("storage down");
            },
        });
        expect(db.deletes.some((d) => d.id === "e1")).toBe(false);
    });

    // The keep-to-retry promise above is only real if no OTHER deleter can
    // reach the row: the generic 7-day done purge carries no id filter, so
    // once finished_at ages past DONE_RETENTION_MS it would sweep the very
    // row step 1 preserved — erasing the only pointer to an artifact whose
    // delete is still failing, and leaking a full copy of the user's data.
    it("exempts export.build from the generic done purge — kept rows are retry state", async () => {
        const db = makeDb({
            selectData: [
                { id: "e1", result: { storage_path: "exports/u/e1.json" } },
            ],
        });
        await runDbJobRetentionSweep(db as never, {
            deleteStoredFile: async () => {
                throw new Error("storage down");
            },
        });
        const donePurge = db.deletes.find(
            (d) => d.status === "done" && "lt:finished_at" in d,
        );
        expect(donePurge).toBeDefined();
        expect(donePurge?.["neq:kind"]).toBe("export.build");
    });
});
