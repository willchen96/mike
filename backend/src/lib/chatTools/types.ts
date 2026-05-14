/**
 * Shared type aliases for the chatTools module.
 *
 * Consumed by stream.ts, tool-runner.ts, doc-context.ts, citations.ts,
 * workflow-store.ts and tools/*. Hosted here (not in index.ts) so
 * sibling modules can import via "./types" without circular imports
 * through the façade.
 */

export type DocStore = Map<
    string,
    { storage_path: string; file_type: string; filename: string }
>;

export type WorkflowStore = Map<string, { title: string; prompt_md: string }>;

export type DocIndex = Record<
    string,
    {
        document_id: string;
        filename: string;
        version_id?: string | null;
        version_number?: number | null;
    }
>;

export type TabularCellStore = {
    columns: { index: number; name: string }[];
    documents: { id: string; filename: string }[];
    /** key: `${colIndex}:${docId}` */
    cells: Map<string, { summary: string; flag?: string; reasoning?: string } | null>;
};

export type ToolCall = {
    id: string;
    function: { name: string; arguments: string };
};

export type ChatMessage = {
    role: string;
    content: string | null;
    files?: { filename: string; document_id?: string }[];
    workflow?: { id: string; title: string };
};

export type EditAnnotation = {
    kind: "edit";
    edit_id: string;
    document_id: string;
    version_id: string;
    version_number?: number | null;
    change_id: string;
    del_w_id?: string;
    ins_w_id?: string;
    deleted_text: string;
    inserted_text: string;
    context_before: string;
    context_after: string;
    reason?: string;
    status: "pending" | "accepted" | "rejected";
};

export type TurnEditState = Map<
    string,
    { versionId: string; versionNumber: number; storagePath: string }
>;

export type DocEditedResult = {
    filename: string;
    document_id: string;
    version_id: string;
    version_number: number | null;
    download_url: string;
    annotations: EditAnnotation[];
};

export type DocCreatedResult = {
    filename: string;
    download_url: string;
    document_id?: string;
    version_id?: string;
    version_number?: number | null;
};

export type DocReplicatedResult = {
    /** Filename of the source document being copied. */
    filename: string;
    /** How many copies were produced in this single tool call. */
    count: number;
    /** One entry per new copy. */
    copies: {
        new_filename: string;
        document_id: string;
        version_id: string;
    }[];
};
