import { describe, it, expect, vi, beforeEach } from "vitest";
import { hydrateEditStatuses } from "../../src/routes/chat";
import type { createServerSupabase } from "../../src/lib/supabase";

// Minimal chainable mock for db.from().select().in()
function makeDbMock(rowsById: Record<string, unknown[]>) {
    const queryBuilder = {
        select: vi.fn().mockReturnThis(),
        in: vi.fn().mockImplementation((col: string, ids: string[]) => {
            const key = `${col}:${ids.sort().join(",")}`;
            return Promise.resolve({ data: rowsById[key] ?? [], error: null });
        }),
    };
    const db = {
        from: vi.fn().mockReturnValue(queryBuilder),
        _queryBuilder: queryBuilder,
    };
    return db as unknown as ReturnType<typeof createServerSupabase> & {
        _queryBuilder: typeof queryBuilder;
    };
}

describe("hydrateEditStatuses", () => {
    it("returns empty array without issuing any db queries", async () => {
        const db = makeDbMock({});
        const result = await hydrateEditStatuses([], db);
        expect(result).toEqual([]);
        expect(db.from).not.toHaveBeenCalled();
    });

    it("returns messages unchanged when no annotations or edit events are present", async () => {
        const db = makeDbMock({});
        const messages = [
            { id: "m1", role: "user", content: "hello", annotations: [] },
            { id: "m2", role: "assistant", content: [{ type: "text", text: "hi" }], annotations: null },
        ];
        const result = await hydrateEditStatuses(messages as Record<string, unknown>[], db);
        expect(result).toHaveLength(2);
        expect(db.from).not.toHaveBeenCalled();
    });

    it("issues at most TWO queries for messages with edit_id annotations, regardless of message count", async () => {
        const editId1 = "edit-uuid-1";
        const editId2 = "edit-uuid-2";
        const versionId1 = "ver-uuid-1";

        const db = makeDbMock({
            [`id:${[editId1, editId2].sort().join(",")}`]: [
                { id: editId1, status: "accepted" },
                { id: editId2, status: "rejected" },
            ],
            [`id:${versionId1}`]: [
                { id: versionId1, version_number: 3 },
            ],
        });

        // 5 messages — each with edit annotations — but hydrate must issue ≤2 queries total
        const messages: Record<string, unknown>[] = Array.from({ length: 5 }, (_, i) => ({
            id: `msg-${i}`,
            role: "assistant",
            annotations: [{ edit_id: i < 3 ? editId1 : editId2 }],
            content: [{ type: "doc_edited", annotations: [], version_id: versionId1 }],
        }));

        await hydrateEditStatuses(messages, db);

        // db.from() called at most twice: once for document_edits, once for document_versions
        expect(db.from).toHaveBeenCalledTimes(2);
        expect(db.from).toHaveBeenCalledWith("document_edits");
        expect(db.from).toHaveBeenCalledWith("document_versions");
    });

    it("patches edit statuses from DB into annotation objects", async () => {
        const editId = "edit-abc";
        const db = makeDbMock({
            [`id:${editId}`]: [{ id: editId, status: "accepted" }],
        });

        const messages: Record<string, unknown>[] = [
            {
                id: "m1",
                role: "assistant",
                annotations: [{ edit_id: editId, status: "pending" }],
                content: [],
            },
        ];

        const result = await hydrateEditStatuses(messages, db);
        const ann = (result[0]!.annotations as Record<string, unknown>[])[0]!;
        expect(ann.status).toBe("accepted");
    });

    it("patches version_number into doc_edited content events", async () => {
        const versionId = "ver-xyz";
        const db = makeDbMock({
            [`id:${versionId}`]: [{ id: versionId, version_number: 7 }],
        });

        const messages: Record<string, unknown>[] = [
            {
                id: "m1",
                role: "assistant",
                annotations: [],
                content: [
                    { type: "doc_edited", annotations: [], version_id: versionId },
                ],
            },
        ];

        const result = await hydrateEditStatuses(messages, db);
        const ev = (result[0]!.content as Record<string, unknown>[])[0]!;
        expect(ev.version_number).toBe(7);
    });
});
