import type {
    ColumnConfig,
    MikeWorkflow,
} from "@/app/components/shared/types";

const WORKFLOW_FILE_FORMAT = "mike.workflow" as const;
const WORKFLOW_FILE_VERSION = 1 as const;

export interface WorkflowFile {
    format: typeof WORKFLOW_FILE_FORMAT;
    version: typeof WORKFLOW_FILE_VERSION;
    title: string;
    type: "assistant" | "tabular";
    practice: string | null;
    prompt_md: string | null;
    columns_config: ColumnConfig[] | null;
}

export function buildWorkflowEnvelope(wf: MikeWorkflow): WorkflowFile {
    return {
        format: WORKFLOW_FILE_FORMAT,
        version: WORKFLOW_FILE_VERSION,
        title: wf.title,
        type: wf.type,
        practice: wf.practice ?? null,
        prompt_md: wf.prompt_md ?? null,
        columns_config: wf.columns_config ?? null,
    };
}

function sanitizeFilename(title: string): string {
    const cleaned = title
        .normalize("NFKD")
        .replace(/[^\w\s.-]/g, "")
        .trim()
        .replace(/\s+/g, "-");
    return cleaned.length > 0 ? cleaned : "workflow";
}

export function downloadWorkflow(wf: MikeWorkflow): void {
    const envelope = buildWorkflowEnvelope(wf);
    const blob = new Blob([JSON.stringify(envelope, null, 2)], {
        type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${sanitizeFilename(wf.title)}.mikeworkflow.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

export class WorkflowFileError extends Error {}

export function parseWorkflowFile(raw: string): WorkflowFile {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new WorkflowFileError("File is not valid JSON.");
    }
    if (!parsed || typeof parsed !== "object") {
        throw new WorkflowFileError("File is not a workflow envelope.");
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.format !== WORKFLOW_FILE_FORMAT) {
        throw new WorkflowFileError(
            "Not a Mike workflow file (missing or wrong 'format').",
        );
    }
    if (obj.version !== WORKFLOW_FILE_VERSION) {
        throw new WorkflowFileError(
            `Unsupported workflow file version: ${String(obj.version)}.`,
        );
    }
    if (typeof obj.title !== "string" || !obj.title.trim()) {
        throw new WorkflowFileError("Workflow file is missing a title.");
    }
    if (obj.type !== "assistant" && obj.type !== "tabular") {
        throw new WorkflowFileError(
            "Workflow type must be 'assistant' or 'tabular'.",
        );
    }
    if (obj.columns_config != null && !Array.isArray(obj.columns_config)) {
        throw new WorkflowFileError("columns_config must be an array.");
    }
    return {
        format: WORKFLOW_FILE_FORMAT,
        version: WORKFLOW_FILE_VERSION,
        title: obj.title.trim(),
        type: obj.type,
        practice: (obj.practice as string | null | undefined) ?? null,
        prompt_md: (obj.prompt_md as string | null | undefined) ?? null,
        columns_config:
            (obj.columns_config as ColumnConfig[] | null | undefined) ?? null,
    };
}

export async function readWorkflowFile(file: File): Promise<WorkflowFile> {
    const text = await file.text();
    return parseWorkflowFile(text);
}
