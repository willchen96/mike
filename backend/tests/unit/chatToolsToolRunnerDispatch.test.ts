/**
 * Phase 8 (CLEAN-30) dispatcher coverage for the split chatTools module.
 *
 * The golden-log suite pins runLLMStream callback ordering, but intentionally
 * does not execute runToolCalls. These tests cover the no-DB dispatcher
 * branches and mock storage-heavy tool runners so the split façade has a
 * direct regression net.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocIndex, DocStore, ToolCall, WorkflowStore, TabularCellStore } from "../../src/lib/chatTools";

vi.mock("../../src/lib/chatTools/tools/read-document", () => ({
    runReadDocument: vi.fn(async () => "read content"),
}));

vi.mock("../../src/lib/chatTools/tools/find-in-document", () => ({
    runFindInDocument: vi.fn(async () => JSON.stringify({ total_matches: 2 })),
}));

vi.mock("../../src/lib/chatTools/tools/fetch-documents", () => ({
    runFetchDocuments: vi.fn(async () => ({
        content: "fetched content",
        docsRead: [{ filename: "brief.docx", document_id: "document-1" }],
    })),
}));

vi.mock("../../src/lib/chatTools/tools/replicate-document", () => ({
    runReplicateDocument: vi.fn(async () => ({
        toolResult: {
            role: "tool",
            tool_call_id: "tc-replicate",
            content: JSON.stringify({ ok: true }),
        },
        replicated: {
            filename: "brief.docx",
            count: 2,
            copies: [
                {
                    new_filename: "brief copy.docx",
                    document_id: "document-copy",
                    version_id: "version-copy",
                },
            ],
        },
    })),
}));

vi.mock("../../src/lib/chatTools/tools/generate-docx", () => ({
    runGenerateDocx: vi.fn(async () => ({
        filename: "Generated.docx",
        download_url: "http://download/generated",
        document_id: "document-generated",
        version_id: "version-generated",
        version_number: 1,
        storage_path: "generated/path.docx",
    })),
}));

import { runToolCalls } from "../../src/lib/chatTools";
import { runReadDocument } from "../../src/lib/chatTools/tools/read-document";
import { runFindInDocument } from "../../src/lib/chatTools/tools/find-in-document";
import { runFetchDocuments } from "../../src/lib/chatTools/tools/fetch-documents";
import { runReplicateDocument } from "../../src/lib/chatTools/tools/replicate-document";
import { runGenerateDocx } from "../../src/lib/chatTools/tools/generate-docx";

function makeToolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
    return {
        id,
        function: {
            name,
            arguments: JSON.stringify(args),
        },
    };
}

function makeHarness() {
    const docStore: DocStore = new Map([
        ["doc-0", { storage_path: "source/path.docx", file_type: "docx", filename: "brief.docx" }],
    ]);
    const docIndex: DocIndex = {
        "doc-0": {
            document_id: "document-1",
            filename: "brief.docx",
            version_id: "version-1",
            version_number: 1,
        },
    };
    const workflowStore: WorkflowStore = new Map([
        ["wf-1", { title: "Summarize", prompt_md: "Summarize the record." }],
    ]);
    const tabularStore: TabularCellStore = {
        columns: [{ index: 0, name: "Risk" }],
        documents: [{ id: "document-1", filename: "brief.docx" }],
        cells: new Map([
            ["0:document-1", { summary: "High risk", flag: "red", reasoning: "Late filing" }],
        ]),
    };
    const writes: string[] = [];
    const write = (s: string) => {
        writes.push(s);
    };

    return {
        docStore,
        docIndex,
        workflowStore,
        tabularStore,
        writes,
        write,
        db: {} as Parameters<typeof runToolCalls>[3],
    };
}

function parseWrites(writes: string[]): Record<string, unknown>[] {
    return writes.map((s) => JSON.parse(s.replace(/^data: /, "").trim()));
}

describe("runToolCalls dispatcher", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("dispatches read/find/fetch document branches and aggregates document activity", async () => {
        const h = makeHarness();

        const result = await runToolCalls(
            [
                makeToolCall("tc-read", "read_document", { doc_id: "doc-0" }),
                makeToolCall("tc-find", "find_in_document", { doc_id: "doc-0", query: "risk" }),
                makeToolCall("tc-fetch", "fetch_documents", { doc_ids: ["doc-0"] }),
            ],
            h.docStore,
            "user-1",
            h.db,
            h.write,
            h.workflowStore,
            h.tabularStore,
            h.docIndex,
        );

        expect(runReadDocument).toHaveBeenCalledWith(expect.objectContaining({ docLabel: "doc-0" }));
        expect(runFindInDocument).toHaveBeenCalledWith(expect.objectContaining({ docLabel: "doc-0", query: "risk" }));
        expect(runFetchDocuments).toHaveBeenCalledWith(expect.objectContaining({ docIds: ["doc-0"] }));
        expect(result.toolResults).toHaveLength(3);
        expect(result.docsRead).toEqual([
            { filename: "brief.docx", document_id: "document-1" },
            { filename: "brief.docx", document_id: "document-1" },
        ]);
        expect(result.docsFound).toEqual([
            { filename: "brief.docx", query: "risk", total_matches: 2 },
        ]);
    });

    it("dispatches list_documents, read_workflow, and read_table_cells without external services", async () => {
        const h = makeHarness();

        const result = await runToolCalls(
            [
                makeToolCall("tc-list", "list_documents", {}),
                makeToolCall("tc-workflow", "read_workflow", { workflow_id: "wf-1" }),
                makeToolCall("tc-cells", "read_table_cells", { col_indices: [0], row_indices: [0] }),
            ],
            h.docStore,
            "user-1",
            h.db,
            h.write,
            h.workflowStore,
            h.tabularStore,
            h.docIndex,
        );

        expect(JSON.parse(String(result.toolResults[0] && (result.toolResults[0] as { content: string }).content))).toEqual([
            { doc_id: "doc-0", filename: "brief.docx", file_type: "docx" },
        ]);
        expect(result.workflowsApplied).toEqual([
            { workflow_id: "wf-1", title: "Summarize" },
        ]);
        expect(String((result.toolResults[2] as { content: string }).content)).toContain("Summary: High risk");
        expect(result.docsRead).toEqual([{ filename: "1 column × 1 row" }]);

        const events = parseWrites(h.writes);
        expect(events).toEqual([
            { type: "workflow_applied", workflow_id: "wf-1", title: "Summarize" },
            { type: "doc_read_start", filename: "1 column × 1 row" },
            { type: "doc_read", filename: "1 column × 1 row" },
        ]);
    });

    it("dispatches replicate_document and generate_docx, updating the in-turn doc maps", async () => {
        const h = makeHarness();

        const result = await runToolCalls(
            [
                makeToolCall("tc-replicate", "replicate_document", { doc_id: "doc-0", count: 2 }),
                makeToolCall("tc-generate", "generate_docx", { title: "Generated", sections: [] }),
            ],
            h.docStore,
            "user-1",
            h.db,
            h.write,
            h.workflowStore,
            h.tabularStore,
            h.docIndex,
            undefined,
            "project-1",
        );

        expect(runReplicateDocument).toHaveBeenCalledWith(expect.objectContaining({
            rawDocId: "doc-0",
            requestedCount: 2,
            sourceLabel: "doc-0",
            projectId: "project-1",
        }));
        expect(runGenerateDocx).toHaveBeenCalledWith(expect.objectContaining({
            title: "Generated",
            options: { landscape: false, projectId: "project-1" },
        }));
        expect(result.docsReplicated).toHaveLength(1);
        expect(result.docsCreated).toEqual([
            {
                filename: "Generated.docx",
                download_url: "http://download/generated",
                document_id: "document-generated",
                version_id: "version-generated",
                version_number: 1,
            },
        ]);
        expect(h.docIndex["doc-1"]).toEqual({
            document_id: "document-generated",
            filename: "Generated.docx",
        });
        expect(h.docStore.get("doc-1")).toEqual({
            storage_path: "generated/path.docx",
            file_type: "docx",
            filename: "Generated.docx",
        });
    });

    it("emits a parse error event and skips execution when tool arguments are malformed", async () => {
        const h = makeHarness();
        const badCall: ToolCall = {
            id: "tc-bad",
            function: {
                name: "generate_docx",
                arguments: "{not-json",
            },
        };

        const result = await runToolCalls(
            [badCall],
            h.docStore,
            "user-1",
            h.db,
            h.write,
            h.workflowStore,
            h.tabularStore,
            h.docIndex,
        );

        expect(runGenerateDocx).not.toHaveBeenCalled();
        expect(result.toolResults).toEqual([]);
        expect(parseWrites(h.writes)).toEqual([
            expect.objectContaining({
                type: "tool_args_parse_error",
                tool: "generate_docx",
            }),
        ]);
    });
});
