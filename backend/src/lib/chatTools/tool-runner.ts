/**
 * Tool-call dispatcher: parses tool-call arguments and routes to the
 * matching tools/*.ts runner. Returns aggregated docsRead / docsFound /
 * docsCreated / docsReplicated / docsEdited / workflowsApplied arrays
 * for the streaming layer to attach to the next-iteration prompt.
 */

import { z } from "zod";
import { createServerSupabase } from "../supabase";
import type {
    DocStore,
    DocIndex,
    WorkflowStore,
    TabularCellStore,
    ToolCall,
    TurnEditState,
    DocCreatedResult,
    DocReplicatedResult,
    DocEditedResult,
} from "./types";
import { resolveDocLabel } from "./doc-context";
import { logger } from "../logger";
import { parseLlmJson } from "./parseLlmJson";
import { ToolArgSchemas } from "./llm-schemas";
import { runReadDocument } from "./tools/read-document";
import { runFindInDocument } from "./tools/find-in-document";
import { runListDocuments } from "./tools/list-documents";
import { runFetchDocuments } from "./tools/fetch-documents";
import { runReadWorkflow } from "./tools/read-workflow";
import { runReplicateDocument } from "./tools/replicate-document";
import { runGenerateDocx } from "./tools/generate-docx";
import { runEditDocument } from "./tools/edit-document";

export async function runToolCalls(
    toolCalls: ToolCall[],
    docStore: DocStore,
    userId: string,
    db: ReturnType<typeof createServerSupabase>,
    write: (s: string) => void,
    workflowStore?: WorkflowStore,
    tabularStore?: TabularCellStore,
    docIndex?: DocIndex,
    turnEditState?: TurnEditState,
    projectId?: string | null,
): Promise<{
    toolResults: unknown[];
    docsRead: { filename: string; document_id?: string }[];
    docsFound: { filename: string; query: string; total_matches: number }[];
    docsCreated: DocCreatedResult[];
    docsReplicated: DocReplicatedResult[];
    workflowsApplied: { workflow_id: string; title: string }[];
    docsEdited: DocEditedResult[];
}> {
    const toolResults: unknown[] = [];
    const docsRead: { filename: string; document_id?: string }[] = [];
    const docsFound: {
        filename: string;
        query: string;
        total_matches: number;
    }[] = [];
    const docsCreated: DocCreatedResult[] = [];
    const docsReplicated: DocReplicatedResult[] = [];
    const workflowsApplied: { workflow_id: string; title: string }[] = [];
    const docsEdited: DocEditedResult[] = [];

    for (const tc of toolCalls) {
        let args: Record<string, unknown> = {};
        const knownSchema: z.ZodSchema<Record<string, unknown>> =
            (ToolArgSchemas[tc.function.name as keyof typeof ToolArgSchemas] as z.ZodSchema<Record<string, unknown>> | undefined) ??
            z.object({}).passthrough();
        const argsResult = parseLlmJson(
            tc.function.arguments || "{}",
            knownSchema,
        );
        if (argsResult.ok) {
            args = argsResult.data as Record<string, unknown>;
        } else {
            write(
                `data: ${JSON.stringify({ type: "tool_args_parse_error", tool: tc.function.name, error: argsResult.error })}\n\n`,
            );
            logger.warn(
                { err: argsResult.error, tool: tc.function.name },
                "[chatTools/tool-runner] tool args parse failed",
            );
            // Skip this tool call entirely — do not execute with empty args
            continue;
        }

        if (tc.function.name === "read_document") {
            const rawDocId = args.doc_id as string;
            const docId =
                resolveDocLabel(rawDocId, docStore, docIndex) ?? rawDocId;
            const content = await runReadDocument({ docLabel: docId, docStore, write, docIndex, db });
            const filename = docStore.get(docId)?.filename;
            const documentId = docIndex?.[docId]?.document_id;
            if (filename) docsRead.push({ filename, document_id: documentId });
            toolResults.push({ role: "tool", tool_call_id: tc.id, content });

        } else if (tc.function.name === "find_in_document") {
            const rawDocId = args.doc_id as string;
            const docId =
                resolveDocLabel(rawDocId, docStore, docIndex) ?? rawDocId;
            const query = (args.query as string) ?? "";
            const maxResults = typeof args.max_results === "number" ? args.max_results : undefined;
            const contextChars = typeof args.context_chars === "number" ? args.context_chars : undefined;
            const content = await runFindInDocument({
                docLabel: docId,
                query,
                maxResults,
                contextChars,
                docStore,
                write,
                docIndex,
                db,
            });
            const filename = docStore.get(docId)?.filename;
            if (filename) {
                let totalMatches = 0;
                // NOTE: This parses OUR tool result, not LLM output. Per Phase 10 / CLEAN-23,
                // this site is intentionally NOT wrapped with parseLlmJson — failure here
                // would be an internal bug, not LLM misbehavior.
                try {
                    const parsed = JSON.parse(content) as {
                        total_matches?: number;
                    };
                    totalMatches = parsed.total_matches ?? 0;
                } catch {
                    /* ignore — still record the find attempt */
                }
                docsFound.push({
                    filename,
                    query,
                    total_matches: totalMatches,
                });
            }
            toolResults.push({ role: "tool", tool_call_id: tc.id, content });

        } else if (tc.function.name === "list_documents") {
            const content = runListDocuments({ docStore });
            toolResults.push({
                role: "tool",
                tool_call_id: tc.id,
                content,
            });

        } else if (tc.function.name === "fetch_documents") {
            const rawDocIds = (args.doc_ids as string[]) ?? [];
            const docIds = rawDocIds.map(
                (id) => resolveDocLabel(id, docStore, docIndex) ?? id,
            );
            const { content, docsRead: fetched } = await runFetchDocuments({
                docIds,
                docStore,
                write,
                docIndex,
                db,
            });
            for (const r of fetched) docsRead.push(r);
            toolResults.push({
                role: "tool",
                tool_call_id: tc.id,
                content,
            });

        } else if (tc.function.name === "list_workflows") {
            const list = workflowStore
                ? Array.from(workflowStore.entries()).map(([id, w]) => ({ id, title: w.title }))
                : [];
            toolResults.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(list) });

        } else if (tc.function.name === "read_workflow") {
            const wfId = args.workflow_id as string;
            const { content, applied } = runReadWorkflow({
                workflowId: wfId,
                workflowStore,
                write,
            });
            if (applied) workflowsApplied.push(applied);
            toolResults.push({
                role: "tool",
                tool_call_id: tc.id,
                content,
            });

        } else if (tc.function.name === "read_table_cells" && tabularStore) {
            const colIndices = args.col_indices as number[] | undefined;
            const rowIndices = args.row_indices as number[] | undefined;

            const filteredCols = colIndices?.length
                ? tabularStore.columns.filter((_, i) => colIndices.includes(i))
                : tabularStore.columns;
            const filteredDocs = rowIndices?.length
                ? tabularStore.documents.filter((_, i) => rowIndices.includes(i))
                : tabularStore.documents;

            const label = `${filteredCols.length} ${filteredCols.length === 1 ? "column" : "columns"} × ${filteredDocs.length} ${filteredDocs.length === 1 ? "row" : "rows"}`;
            write(`data: ${JSON.stringify({ type: "doc_read_start", filename: label })}\n\n`);

            const lines: string[] = [];
            for (const col of filteredCols) {
                const colPos = tabularStore.columns.findIndex((c) => c.index === col.index);
                for (const doc of filteredDocs) {
                    const rowPos = tabularStore.documents.findIndex((d) => d.id === doc.id);
                    const cell = tabularStore.cells.get(`${col.index}:${doc.id}`);
                    lines.push(`[COL:${colPos} "${col.name}" | ROW:${rowPos} "${doc.filename}"]`);
                    if (cell?.summary) {
                        lines.push(`Summary: ${cell.summary}`);
                        if (cell.flag) lines.push(`Flag: ${cell.flag}`);
                        if (cell.reasoning) lines.push(`Reasoning: ${cell.reasoning}`);
                    } else {
                        lines.push(`(not yet generated)`);
                    }
                    lines.push("");
                }
            }

            write(`data: ${JSON.stringify({ type: "doc_read", filename: label })}\n\n`);
            docsRead.push({ filename: label });
            toolResults.push({
                role: "tool",
                tool_call_id: tc.id,
                content: lines.join("\n") || "No cells found.",
            });

        } else if (tc.function.name === "edit_document" && docIndex) {
            const rawDocId = args.doc_id as string;
            const editsRaw = args.edits as unknown[] | undefined;
            const docId =
                resolveDocLabel(rawDocId, docStore, docIndex) ?? rawDocId;
            const docInfo = docStore.get(docId);
            const indexed = docIndex?.[docId];

            const emitEditError = (
                filename: string,
                documentId: string,
                error: string,
            ) => {
                // Surface the failure as a failed "Edited" block in the UI
                // (start → done-with-error) so it matches the shape the
                // success/late-failure paths already use.
                write(
                    `data: ${JSON.stringify({
                        type: "doc_edited_start",
                        filename,
                    })}\n\n`,
                );
                write(
                    `data: ${JSON.stringify({
                        type: "doc_edited",
                        filename,
                        document_id: documentId,
                        version_id: "",
                        download_url: "",
                        annotations: [],
                        error,
                    })}\n\n`,
                );
            };

            if (!docInfo || !indexed) {
                const err = `Document '${docId}' not found in this chat's attachments.`;
                emitEditError(docId, indexed?.document_id ?? "", err);
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: JSON.stringify({ error: err }),
                });
            } else if (
                !Array.isArray(editsRaw) ||
                editsRaw.length === 0
            ) {
                const err = "edits array is required and must not be empty.";
                emitEditError(docInfo.filename, indexed.document_id, err);
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: JSON.stringify({ error: err }),
                });
            } else if (docInfo.file_type !== "docx") {
                const err = "edit_document only supports .docx files.";
                emitEditError(docInfo.filename, indexed.document_id, err);
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: JSON.stringify({ error: err }),
                });
            } else {
                write(
                    `data: ${JSON.stringify({
                        type: "doc_edited_start",
                        filename: docInfo.filename,
                    })}\n\n`,
                );
                const edits = (editsRaw as Record<string, unknown>[]).map(
                    (e) => ({
                        find: String(e.find ?? ""),
                        replace: String(e.replace ?? ""),
                        context_before: String(e.context_before ?? ""),
                        context_after: String(e.context_after ?? ""),
                        reason: e.reason ? String(e.reason) : undefined,
                    }),
                );
                const reuseVersion = turnEditState?.get(indexed.document_id);
                const result = await runEditDocument({
                    documentId: indexed.document_id,
                    userId,
                    edits,
                    db,
                    reuseVersion,
                });

                if (result.ok) {
                    turnEditState?.set(indexed.document_id, {
                        versionId: result.version_id,
                        versionNumber: result.version_number,
                        storagePath: result.storage_path,
                    });
                    // Keep the chat-local doc label pointed at the latest
                    // edited version so any follow-up read_document call in
                    // the same assistant turn reads and cites the same bytes.
                    if (docIndex[docId]) {
                        docIndex[docId] = {
                            ...docIndex[docId],
                            version_id: result.version_id,
                            version_number: result.version_number,
                        };
                    }
                    const currentDocStore = docStore.get(docId);
                    if (currentDocStore) {
                        docStore.set(docId, {
                            ...currentDocStore,
                            storage_path: result.storage_path,
                        });
                    }
                    const payload: DocEditedResult = {
                        filename: docInfo.filename,
                        document_id: indexed.document_id,
                        version_id: result.version_id,
                        version_number: result.version_number,
                        download_url: result.download_url,
                        annotations: result.annotations,
                    };
                    docsEdited.push(payload);
                    write(
                        `data: ${JSON.stringify({
                            type: "doc_edited",
                            ...payload,
                        })}\n\n`,
                    );
                    toolResults.push({
                        role: "tool",
                        tool_call_id: tc.id,
                        content: JSON.stringify({
                            ok: true,
                            doc_id: docId,
                            document_id: indexed.document_id,
                            version_id: result.version_id,
                            version_number: result.version_number,
                            applied: result.annotations.length,
                            errors: result.errors,
                        }),
                    });
                } else {
                    write(
                        `data: ${JSON.stringify({
                            type: "doc_edited",
                            filename: docInfo.filename,
                            document_id: indexed.document_id,
                            version_id: "",
                            download_url: "",
                            annotations: [],
                            error: result.error,
                        })}\n\n`,
                    );
                    toolResults.push({
                        role: "tool",
                        tool_call_id: tc.id,
                        content: JSON.stringify({
                            ok: false,
                            error: result.error,
                        }),
                    });
                }
            }

        } else if (tc.function.name === "replicate_document" && docIndex) {
            const rawDocId = args.doc_id as string;
            const requestedFilename =
                typeof args.new_filename === "string" &&
                args.new_filename.trim()
                    ? args.new_filename.trim()
                    : null;
            // CLEAN-51: hard-reject out-of-range count; model must retry.
            const rawCount =
                typeof args.count === "number" && Number.isFinite(args.count)
                    ? Math.floor(args.count)
                    : 1;
            if (rawCount < 1 || rawCount > 20) {
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: JSON.stringify({
                        ok: false,
                        error: `count must be between 1 and 20 (got ${rawCount})`,
                    }),
                });
                continue;
            }
            const requestedCount = rawCount;
            const sourceLabel =
                resolveDocLabel(rawDocId, docStore, docIndex) ?? rawDocId;

            const { toolResult, replicated } = await runReplicateDocument({
                rawDocId,
                requestedFilename,
                requestedCount,
                sourceLabel,
                docStore,
                docIndex,
                userId,
                projectId,
                db,
                write,
                toolCallId: tc.id,
            });
            if (replicated) docsReplicated.push(replicated);
            toolResults.push(toolResult);

        } else if (tc.function.name === "generate_docx") {
            const title = args.title as string;
            const landscape = !!(args.landscape);
            logger.info({ title, landscape, landscapeArg: args.landscape }, "[generate_docx] tool args");
            const previewFilename = `${(title.replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, 64) || "document")}.docx`;
            write(`data: ${JSON.stringify({ type: "doc_created_start", filename: previewFilename })}\n\n`);
            const result = await runGenerateDocx({
                title,
                sections: args.sections as unknown[],
                userId,
                db,
                options: { landscape, projectId: projectId ?? null },
            });
            let newDocLabel: string | null = null;
            if ("filename" in result && "download_url" in result) {
                const dlFilename = result.filename as string;
                const dlUrl = result.download_url as string;
                const documentId = (result as { document_id?: string }).document_id;
                const versionId = (result as { version_id?: string }).version_id;
                const versionNumber = (result as { version_number?: number }).version_number ?? null;
                const storagePath = (result as { storage_path?: string }).storage_path;

                // Register the generated doc in the chat context so
                // edit_document (and read_document / find_in_document)
                // can act on it within the same assistant turn. New label
                // is the next free `doc-N` index. Subsequent turns pick
                // it up via the normal attachment/project doc query.
                if (documentId && storagePath && docIndex) {
                    const existingLabels = new Set(Object.keys(docIndex));
                    let i = 0;
                    while (existingLabels.has(`doc-${i}`)) i++;
                    newDocLabel = `doc-${i}`;
                    docIndex[newDocLabel] = {
                        document_id: documentId,
                        filename: dlFilename,
                    };
                    docStore.set(newDocLabel, {
                        storage_path: storagePath,
                        file_type: "docx",
                        filename: dlFilename,
                    });
                }

                write(
                    `data: ${JSON.stringify({
                        type: "doc_created",
                        filename: dlFilename,
                        download_url: dlUrl,
                        document_id: documentId,
                        version_id: versionId,
                        version_number: versionNumber,
                    })}\n\n`,
                );
                docsCreated.push({
                    filename: dlFilename,
                    download_url: dlUrl,
                    document_id: documentId,
                    version_id: versionId,
                    version_number: versionNumber,
                });
            } else {
                write(`data: ${JSON.stringify({ type: "doc_created", filename: previewFilename, download_url: "" })}\n\n`);
            }
            // Surface the chat-local doc label in the tool result so the
            // model can pass it as `doc_id` to edit_document / read_document
            // / find_in_document in the same turn. Without this the model
            // only sees the DB UUID, which isn't valid as a doc_id anchor.
            const toolResultPayload = newDocLabel
                ? { ...(result as Record<string, unknown>), doc_id: newDocLabel }
                : result;
            toolResults.push({
                role: "tool",
                tool_call_id: tc.id,
                content: JSON.stringify(toolResultPayload),
            });
        }
    }

    return {
        toolResults,
        docsRead,
        docsFound,
        docsCreated,
        docsReplicated,
        workflowsApplied,
        docsEdited,
    };
}
