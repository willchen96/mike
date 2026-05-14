/**
 * read_workflow tool runner.
 *
 * Looks up a workflow by id in the WorkflowStore, emits a workflow_applied
 * SSE event, and returns the workflow's prompt_md as the tool result content.
 */

import type { WorkflowStore } from "../types";

export function runReadWorkflow(args: {
    workflowId: string;
    workflowStore: WorkflowStore | undefined;
    write: (s: string) => void;
}): { content: string; applied: { workflow_id: string; title: string } | null } {
    const { workflowId, workflowStore, write } = args;
    const wf = workflowStore?.get(workflowId);
    if (wf) {
        write(`data: ${JSON.stringify({ type: "workflow_applied", workflow_id: workflowId, title: wf.title })}\n\n`);
        return {
            content: wf.prompt_md,
            applied: { workflow_id: workflowId, title: wf.title },
        };
    }
    return {
        content: `Workflow '${workflowId}' not found.`,
        applied: null,
    };
}
